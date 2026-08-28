import type { Policy } from '../config/index.js'
import type { Scorecard } from './scorecard.js'

export type PolicyVerdict = { policy: string; pass: boolean; violations: string[] }

/**
 * Thresholds are applied to a scorecard rather than baked into assertions.
 *
 * Measurement is primary: a run always produces the full set of numbers. A
 * policy is a separate, named opinion about which of those numbers are allowed
 * to be non-zero, so the bar can be moved without touching test code and the
 * same run can be judged under several bars.
 */
export function evaluatePolicy(policy: Policy, s: Scorecard): PolicyVerdict {
  const violations: string[] = []
  const h = s.headline

  const check = (limit: number | null, actual: number, label: string, unit = '') => {
    if (limit === null) return
    if (actual > limit) violations.push(`${label}: ${actual}${unit} exceeds limit of ${limit}${unit}`)
  }

  check(policy.maxFailedRequests, h.failedRequests, 'failed requests')
  check(policy.maxContiguousOutageMs, h.longestContiguousOutageMs, 'longest contiguous outage', 'ms')
  check(policy.maxIncorrectResults, h.incorrectResults, 'incorrect results')
  check(policy.maxGraphqlErrors, h.graphqlErrors, 'graphql errors')
  check(policy.maxLostEvents, h.lostEvents, 'lost events')
  check(policy.maxMissedSubRows, h.missedSubscriptionRows, 'missed subscription rows')
  check(policy.maxSubscriptionDrops, h.subscriptionDrops, 'subscription drops')
  check(policy.maxReconnectMs, h.maxReconnectMs, 'max subscription reconnect', 'ms')

  // Cron is asserted as a lower bound: a run long enough to cross N minute
  // boundaries must have seen at least N fires.
  if (policy.name !== 'informational' && s.cron.observed < s.cron.expectedAtLeast) {
    violations.push(`cron fires: observed ${s.cron.observed}, expected at least ${s.cron.expectedAtLeast}`)
  }

  // A retry that never lands is silent event loss with extra steps.
  if (policy.maxLostEvents !== null && s.events.retriesLost.length > policy.maxLostEvents) {
    violations.push(`retried events never delivered: ${s.events.retriesLost.length}`)
  }

  return { policy: policy.name, pass: violations.length === 0, violations }
}
