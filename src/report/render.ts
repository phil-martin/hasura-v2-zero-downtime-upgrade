import type { Scorecard } from './scorecard.js'
import type { PolicyVerdict } from './policies.js'

const pct = (n: number) => `${(n * 100).toFixed(3)}%`
const ms = (n: number) => `${Math.round(n)}ms`

function bar(label: string, width = 78): string {
  const pad = Math.max(0, width - label.length - 4)
  return `\n── ${label} ${'─'.repeat(pad)}`
}

export function renderScorecard(s: Scorecard, verdict: PolicyVerdict): string {
  const out: string[] = []

  out.push(bar('RUN'))
  out.push(`  profile        ${s.profile}`)
  out.push(`  upgrader       ${s.upgrader}`)
  out.push(`  versions       ${s.fromVersion} → ${s.toVersion}`)
  out.push(`  duration       ${ms(s.runEnd - s.runStart)}`)

  out.push(bar('HEADLINE'))
  const h = s.headline
  out.push(`  longest contiguous outage   ${ms(h.longestContiguousOutageMs)}`)
  out.push(`  failed requests             ${h.failedRequests}`)
  out.push(`  incorrect results           ${h.incorrectResults}`)
  out.push(`  graphql errors              ${h.graphqlErrors}`)
  out.push(`  lost events                 ${h.lostEvents}`)
  out.push(`  missed subscription rows    ${h.missedSubscriptionRows}`)
  out.push(`  subscription drops          ${h.subscriptionDrops}`)
  out.push(`  max reconnect               ${ms(h.maxReconnectMs)}`)

  out.push(bar('WINDOWS'))
  out.push(
    `  ${'window'.padEnd(14)}${'kind'.padEnd(8)}${'dur'.padStart(8)}${'reqs'.padStart(8)}${'fails'.padStart(7)}${'rate'.padStart(10)}${'outage'.padStart(9)}${'p99'.padStart(9)}`,
  )
  for (const w of s.windows) {
    out.push(
      `  ${w.window.name.padEnd(14)}${w.window.kind.padEnd(8)}${ms(w.durationMs).padStart(8)}${String(w.requests).padStart(8)}${String(w.failures).padStart(7)}${pct(w.failureRate).padStart(10)}${ms(w.longestContiguousOutageMs).padStart(9)}${ms(w.latency.p99).padStart(9)}`,
    )
  }
  out.push(
    `  ${'OVERALL'.padEnd(14)}${''.padEnd(8)}${ms(s.overall.durationMs).padStart(8)}${String(s.overall.requests).padStart(8)}${String(s.overall.failures).padStart(7)}${pct(s.overall.failureRate).padStart(10)}${ms(s.overall.longestContiguousOutageMs).padStart(9)}${ms(s.overall.latency.p99).padStart(9)}`,
  )

  const kinds = s.overall.byKind
  out.push(
    `  failure kinds: unavailable=${kinds.unavailable} timeout=${kinds.timeout} graphql-error=${kinds['graphql-error']} wrong-result=${kinds['wrong-result']}`,
  )

  out.push(bar('SUBSCRIPTIONS'))
  for (const sub of s.subscriptions) {
    out.push(
      `  ${sub.id.padEnd(24)} updates=${String(sub.updates).padStart(5)}  drops=${sub.drops}  maxReconnect=${ms(sub.maxReconnectMs)}  missed=${sub.missedRows} (${pct(sub.missedRate)})  maxSeq=${sub.maxSeqSeen}`,
    )
  }
  out.push(`  seq rows written=${s.seqWritten} writeFailures=${s.seqWriteFailures}`)

  out.push(bar('EVENTS'))
  const e = s.events
  const lat = e.deliveryLatencyMs.slice().sort((a, b) => a - b)
  const p = (q: number) => (lat.length ? ms(lat[Math.min(lat.length - 1, Math.ceil((q / 100) * lat.length) - 1)]!) : 'n/a')
  out.push(`  expected=${e.expected} delivered=${e.delivered} lost=${e.lost.length} duplicates=${e.duplicates}`)
  out.push(`  retried-then-delivered=${e.retriedSuccessfully} retries-lost=${e.retriesLost.length}`)
  out.push(`  delivery latency p50=${p(50)} p95=${p(95)} max=${lat.length ? ms(lat[lat.length - 1]!) : 'n/a'}`)
  if (e.lost.length > 0) out.push(`  lost keys: ${e.lost.slice(0, 8).join(', ')}${e.lost.length > 8 ? ' …' : ''}`)

  out.push(bar('CRON'))
  out.push(`  fires observed=${s.cron.observed} (expected at least ${s.cron.expectedAtLeast})`)
  out.push(`  before upgrade=${s.cron.firesBeforeUpgrade} after upgrade=${s.cron.firesAfterUpgrade}`)
  out.push(
    `  scheduled events in metadata store: start=${s.cron.scheduledEventsAtStart ?? 'n/a'} end=${s.cron.scheduledEventsAtEnd ?? 'n/a'}`,
  )

  out.push(bar('TIMELINE'))
  for (const m of s.markers) {
    const detail = m.detail === undefined ? '' : ` ${JSON.stringify(m.detail)}`
    out.push(`  +${String(m.atMs).padStart(7)}ms  ${m.name}${detail}`)
  }

  out.push(bar(`VERDICT — policy "${verdict.policy}"`))
  if (verdict.pass) {
    out.push('  PASS')
  } else {
    out.push('  FAIL')
    for (const v of verdict.violations) out.push(`    • ${v}`)
  }
  out.push('')
  return out.join('\n')
}
