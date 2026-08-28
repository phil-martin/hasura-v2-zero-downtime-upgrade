import { cfg } from '../config/index.js'
import { HasuraClient } from '../hasura/client.js'
import { loadExpected } from '../oracle/expected.js'
import { denialProbes, readProbes } from '../probes/reads.js'
import type { GqlClient, Probe, ProbeCtx } from '../probes/types.js'

export type VerificationResult = {
  ok: boolean
  ran: number
  failures: Array<{ probeId: string; kind: string; detail: string }>
}

/**
 * Run the full read-correctness suite against one engine directly, bypassing
 * HAProxy.
 *
 * This is the highest-value step in the whole upgrade. It converts "upgrade and
 * hope" into "prove, then switch": if the new version disagrees with the oracle
 * about anything — a changed numeric format, a permission that silently
 * widened, a broken remote relationship — we find out while blue is still
 * serving every user request, and abort with nobody affected.
 *
 * Only read and denial probes are used. Mutation probes would write to the
 * shared source database, and a verification step must not have side effects on
 * the data the live engine is serving.
 */
export async function verifyEngine(baseUrl: string): Promise<VerificationResult> {
  const expected = await loadExpected()
  const admin = new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret })
  const anon = new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret, unauthenticated: true })
  const roleClients = new Map<string, GqlClient>()

  const ctx: ProbeCtx = {
    admin,
    anon,
    as(role, userId) {
      const key = `${role}:${userId ?? ''}`
      let client = roleClients.get(key)
      if (!client) {
        client = new HasuraClient({ baseUrl, adminSecret: cfg.adminSecret, role, userId })
        roleClients.set(key, client)
      }
      return client
    },
    sidecarUrl: cfg.sidecarUrl,
    nextKey: (prefix) => `verify-${prefix}`,
    expectEvent: () => {
      throw new Error('verification must not create event expectations')
    },
  }

  const probes: Probe[] = [...readProbes(expected), ...denialProbes()]
  const failures: VerificationResult['failures'] = []

  for (const probe of probes) {
    try {
      const outcome = await probe.run(ctx)
      if (!outcome.ok) failures.push({ probeId: probe.id, kind: outcome.kind, detail: outcome.detail })
    } catch (err) {
      failures.push({ probeId: probe.id, kind: 'threw', detail: String(err).slice(0, 300) })
    }
  }

  return { ok: failures.length === 0, ran: probes.length, failures }
}
