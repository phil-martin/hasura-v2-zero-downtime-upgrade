/**
 * Canonical JSON for deep equality.
 *
 * Object key order is normalised because it is not semantically meaningful and
 * could differ between Hasura versions; array order is preserved because every
 * probe query specifies an explicit order_by, so ordering IS meaningful and a
 * change in it is a genuine regression we want to catch.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalise(value))
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalise)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) out[key] = normalise(obj[key])
  return out
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

/** Short, readable description of where two values first differ. */
export function diffSummary(expected: unknown, actual: unknown): string {
  const e = canonical(expected)
  const a = canonical(actual)
  if (e === a) return 'no difference'
  let i = 0
  while (i < e.length && i < a.length && e[i] === a[i]) i++
  const window = 90
  const from = Math.max(0, i - 20)
  return `first difference at char ${i}: expected …${e.slice(from, from + window)}… got …${a.slice(from, from + window)}…`
}
