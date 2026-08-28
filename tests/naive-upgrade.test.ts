import { beforeAll, describe, expect, it } from 'vitest'
import { runHarness } from '../src/runner/index.js'
import { cfg } from '../src/config/index.js'
import { BLUE_CONTAINER, currentImage } from '../src/stack/index.js'
import { report, resetStackTo } from './helpers.js'

/**
 * The red baseline.
 *
 * This test does not merely assert "the naive upgrade failed". It asserts the
 * measured damage EXCEEDS a floor. The distinction matters: if the naive path's
 * damage ever drops below this floor, either the harness has lost its detection
 * power or something changed underneath us — and in both cases we want to be
 * told, rather than quietly losing the red baseline that gives every green
 * result its meaning.
 */
describe('naive upgrade — stop, retag, start', () => {
  beforeAll(async () => {
    await resetStackTo(cfg.fromVersion)
  }, 600_000)

  it('causes measurable downtime that exceeds the detection floor', async () => {
    const result = await runHarness({
      profileName: 'default',
      policyName: 'strict',
      upgraderName: 'naive',
      // Model what a community deployment actually looks like today: Hasura's
      // port published straight to the host. Measuring the naive upgrade from
      // behind HAProxy would measure it through the very component that is part
      // of the fix, and the proxy's conn-failure retry would absorb the gap.
      probeTarget: 'direct-blue',
    })
    report('NAIVE UPGRADE', result)

    const h = result.scorecard.headline

    // The upgrade must actually have happened, or this measures nothing.
    expect(await currentImage(BLUE_CONTAINER)).toBe(`hasura/graphql-engine:${cfg.toVersion}`)
    expect(result.scorecard.markers.map((m) => m.name)).toContain('upgrade.end')

    // Damage floor.
    expect(h.longestContiguousOutageMs).toBeGreaterThan(2_000)
    expect(h.failedRequests).toBeGreaterThan(0)
    expect(result.scorecard.overall.byKind.unavailable).toBeGreaterThan(0)

    // Subscriptions cannot survive the process being replaced.
    expect(h.subscriptionDrops).toBeGreaterThan(0)

    // The damage must land inside the upgrade window, not be smeared across
    // the run. If it were, the window derivation would be broken.
    const upgradeWindow = result.scorecard.windows.find((w) => w.window.name === 'upgrade')
    expect(upgradeWindow).toBeDefined()
    expect(upgradeWindow!.failures).toBeGreaterThan(0)

    // The quiet window before the upgrade must be clean, proving the failures
    // are caused by the upgrade rather than by an unhealthy stack.
    const before = result.scorecard.windows.find((w) => w.window.name === 'before')
    expect(before).toBeDefined()
    expect(before!.failures).toBe(0)

    expect(result.verdict.pass).toBe(false)
  }, 1_200_000)
})
