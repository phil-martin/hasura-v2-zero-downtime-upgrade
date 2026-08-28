import { cfg, policy, profile, type Policy, type Profile } from '../config/index.js'
import { HasuraClient } from '../hasura/client.js'
import { loadExpected, type ExpectedMap } from '../oracle/expected.js'
import { denialProbes, readProbes } from '../probes/reads.js'
import { mutationProbes } from '../probes/mutations.js'
import { actionProbes } from '../probes/actions.js'
import { eventProbes, reconcileEvents, type EventExpectation } from '../probes/events.js'
import { fetchCronFires, reconcileCron } from '../probes/cron.js'
import { SeqWriter } from '../probes/seqWriter.js'
import { LiveMaxSeqSubscription, StreamingSeqSubscription, wsUrlFor } from '../probes/subscriptions.js'
import type { GqlClient, Probe, ProbeCtx, ProbeGroup } from '../probes/types.js'
import { Timeline } from './timeline.js'
import { deriveWindows } from '../report/windows.js'
import { scoreWindow, type ProxyCounters, type Scorecard, type SubscriptionScore } from '../report/scorecard.js'
import { evaluatePolicy, type PolicyVerdict } from '../report/policies.js'
import {
  BLUE_CONTAINER,
  GREEN_CONTAINER,
  containerEnvVar,
  containerRunning,
  dbNameFromUrl,
  lightReset,
} from '../stack/index.js'
import { sql } from '../db/pool.js'
import { BACKEND, HaproxyClient } from '../haproxy/client.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../config/index.js'
import type { Upgrader } from '../upgraders/types.js'
import { noopUpgrader } from '../upgraders/types.js'
import { naiveUpgrader } from '../upgraders/naive.js'
import { zeroDowntimeUpgrader } from '../upgraders/zeroDowntime.js'

/**
 * How often each probe group repeats. Read-heavy groups run fastest because
 * they are the cheapest and give the finest-grained outage resolution; event
 * and action probes are slower because each one costs a webhook round trip and
 * flooding them would measure the sidecar rather than Hasura.
 */
const GROUP_INTERVAL_MS: Record<ProbeGroup, number> = {
  query: 250,
  rbac: 300,
  rest: 300,
  remote: 400,
  mutation: 400,
  event: 1_200,
  action: 1_500,
  cron: 0,
  subscription: 0,
}

export const UPGRADERS: Record<string, Upgrader> = {
  none: noopUpgrader,
  naive: naiveUpgrader,
  'zero-downtime': zeroDowntimeUpgrader,
}

/**
 * Where probes send their traffic.
 *
 * `proxy` is the proposed topology: HAProxy in front, health checks, drain.
 * `direct-blue` models what a community deployment looks like TODAY — Hasura's
 * port published straight to the host, with no proxy, no health checking and no
 * connection retries.
 *
 * The naive baseline must use `direct-blue`. Measuring the naive upgrade from
 * behind HAProxy measures it through the very component that is part of the
 * fix, which makes the fix look unnecessary: the proxy's conn-failure retry
 * quietly absorbs the gap between the old container exiting and the new one
 * listening.
 */
export type ProbeTarget = 'proxy' | 'direct-blue'

export type RunOptions = {
  profileName?: string
  policyName?: string
  upgraderName?: string
  probeTarget?: ProbeTarget
  /** Overrides merged over the captured expectations, for fault injection. */
  expectedOverrides?: ExpectedMap
  /** Extra work to run at a given offset, for fault injection. */
  faults?: Array<{ atMs: number; run: (t: Timeline) => Promise<void> }>
  log?: (msg: string) => void
  /** Skip the reset, when the caller has already prepared the stack. */
  skipReset?: boolean
}

export type RunResult = {
  scorecard: Scorecard
  verdict: PolicyVerdict
  timeline: Timeline
}

export async function runHarness(opts: RunOptions = {}): Promise<RunResult> {
  const prof: Profile = profile(opts.profileName ?? process.env.PROFILE ?? 'default')
  const pol: Policy = policy(opts.policyName ?? process.env.POLICY ?? 'strict')
  const upgraderName = opts.upgraderName ?? 'none'
  const upgrader = UPGRADERS[upgraderName]
  if (!upgrader) throw new Error(`unknown upgrader "${upgraderName}"`)

  const log = opts.log ?? ((m: string) => console.log(`[harness] ${m}`))

  if (!opts.skipReset) await lightReset()

  const expected: ExpectedMap = { ...(await loadExpected()), ...(opts.expectedOverrides ?? {}) }

  const probeTarget: ProbeTarget = opts.probeTarget ?? 'proxy'
  const targetUrl = probeTarget === 'proxy' ? cfg.proxyUrl : cfg.blueDirectUrl
  log(`probes targeting ${probeTarget} (${targetUrl})`)

  const admin = new HasuraClient({ baseUrl: targetUrl, adminSecret: cfg.adminSecret })
  const anon = new HasuraClient({ baseUrl: targetUrl, adminSecret: cfg.adminSecret, unauthenticated: true })
  const roleClients = new Map<string, GqlClient>()

  const eventExpectations: EventExpectation[] = []
  let keyCounter = 0
  const runId = `r${Date.now().toString(36)}`

  const ctx: ProbeCtx = {
    admin,
    anon,
    as(role, userId) {
      const cacheKey = `${role}:${userId ?? ''}`
      let client = roleClients.get(cacheKey)
      if (!client) {
        client = new HasuraClient({ baseUrl: targetUrl, adminSecret: cfg.adminSecret, role, userId })
        roleClients.set(cacheKey, client)
      }
      return client
    },
    sidecarUrl: cfg.sidecarUrl,
    nextKey: (prefix) => `${runId}-${prefix}-${++keyCounter}`,
    expectEvent: (probeKey, trigger, forcedRetry) => {
      eventExpectations.push({ probeKey, trigger, at: Date.now(), forcedRetry })
    },
  }

  const probes: Probe[] = [
    ...readProbes(expected),
    ...denialProbes(),
    ...mutationProbes(),
    ...eventProbes(),
    ...actionProbes(),
  ]

  const scheduledEventsAtStart = await countScheduledCronEvents()
  const proxyBefore = await readProxyCounters()

  const runStart = Date.now()
  const timeline = new Timeline(runStart)
  timeline.marker('run.start', {
    profile: prof.name,
    upgrader: upgraderName,
    probeTarget,
    from: cfg.fromVersion,
    to: cfg.toVersion,
  })

  // --- long-lived probes ---------------------------------------------------
  const writer = new SeqWriter(250)
  writer.start()

  const wsUrl = wsUrlFor(targetUrl)
  const streaming = new StreamingSeqSubscription('s_streaming_cursor', wsUrl, cfg.adminSecret)
  const live = new LiveMaxSeqSubscription('s_live_max_seq', wsUrl, cfg.adminSecret)
  streaming.start()
  live.start()

  // --- request/response probe loops ---------------------------------------
  let stopping = false
  const loops = probes.map(async (probe) => {
    const interval = GROUP_INTERVAL_MS[probe.group] || 500
    // Stagger starts so all probes do not fire in lockstep, which would produce
    // a spiky load profile and coarse outage resolution.
    await sleep(Math.random() * interval)
    while (!stopping) {
      const started = Date.now()
      try {
        const outcome = await probe.run(ctx)
        timeline.record({ probeId: probe.id, group: probe.group, ...outcome })
      } catch (err) {
        // A probe throwing is itself a failure to observe a healthy system.
        timeline.record({
          probeId: probe.id,
          group: probe.group,
          ok: false,
          latencyMs: Date.now() - started,
          kind: 'unavailable',
          detail: `probe threw: ${String(err).slice(0, 300)}`,
        })
      }
      const elapsed = Date.now() - started
      if (!stopping) await sleep(Math.max(0, interval - elapsed))
    }
  })

  // --- scheduled orchestrator actions --------------------------------------
  const upgradeCtx = { timeline, log }
  const actionPromises: Array<Promise<void>> = []

  for (const action of prof.schedule) {
    if (upgraderName === 'none') break
    actionPromises.push(
      (async () => {
        await sleep(action.atMs)
        if (stopping) return
        try {
          log(`running scheduled action "${action.action}" at +${action.atMs}ms`)
          if (action.action === 'upgrade') await upgrader.upgrade(upgradeCtx)
          else await upgrader.rollback(upgradeCtx)
        } catch (err) {
          // A failed upgrade must not abort the run. The whole point is to
          // measure what the failure did to live traffic.
          timeline.marker(`${action.action}.failed`, { error: String(err).slice(0, 500) })
          log(`action "${action.action}" FAILED: ${String(err).slice(0, 500)}`)
        }
      })(),
    )
  }

  for (const fault of opts.faults ?? []) {
    actionPromises.push(
      (async () => {
        await sleep(fault.atMs)
        if (stopping) return
        try {
          await fault.run(timeline)
        } catch (err) {
          timeline.marker('fault.failed', { error: String(err).slice(0, 300) })
        }
      })(),
    )
  }

  // --- run -----------------------------------------------------------------
  await sleep(prof.durationMs)
  stopping = true
  await Promise.allSettled(loops)
  await Promise.allSettled(actionPromises)

  const runEnd = Date.now()
  timeline.marker('run.end')
  const proxyAfter = await readProxyCounters()

  // Stop producing rows first, then give subscriptions a moment to drain what
  // was already committed, so trailing rows are not miscounted as missed.
  await writer.stop()
  await sleep(3_000)
  await streaming.stop()
  await live.stop()

  // --- settle and reconcile ------------------------------------------------
  // Graceful shutdown marks unfinished events pending rather than dropping
  // them, so a delivery can legitimately arrive well after the upgrade
  // finished. Reconciling at runEnd would report those as lost.
  log(`settling ${prof.settleMs}ms before reconciling events`)
  await sleep(prof.settleMs)

  const events = await reconcileEvents(eventExpectations, cfg.sidecarUrl)
  const cronFires = await fetchCronFires(cfg.sidecarUrl)
  const upgradeMarker = timeline.markerAt('upgrade.start')
  const scheduledEventsAtEnd = await countScheduledCronEvents()
  const cron = reconcileCron(
    cronFires,
    runStart,
    runEnd,
    upgradeMarker?.t ?? null,
    scheduledEventsAtStart,
    scheduledEventsAtEnd,
  )

  // --- score ---------------------------------------------------------------
  const records = timeline.records()
  const windows = deriveWindows(timeline.markers(), runStart, runEnd)
  const windowScores = windows.map((w) => scoreWindow(w, records))
  const overall = scoreWindow({ name: 'overall', startMs: runStart, endMs: runEnd + 1, kind: 'quiet' }, records)

  const streamStats = streaming.stats()
  const liveStats = live.stats()
  const missed = streaming.missed(writer.written)

  const subscriptions: SubscriptionScore[] = [
    {
      id: streamStats.id,
      drops: streamStats.drops.length,
      reconnectMs: streamStats.reconnectMs,
      maxReconnectMs: max(streamStats.reconnectMs),
      updates: streamStats.updates,
      missedRows: missed.length,
      missedRate: writer.written.length === 0 ? 0 : missed.length / writer.written.length,
      maxSeqSeen: streamStats.maxSeqSeen,
    },
    {
      id: liveStats.id,
      drops: liveStats.drops.length,
      reconnectMs: liveStats.reconnectMs,
      maxReconnectMs: max(liveStats.reconnectMs),
      updates: liveStats.updates,
      // A live query reports current state rather than a row stream, so
      // "missed rows" is not a meaningful measure for it. Falling behind is
      // caught by maxSeqSeen instead.
      missedRows: 0,
      missedRate: 0,
      maxSeqSeen: liveStats.maxSeqSeen,
    },
  ]

  const scorecard: Scorecard = {
    profile: prof.name,
    probeTarget,
    upgrader: upgraderName,
    fromVersion: cfg.fromVersion,
    toVersion: cfg.toVersion,
    runStart,
    runEnd,
    windows: windowScores,
    overall,
    subscriptions,
    proxy: deltaProxy(proxyBefore, proxyAfter),
    events,
    cron,
    seqWritten: writer.written.length,
    seqWriteFailures: writer.writeFailures.length,
    markers: timeline.markers().map((m) => ({ name: m.name, atMs: m.t - runStart, detail: m.detail })),
    headline: {
      longestContiguousOutageMs: overall.longestContiguousOutageMs,
      failedRequests: overall.failures,
      incorrectResults: overall.byKind['wrong-result'],
      graphqlErrors: overall.byKind['graphql-error'],
      lostEvents: events.lost.length,
      missedSubscriptionRows: missed.length,
      subscriptionDrops: subscriptions.reduce((n, s) => n + s.drops, 0),
      maxReconnectMs: Math.max(0, ...subscriptions.map((s) => s.maxReconnectMs)),
    },
  }

  const verdict = evaluatePolicy(pol, scorecard)
  await persistRun(scorecard, verdict).catch((err) => log(`could not persist run: ${String(err)}`))
  return { scorecard, verdict, timeline }
}

/**
 * Read cumulative proxy counters for the backend as a whole.
 *
 * Returns null when HAProxy is unreachable, which is a legitimate state for a
 * `direct-blue` run where the proxy is not part of the topology under test.
 */
async function readProxyCounters(): Promise<ProxyCounters | null> {
  try {
    const hap = new HaproxyClient(cfg.haproxyHost, cfg.haproxyPort)
    const stats = await hap.showStat()
    const backend = stats.find((s) => s.pxname === BACKEND && s.svname === 'BACKEND')
    if (!backend) return null
    return {
      retries: backend.wretr,
      redispatches: backend.wredis,
      connErrors: backend.econ,
      respErrors: backend.eresp,
    }
  } catch {
    return null
  }
}

function deltaProxy(before: ProxyCounters | null, after: ProxyCounters | null): ProxyCounters | null {
  if (!before || !after) return null
  return {
    retries: after.retries - before.retries,
    redispatches: after.redispatches - before.redispatches,
    connErrors: after.connErrors - before.connErrors,
    respErrors: after.respErrors - before.respErrors,
  }
}

/** Persist the full scorecard so a run can be re-examined without re-running it. */
async function persistRun(scorecard: Scorecard, verdict: PolicyVerdict): Promise<void> {
  const dir = resolve(REPO_ROOT, 'runs')
  await mkdir(dir, { recursive: true })
  const stamp = new Date(scorecard.runStart).toISOString().replace(/[:.]/g, '-')
  const file = resolve(dir, `${stamp}-${scorecard.upgrader}-${scorecard.profile}.json`)
  await writeFile(file, `${JSON.stringify({ scorecard, verdict }, null, 2)}\n`, 'utf8')
}

/**
 * Count cron events Hasura has pre-generated into the metadata store.
 *
 * Discovers which metadata database is canonical by inspecting the running
 * container's environment rather than tracking it in a file. Roles alternate
 * after every successful upgrade and a state file can drift; the running
 * container cannot.
 */
async function countScheduledCronEvents(): Promise<number | null> {
  const container = (await containerRunning(GREEN_CONTAINER)) ? GREEN_CONTAINER : BLUE_CONTAINER
  const url = await containerEnvVar(container, 'HASURA_GRAPHQL_METADATA_DATABASE_URL')
  const db = dbNameFromUrl(url) ?? cfg.metadataDb
  try {
    const rows = await sql<{ n: string }>(db, `SELECT count(*)::text AS n FROM hdb_catalog.hdb_cron_events`)
    return Number(rows[0]?.n ?? 0)
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const max = (xs: number[]) => (xs.length === 0 ? 0 : Math.max(...xs))
