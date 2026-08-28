/**
 * How a probe can fail.
 *
 * These are kept distinct because they point at completely different bugs and
 * blurring them would destroy the harness's diagnostic value:
 *
 *   unavailable   - the request never got a usable answer. This is downtime.
 *   timeout       - a response was expected but never arrived in budget.
 *   graphql-error - a well-formed response carrying `errors`. The server was
 *                   up; something about the request or schema was wrong.
 *   wrong-result  - HTTP 200, no errors, and the data does not match what the
 *                   oracle knows to be true. The worst kind: silent corruption.
 */
export type FailureKind = 'unavailable' | 'graphql-error' | 'wrong-result' | 'timeout'

export type ProbeGroup =
  | 'query'
  | 'mutation'
  | 'rbac'
  | 'subscription'
  | 'event'
  | 'cron'
  | 'action'
  | 'remote'
  | 'rest'

export type ProbeOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; kind: FailureKind; detail: string }

export interface Probe {
  id: string
  group: ProbeGroup
  run(ctx: ProbeCtx): Promise<ProbeOutcome>
}

export interface ProbeCtx {
  /** Admin-role client pointed at HAProxy. */
  admin: GqlClient
  /** Client for a named role, with session variables. */
  as(role: string, userId?: number): GqlClient
  /** Unauthenticated client, which Hasura maps to the `anonymous` role. */
  anon: GqlClient
  sidecarUrl: string
  /** Monotonic counter for generating unique probe keys within a run. */
  nextKey(prefix: string): string
  /**
   * Records a mutation probe key that should produce an event delivery.
   * Reconciled after a settle window rather than immediately, because graceful
   * shutdown marks unfinished events pending rather than dropping them.
   */
  expectEvent(probeKey: string, trigger: string, forcedRetry: boolean): void
}

/** Minimal surface probes need; implemented by HasuraClient. */
export interface GqlClient {
  graphql(query: string, variables?: Record<string, unknown>): Promise<GqlResult>
  restGet(path: string): Promise<GqlResult>
}

export type GqlResult =
  | { kind: 'ok'; data: unknown; status: number; latencyMs: number }
  | { kind: 'unavailable'; detail: string; status: number | null; latencyMs: number }
  | { kind: 'graphql-error'; errors: unknown; status: number; latencyMs: number }
  | { kind: 'timeout'; detail: string; latencyMs: number }

export const ok = (latencyMs: number): ProbeOutcome => ({ ok: true, latencyMs })

export const fail = (latencyMs: number, kind: FailureKind, detail: string): ProbeOutcome => ({
  ok: false,
  latencyMs,
  kind,
  detail,
})

/**
 * Maps a transport-level result onto a probe outcome. Probes call this for the
 * non-`ok` cases and do their own comparison for `ok`.
 */
export function outcomeFromResult(r: GqlResult): ProbeOutcome | null {
  switch (r.kind) {
    case 'ok':
      return null
    case 'unavailable':
      return fail(r.latencyMs, 'unavailable', r.detail)
    case 'timeout':
      return fail(r.latencyMs, 'timeout', r.detail)
    case 'graphql-error':
      return fail(r.latencyMs, 'graphql-error', JSON.stringify(r.errors).slice(0, 500))
  }
}
