export type CronFire = { name: string; receivedAt: number; scheduledAt: string | null }

export type CronReconciliation = {
  observed: number
  expectedAtLeast: number
  firesBeforeUpgrade: number
  firesAfterUpgrade: number
  /**
   * Cron events Hasura had pre-generated into the metadata store before the
   * upgrade. This is the number that justifies cloning the metadata database
   * rather than starting green with an empty one, which would discard them all.
   */
  scheduledEventsAtStart: number | null
  scheduledEventsAtEnd: number | null
}

export async function fetchCronFires(sidecarUrl: string): Promise<CronFire[]> {
  const res = await fetch(`${sidecarUrl}/_harness/cron-fires`)
  const body = (await res.json()) as { cronFires: CronFire[] }
  return body.cronFires ?? []
}

/**
 * The heartbeat trigger runs `* * * * *`, so it fires on each minute boundary.
 * A run of N milliseconds crosses at least floor(N / 60000) boundaries, and may
 * cross one more depending on where it started. We assert the lower bound only.
 */
export function expectedCronFires(durationMs: number): number {
  return Math.max(0, Math.floor(durationMs / 60_000))
}

export function reconcileCron(
  fires: CronFire[],
  runStart: number,
  runEnd: number,
  upgradeAt: number | null,
  scheduledEventsAtStart: number | null,
  scheduledEventsAtEnd: number | null,
): CronReconciliation {
  const inWindow = fires.filter((f) => f.receivedAt >= runStart && f.receivedAt <= runEnd)
  return {
    observed: inWindow.length,
    expectedAtLeast: expectedCronFires(runEnd - runStart),
    firesBeforeUpgrade: upgradeAt === null ? inWindow.length : inWindow.filter((f) => f.receivedAt < upgradeAt).length,
    firesAfterUpgrade: upgradeAt === null ? 0 : inWindow.filter((f) => f.receivedAt >= upgradeAt).length,
    scheduledEventsAtStart,
    scheduledEventsAtEnd,
  }
}
