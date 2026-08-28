/**
 * Harness sidecar.
 *
 * One service covering everything Hasura needs to call outwards to:
 *   - event trigger webhook
 *   - cron trigger webhook
 *   - two Action handlers (one sync, one async)
 *   - a remote schema
 *
 * It records every delivery with a timestamp so the harness can reconcile what
 * Hasura *should* have delivered against what actually arrived, including
 * deliveries that land after an upgrade completed.
 */
import { createServer } from 'node:http'
import { buildSchema, graphql } from 'graphql'

const PORT = Number(process.env.PORT ?? 8081)

// ---------------------------------------------------------------------------
// Recorded state
// ---------------------------------------------------------------------------

/** @type {Array<{triggerName:string, probeKey:string|null, op:string, eventId:string, currentRetry:number, receivedAt:number}>} */
const deliveries = []
/** @type {Array<{name:string, receivedAt:number, scheduledAt:string|null, payload:unknown}>} */
const cronFires = []
/** @type {Array<{name:string, receivedAt:number}>} */
const actionCalls = []

/**
 * probeKey -> remaining forced failures. Used to prove Hasura's retry backoff
 * still delivers across an upgrade boundary: the old engine schedules the
 * retry, the new one delivers it.
 * @type {Map<string, number>}
 */
const forcedFailures = new Map()

/** Global kill switch for fault-injection tests. */
let failAllEvents = false

const nowMs = () => Date.now()

// ---------------------------------------------------------------------------
// Remote schema
// ---------------------------------------------------------------------------

const remoteSchema = buildSchema(`
  type RemoteBookInfo {
    bookId: Int!
    shelfCode: String!
    warehouse: String!
  }

  type Query {
    remotePing: String!
    remoteBookInfo(bookId: Int!): RemoteBookInfo!
  }
`)

// Deterministic by construction, so remote-schema probes have exact expected
// results just like the database ones.
const remoteRoot = {
  remotePing: () => 'pong',
  remoteBookInfo: ({ bookId }) => ({
    bookId,
    shelfCode: `SH-${String(bookId % 50).padStart(2, '0')}`,
    warehouse: `W${bookId % 3}`,
  }),
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** Hasura puts the row under event.data.new for INSERT/UPDATE, .old for DELETE. */
function extractProbeKey(body) {
  const data = body?.event?.data
  const row = data?.new ?? data?.old
  return typeof row?.probe_key === 'string' ? row.probe_key : null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = {
  'POST /webhook/event': async (req, res) => {
    const body = await readJson(req)
    const probeKey = extractProbeKey(body)
    const record = {
      triggerName: body?.trigger?.name ?? 'unknown',
      probeKey,
      op: body?.event?.op ?? 'unknown',
      eventId: body?.id ?? 'unknown',
      currentRetry: body?.delivery_info?.current_retry ?? 0,
      receivedAt: nowMs(),
    }

    if (failAllEvents) {
      // Not recorded: from the harness's point of view this delivery never
      // happened, which is exactly what we want a fault injection to look like.
      return send(res, 503, { error: 'forced failure (failAllEvents)' })
    }

    const remaining = probeKey ? (forcedFailures.get(probeKey) ?? 0) : 0
    if (remaining > 0) {
      forcedFailures.set(probeKey, remaining - 1)
      // Record the rejected attempt so a retry probe can prove the retry
      // actually happened rather than the first attempt having quietly worked.
      deliveries.push({ ...record, rejected: true })
      return send(res, 503, { error: `forced failure, ${remaining - 1} remaining` })
    }

    deliveries.push(record)
    return send(res, 200, { ok: true })
  },

  'POST /webhook/cron': async (req, res) => {
    const body = await readJson(req)
    cronFires.push({
      name: body?.name ?? body?.trigger_name ?? 'heartbeat',
      receivedAt: nowMs(),
      scheduledAt: body?.scheduled_time ?? null,
      payload: body?.payload ?? null,
    })
    return send(res, 200, { ok: true })
  },

  // Sync Action. Deterministic so the probe can assert an exact result:
  // total = qty * unitPrice * 1.1, rounded to 2dp, as a string to avoid any
  // float representation drift between versions.
  'POST /action/quote': async (req, res) => {
    const body = await readJson(req)
    actionCalls.push({ name: 'computeQuote', receivedAt: nowMs() })
    const qty = Number(body?.input?.qty)
    const unitPrice = Number(body?.input?.unitPrice)
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) {
      return send(res, 400, { message: 'qty and unitPrice must be numeric', code: 'bad-input' })
    }
    const total = Math.round(qty * unitPrice * 1.1 * 100) / 100
    return send(res, 200, {
      qty,
      unitPrice: unitPrice.toFixed(2),
      total: total.toFixed(2),
    })
  },

  // Async Action handler. Identical contract to a sync one; "async" only
  // describes how the client retrieves the result.
  'POST /action/slow-echo': async (req, res) => {
    const body = await readJson(req)
    actionCalls.push({ name: 'slowEcho', receivedAt: nowMs() })
    const message = String(body?.input?.message ?? '')
    await new Promise((r) => setTimeout(r, 500))
    return send(res, 200, { echoed: message, length: message.length })
  },

  'POST /remote/graphql': async (req, res) => {
    const body = await readJson(req)
    const result = await graphql({
      schema: remoteSchema,
      source: body?.query ?? '',
      rootValue: remoteRoot,
      variableValues: body?.variables ?? undefined,
      operationName: body?.operationName ?? undefined,
    })
    return send(res, 200, result)
  },

  // --- harness control surface -------------------------------------------

  'GET /_harness/health': async (_req, res) => send(res, 200, { ok: true }),

  'GET /_harness/deliveries': async (_req, res) =>
    send(res, 200, { deliveries, count: deliveries.length }),

  'GET /_harness/cron-fires': async (_req, res) =>
    send(res, 200, { cronFires, count: cronFires.length }),

  'GET /_harness/action-calls': async (_req, res) =>
    send(res, 200, { actionCalls, count: actionCalls.length }),

  'POST /_harness/reset': async (_req, res) => {
    deliveries.length = 0
    cronFires.length = 0
    actionCalls.length = 0
    forcedFailures.clear()
    failAllEvents = false
    return send(res, 200, { ok: true })
  },

  'POST /_harness/fail-next': async (req, res) => {
    const body = await readJson(req)
    const probeKey = String(body?.probeKey ?? '')
    const times = Number(body?.times ?? 1)
    if (!probeKey) return send(res, 400, { error: 'probeKey required' })
    forcedFailures.set(probeKey, times)
    return send(res, 200, { ok: true, probeKey, times })
  },

  'POST /_harness/fail-all': async (req, res) => {
    const body = await readJson(req)
    failAllEvents = Boolean(body?.enabled)
    return send(res, 200, { ok: true, failAllEvents })
  },
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const key = `${req.method} ${url.pathname}`
  const handler = routes[key]
  if (!handler) return send(res, 404, { error: `no route for ${key}` })
  try {
    await handler(req, res)
  } catch (err) {
    send(res, 500, { error: String(err) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sidecar] listening on ${PORT}`)
})
