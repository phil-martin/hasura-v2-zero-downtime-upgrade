import { beforeAll, describe, expect, it } from 'vitest'
import { runHarness } from '../src/runner/index.js'
import { closeAllPools } from '../src/db/pool.js'
import { report, resetStackTo } from './helpers.js'

/**
 * The baseline: no upgrade happens, so nothing at all may go wrong.
 *
 * Run three times consecutively. A harness that is green once but flaky is
 * worse than no harness, because it turns every genuine regression into a
 * shrug — and every later claim in this project rests on the baseline being
 * trustworthy.
 */
describe('baseline — no upgrade', () => {
  beforeAll(async () => {
    await resetStackTo()
  }, 600_000)

  for (const attempt of [1, 2, 3]) {
    it(`is clean under the strict policy (run ${attempt} of 3)`, async () => {
      const result = await runHarness({
        profileName: 'fast',
        policyName: 'strict',
        upgraderName: 'none',
      })
      report(`BASELINE run ${attempt}/3`, result)

      const h = result.scorecard.headline
      expect(h.failedRequests).toBe(0)
      expect(h.incorrectResults).toBe(0)
      expect(h.graphqlErrors).toBe(0)
      expect(h.longestContiguousOutageMs).toBe(0)
      expect(h.lostEvents).toBe(0)
      expect(h.missedSubscriptionRows).toBe(0)
      expect(h.subscriptionDrops).toBe(0)

      // A run that recorded almost nothing could pass every assertion above
      // while proving nothing. Assert the harness actually exercised the system.
      expect(result.scorecard.overall.requests).toBeGreaterThan(2_000)
      expect(result.scorecard.events.expected).toBeGreaterThan(20)
      expect(result.scorecard.seqWritten).toBeGreaterThan(100)
      for (const sub of result.scorecard.subscriptions) {
        expect(sub.updates).toBeGreaterThan(0)
      }

      expect(result.verdict.violations).toEqual([])
      expect(result.verdict.pass).toBe(true)
    }, 900_000)
  }

  it('closes database pools', async () => {
    await closeAllPools()
  })
})
