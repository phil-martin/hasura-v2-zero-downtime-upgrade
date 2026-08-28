import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { COMPOSE_DIR, SEED_DIR, cfg, metadataDbUrl } from '../config/index.js'
import { HasuraClient, waitHealthy } from '../hasura/client.js'
import { closeAllPools, pool, sql } from '../db/pool.js'

const exec = promisify(execFile)

export const PROJECT = 'hzdu'
export const BLUE_CONTAINER = `${PROJECT}-hasura-blue-1`
export const GREEN_CONTAINER = `${PROJECT}-hasura-green-1`
export const PG_CONTAINER = `${PROJECT}-postgres-1`
export const SIDECAR_CONTAINER = `${PROJECT}-sidecar-1`

export type ComposeEnv = Record<string, string>

export async function compose(args: string[], env: ComposeEnv = {}, timeoutMs = 300_000) {
  return exec('docker', ['compose', ...args], {
    cwd: COMPOSE_DIR,
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
}

export async function docker(args: string[], timeoutMs = 120_000) {
  return exec('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}

/** Environment that pins which image each engine runs and which metadata DB it uses. */
export function versionEnv(opts: {
  blueVersion?: string
  greenVersion?: string
  blueMetadataDb?: string
  greenMetadataDb?: string
}): ComposeEnv {
  const env: ComposeEnv = {
    BLUE_VERSION: opts.blueVersion ?? cfg.fromVersion,
    GREEN_VERSION: opts.greenVersion ?? cfg.toVersion,
    HASURA_ADMIN_SECRET: cfg.adminSecret,
  }
  if (opts.blueMetadataDb) env.BLUE_METADATA_DB_URL = metadataDbUrl(opts.blueMetadataDb)
  if (opts.greenMetadataDb) env.GREEN_METADATA_DB_URL = metadataDbUrl(opts.greenMetadataDb)
  return env
}

export function adminClient(baseUrl: string): HasuraClient {
  return new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Tear everything down including volumes, then rebuild from scratch, seed, and
 * apply metadata. Used between tests that change which version blue runs.
 */
export async function fullReset(opts: { blueVersion?: string } = {}): Promise<void> {
  // `--profile green` so green is torn down too, and `-v` so the Postgres
  // volume goes with it — that is what removes any metadata clones left behind
  // by a previous upgrade, along with HAProxy's server states, returning the
  // stack to a genuinely known starting point.
  await compose(['--profile', 'green', 'down', '-v', '--remove-orphans'], {}, 180_000).catch(() => {})
  await closeAllPools()
  const env = versionEnv({ blueVersion: opts.blueVersion, blueMetadataDb: cfg.metadataDb })
  await compose(['up', '-d', '--build', 'postgres', 'sidecar', 'haproxy', 'hasura-blue'], env, 420_000)
  await waitForPostgres(120_000)
  await seedAppDb()
  const blue = adminClient(cfg.blueDirectUrl)
  await waitHealthy(blue, 180_000)
  await applyMetadata(blue)
  await waitHealthy(adminClient(cfg.proxyUrl), 60_000)
}

/**
 * Cheap reset between runs of the same version: clear the mutable partition and
 * the sidecar's record, leave immutable data, metadata, and catalog alone.
 */
export async function lightReset(): Promise<void> {
  await sql(
    cfg.appDb,
    `TRUNCATE orders, seq_stream, events_source RESTART IDENTITY;
     UPDATE counters SET value = 0;`,
  )
  // Clear any events left over from a previous run so reconciliation only ever
  // sees deliveries belonging to the run under measurement.
  await sql(cfg.appDb, `DELETE FROM hdb_catalog.event_invocation_logs; DELETE FROM hdb_catalog.event_log;`).catch(
    () => {},
  )
  await fetch(`${cfg.sidecarUrl}/_harness/reset`, { method: 'POST' }).catch(() => {})
}

export async function waitForPostgres(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'never attempted'
  while (Date.now() < deadline) {
    try {
      await pool('postgres').query('SELECT 1')
      return
    } catch (err) {
      last = String(err)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`postgres not reachable after ${timeoutMs}ms: ${last}`)
}

export async function seedAppDb(): Promise<void> {
  for (const file of ['001-schema.sql', '002-immutable-data.sql', '003-functions-views.sql']) {
    const text = await readFile(resolve(SEED_DIR, file), 'utf8')
    await pool(cfg.appDb).query(text)
  }
}

export async function applyMetadata(client: HasuraClient): Promise<void> {
  const text = await readFile(resolve(SEED_DIR, 'metadata/metadata.json'), 'utf8')
  await client.replaceMetadata(JSON.parse(text))
  const bad = await client.inconsistentMetadata()
  if (bad.length > 0) {
    throw new Error(`metadata applied but inconsistent: ${JSON.stringify(bad).slice(0, 1000)}`)
  }
}

// ---------------------------------------------------------------------------
// Metadata database cloning
// ---------------------------------------------------------------------------

/**
 * Clone the metadata database so green can migrate a copy while blue keeps
 * serving from the original untouched.
 *
 * pg_dump/psql rather than CREATE DATABASE ... TEMPLATE: templating is faster
 * but requires zero connections to the template database, and blue is connected
 * to it by definition.
 *
 * The clone must be a copy rather than a fresh database. Hasura pre-generates
 * future cron events into hdb_cron_events in the metadata store; starting green
 * empty would silently discard every scheduled event.
 */
export async function cloneMetadataDb(source: string, target: string): Promise<{ ms: number; rows: number }> {
  const started = Date.now()
  await dropDatabase(target)
  await sql('postgres', `CREATE DATABASE ${quoteIdent(target)}`)
  await docker([
    'exec',
    PG_CONTAINER,
    'sh',
    '-c',
    `pg_dump -U ${cfg.pg.user} --no-owner --no-acl ${source} | psql -q -U ${cfg.pg.user} -d ${target} -v ON_ERROR_STOP=1`,
  ])
  const rows = await sql<{ n: string }>(target, `SELECT count(*)::text AS n FROM hdb_catalog.hdb_cron_events`).catch(
    () => [{ n: '0' }],
  )
  return { ms: Date.now() - started, rows: Number(rows[0]?.n ?? 0) }
}

/**
 * Copy async action results from the old metadata database into the clone.
 *
 * The clone is taken before green boots, but blue keeps serving until it is
 * drained and stopped. Any async action created on blue in that window writes
 * its result to blue's `hdb_action_log`, which green — reading the clone — can
 * never see. The client polls forever and the result is silently lost.
 *
 * The harness caught this as a single unexplained timeout during the upgrade
 * window. Copying the rows across after blue stops closes the gap. Action ids
 * are UUIDs, so re-inserting rows the clone already has is a no-op.
 */
export async function copyActionLog(fromDb: string, toDb: string): Promise<{ copied: number }> {
  const cols = await sql<{ column_name: string }>(
    fromDb,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'hdb_catalog' AND table_name = 'hdb_action_log'
     ORDER BY ordinal_position`,
  )
  const names = cols.map((c) => c.column_name)
  if (names.length === 0) return { copied: 0 }

  // What the target already has, and whether its copy is finished. An action
  // row is written when the action is created and updated again when the
  // handler responds, so copying once with ON CONFLICT DO NOTHING is not
  // enough: a row copied while still 'created' would stay pending on green
  // forever, which is exactly the failure the harness caught.
  const targetState = new Map(
    (
      await sql<{ id: string; done: boolean }>(
        toDb,
        `SELECT id::text AS id, (response_received_at IS NOT NULL) AS done FROM hdb_catalog.hdb_action_log`,
      )
    ).map((r) => [r.id, r.done]),
  )

  const quoted = names.map(quoteIdent).join(', ')
  // Only recent rows: anything older cannot still be in flight, and scanning
  // the whole log every second would grow without bound.
  const rows = await sql<Record<string, unknown>>(
    fromDb,
    `SELECT ${quoted} FROM hdb_catalog.hdb_action_log WHERE created_at > now() - interval '15 minutes'`,
  )

  const pending = rows.filter((r) => {
    const done = targetState.get(String(r.id))
    if (done === undefined) return true // target has never seen it
    return !done && r.response_received_at !== null // target's copy is stale
  })
  if (pending.length === 0) return { copied: 0 }

  const placeholders = names.map((_, i) => `$${i + 1}`).join(', ')
  const updatable = names.filter((n) => n !== 'id')
  const updateSet = updatable.map((n) => `${quoteIdent(n)} = EXCLUDED.${quoteIdent(n)}`).join(', ')

  let copied = 0
  for (const row of pending) {
    const values = names.map((n) => {
      const v = row[n]
      // jsonb columns come back as parsed objects; Postgres needs text it can cast.
      return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
    })
    const res = await sql(
      toDb,
      `INSERT INTO hdb_catalog.hdb_action_log (${quoted}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
      values,
    ).catch(() => null)
    if (res !== null) copied++
  }
  return { copied }
}

export async function dropDatabase(name: string): Promise<void> {
  await sql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  ).catch(() => {})
  await sql('postgres', `DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
}

export async function listMetadataDbs(): Promise<string[]> {
  const rows = await sql<{ datname: string }>(
    'postgres',
    `SELECT datname FROM pg_database WHERE datname LIKE 'hasura_metadata%' ORDER BY datname`,
  )
  return rows.map((r) => r.datname)
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`unsafe database identifier: ${name}`)
  return `"${name}"`
}

// ---------------------------------------------------------------------------
// Container introspection
// ---------------------------------------------------------------------------

/**
 * Read an environment variable out of a running container.
 *
 * This is how the orchestrator discovers which metadata database is currently
 * canonical, rather than keeping a state file. Roles alternate after every
 * successful upgrade, and a state file can drift from reality; the running
 * container cannot.
 */
export async function containerEnvVar(container: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await docker([
      'inspect',
      container,
      '--format',
      '{{range .Config.Env}}{{println .}}{{end}}',
    ])
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0 && line.slice(0, eq) === name) return line.slice(eq + 1)
    }
    return null
  } catch {
    return null
  }
}

export function dbNameFromUrl(url: string | null): string | null {
  if (!url) return null
  const m = /\/([^/?]+)(\?|$)/.exec(url)
  return m?.[1] ?? null
}

export async function containerRunning(container: string): Promise<boolean> {
  try {
    const { stdout } = await docker(['inspect', container, '--format', '{{.State.Running}}'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/** The container's IP on the compose network, as Docker sees it. */
export async function containerIp(container: string): Promise<string | null> {
  try {
    const { stdout } = await docker([
      'inspect',
      container,
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    ])
    const ip = stdout.trim()
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null
  } catch {
    return null
  }
}

export async function currentImage(container: string): Promise<string | null> {
  try {
    const { stdout } = await docker(['inspect', container, '--format', '{{.Config.Image}}'])
    return stdout.trim()
  } catch {
    return null
  }
}
