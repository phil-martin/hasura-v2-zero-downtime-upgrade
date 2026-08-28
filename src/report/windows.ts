import type { Marker } from '../runner/timeline.js'

export type Window = {
  name: string
  startMs: number
  endMs: number
  kind: 'quiet' | 'action'
}

/**
 * Derive measurement windows from the marker timeline.
 *
 * Windows are not hardcoded phases. Each orchestrator action contributes a
 * window bounded by its own markers, and the stretches between actions become
 * quiet windows. This falls out of treating the upgrade trigger as a schedule
 * of timed actions rather than a single point, and it is what makes an
 * upgrade-then-rollback run measurable without special-casing.
 *
 * Rates must be reported per window. Across a whole run the denominator hides
 * everything: an 8-second outage inside a 5-minute run is ~2.6% of requests,
 * which reads as almost fine.
 */
export function deriveWindows(markers: readonly Marker[], runStart: number, runEnd: number): Window[] {
  const starts = markers
    .filter((m) => m.name.endsWith('.start'))
    .map((m) => ({ prefix: m.name.slice(0, -'.start'.length), t: m.t }))
    // `run.start`/`run.end` bound the whole run rather than an orchestrator
    // action; treating them as an action would collapse every window into one.
    .filter((s) => s.prefix !== 'run')
    .sort((a, b) => a.t - b.t)

  const actions: Window[] = []
  for (const s of starts) {
    const terminator = markers.find(
      (m) => m.t >= s.t && (m.name === `${s.prefix}.end` || m.name === `${s.prefix}.aborted`),
    )
    actions.push({
      name: s.prefix,
      startMs: s.t,
      endMs: terminator?.t ?? runEnd,
      kind: 'action',
    })
  }

  const windows: Window[] = []
  let cursor = runStart
  for (const [i, action] of actions.entries()) {
    if (action.startMs > cursor) {
      windows.push({
        name: i === 0 ? 'before' : `between-${i}`,
        startMs: cursor,
        endMs: action.startMs,
        kind: 'quiet',
      })
    }
    windows.push(action)
    cursor = Math.max(cursor, action.endMs)
  }
  if (runEnd > cursor) {
    windows.push({
      name: actions.length === 0 ? 'whole-run' : 'after',
      startMs: cursor,
      endMs: runEnd,
      kind: 'quiet',
    })
  }
  return windows
}
