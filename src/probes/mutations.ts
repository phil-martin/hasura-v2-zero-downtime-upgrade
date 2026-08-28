import { deepEqual, diffSummary } from '../oracle/canonical.js'
import { fail, ok, outcomeFromResult, type Probe, type ProbeCtx, type ProbeOutcome } from './types.js'

/**
 * Mutation probes assert by round-trip rather than against a fixed expectation.
 *
 * Every invocation generates a unique probe_key, writes with a known payload,
 * and asserts the response echoes exactly what was sent. Because the mutable
 * partition is never read by an exact-match probe, concurrent writes from other
 * probes cannot make these flaky, and these cannot make the read probes flaky.
 */

type Check = (data: any) => string | null

async function mutate(
  ctx: ProbeCtx,
  query: string,
  variables: Record<string, unknown>,
  check: Check,
): Promise<ProbeOutcome> {
  const result = await ctx.admin.graphql(query, variables)
  const transportFailure = outcomeFromResult(result)
  if (transportFailure) return transportFailure
  if (result.kind !== 'ok') return fail(result.latencyMs, 'unavailable', 'unreachable branch')

  const problem = check(result.data)
  return problem ? fail(result.latencyMs, 'wrong-result', problem) : ok(result.latencyMs)
}

export function mutationProbes(): Probe[] {
  return [
    {
      id: 'm_insert_returning',
      group: 'mutation',
      async run(ctx) {
        const key = ctx.nextKey('ins')
        return mutate(
          ctx,
          `mutation Ins($key: String!, $qty: Int!) {
             insert_orders_one(object: {probe_key: $key, qty: $qty, payload: {origin: "probe"}}) {
               probe_key qty status payload
             }
           }`,
          { key, qty: 4 },
          (d) => {
            const row = d?.insert_orders_one
            if (!row) return 'insert returned no row'
            if (row.probe_key !== key) return `probe_key echoed as ${row.probe_key}, sent ${key}`
            if (row.qty !== 4) return `qty echoed as ${row.qty}, sent 4`
            if (row.status !== 'new') return `status default was ${row.status}, expected "new"`
            if (!deepEqual(row.payload, { origin: 'probe' })) {
              return `payload round-trip mismatch: ${diffSummary({ origin: 'probe' }, row.payload)}`
            }
            return null
          },
        )
      },
    },

    {
      id: 'm_insert_multi',
      group: 'mutation',
      async run(ctx) {
        const base = ctx.nextKey('multi')
        const objects = [1, 2, 3].map((n) => ({ probe_key: `${base}-${n}`, qty: n }))
        return mutate(
          ctx,
          `mutation InsMulti($objects: [orders_insert_input!]!) {
             insert_orders(objects: $objects) { affected_rows returning { probe_key qty } }
           }`,
          { objects },
          (d) => {
            const res = d?.insert_orders
            if (!res) return 'multi-insert returned nothing'
            if (res.affected_rows !== 3) return `affected_rows was ${res.affected_rows}, expected 3`
            const got = [...(res.returning ?? [])].sort((a: any, b: any) =>
              String(a.probe_key).localeCompare(String(b.probe_key)),
            )
            if (!deepEqual(got, objects)) return `returning mismatch: ${diffSummary(objects, got)}`
            return null
          },
        )
      },
    },

    {
      id: 'm_upsert_on_conflict',
      group: 'mutation',
      async run(ctx) {
        const key = ctx.nextKey('upsert')
        const upsert = `mutation Ups($key: String!, $qty: Int!) {
            insert_orders_one(
              object: {probe_key: $key, qty: $qty},
              on_conflict: {constraint: orders_probe_key_key, update_columns: [qty]}
            ) { probe_key qty }
          }`

        const first = await ctx.admin.graphql(upsert, { key, qty: 1 })
        const firstFailure = outcomeFromResult(first)
        if (firstFailure) return firstFailure

        // The upsert must update in place, not create a second row.
        return mutate(ctx, upsert, { key, qty: 9 }, (d) => {
          const row = d?.insert_orders_one
          if (!row) return 'upsert returned no row'
          if (row.qty !== 9) return `upsert did not update qty: got ${row.qty}, expected 9`
          return null
        }).then(async (outcome) => {
          if (!outcome.ok) return outcome
          const count = await ctx.admin.graphql(
            `query C($key: String!) { orders_aggregate(where: {probe_key: {_eq: $key}}) { aggregate { count } } }`,
            { key },
          )
          if (count.kind !== 'ok') return outcomeFromResult(count) ?? outcome
          const n = (count.data as any)?.orders_aggregate?.aggregate?.count
          if (n !== 1) return fail(outcome.latencyMs, 'wrong-result', `upsert produced ${n} rows, expected exactly 1`)
          return outcome
        })
      },
    },

    {
      id: 'm_update_set',
      group: 'mutation',
      async run(ctx) {
        const key = ctx.nextKey('upd')
        const created = await ctx.admin.graphql(
          `mutation Seed($key: String!) { insert_orders_one(object: {probe_key: $key, qty: 1}) { probe_key } }`,
          { key },
        )
        const seedFailure = outcomeFromResult(created)
        if (seedFailure) return seedFailure

        return mutate(
          ctx,
          `mutation Upd($key: String!) {
             update_orders(where: {probe_key: {_eq: $key}}, _set: {status: "shipped"}) {
               affected_rows returning { probe_key status }
             }
           }`,
          { key },
          (d) => {
            const res = d?.update_orders
            if (res?.affected_rows !== 1) return `affected_rows was ${res?.affected_rows}, expected 1`
            const row = res.returning?.[0]
            if (row?.status !== 'shipped') return `status was ${row?.status}, expected "shipped"`
            if (row?.probe_key !== key) return `probe_key was ${row?.probe_key}, expected ${key}`
            return null
          },
        )
      },
    },

    {
      id: 'm_update_inc',
      group: 'mutation',
      async run(ctx) {
        // Many probe instances increment this concurrently, so the assertion is
        // an invariant (it advanced, and stayed a positive integer) rather than
        // an exact value. Global monotonicity is checked in the scorecard.
        return mutate(
          ctx,
          `mutation Inc {
             update_counters_by_pk(pk_columns: {name: "probe_counter"}, _inc: {value: 1}) { name value }
           }`,
          {},
          (d) => {
            const row = d?.update_counters_by_pk
            if (!row) return '_inc returned no row'
            const value = Number(row.value)
            if (!Number.isInteger(value) || value < 1) return `counter value was ${row.value}, expected a positive integer`
            return null
          },
        )
      },
    },

    {
      id: 'm_update_jsonb_append',
      group: 'mutation',
      async run(ctx) {
        const key = ctx.nextKey('jsonb')
        const created = await ctx.admin.graphql(
          `mutation Seed($key: String!) { insert_orders_one(object: {probe_key: $key, qty: 1, payload: {a: 1}}) { probe_key } }`,
          { key },
        )
        const seedFailure = outcomeFromResult(created)
        if (seedFailure) return seedFailure

        return mutate(
          ctx,
          `mutation Append($key: String!, $patch: jsonb!) {
             update_orders(where: {probe_key: {_eq: $key}}, _append: {payload: $patch}) {
               returning { payload }
             }
           }`,
          { key, patch: { b: 2 } },
          (d) => {
            const payload = d?.update_orders?.returning?.[0]?.payload
            if (!deepEqual(payload, { a: 1, b: 2 })) {
              return `jsonb _append mismatch: ${diffSummary({ a: 1, b: 2 }, payload)}`
            }
            return null
          },
        )
      },
    },

    {
      id: 'm_delete_returning',
      group: 'mutation',
      async run(ctx) {
        const key = ctx.nextKey('del')
        const created = await ctx.admin.graphql(
          `mutation Seed($key: String!) { insert_orders_one(object: {probe_key: $key, qty: 1}) { probe_key } }`,
          { key },
        )
        const seedFailure = outcomeFromResult(created)
        if (seedFailure) return seedFailure

        return mutate(
          ctx,
          `mutation Del($key: String!) {
             delete_orders(where: {probe_key: {_eq: $key}}) { affected_rows returning { probe_key } }
           }`,
          { key },
          (d) => {
            const res = d?.delete_orders
            if (res?.affected_rows !== 1) return `affected_rows was ${res?.affected_rows}, expected 1`
            if (res.returning?.[0]?.probe_key !== key) {
              return `deleted row echoed ${res.returning?.[0]?.probe_key}, expected ${key}`
            }
            return null
          },
        )
      },
    },

    {
      id: 'm_multi_mutation_one_request',
      group: 'mutation',
      async run(ctx) {
        // Two mutations in a single request. Hasura runs them sequentially in
        // one transaction, so either both land or neither does.
        const a = ctx.nextKey('tx-a')
        const b = ctx.nextKey('tx-b')
        return mutate(
          ctx,
          `mutation Both($a: String!, $b: String!) {
             first: insert_orders_one(object: {probe_key: $a, qty: 1}) { probe_key qty }
             second: insert_orders_one(object: {probe_key: $b, qty: 2}) { probe_key qty }
           }`,
          { a, b },
          (d) => {
            if (d?.first?.probe_key !== a) return `first mutation echoed ${d?.first?.probe_key}, expected ${a}`
            if (d?.second?.probe_key !== b) return `second mutation echoed ${d?.second?.probe_key}, expected ${b}`
            if (d?.first?.qty !== 1 || d?.second?.qty !== 2) return 'qty values did not round-trip'
            return null
          },
        )
      },
    },
  ]
}
