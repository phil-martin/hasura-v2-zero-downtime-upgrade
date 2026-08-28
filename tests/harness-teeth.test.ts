import { beforeAll, describe, expect, it } from 'vitest'
import { runHarness } from '../src/runner/index.js'
import { cfg } from '../src/config/index.js'
import { BLUE_CONTAINER } from '../src/stack/index.js'
import { killAndRestartBlue, pauseContainer, rejectAllEvents, severSubscriptions } from '../src/faults/index.js'
import { report, resetStackTo } from './helpers.js'

/**
 * Does the harness actually have teeth?
 *
 * Until these pass, a green result from this harness means nothing: an
 * instrument that has never been observed responding to a known input is not
 * evidence. Each test injects a fault with a known signature and asserts the
 * harness reports that specific signature — not merely "something failed".
 *
 * These are the mutation tests of the project.
 */
describe('harness teeth — injected faults must be detected', () => {
  beforeAll(async () => {
    await resetStackTo(cfg.fromVersion)
  }, 600_000)

  it('detects a 2-second pause as unavailability, sized correctly', async () => {
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 30_000, run: (t) => pauseContainer(BLUE_CONTAINER, 2_000, t) }],
    })
    report('TEETH: 2s pause', result)

    expect(result.scorecard.overall.byKind.unavailable + result.scorecard.overall.byKind.timeout).toBeGreaterThan(0)
    // Sized, not just present: a harness that reports "some outage" for a 2s
    // pause and also for a 60s one is not measuring anything useful.
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeGreaterThan(1_000)
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeLessThan(30_000)
  }, 900_000)

  it('detects SIGKILL as unavailability and drops subscriptions', async () => {
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 30_000, run: (t) => killAndRestartBlue(t, cfg.fromVersion) }],
    })
    report('TEETH: SIGKILL', result)

    expect(result.scorecard.headline.failedRequests).toBeGreaterThan(0)
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeGreaterThan(2_000)
    expect(result.scorecard.headline.subscriptionDrops).toBeGreaterThan(0)
  }, 900_000)

  it('detects a corrupted expectation as a wrong result, not as downtime', async () => {
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      // Deliberately wrong: the real query returns five books.
      expectedOverrides: { q_simple_select: { books: [] } },
    })
    report('TEETH: corrupted expectation', result)

    expect(result.scorecard.headline.incorrectResults).toBeGreaterThan(0)
    // Crucially, silent corruption must NOT be reported as downtime. If these
    // were conflated the harness could not tell a broken upgrade from a slow
    // one.
    expect(result.scorecard.headline.longestContiguousOutageMs).toBe(0)
    expect(result.scorecard.overall.byKind.unavailable).toBe(0)
  }, 900_000)

  it('detects permanently lost events when deliveries exhaust their retries', async () => {
    // The trigger retries 3 times at 5s intervals, so rejecting for 40s
    // guarantees some events exhaust their budget and are lost for good.
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 20_000, run: (t) => rejectAllEvents(40_000, t) }],
    })
    report('TEETH: event loss', result)

    expect(result.scorecard.events.expected).toBeGreaterThan(0)
    expect(result.scorecard.headline.lostEvents).toBeGreaterThan(0)
  }, 900_000)

  it('detects severed websockets as subscription drops with a reconnect', async () => {
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 30_000, run: (t) => severSubscriptions(t) }],
    })
    report('TEETH: severed websockets', result)

    expect(result.scorecard.headline.subscriptionDrops).toBeGreaterThan(0)
    expect(result.scorecard.headline.maxReconnectMs).toBeGreaterThan(0)

    // The streaming subscription must resume its cursor and back-fill. The
    // writer keeps committing rows directly to Postgres throughout the outage,
    // so anything genuinely missed would show up here.
    const streaming = result.scorecard.subscriptions.find((s) => s.id === 's_streaming_cursor')
    expect(streaming).toBeDefined()
    expect(streaming!.maxSeqSeen).toBeGreaterThan(0)
  }, 900_000)
})
