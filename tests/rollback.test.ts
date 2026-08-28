import { beforeAll, describe, expect, it } from 'vitest'
import { runHarness } from '../src/runner/index.js'
import { cfg, PROFILES } from '../src/config/index.js'
import { BLUE_CONTAINER, containerRunning, currentImage } from '../src/stack/index.js'
import { BACKEND, BLUE, HaproxyClient } from '../src/haproxy/client.js'
import { report, resetStackTo } from './helpers.js'

/**
 * Upgrade, then roll back, in one continuous run with probes never stopping.
 *
 * Confidence in an upgrade process is not that upgrades succeed — it is that
 * failures are recoverable. Rollback was designed for from the start but is
 * only actually *tested* here, which is what the timed-action schedule and the
 * longer profile exist to make possible.
 */
describe('rollback after a zero-downtime upgrade', () => {
  beforeAll(async () => {
    await resetStackTo(cfg.fromVersion)
  }, 600_000)

  it('returns to the old version without downtime or data loss', async () => {
    // A shortened soak: long enough to contain an upgrade, a settle, and a
    // rollback, without a 20-minute test.
    const profileName = 'rollback-test'
    PROFILES[profileName] = {
      name: profileName,
      durationMs: 420_000,
      schedule: [
        { atMs: 90_000, action: 'upgrade' },
        { atMs: 270_000, action: 'rollback' },
      ],
      settleMs: 40_000,
    }

    const result = await runHarness({
      profileName,
      policyName: 'zero-downtime',
      upgraderName: 'zero-downtime',
    })
    report('UPGRADE THEN ROLLBACK', result)

    const markers = result.scorecard.markers.map((m) => m.name)
    expect(markers).toContain('upgrade.end')
    expect(markers).toContain('rollback.start')
    expect(markers).toContain('rollback.end')

    // Back on the original version, serving from the metadata database that was
    // never migrated.
    expect(await containerRunning(BLUE_CONTAINER)).toBe(true)
    expect(await currentImage(BLUE_CONTAINER)).toBe(`hasura/graphql-engine:${cfg.fromVersion}`)

    const hap = new HaproxyClient(cfg.haproxyHost, cfg.haproxyPort)
    const blue = (await hap.showStat()).find((s) => s.pxname === BACKEND && s.svname === BLUE)
    expect(blue?.status).toMatch(/^UP/)

    const h = result.scorecard.headline
    expect(h.failedRequests).toBe(0)
    expect(h.longestContiguousOutageMs).toBe(0)
    expect(h.incorrectResults).toBe(0)
    expect(h.lostEvents).toBe(0)
    expect(h.missedSubscriptionRows).toBe(0)

    // Both windows must be individually clean, not merely clean on average.
    const upgrade = result.scorecard.windows.find((w) => w.window.name === 'upgrade')
    const rollback = result.scorecard.windows.find((w) => w.window.name === 'rollback')
    expect(upgrade?.failures).toBe(0)
    expect(rollback?.failures).toBe(0)

    expect(result.verdict.pass).toBe(true)
  }, 1_800_000)
})
