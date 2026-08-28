import { connect } from 'node:net'

export type ServerState = 'ready' | 'drain' | 'maint'

export type ServerStat = {
  pxname: string
  svname: string
  status: string
  /** Current sessions held by this server, including websocket tunnels. */
  scur: number
  /** Cumulative sessions. */
  stot: number
  /**
   * Integrity counters. A run can report zero client-visible failures while the
   * proxy was quietly retrying a real backend gap. Without these, "0 failed
   * requests" could be an artefact of `retry-on conn-failure` rather than
   * evidence the switch was clean, and the headline number would be flattering
   * rather than true.
   */
  wretr: number
  wredis: number
  econ: number
  eresp: number
}

/**
 * HAProxy Runtime API client.
 *
 * The upgrade orchestrator drives server states over this socket rather than
 * rewriting haproxy.cfg and reloading. That matters for two reasons: the proxy
 * process is never replaced during an upgrade, so established connections are
 * never disturbed; and `show stat` gives an observable signal that a drain has
 * actually completed, so the orchestrator can wait on evidence rather than
 * sleeping and hoping.
 */
export class HaproxyClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async command(cmd: string, timeoutMs = 5_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port })
      let out = ''
      const done = (err?: Error) => {
        socket.destroy()
        if (err) reject(err)
        else resolve(out)
      }
      socket.setTimeout(timeoutMs, () => done(new Error(`haproxy command timed out: ${cmd}`)))
      socket.on('connect', () => socket.write(`${cmd}\n`))
      socket.on('data', (chunk) => {
        out += chunk.toString('utf8')
      })
      socket.on('end', () => done())
      socket.on('error', (err) => done(err))
    })
  }

  async showStat(): Promise<ServerStat[]> {
    const raw = await this.command('show stat')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const headerLine = lines.find((l) => l.startsWith('#'))
    if (!headerLine) return []
    // Parse by column name rather than position: HAProxy has added columns
    // between versions and positional parsing would silently read the wrong one.
    const cols = headerLine.replace(/^#\s*/, '').split(',')
    const idx = (name: string) => cols.indexOf(name)
    const iPx = idx('pxname')
    const iSv = idx('svname')
    const iStatus = idx('status')
    const iScur = idx('scur')
    const iStot = idx('stot')
    const num = (f: string[], i: number) => (i < 0 ? 0 : Number(f[i] ?? '0') || 0)
    const iWretr = idx('wretr')
    const iWredis = idx('wredis')
    const iEcon = idx('econ')
    const iEresp = idx('eresp')

    const stats: ServerStat[] = []
    for (const line of lines) {
      if (line.startsWith('#')) continue
      const f = line.split(',')
      const pxname = f[iPx] ?? ''
      const svname = f[iSv] ?? ''
      if (!pxname || !svname) continue
      stats.push({
        pxname,
        svname,
        status: f[iStatus] ?? '',
        scur: num(f, iScur),
        stot: num(f, iStot),
        wretr: num(f, iWretr),
        wredis: num(f, iWredis),
        econ: num(f, iEcon),
        eresp: num(f, iEresp),
      })
    }
    return stats
  }

  async serverStat(backend: string, server: string): Promise<ServerStat | undefined> {
    const stats = await this.showStat()
    return stats.find((s) => s.pxname === backend && s.svname === server)
  }

  async setServerState(backend: string, server: string, state: ServerState): Promise<void> {
    const out = await this.command(`set server ${backend}/${server} state ${state}`)
    const trimmed = out.trim()
    // HAProxy answers with empty output on success and an error string otherwise.
    if (trimmed && !/^\s*$/.test(trimmed)) {
      throw new Error(`haproxy rejected "set server ${backend}/${server} state ${state}": ${trimmed}`)
    }
  }

  /** Force health-check re-evaluation, useful right after a backend appears. */
  async enableHealth(backend: string, server: string): Promise<void> {
    await this.command(`enable health ${backend}/${server}`)
  }

  /**
   * Point a server at an explicit address.
   *
   * Green does not exist when HAProxy boots, so its hostname cannot resolve and
   * it sits in `MAINT (resolution)`. Waiting for HAProxy's DNS refresh to
   * notice the new container works, but its timing depends on `hold` intervals
   * and would make the switch's duration a function of DNS luck. Setting the
   * address from Docker's own view of the container is deterministic.
   *
   * Must be called while the server is still in maintenance, before setting it
   * ready.
   */
  async setServerAddr(backend: string, server: string, ip: string, port: number): Promise<void> {
    const out = await this.command(`set server ${backend}/${server} addr ${ip} port ${port}`)
    const trimmed = out.trim()
    // HAProxy echoes a confirmation line on success here, unlike `state`.
    if (/error|not found|cannot/i.test(trimmed)) {
      throw new Error(`haproxy rejected addr change for ${backend}/${server}: ${trimmed}`)
    }
  }

  /**
   * Wait until a draining server holds no sessions.
   *
   * Websocket subscriptions are counted in `scur` and will hold until their
   * clients disconnect, so this is where the subscription reconnect budget is
   * spent. Returns rather than throws on timeout: a residual connection count
   * is a measurement, not an error, and the caller records it.
   */
  async waitDrained(
    backend: string,
    server: string,
    timeoutMs: number,
    pollMs = 200,
  ): Promise<{ drained: boolean; residual: number; ms: number }> {
    const started = Date.now()
    let residual = 0
    while (Date.now() - started < timeoutMs) {
      const stat = await this.serverStat(backend, server)
      residual = stat?.scur ?? 0
      if (residual === 0) {
        return { drained: true, residual: 0, ms: Date.now() - started }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return { drained: false, residual, ms: Date.now() - started }
  }

  async waitServerStatus(
    backend: string,
    server: string,
    predicate: (status: string) => boolean,
    timeoutMs: number,
    pollMs = 250,
  ): Promise<string> {
    const started = Date.now()
    let last = 'unknown'
    while (Date.now() - started < timeoutMs) {
      const stat = await this.serverStat(backend, server)
      last = stat?.status ?? 'missing'
      if (predicate(last)) return last
      await new Promise((r) => setTimeout(r, pollMs))
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${backend}/${server} status, last saw "${last}"`,
    )
  }
}

export const BACKEND = 'be_hasura'
export const BLUE = 'blue'
export const GREEN = 'green'
