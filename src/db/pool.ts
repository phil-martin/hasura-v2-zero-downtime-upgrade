import pg from 'pg'
import { cfg } from '../config/index.js'

const pools = new Map<string, pg.Pool>()

export function pool(database: string): pg.Pool {
  let p = pools.get(database)
  if (!p) {
    p = new pg.Pool({
      host: cfg.pg.host,
      port: cfg.pg.port,
      user: cfg.pg.user,
      password: cfg.pg.password,
      database,
      max: 8,
      idleTimeoutMillis: 10_000,
    })
    // A pool that emits an unhandled 'error' takes the process down. During an
    // upgrade, backend connections legitimately get severed; that is data, not
    // a crash.
    p.on('error', () => {})
    pools.set(database, p)
  }
  return p
}

export async function closeAllPools(): Promise<void> {
  for (const [name, p] of pools) {
    await p.end().catch(() => {})
    pools.delete(name)
  }
}

export async function sql<T extends pg.QueryResultRow = any>(
  database: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await pool(database).query<T>(text, values)
  return res.rows
}
