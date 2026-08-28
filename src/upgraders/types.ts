import type { Timeline } from '../runner/timeline.js'

export type UpgradeContext = {
  timeline: Timeline
  log(msg: string): void
}

/**
 * An upgrade strategy.
 *
 * Both strategies emit markers onto the same timeline the probes write to,
 * which is what lets the report attribute damage to a specific phase rather
 * than reporting an undifferentiated failure count.
 */
export interface Upgrader {
  name: string
  upgrade(ctx: UpgradeContext): Promise<void>
  rollback(ctx: UpgradeContext): Promise<void>
}

export const noopUpgrader: Upgrader = {
  name: 'none',
  async upgrade() {
    /* baseline runs perform no upgrade at all */
  },
  async rollback() {},
}
