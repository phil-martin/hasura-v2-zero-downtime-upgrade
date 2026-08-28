import { cfg } from '../config/index.js'
import { waitHealthy } from '../hasura/client.js'
import { adminClient, compose, docker, versionEnv } from '../stack/index.js'
import type { Timeline } from '../runner/timeline.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Deliberate faults, used to prove the harness detects damage.
 *
 * These exist because a test harness that has never been observed failing is
 * not evidence of anything. Each fault here has a known signature, and the
 * teeth tests assert the harness reports that signature.
 */

/** Freeze a container's processes. From outside it looks like a hung server. */
export async function pauseContainer(name: string, ms: number, timeline?: Timeline): Promise<void> {
  timeline?.marker('fault.pause.start', { container: name, ms })
  await docker(['pause', name])
  try {
    await sleep(ms)
  } finally {
    await docker(['unpause', name]).catch(() => {})
    timeline?.marker('fault.pause.end', { container: name })
  }
}

/**
 * SIGKILL, with no graceful shutdown at all, then restart.
 *
 * This is the specific case that loses in-flight events: Hasura never gets to
 * mark them pending, so they sit locked in the event log until something
 * reclaims them.
 */
export async function killAndRestartBlue(timeline?: Timeline, version = cfg.fromVersion): Promise<void> {
  timeline?.marker('fault.kill.start', { container: 'hasura-blue', signal: 'SIGKILL' })
  await docker(['kill', '--signal', 'SIGKILL', 'hzdu-hasura-blue-1'])
  await compose(['up', '-d', '--no-deps', 'hasura-blue'], versionEnv({ blueVersion: version, blueMetadataDb: cfg.metadataDb }), 300_000)
  await waitHealthy(adminClient(cfg.blueDirectUrl), 300_000)
  timeline?.marker('fault.kill.end', { container: 'hasura-blue' })
}

/**
 * Make the sidecar reject every event delivery for a while.
 *
 * Held longer than the trigger's retry budget (3 retries at 5s intervals), so
 * some events exhaust their retries and are permanently lost. That is real,
 * unrecoverable event loss, and the harness must report it.
 */
export async function rejectAllEvents(ms: number, timeline?: Timeline): Promise<void> {
  timeline?.marker('fault.rejectEvents.start', { ms })
  await setFailAll(true)
  try {
    await sleep(ms)
  } finally {
    await setFailAll(false).catch(() => {})
    timeline?.marker('fault.rejectEvents.end', {})
  }
}

async function setFailAll(enabled: boolean): Promise<void> {
  await fetch(`${cfg.sidecarUrl}/_harness/fail-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

/** Sever every websocket by restarting the engine holding them. */
export async function severSubscriptions(timeline?: Timeline): Promise<void> {
  timeline?.marker('fault.severWs.start', {})
  await docker(['restart', '-t', '5', 'hzdu-hasura-blue-1'])
  await waitHealthy(adminClient(cfg.blueDirectUrl), 300_000)
  timeline?.marker('fault.severWs.end', {})
}
