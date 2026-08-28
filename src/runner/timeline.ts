import type { ProbeGroup, ProbeOutcome } from '../probes/types.js'

export type TimelineRecord = { t: number; probeId: string; group: ProbeGroup } & ProbeOutcome

export type Marker = { t: number; name: string; detail?: unknown }

/**
 * The single ordered record of everything that happened during a run.
 *
 * Probe outcomes and orchestrator markers land on the same timeline, which is
 * what lets the report attribute damage to a specific upgrade phase rather than
 * reporting an undifferentiated failure count.
 */
export class Timeline {
  readonly startedAt: number
  private readonly _records: TimelineRecord[] = []
  private readonly _markers: Marker[] = []

  constructor(startedAt: number = Date.now()) {
    this.startedAt = startedAt
  }

  record(entry: { probeId: string; group: ProbeGroup } & ProbeOutcome, t: number = Date.now()): void {
    this._records.push({ t, ...entry })
  }

  marker(name: string, detail?: unknown, t: number = Date.now()): void {
    this._markers.push({ t, name, detail })
  }

  records(): readonly TimelineRecord[] {
    return this._records
  }

  markers(): readonly Marker[] {
    return this._markers
  }

  markerAt(name: string): Marker | undefined {
    return this._markers.find((m) => m.name === name)
  }

  /** Milliseconds since the run started, for human-readable output. */
  rel(t: number): number {
    return t - this.startedAt
  }

  toJSON() {
    return {
      startedAt: this.startedAt,
      records: this._records,
      markers: this._markers,
    }
  }
}
