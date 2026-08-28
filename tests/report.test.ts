import { describe, expect, it } from 'vitest'
import { deriveWindows } from '../src/report/windows.js'
import { longestContiguousOutage, scoreWindow } from '../src/report/scorecard.js'
import type { TimelineRecord } from '../src/runner/timeline.js'
import type { Marker } from '../src/runner/timeline.js'

const good = (t: number): TimelineRecord => ({ t, probeId: 'p', group: 'query', ok: true, latencyMs: 5 })
const down = (t: number): TimelineRecord => ({
  t,
  probeId: 'p',
  group: 'query',
  ok: false,
  latencyMs: 5,
  kind: 'unavailable',
  detail: 'ECONNREFUSED',
})
const wrong = (t: number): TimelineRecord => ({
  t,
  probeId: 'p',
  group: 'query',
  ok: false,
  latencyMs: 5,
  kind: 'wrong-result',
  detail: 'mismatch',
})

describe('longestContiguousOutage', () => {
  it('is zero when everything succeeds', () => {
    expect(longestContiguousOutage([good(0), good(100), good(200)])).toBe(0)
  })

  it('measures the gap between the successes bounding a failure run', () => {
    // success at 0, failures through 1900, success again at 2000
    const records = [good(0), down(100), down(1000), down(1900), good(2000)]
    expect(longestContiguousOutage(records)).toBe(2000)
  })

  it('does not count correctness failures as downtime', () => {
    // The server answered promptly, it just answered wrongly. Counting this as
    // downtime would conflate two very different defects.
    const records = [good(0), wrong(100), wrong(1900), good(2000)]
    expect(longestContiguousOutage(records)).toBe(0)
  })

  it('counts an outage still open when the run ended', () => {
    const records = [good(0), down(500), down(3000)]
    expect(longestContiguousOutage(records)).toBe(3000)
  })

  it('reports the worst outage, not the last', () => {
    const records = [good(0), down(100), good(500), good(1000), down(1100), good(5000)]
    expect(longestContiguousOutage(records)).toBe(4000)
  })
})

describe('rate versus shape', () => {
  /**
   * This is the case that motivated recording peaks alongside rates. Both
   * timelines have an identical failure rate; only one of them is downtime.
   */
  it('distinguishes evenly-spread flakiness from one solid outage at equal rate', () => {
    const window = { name: 'w', startMs: 0, endMs: 20_000, kind: 'quiet' as const }

    // 100 records, 10 failures spread one per second.
    const spread: TimelineRecord[] = []
    for (let i = 0; i < 100; i++) spread.push(i % 10 === 5 ? down(i * 100) : good(i * 100))

    // 100 records, 10 failures in one contiguous block.
    const block: TimelineRecord[] = []
    for (let i = 0; i < 100; i++) block.push(i >= 40 && i < 50 ? down(i * 100) : good(i * 100))

    const a = scoreWindow(window, spread)
    const b = scoreWindow(window, block)

    expect(a.failureRate).toBeCloseTo(b.failureRate, 10)
    expect(a.failures).toBe(b.failures)
    // Identical rates, very different outages.
    expect(a.longestContiguousOutageMs).toBeLessThan(300)
    expect(b.longestContiguousOutageMs).toBeGreaterThanOrEqual(1000)
  })
})

describe('deriveWindows', () => {
  const m = (name: string, t: number): Marker => ({ t, name })

  it('treats a run with no actions as a single quiet window', () => {
    const windows = deriveWindows([m('run.start', 0), m('run.end', 1000)], 0, 1000)
    expect(windows).toEqual([{ name: 'whole-run', startMs: 0, endMs: 1000, kind: 'quiet' }])
  })

  it('does not treat run.start as an orchestrator action', () => {
    // Regression: `run.start` matches the `*.start` convention and previously
    // swallowed the entire run into one action window.
    const windows = deriveWindows([m('run.start', 0), m('run.end', 5000)], 0, 5000)
    expect(windows.every((w) => w.kind === 'quiet')).toBe(true)
  })

  it('splits before, during, and after an upgrade', () => {
    const markers = [m('run.start', 0), m('upgrade.start', 1000), m('upgrade.end', 3000), m('run.end', 5000)]
    const windows = deriveWindows(markers, 0, 5000)
    expect(windows.map((w) => [w.name, w.kind, w.startMs, w.endMs])).toEqual([
      ['before', 'quiet', 0, 1000],
      ['upgrade', 'action', 1000, 3000],
      ['after', 'quiet', 3000, 5000],
    ])
  })

  it('handles an upgrade followed by a rollback in one run', () => {
    const markers = [
      m('upgrade.start', 1000),
      m('upgrade.end', 2000),
      m('rollback.start', 4000),
      m('rollback.end', 4500),
    ]
    const windows = deriveWindows(markers, 0, 6000)
    expect(windows.map((w) => w.name)).toEqual(['before', 'upgrade', 'between-1', 'rollback', 'after'])
  })

  it('closes an aborted action window at the abort marker', () => {
    const markers = [m('upgrade.start', 1000), m('upgrade.aborted', 1500)]
    const windows = deriveWindows(markers, 0, 3000)
    const upgrade = windows.find((w) => w.name === 'upgrade')
    expect(upgrade).toMatchObject({ startMs: 1000, endMs: 1500, kind: 'action' })
  })
})
