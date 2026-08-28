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

  it('detects a short pause as a latency excursion, not as downtime', async () => {
    // A paused container still accepts TCP but never answers, so requests hang
    // for the duration and then complete. With a 10s client timeout, a 2s pause
    // produces no failures at all — it is degradation, not an outage, and the
    // harness must say so rather than inventing downtime that users never saw.
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 30_000, run: (t) => pauseContainer(BLUE_CONTAINER, 2_000, t) }],
    })
    report('TEETH: 2s pause', result)

    const before = result.scorecard.windows.find((w) => w.window.name === 'before')
    expect(before).toBeDefined()

    // Baseline is single-digit milliseconds.
    expect(before!.latency.p99).toBeLessThan(200)

    // The stall is asserted against the OVERALL max rather than the fault
    // window's. A request that starts before the pause and hangs through it is
    // recorded when it completes, which is after `fault.pause.end` — so it lands
    // in the next window, and which window catches it depends on exactly when
    // each probe happened to fire. Overall max is the same measurement without
    // the timing lottery.
    expect(result.scorecard.overall.latency.max).toBeGreaterThan(1_500)

    // And it must NOT be reported as downtime, because nothing actually failed.
    expect(result.scorecard.headline.longestContiguousOutageMs).toBe(0)
    expect(result.scorecard.headline.failedRequests).toBe(0)
  }, 900_000)

  it('detects a pause longer than the client timeout as a sized outage', async () => {
    // Long enough that HAProxy's health check marks blue down (inter 1s, fall 2)
    // and requests start getting 503s, and long enough that hung requests
    // exceed the 10s client timeout. This is the case that IS downtime.
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      faults: [{ atMs: 25_000, run: (t) => pauseContainer(BLUE_CONTAINER, 15_000, t) }],
    })
    report('TEETH: 15s pause', result)

    expect(result.scorecard.overall.byKind.unavailable + result.scorecard.overall.byKind.timeout).toBeGreaterThan(0)
    // Sized, not merely present: a harness reporting "some outage" for both a
    // 2s pause and a 15s one would not be measuring anything useful.
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeGreaterThan(3_000)
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeLessThan(40_000)
  }, 900_000)

  it('detects SIGKILL as unavailability when no proxy is absorbing it', async () => {
    // Targeted directly at the published port. Through HAProxy this fault is
    // invisible: `retry-on conn-failure` retries the refused connections
    // against the restarted container and every request succeeds. That is the
    // proxy working as intended, but it means the proxy must be out of the path
    // for this to test the harness rather than the proxy.
    const result = await runHarness({
      profileName: 'fast',
      policyName: 'informational',
      upgraderName: 'none',
      probeTarget: 'direct-blue',
      faults: [{ atMs: 30_000, run: (t) => killAndRestartBlue(t, cfg.fromVersion) }],
    })
    report('TEETH: SIGKILL (direct)', result)

    expect(result.scorecard.headline.failedRequests).toBeGreaterThan(0)
    expect(result.scorecard.overall.byKind.unavailable).toBeGreaterThan(0)
    expect(result.scorecard.headline.longestContiguousOutageMs).toBeGreaterThan(200)
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
