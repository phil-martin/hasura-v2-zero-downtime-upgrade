import { deepEqual, diffSummary } from '../oracle/canonical.js'
import type { ExpectedMap } from '../oracle/expected.js'
import { DENIAL_SPECS, READ_SPECS, type ClientSpec, type DenialSpec, type ReadSpec } from '../oracle/readSpecs.js'
import { fail, ok, outcomeFromResult, type GqlClient, type Probe, type ProbeCtx } from './types.js'

export function clientFor(ctx: ProbeCtx, spec: ClientSpec): GqlClient {
  if (spec === 'admin') return ctx.admin
  if (spec === 'anon') return ctx.anon
  return ctx.as(spec.role, spec.userId)
}

export async function runRead(ctx: ProbeCtx, spec: ReadSpec) {
  const client = clientFor(ctx, spec.client)
  return spec.restPath ? client.restGet(spec.restPath) : client.graphql(spec.query!, spec.variables)
}

/**
 * Exact-match read probes.
 *
 * `expected` is passed in rather than loaded here so fault-injection tests can
 * deliberately corrupt an expectation and confirm the harness reports
 * `wrong-result`. A harness that cannot be made to fail on demand is not
 * evidence of anything.
 */
export function readProbes(expected: ExpectedMap): Probe[] {
  return READ_SPECS.map((spec): Probe => ({
    id: spec.id,
    group: spec.group,
    async run(ctx) {
      const result = await runRead(ctx, spec)
      const transportFailure = outcomeFromResult(result)
      if (transportFailure) return transportFailure
      if (result.kind !== 'ok') return fail(result.latencyMs, 'unavailable', 'unreachable branch')

      if (!(spec.id in expected)) {
        return fail(result.latencyMs, 'wrong-result', `no expectation captured for ${spec.id}`)
      }
      if (!deepEqual(expected[spec.id], result.data)) {
        return fail(result.latencyMs, 'wrong-result', diffSummary(expected[spec.id], result.data))
      }
      return ok(result.latencyMs)
    },
  }))
}

/** Probes whose success condition is receiving a specific permission error. */
export function denialProbes(): Probe[] {
  return DENIAL_SPECS.map((spec: DenialSpec): Probe => ({
    id: spec.id,
    group: spec.group,
    async run(ctx) {
      const client = clientFor(ctx, spec.client)
      const result = await client.graphql(spec.query)

      // Transport failures are still failures here. Only a genuine
      // graphql-error carrying the right message counts as success.
      if (result.kind === 'unavailable') return fail(result.latencyMs, 'unavailable', result.detail)
      if (result.kind === 'timeout') return fail(result.latencyMs, 'timeout', result.detail)

      if (result.kind === 'ok') {
        return fail(
          result.latencyMs,
          'wrong-result',
          `expected permission denial containing "${spec.expectErrorContains}" but the query succeeded — permissions may have silently widened`,
        )
      }

      const text = JSON.stringify(result.errors)
      if (!text.includes(spec.expectErrorContains)) {
        return fail(
          result.latencyMs,
          'wrong-result',
          `expected error containing "${spec.expectErrorContains}", got ${text.slice(0, 300)}`,
        )
      }
      return ok(result.latencyMs)
    },
  }))
}
