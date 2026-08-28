import { createClient, type Client } from 'graphql-ws'
import WebSocket from 'ws'

export type SubscriptionStats = {
  id: string
  connects: number
  drops: Array<{ at: number; reason: string }>
  reconnectMs: number[]
  updates: number
  firstConnectedAt: number | null
  lastPayloadAt: number | null
}

export type StreamingStats = SubscriptionStats & {
  receivedSeq: number[]
  maxSeqSeen: number
}

function makeClient(url: string, adminSecret: string): Client {
  return createClient({
    url,
    webSocketImpl: WebSocket,
    // Hasura reads auth from the connection_init payload's `headers` object.
    connectionParams: { headers: { 'x-hasura-admin-secret': adminSecret } },
    // Lazy so the socket opens when the subscription starts and connection
    // failures surface through the iterator, where they are measured. With
    // `lazy: false` they instead go to graphql-ws's `onNonLazyError`, which
    // defaults to console.error and dumps an entire CloseEvent per drop.
    lazy: true,
    onNonLazyError: () => {},
    // Reconnection is handled explicitly below rather than by the library, so
    // that drop and reconnect timings can be measured and, for the streaming
    // subscription, so the cursor can be advanced on resume.
    retryAttempts: 0,
    keepAlive: 10_000,
  })
}

abstract class BaseSubscription {
  protected running = false
  protected client: Client | null = null
  readonly connects: number[] = []
  readonly drops: Array<{ at: number; reason: string }> = []
  readonly reconnectMs: number[] = []
  protected updates = 0
  protected firstConnectedAt: number | null = null
  protected lastPayloadAt: number | null = null
  private loopPromise: Promise<void> | null = null

  constructor(
    readonly id: string,
    protected readonly wsUrl: string,
    protected readonly adminSecret: string,
  ) {}

  start(): void {
    this.running = true
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    try {
      await this.client?.dispose()
    } catch {
      /* disposing a already-dead socket is not interesting */
    }
    await this.loopPromise?.catch(() => {})
  }

  private async loop(): Promise<void> {
    let disconnectedAt: number | null = null
    while (this.running) {
      const attemptStart = Date.now()
      try {
        this.client = makeClient(this.wsUrl, this.adminSecret)
        await this.consume(this.client, () => {
          const now = Date.now()
          this.connects.push(now)
          if (this.firstConnectedAt === null) this.firstConnectedAt = now
          if (disconnectedAt !== null) {
            this.reconnectMs.push(now - disconnectedAt)
            disconnectedAt = null
          }
        })
        // A clean completion while still running means the server ended the
        // subscription; treat it the same as a drop so it cannot hide.
        if (this.running) {
          disconnectedAt = Date.now()
          this.drops.push({ at: disconnectedAt, reason: 'subscription completed unexpectedly' })
        }
      } catch (err) {
        if (!this.running) break
        disconnectedAt = Date.now()
        this.drops.push({ at: disconnectedAt, reason: describeError(err) })
      } finally {
        try {
          await this.client?.dispose()
        } catch {
          /* ignore */
        }
        this.client = null
      }

      if (!this.running) break
      // Back off just enough to avoid hammering a down server, while staying
      // well inside the reconnect budget the policy allows.
      const elapsed = Date.now() - attemptStart
      await sleep(elapsed < 200 ? 250 : 100)
    }
  }

  protected abstract consume(client: Client, onConnected: () => void): Promise<void>

  baseStats(): SubscriptionStats {
    return {
      id: this.id,
      connects: this.connects.length,
      drops: this.drops,
      reconnectMs: this.reconnectMs,
      updates: this.updates,
      firstConnectedAt: this.firstConnectedAt,
      lastPayloadAt: this.lastPayloadAt,
    }
  }
}

/**
 * Streaming subscription with an explicit cursor over `seq`.
 *
 * This is the only construction in the harness that can prove "missed zero
 * data" rather than assume it. The writer produces a contiguous integer
 * sequence; any integer written but never received is, unambiguously, data the
 * subscriber lost. On reconnect the cursor resumes from the highest seq already
 * seen, which is exactly what a well-behaved client would do.
 */
export class StreamingSeqSubscription extends BaseSubscription {
  private readonly received = new Set<number>()
  private maxSeq = 0

  protected async consume(client: Client, onConnected: () => void): Promise<void> {
    let announced = false
    const iterator = client.iterate<{ seq_stream_stream: Array<{ seq: number }> }>({
      query: `subscription Stream($cursor: [seq_stream_stream_cursor_input]!) {
                seq_stream_stream(batch_size: 200, cursor: $cursor) { seq }
              }`,
      variables: {
        cursor: [{ initial_value: { seq: this.maxSeq }, ordering: 'ASC' }],
      },
    })

    for await (const payload of iterator) {
      if (!announced) {
        announced = true
        onConnected()
      }
      const rows = payload.data?.seq_stream_stream ?? []
      if (rows.length > 0) {
        this.updates++
        this.lastPayloadAt = Date.now()
      }
      for (const row of rows) {
        const seq = Number(row.seq)
        this.received.add(seq)
        if (seq > this.maxSeq) this.maxSeq = seq
      }
      if (!this.running) break
    }
    if (!announced) onConnected()
  }

  stats(): StreamingStats {
    return {
      ...this.baseStats(),
      receivedSeq: [...this.received].sort((a, b) => a - b),
      maxSeqSeen: this.maxSeq,
    }
  }

  /** Sequence numbers the writer committed but this subscription never saw. */
  missed(written: number[]): number[] {
    return written.filter((s) => !this.received.has(s))
  }
}

/**
 * Live query over an aggregate. Complements the streaming subscription: live
 * queries are re-polled and multiplexed by Hasura, a completely different code
 * path from streaming, and one that could regress independently.
 */
export class LiveMaxSeqSubscription extends BaseSubscription {
  private maxSeq = 0

  protected async consume(client: Client, onConnected: () => void): Promise<void> {
    let announced = false
    const iterator = client.iterate<{
      seq_stream_aggregate: { aggregate: { max: { seq: number | null } | null } | null }
    }>({
      query: `subscription LiveMax { seq_stream_aggregate { aggregate { max { seq } } } }`,
    })

    for await (const payload of iterator) {
      if (!announced) {
        announced = true
        onConnected()
      }
      this.updates++
      this.lastPayloadAt = Date.now()
      const max = Number(payload.data?.seq_stream_aggregate?.aggregate?.max?.seq ?? 0)
      if (max > this.maxSeq) this.maxSeq = max
      if (!this.running) break
    }
    if (!announced) onConnected()
  }

  stats(): SubscriptionStats & { maxSeqSeen: number } {
    return { ...this.baseStats(), maxSeqSeen: this.maxSeq }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (Array.isArray(err)) return `GraphQL errors: ${JSON.stringify(err).slice(0, 300)}`
  if (err && typeof err === 'object') {
    const e = err as { code?: number; reason?: string; type?: string }
    if (e.code !== undefined) return `close ${e.code}${e.reason ? `: ${e.reason}` : ''}`
    return JSON.stringify(err).slice(0, 300)
  }
  return String(err)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function wsUrlFor(httpUrl: string): string {
  return `${httpUrl.replace(/^http/, 'ws')}/v1/graphql`
}
