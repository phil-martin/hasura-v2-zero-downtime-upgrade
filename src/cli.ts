import { cfg } from './config/index.js'
import { HasuraClient, waitHealthy } from './hasura/client.js'
import { READ_SPECS } from './oracle/readSpecs.js'
import { clientFor, runRead } from './probes/reads.js'
import { saveExpected, EXPECTED_PATH, type ExpectedMap } from './oracle/expected.js'
import type { GqlClient, ProbeCtx } from './probes/types.js'
import {
  adminClient,
  applyMetadata,
  compose,
  fullReset,
  lightReset,
  seedAppDb,
  versionEnv,
  waitForPostgres,
} from './stack/index.js'
import { runHarness } from './runner/index.js'
import { renderScorecard } from './report/render.js'
import { closeAllPools } from './db/pool.js'

function flag(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

/** Build a ProbeCtx for one-shot uses that never mutate or emit events. */
function readOnlyCtx(baseUrl: string): ProbeCtx {
  const roleClients = new Map<string, GqlClient>()
  return {
    admin: new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret }),
    anon: new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret, unauthenticated: true }),
    as(role, userId) {
      const key = `${role}:${userId ?? ''}`
      let c = roleClients.get(key)
      if (!c) {
        c = new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret, role, userId })
        roleClients.set(key, c)
      }
      return c
    },
    sidecarUrl: cfg.sidecarUrl,
    nextKey: (p) => `cli-${p}`,
    expectEvent: () => {},
  }
}

async function snapshot(): Promise<void> {
  const ctx = readOnlyCtx(cfg.proxyUrl)
  const out: ExpectedMap = {}
  for (const spec of READ_SPECS) {
    const result = await runRead(ctx, spec)
    if (result.kind !== 'ok') {
      throw new Error(`cannot snapshot ${spec.id}: ${JSON.stringify(result).slice(0, 400)}`)
    }
    out[spec.id] = result.data
    console.log(`  captured ${spec.id}`)
  }
  await saveExpected(out)
  console.log(`\nWrote ${Object.keys(out).length} expectations to ${EXPECTED_PATH}`)
  // Deliberately noisy: these expectations are the oracle. If they were captured
  // against a broken stack, every later "pass" is meaningless.
  console.log('Verify these were captured against a freshly seeded stack before committing.')
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run'

  switch (command) {
    case 'stack-up': {
      await compose(
        ['up', '-d', '--build', 'postgres', 'sidecar', 'haproxy', 'hasura-blue'],
        versionEnv({ blueMetadataDb: cfg.metadataDb }),
        420_000,
      )
      await waitForPostgres(120_000)
      await waitHealthy(adminClient(cfg.blueDirectUrl), 180_000)
      console.log('stack up')
      break
    }

    case 'stack-down': {
      await compose(['--profile', 'green', 'down', '-v', '--remove-orphans'], {}, 180_000)
      console.log('stack down')
      break
    }

    case 'stack-reset': {
      await fullReset({ blueVersion: flag('from', cfg.fromVersion) })
      console.log('stack reset, seeded, metadata applied')
      break
    }

    case 'seed': {
      await waitForPostgres(60_000)
      await seedAppDb()
      await applyMetadata(adminClient(cfg.blueDirectUrl))
      console.log('seeded and metadata applied')
      break
    }

    case 'snapshot': {
      await snapshot()
      break
    }

    case 'light-reset': {
      await lightReset()
      console.log('mutable partition truncated, sidecar reset')
      break
    }

    case 'run': {
      const { scorecard, verdict } = await runHarness({
        profileName: flag('profile'),
        policyName: flag('policy'),
        upgraderName: flag('upgrader', 'none'),
        probeTarget: flag('target', 'proxy') === 'direct-blue' ? 'direct-blue' : 'proxy',
      })
      console.log(renderScorecard(scorecard, verdict))
      process.exitCode = verdict.pass ? 0 : 1
      break
    }

    default:
      console.error(
        `unknown command "${command}". Expected one of: stack-up, stack-down, stack-reset, seed, snapshot, light-reset, run`,
      )
      process.exitCode = 2
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeAllPools()
  })
