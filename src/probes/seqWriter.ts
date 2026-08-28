import { pool } from '../db/pool.js'
import { cfg } from '../config/index.js'

/**
 * Advances a monotonic sequence in `seq_stream` at a fixed cadence.
 *
 * Writes go DIRECTLY to Postgres, deliberately bypassing Hasura. If this wrote
 * through GraphQL, an outage would stop rows being produced and the streaming
 * subscription would have nothing to miss — the harness would measure zero data
 * loss simply because there was no data. Writing direct means rows keep
 * appearing throughout an outage, so the subscription must reconnect AND
 * back-fill every row written while it was gone in order to pass.
 */
export class SeqWriter {
  private timer: NodeJS.Timeout | null = null
  private next = 1
  private stopped = false
  readonly written: number[] = []
  readonly writeFailures: string[] = []

  constructor(private readonly intervalMs = 250) {}

  start(): void {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      const seq = this.next++
      try {
        await pool(cfg.appDb).query('INSERT INTO seq_stream (seq) VALUES ($1)', [seq])
        this.written.push(seq)
      } catch (err) {
        // A write failure means the row never existed, so it must not be
        // counted as something the subscription failed to deliver.
        this.writeFailures.push(`seq ${seq}: ${String(err).slice(0, 200)}`)
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, this.intervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  get lastWritten(): number {
    return this.written.length > 0 ? this.written[this.written.length - 1]! : 0
  }
}
