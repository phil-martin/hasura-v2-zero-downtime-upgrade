import type { TimelineRecord } from '../runner/timeline.js'
import type { FailureKind } from '../probes/types.js'
import type { Window } from './windows.js'
import type { EventReconciliation } from '../probes/events.js'
import type { CronReconciliation } from '../probes/cron.js'

export type LatencyStats = { p50: number; p95: number; p99: number; max: number }

export type WindowScore = {
  window: Window
  durationMs: number
  requests: number
  failures: number
  failureRate: number
  byKind: Record<FailureKind, number>
  /**
   * Longest stretch with no successful response, bounded by successes either
   * side, that contains at least one failure. This is the downtime number.
   * Failure *rate* cannot distinguish 2% spread evenly (flakiness) from 2% in
   * one solid block (an outage); this can.
   */
  longestContiguousOutageMs: number
  /** Worst single one-second bucket, by failure count. */
  worstSecondFailures: number
  latency: LatencyStats
}

export type SubscriptionScore = {
  id: string
  drops: number
  reconnectMs: number[]
  maxReconnectMs: number
  updates: number
  missedRows: number
  missedRate: number
  maxSeqSeen: number
}

export type Scorecard = {
  profile: string
  upgrader: string
  fromVersion: string
  toVersion: string
  runStart: number
  runEnd: number
  windows: WindowScore[]
  overall: WindowScore
  subscriptions: SubscriptionScore[]
  events: EventReconciliation
  cron: CronReconciliation
  seqWritten: number
  seqWriteFailures: number
  markers: Array<{ name: string; atMs: number; detail?: unknown }>
  headline: {
    longestContiguousOutageMs: number
    failedRequests: number
    incorrectResults: number
    graphqlErrors: number
    lostEvents: number
    missedSubscriptionRows: number
    subscriptionDrops: number
    maxReconnectMs: number
  }
}

const EMPTY_KINDS = (): Record<FailureKind, number> => ({
  unavailable: 0,
  'graphql-error': 0,
  'wrong-result': 0,
  timeout: 0,
})

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[idx]! * 100) / 100
}

/**
 * Longest interval between two consecutive successful responses that contains
 * at least one failure.
 *
 * Bounding on successes rather than counting failure runs is what makes this
 * meaningful: it measures wall-clock time during which the service was not
 * usefully answering, which is what "downtime" means to a user. A gap with no
 * failure in it is just a quiet period and is not counted.
 */
export function longestContiguousOutage(records: TimelineRecord[]): number {
  const sorted = [...records].sort((a, b) => a.t - b.t)
  let worst = 0
  let lastSuccessAt: number | null = null
  let failuresSinceSuccess = 0
  let firstFailureAt: number | null = null

  for (const r of sorted) {
    if (r.ok) {
      if (failuresSinceSuccess > 0) {
        const from = lastSuccessAt ?? firstFailureAt!
        worst = Math.max(worst, r.t - from)
      }
      lastSuccessAt = r.t
      failuresSinceSuccess = 0
      firstFailureAt = null
    } else {
      // Correctness failures are not outages: the service answered promptly, it
      // just answered wrongly. Counting them here would inflate downtime.
      if (r.kind === 'unavailable' || r.kind === 'timeout') {
        failuresSinceSuccess++
        if (firstFailureAt === null) firstFailureAt = r.t
      }
    }
  }
  // An outage still open when the run ended still counts, measured to the last
  // observation rather than silently dropped.
  if (failuresSinceSuccess > 0 && sorted.length > 0) {
    const from = lastSuccessAt ?? firstFailureAt!
    worst = Math.max(worst, sorted[sorted.length - 1]!.t - from)
  }
  return Math.round(worst)
}

function worstSecondBucket(records: TimelineRecord[]): number {
  const buckets = new Map<number, number>()
  for (const r of records) {
    if (r.ok) continue
    if (r.kind !== 'unavailable' && r.kind !== 'timeout') continue
    const bucket = Math.floor(r.t / 1000)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  let worst = 0
  for (const n of buckets.values()) worst = Math.max(worst, n)
  return worst
}

export function scoreWindow(window: Window, all: readonly TimelineRecord[]): WindowScore {
  const records = all.filter((r) => r.t >= window.startMs && r.t < window.endMs)
  const byKind = EMPTY_KINDS()
  let failures = 0
  const latencies: number[] = []

  for (const r of records) {
    latencies.push(r.latencyMs)
    if (!r.ok) {
      failures++
      byKind[r.kind]++
    }
  }
  latencies.sort((a, b) => a - b)

  return {
    window,
    durationMs: window.endMs - window.startMs,
    requests: records.length,
    failures,
    failureRate: records.length === 0 ? 0 : failures / records.length,
    byKind,
    longestContiguousOutageMs: longestContiguousOutage(records),
    worstSecondFailures: worstSecondBucket(records),
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length > 0 ? Math.round(latencies[latencies.length - 1]! * 100) / 100 : 0,
    },
  }
}
