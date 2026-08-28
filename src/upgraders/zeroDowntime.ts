import { cfg } from '../config/index.js'
import { waitHealthy } from '../hasura/client.js'
import { BACKEND, BLUE, GREEN, HaproxyClient } from '../haproxy/client.js'
import {
  BLUE_CONTAINER,
  adminClient,
  cloneMetadataDb,
  compose,
  containerEnvVar,
  containerRunning,
  dbNameFromUrl,
  dropDatabase,
  versionEnv,
} from '../stack/index.js'
import type { Upgrader, UpgradeContext } from './types.js'
import { verifyEngine } from './verify.js'

/** Milliseconds to keep a draining server serving its existing connections. */
const DRAIN_TIMEOUT_MS = 30_000

type UpgradeState = {
  originalMetadataDb: string
  cloneDb: string
  blueStopped: boolean
}

// Module-scoped because a run performs at most one upgrade, and rollback needs
// to know what the upgrade did. Nothing here is persisted: on a fresh process
// the orchestrator rediscovers reality from the running containers.
let state: UpgradeState | null = null

const haproxy = () => new HaproxyClient(cfg.haproxyHost, cfg.haproxyPort)

/**
 * Blue/green upgrade with an observable drain and a correctness gate.
 *
 * Green boots against a *clone* of the metadata database, so green's catalog
 * migration never touches the database blue is serving from. That is what makes
 * rollback cheap: blue's metadata is byte-for-byte what it was before, so
 * reverting is a proxy state change rather than a database repair.
 *
 * The clone is a copy rather than a fresh database on purpose. Hasura
 * pre-generates future cron events into hdb_cron_events in the metadata store;
 * starting green empty would silently discard every scheduled event.
 */
export const zeroDowntimeUpgrader: Upgrader = {
  name: 'zero-downtime',

  async upgrade(ctx: UpgradeContext) {
    const started = Date.now()
    ctx.timeline.marker('upgrade.start', { strategy: 'zero-downtime', to: cfg.toVersion })
    const hap = haproxy()

    // --- 1. Pre-flight on blue --------------------------------------------
    const blue = adminClient(cfg.blueDirectUrl)
    const blueVersion = await blue.version()
    const before = await blue.exportMetadata()
    const blueInconsistent = await blue.inconsistentMetadata()
    if (blueInconsistent.length > 0) {
      // Refuse to upgrade from a broken starting point: we would not be able to
      // tell our damage from the damage already there.
      ctx.timeline.marker('upgrade.aborted', {
        stage: 'preflight-blue',
        reason: 'blue metadata is already inconsistent',
        inconsistent: blueInconsistent.length,
      })
      throw new Error('aborting upgrade: blue metadata is already inconsistent')
    }
    ctx.timeline.marker('preflight.blue.ok', {
      blueVersion,
      resourceVersion: before.resourceVersion,
    })

    // --- 2. Clone the metadata database ------------------------------------
    const originalMetadataDb =
      dbNameFromUrl(await containerEnvVar(BLUE_CONTAINER, 'HASURA_GRAPHQL_METADATA_DATABASE_URL')) ?? cfg.metadataDb
    const cloneDb = `hasura_metadata_${Date.now().toString(36)}`
    ctx.log(`cloning metadata ${originalMetadataDb} → ${cloneDb}`)
    const clone = await cloneMetadataDb(originalMetadataDb, cloneDb)
    ctx.timeline.marker('metadata.cloned', {
      from: originalMetadataDb,
      to: cloneDb,
      ms: clone.ms,
      cronEventsPreserved: clone.rows,
    })
    state = { originalMetadataDb, cloneDb, blueStopped: false }

    // --- 3. Boot green against the clone -----------------------------------
    ctx.log(`starting green on ${cfg.toVersion} against ${cloneDb}`)
    const bootStarted = Date.now()
    await compose(
      ['--profile', 'green', 'up', '-d', '--no-deps', 'hasura-green'],
      versionEnv({ greenVersion: cfg.toVersion, greenMetadataDb: cloneDb }),
      300_000,
    )
    const green = adminClient(cfg.greenDirectUrl)
    await waitHealthy(green, 300_000)
    ctx.timeline.marker('green.ready', { ms: Date.now() - bootStarted })

    // --- 4. Gate on green ---------------------------------------------------
    const abort = async (stage: string, reason: string, detail?: unknown) => {
      ctx.log(`ABORTING at ${stage}: ${reason}`)
      await compose(['--profile', 'green', 'stop', 'hasura-green'], versionEnv({}), 180_000).catch(() => {})
      await compose(['--profile', 'green', 'rm', '-f', 'hasura-green'], versionEnv({}), 120_000).catch(() => {})
      await dropDatabase(cloneDb).catch(() => {})
      state = null
      ctx.timeline.marker('upgrade.aborted', { stage, reason, detail })
      throw new Error(`upgrade aborted at ${stage}: ${reason}`)
    }

    const greenVersion = await green.version()
    if (greenVersion !== cfg.toVersion) {
      await abort('gate-version', `green reports ${greenVersion}, expected ${cfg.toVersion}`)
    }

    const greenInconsistent = await green.inconsistentMetadata()
    if (greenInconsistent.length > 0) {
      await abort('gate-metadata', `new version rejected ${greenInconsistent.length} metadata object(s)`, greenInconsistent)
    }

    ctx.log('verifying correctness on green before switching any traffic')
    const verifyStarted = Date.now()
    const verification = await verifyEngine(cfg.greenDirectUrl)
    if (!verification.ok) {
      await abort('gate-verify', `${verification.failures.length}/${verification.ran} probes failed on green`, verification.failures.slice(0, 10))
    }
    ctx.timeline.marker('green.verified', {
      probes: verification.ran,
      ms: Date.now() - verifyStarted,
    })

    // --- 5. Switch traffic --------------------------------------------------
    // Green becomes ready BEFORE blue starts draining, so there is never an
    // instant with no ready backend.
    await hap.setServerState(BACKEND, GREEN, 'ready')
    const greenStatus = await hap.waitServerStatus(BACKEND, GREEN, (s) => s.startsWith('UP'), 60_000)
    await hap.setServerState(BACKEND, BLUE, 'drain')
    ctx.timeline.marker('traffic.switch', { greenStatus })

    // --- 6. Drain blue ------------------------------------------------------
    // Websocket subscriptions hold their sessions, so this is where the
    // reconnect budget is spent. A residual count is a measurement, not an
    // error: it is recorded and the upgrade proceeds.
    const drain = await hap.waitDrained(BACKEND, BLUE, DRAIN_TIMEOUT_MS)
    ctx.timeline.marker('drain.complete', drain)

    // --- 7. Stop blue -------------------------------------------------------
    ctx.log('stopping blue with full graceful-shutdown grace period')
    const stopStarted = Date.now()
    await compose(['stop', 'hasura-blue'], versionEnv({ blueMetadataDb: originalMetadataDb }), 180_000)
    state.blueStopped = true
    ctx.timeline.marker('blue.stopped', { ms: Date.now() - stopStarted })

    // --- 8. Post-conditions -------------------------------------------------
    const after = await green.exportMetadata()
    if (after.resourceVersion !== before.resourceVersion) {
      // Metadata changed underneath the upgrade. Not fatal, but it invalidates
      // the assumption the clone was based on, so it must be visible.
      ctx.timeline.marker('metadata.drift', {
        before: before.resourceVersion,
        after: after.resourceVersion,
      })
    }
    const stats = await hap.showStat()
    const greenStat = stats.find((s) => s.pxname === BACKEND && s.svname === GREEN)

    ctx.timeline.marker('upgrade.end', {
      strategy: 'zero-downtime',
      totalMs: Date.now() - started,
      canonicalMetadataDb: cloneDb,
      greenStatus: greenStat?.status,
    })
  },

  /**
   * Rollback.
   *
   * Before blue is stopped this is only a proxy state change, because blue's
   * metadata database was never migrated. After blue is stopped it is a restart
   * against that same untouched database. Either way the pre-upgrade state is
   * still on disk; nothing needs repairing.
   */
  async rollback(ctx: UpgradeContext) {
    const started = Date.now()
    ctx.timeline.marker('rollback.start', { strategy: 'zero-downtime' })
    const hap = haproxy()
    const originalMetadataDb = state?.originalMetadataDb ?? cfg.metadataDb

    if (!(await containerRunning(BLUE_CONTAINER))) {
      ctx.log(`restarting blue on ${cfg.fromVersion} against untouched ${originalMetadataDb}`)
      await compose(
        ['up', '-d', '--no-deps', 'hasura-blue'],
        versionEnv({ blueVersion: cfg.fromVersion, blueMetadataDb: originalMetadataDb }),
        300_000,
      )
      await waitHealthy(adminClient(cfg.blueDirectUrl), 300_000)
      ctx.timeline.marker('rollback.blue.restarted', { ms: Date.now() - started })
    }

    await hap.setServerState(BACKEND, BLUE, 'ready')
    const blueStatus = await hap.waitServerStatus(BACKEND, BLUE, (s) => s.startsWith('UP'), 60_000)
    await hap.setServerState(BACKEND, GREEN, 'drain')
    ctx.timeline.marker('rollback.traffic.switch', { blueStatus })

    const drain = await hap.waitDrained(BACKEND, GREEN, DRAIN_TIMEOUT_MS)
    ctx.timeline.marker('rollback.drain.complete', drain)

    await compose(['--profile', 'green', 'stop', 'hasura-green'], versionEnv({}), 180_000).catch(() => {})
    await hap.setServerState(BACKEND, GREEN, 'maint').catch(() => {})

    ctx.timeline.marker('rollback.end', {
      strategy: 'zero-downtime',
      totalMs: Date.now() - started,
      canonicalMetadataDb: originalMetadataDb,
    })
  },
}

/** Exposed so tests can assert the abort path leaves no clone behind. */
export function currentUpgradeState(): Readonly<UpgradeState> | null {
  return state
}

export function resetUpgradeState(): void {
  state = null
}
