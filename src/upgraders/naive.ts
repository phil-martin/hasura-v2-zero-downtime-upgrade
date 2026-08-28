import { cfg } from '../config/index.js'
import { adminClient, compose, versionEnv } from '../stack/index.js'
import { waitHealthy } from '../hasura/client.js'
import type { Upgrader } from './types.js'

/**
 * The red baseline: what a community deployment actually does today.
 *
 * Stop the container, point it at the new image, start it again. It never
 * touches green — using blue/green here would be cheating the baseline, and the
 * whole point is to measure the damage the obvious approach causes.
 *
 * Expected damage is the sum of graceful-shutdown time, image start time, and
 * catalog migration time, during all of which there is no server to answer.
 */
export const naiveUpgrader: Upgrader = {
  name: 'naive',

  async upgrade(ctx) {
    ctx.timeline.marker('upgrade.start', { strategy: 'naive', to: cfg.toVersion })

    const stopStarted = Date.now()
    ctx.log('naive: stopping hasura-blue')
    await compose(['stop', 'hasura-blue'], versionEnv({ blueMetadataDb: cfg.metadataDb }), 180_000)
    ctx.timeline.marker('naive.stopped', { ms: Date.now() - stopStarted })

    ctx.log(`naive: recreating hasura-blue on ${cfg.toVersion}`)
    const startStarted = Date.now()
    await compose(
      ['up', '-d', '--no-deps', 'hasura-blue'],
      versionEnv({ blueVersion: cfg.toVersion, blueMetadataDb: cfg.metadataDb }),
      300_000,
    )
    ctx.timeline.marker('naive.started', { ms: Date.now() - startStarted })

    ctx.log('naive: waiting for health')
    const healthStarted = Date.now()
    await waitHealthy(adminClient(cfg.blueDirectUrl), 300_000)
    ctx.timeline.marker('naive.healthy', { ms: Date.now() - healthStarted })

    ctx.timeline.marker('upgrade.end', { strategy: 'naive', totalMs: Date.now() - stopStarted })
  },

  async rollback(ctx) {
    ctx.timeline.marker('rollback.start', { strategy: 'naive', to: cfg.fromVersion })
    await compose(['stop', 'hasura-blue'], versionEnv({ blueMetadataDb: cfg.metadataDb }), 180_000)
    await compose(
      ['up', '-d', '--no-deps', 'hasura-blue'],
      versionEnv({ blueVersion: cfg.fromVersion, blueMetadataDb: cfg.metadataDb }),
      300_000,
    )
    await waitHealthy(adminClient(cfg.blueDirectUrl), 300_000)
    ctx.timeline.marker('rollback.end', { strategy: 'naive' })
  },
}
