import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../..')
export const COMPOSE_DIR = resolve(REPO_ROOT, 'compose')
export const SEED_DIR = resolve(REPO_ROOT, 'seed')

const env = (k: string, fallback: string): string => process.env[k] ?? fallback

export const cfg = {
  fromVersion: env('FROM_VERSION', 'v2.48.4'),
  toVersion: env('TO_VERSION', 'v2.50.1'),

  /** The only endpoint probes are allowed to use. Everything must go through the proxy. */
  proxyUrl: env('PROXY_URL', 'http://127.0.0.1:8080'),

  /**
   * Direct engine access, bypassing HAProxy. Used exclusively by the green
   * pre-flight gate, which must verify correctness on the new version before
   * any traffic is switched to it.
   */
  blueDirectUrl: env('BLUE_DIRECT_URL', 'http://127.0.0.1:8181'),
  greenDirectUrl: env('GREEN_DIRECT_URL', 'http://127.0.0.1:8182'),

  sidecarUrl: env('SIDECAR_URL', 'http://127.0.0.1:8081'),

  haproxyHost: env('HAPROXY_STATS_HOST', '127.0.0.1'),
  haproxyPort: Number(env('HAPROXY_STATS_PORT', '9999')),

  adminSecret: env('HASURA_ADMIN_SECRET', 'harness-admin-secret'),

  pg: {
    host: env('POSTGRES_HOST', '127.0.0.1'),
    port: Number(env('POSTGRES_PORT', '5433')),
    user: env('POSTGRES_USER', 'postgres'),
    password: env('POSTGRES_PASSWORD', 'postgres'),
  },

  /** Database names inside the single Postgres server. */
  appDb: 'appdb',
  metadataDb: 'hasura_metadata',

  /** Internal hostname:port Hasura is reachable at from inside the compose network. */
  internalPgHost: 'postgres',
  internalPgPort: 5432,
} as const

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type UpgradeAction = 'upgrade' | 'rollback'
export type ScheduledAction = { atMs: number; action: UpgradeAction }

export type Profile = {
  name: string
  durationMs: number
  schedule: ScheduledAction[]
  /** Time to keep reconciling event deliveries after probes stop. */
  settleMs: number
}

/**
 * Long runs are deliberate. A five-minute run sees ~5 cron fires; the soak
 * profile sees ~20, which is what makes "did cron survive the metadata clone"
 * an assertion rather than a coin flip.
 */
export const PROFILES: Record<string, Profile> = {
  fast: {
    name: 'fast',
    durationMs: 90_000,
    schedule: [{ atMs: 30_000, action: 'upgrade' }],
    settleMs: 20_000,
  },
  default: {
    name: 'default',
    durationMs: 300_000,
    schedule: [{ atMs: 120_000, action: 'upgrade' }],
    settleMs: 30_000,
  },
  soak: {
    name: 'soak',
    durationMs: 1_200_000,
    schedule: [
      { atMs: 240_000, action: 'upgrade' },
      { atMs: 720_000, action: 'rollback' },
    ],
    settleMs: 45_000,
  },
}

export function profile(name: string): Profile {
  const p = PROFILES[name]
  if (!p) throw new Error(`unknown profile "${name}", expected one of ${Object.keys(PROFILES).join(', ')}`)
  return p
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type PolicyName = 'strict' | 'zero-downtime' | 'informational'

/** `null` means "measure but do not gate on it". */
export type Policy = {
  name: PolicyName
  maxFailedRequests: number | null
  maxContiguousOutageMs: number | null
  maxIncorrectResults: number | null
  maxGraphqlErrors: number | null
  maxLostEvents: number | null
  maxMissedSubRows: number | null
  maxSubscriptionDrops: number | null
  maxReconnectMs: number | null
}

export const POLICIES: Record<PolicyName, Policy> = {
  // No upgrade is happening, so nothing at all may go wrong.
  strict: {
    name: 'strict',
    maxFailedRequests: 0,
    maxContiguousOutageMs: 0,
    maxIncorrectResults: 0,
    maxGraphqlErrors: 0,
    maxLostEvents: 0,
    maxMissedSubRows: 0,
    maxSubscriptionDrops: 0,
    maxReconnectMs: null,
  },
  // The project's actual bar. Subscriptions may drop; nothing may be lost.
  'zero-downtime': {
    name: 'zero-downtime',
    maxFailedRequests: 0,
    maxContiguousOutageMs: 0,
    maxIncorrectResults: 0,
    maxGraphqlErrors: 0,
    maxLostEvents: 0,
    maxMissedSubRows: 0,
    maxSubscriptionDrops: null,
    maxReconnectMs: 30_000,
  },
  informational: {
    name: 'informational',
    maxFailedRequests: null,
    maxContiguousOutageMs: null,
    maxIncorrectResults: null,
    maxGraphqlErrors: null,
    maxLostEvents: null,
    maxMissedSubRows: null,
    maxSubscriptionDrops: null,
    maxReconnectMs: null,
  },
}

export function policy(name: string): Policy {
  const p = POLICIES[name as PolicyName]
  if (!p) throw new Error(`unknown policy "${name}", expected one of ${Object.keys(POLICIES).join(', ')}`)
  return p
}

export function metadataDbUrl(dbName: string): string {
  return `postgres://${cfg.pg.user}:${cfg.pg.password}@${cfg.internalPgHost}:${cfg.internalPgPort}/${dbName}`
}
