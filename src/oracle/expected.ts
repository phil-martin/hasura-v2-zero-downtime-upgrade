import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../config/index.js'

export const EXPECTED_PATH = resolve(REPO_ROOT, 'src/oracle/expected.generated.json')

export type ExpectedMap = Record<string, unknown>

export async function loadExpected(): Promise<ExpectedMap> {
  try {
    return JSON.parse(await readFile(EXPECTED_PATH, 'utf8')) as ExpectedMap
  } catch (err) {
    throw new Error(
      `no expectations found at ${EXPECTED_PATH}. Run \`npm run snapshot\` against a freshly seeded stack first. (${String(err)})`,
    )
  }
}

export async function saveExpected(map: ExpectedMap): Promise<void> {
  const ordered: ExpectedMap = {}
  for (const key of Object.keys(map).sort()) ordered[key] = map[key]
  await writeFile(EXPECTED_PATH, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}
