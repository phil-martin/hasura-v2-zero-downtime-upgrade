import { cfg } from '../src/config/index.js'
import { BLUE_CONTAINER, currentImage, fullReset } from '../src/stack/index.js'
import { resetUpgradeState } from '../src/upgraders/zeroDowntime.js'
import { renderScorecard } from '../src/report/render.js'
import type { RunResult } from '../src/runner/index.js'

/**
 * Put the stack into a known state with blue running the given version.
 *
 * Always does a full reset rather than trying to be clever about reuse. A test
 * that starts from an ambiguous state produces an ambiguous result, and these
 * runs take minutes anyway — the reset is not the expensive part.
 */
export async function resetStackTo(version: string = cfg.fromVersion): Promise<void> {
  resetUpgradeState()
  await fullReset({ blueVersion: version })
  const image = await currentImage(BLUE_CONTAINER)
  if (image !== `hasura/graphql-engine:${version}`) {
    throw new Error(`expected blue on ${version} after reset, got ${image}`)
  }
}

/** Print the full scorecard so a CI log records the measurement, not just pass/fail. */
export function report(label: string, result: RunResult): void {
  console.log(`\n${'='.repeat(79)}\n${label}\n${'='.repeat(79)}`)
  console.log(renderScorecard(result.scorecard, result.verdict))
}
