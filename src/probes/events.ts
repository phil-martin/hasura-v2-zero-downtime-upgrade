import { fail, ok, outcomeFromResult, type Probe, type ProbeCtx } from './types.js'

export type EventExpectation = {
  probeKey: string
  trigger: string
  /** When the mutation that should have fired the trigger succeeded. */
  at: number
  /** True when the sidecar was told to reject the first attempt on purpose. */
  forcedRetry: boolean
}

type SidecarDelivery = {
  triggerName: string
  probeKey: string | null
  op: string
  eventId: string
  currentRetry: number
  receivedAt: number
  rejected?: boolean
}

/**
 * Event probes.
 *
 * A probe registers an expectation the instant its mutation succeeds; whether
 * the delivery ever arrives is decided later, during reconciliation, after a
 * settle window. That separation matters: Hasura's graceful shutdown marks
 * unfinished events *pending* rather than dropping them, so a delivery can
 * legitimately arrive well after the upgrade completed, carried by the new
 * engine. Asserting at the instant probes stop would report those as lost.
 */
export function eventProbes(): Probe[] {
  return [
    {
      id: 'e_insert_fires_event',
      group: 'event',
      async run(ctx) {
        const key = ctx.nextKey('ev-ins')
        const result = await ctx.admin.graphql(
          `mutation Ev($key: String!) {
             insert_events_source_one(object: {probe_key: $key, payload: {kind: "insert-probe"}}) { probe_key }
           }`,
          { key },
        )
        const transportFailure = outcomeFromResult(result)
        if (transportFailure) return transportFailure
        if (result.kind !== 'ok') return fail(result.latencyMs, 'unavailable', 'unreachable branch')
        if ((result.data as any)?.insert_events_source_one?.probe_key !== key) {
          return fail(result.latencyMs, 'wrong-result', 'insert did not echo probe_key')
        }
        ctx.expectEvent(key, 'on_events_source_insert', false)
        return ok(result.latencyMs)
      },
    },

    {
      id: 'e_update_fires_event',
      group: 'event',
      async run(ctx) {
        const key = ctx.nextKey('ev-upd')
        const created = await ctx.admin.graphql(
          `mutation Seed($key: String!) { insert_orders_one(object: {probe_key: $key, qty: 1}) { probe_key } }`,
          { key },
        )
        const seedFailure = outcomeFromResult(created)
        if (seedFailure) return seedFailure

        const updated = await ctx.admin.graphql(
          `mutation Upd($key: String!) {
             update_orders(where: {probe_key: {_eq: $key}}, _set: {status: "touched"}) { affected_rows }
           }`,
          { key },
        )
        const updateFailure = outcomeFromResult(updated)
        if (updateFailure) return updateFailure
        if (updated.kind !== 'ok') return fail(updated.latencyMs, 'unavailable', 'unreachable branch')
        if ((updated.data as any)?.update_orders?.affected_rows !== 1) {
          return fail(updated.latencyMs, 'wrong-result', 'update did not affect exactly one row')
        }
        ctx.expectEvent(key, 'on_orders_update', false)
        return ok(updated.latencyMs)
      },
    },

    {
      id: 'e_retry_delivery',
      group: 'event',
      async run(ctx) {
        // Force the first delivery attempt to be rejected, so the event can only
        // succeed via Hasura's backoff retry. Across an upgrade this is the
        // interesting case: the old engine schedules the retry, the new one
        // delivers it.
        const key = ctx.nextKey('ev-retry')
        try {
          await fetch(`${ctx.sidecarUrl}/_harness/fail-next`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ probeKey: key, times: 1 }),
          })
        } catch (err) {
          return fail(0, 'unavailable', `could not arm forced failure on sidecar: ${String(err)}`)
        }

        const result = await ctx.admin.graphql(
          `mutation EvRetry($key: String!) {
             insert_events_source_one(object: {probe_key: $key, payload: {kind: "retry-probe"}}) { probe_key }
           }`,
          { key },
        )
        const transportFailure = outcomeFromResult(result)
        if (transportFailure) return transportFailure
        if (result.kind !== 'ok') return fail(result.latencyMs, 'unavailable', 'unreachable branch')
        ctx.expectEvent(key, 'on_events_source_insert', true)
        return ok(result.latencyMs)
      },
    },
  ]
}

export type EventReconciliation = {
  expected: number
  delivered: number
  lost: string[]
  duplicates: number
  /** Deliveries that only succeeded after at least one rejected attempt. */
  retriedSuccessfully: number
  /** Expectations armed for retry that never got a successful delivery. */
  retriesLost: string[]
  deliveryLatencyMs: number[]
}

export async function fetchDeliveries(sidecarUrl: string): Promise<SidecarDelivery[]> {
  const res = await fetch(`${sidecarUrl}/_harness/deliveries`)
  const body = (await res.json()) as { deliveries: SidecarDelivery[] }
  return body.deliveries ?? []
}

export async function reconcileEvents(
  expectations: EventExpectation[],
  sidecarUrl: string,
): Promise<EventReconciliation> {
  const deliveries = await fetchDeliveries(sidecarUrl)

  const acceptedByKey = new Map<string, SidecarDelivery[]>()
  const rejectedByKey = new Map<string, number>()
  for (const d of deliveries) {
    if (!d.probeKey) continue
    if (d.rejected) {
      rejectedByKey.set(d.probeKey, (rejectedByKey.get(d.probeKey) ?? 0) + 1)
      continue
    }
    const list = acceptedByKey.get(d.probeKey) ?? []
    list.push(d)
    acceptedByKey.set(d.probeKey, list)
  }

  const lost: string[] = []
  const retriesLost: string[] = []
  const latencies: number[] = []
  let duplicates = 0
  let retriedSuccessfully = 0

  for (const exp of expectations) {
    const accepted = acceptedByKey.get(exp.probeKey) ?? []
    if (accepted.length === 0) {
      lost.push(exp.probeKey)
      if (exp.forcedRetry) retriesLost.push(exp.probeKey)
      continue
    }
    // At-least-once delivery is the contract, so extra deliveries are recorded
    // but are not failures.
    if (accepted.length > 1) duplicates += accepted.length - 1
    if ((rejectedByKey.get(exp.probeKey) ?? 0) > 0) retriedSuccessfully++

    const earliest = accepted.reduce((min, d) => Math.min(min, d.receivedAt), Number.POSITIVE_INFINITY)
    latencies.push(Math.max(0, earliest - exp.at))
  }

  return {
    expected: expectations.length,
    delivered: expectations.length - lost.length,
    lost,
    duplicates,
    retriedSuccessfully,
    retriesLost,
    deliveryLatencyMs: latencies,
  }
}
