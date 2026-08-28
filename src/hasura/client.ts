import { Agent, request } from 'undici'
import type { GqlClient, GqlResult } from '../probes/types.js'

/**
 * Shared connection pool. Client-side keep-alive to HAProxy is realistic and
 * matches how a real application talks to Hasura. HAProxy is separately
 * configured with `option http-server-close` so that its *backend* connections
 * are not pooled — without that, draining a server would not actually move
 * traffic.
 */
const agent = new Agent({
  connections: 64,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
})

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Classify a thrown transport error.
 *
 * Anything we cannot positively identify is treated as `unavailable` rather
 * than swallowed. Under-reporting downtime would make the harness lie in the
 * most damaging possible direction.
 */
function classifyThrown(err: unknown): { kind: 'unavailable' | 'timeout'; detail: string } {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = e?.code ?? e?.cause?.code
  const name = e?.name
  const message = e?.message ?? String(err)

  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timeout', detail: `${name}: ${message}` }
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return { kind: 'timeout', detail: `${code}: ${message}` }
  }
  return { kind: 'unavailable', detail: `${code ?? name ?? 'unknown'}: ${message}` }
}

export type HasuraClientOpts = {
  baseUrl: string
  adminSecret: string
  role?: string
  userId?: number
  /** Omit the admin secret entirely, so Hasura applies the unauthorized role. */
  unauthenticated?: boolean
  timeoutMs?: number
}

export class HasuraClient implements GqlClient {
  readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(opts: HasuraClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (!opts.unauthenticated) {
      h['x-hasura-admin-secret'] = opts.adminSecret
      if (opts.role) h['x-hasura-role'] = opts.role
      if (opts.userId !== undefined) h['x-hasura-user-id'] = String(opts.userId)
    }
    this.headers = h
  }

  async graphql(query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
    return this.post('/v1/graphql', { query, variables: variables ?? {} })
  }

  /** Metadata API. Throws on failure — callers are orchestration code, not probes. */
  async metadata(type: string, args: unknown = {}): Promise<any> {
    const r = await this.post('/v1/metadata', { type, args })
    if (r.kind !== 'ok') {
      throw new Error(`metadata ${type} failed: ${JSON.stringify(r).slice(0, 800)}`)
    }
    return r.data
  }

  async restGet(path: string): Promise<GqlResult> {
    const started = performance.now()
    try {
      const res = await request(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers,
        dispatcher: agent,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      })
      const text = await res.body.text()
      const latencyMs = performance.now() - started
      return this.interpret(res.statusCode, text, latencyMs)
    } catch (err) {
      const latencyMs = performance.now() - started
      const c = classifyThrown(err)
      return c.kind === 'timeout'
        ? { kind: 'timeout', detail: c.detail, latencyMs }
        : { kind: 'unavailable', detail: c.detail, status: null, latencyMs }
    }
  }

  private async post(path: string, body: unknown): Promise<GqlResult> {
    const started = performance.now()
    try {
      const res = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        dispatcher: agent,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      })
      const text = await res.body.text()
      const latencyMs = performance.now() - started
      return this.interpret(res.statusCode, text, latencyMs)
    } catch (err) {
      const latencyMs = performance.now() - started
      const c = classifyThrown(err)
      return c.kind === 'timeout'
        ? { kind: 'timeout', detail: c.detail, latencyMs }
        : { kind: 'unavailable', detail: c.detail, status: null, latencyMs }
    }
  }

  private interpret(status: number, text: string, latencyMs: number): GqlResult {
    // 502/503/504 mean the proxy had no healthy backend, or the backend died
    // mid-request. That is downtime, not an application error.
    if (status === 502 || status === 503 || status === 504) {
      return { kind: 'unavailable', detail: `HTTP ${status}: ${text.slice(0, 200)}`, status, latencyMs }
    }

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        kind: 'unavailable',
        detail: `HTTP ${status} with unparseable body: ${text.slice(0, 200)}`,
        status,
        latencyMs,
      }
    }

    if (status >= 500) {
      return { kind: 'unavailable', detail: `HTTP ${status}: ${text.slice(0, 200)}`, status, latencyMs }
    }
    if (parsed?.errors) {
      return { kind: 'graphql-error', errors: parsed.errors, status, latencyMs }
    }
    if (status >= 400) {
      return { kind: 'graphql-error', errors: parsed, status, latencyMs }
    }
    // REST endpoints return the payload directly; GraphQL nests it under `data`.
    return { kind: 'ok', data: parsed?.data !== undefined ? parsed.data : parsed, status, latencyMs }
  }

  // --- orchestration helpers ------------------------------------------------

  async healthz(): Promise<boolean> {
    try {
      const res = await request(`${this.baseUrl}/healthz`, {
        method: 'GET',
        dispatcher: agent,
        headersTimeout: 3_000,
        bodyTimeout: 3_000,
      })
      await res.body.text()
      return res.statusCode === 200
    } catch {
      return false
    }
  }

  async version(): Promise<string> {
    const res = await request(`${this.baseUrl}/v1/version`, {
      method: 'GET',
      dispatcher: agent,
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    })
    const body = JSON.parse(await res.body.text())
    return String(body.version)
  }

  async exportMetadata(): Promise<{ metadata: unknown; resourceVersion: number }> {
    const out = await this.metadata('export_metadata', { version: 2 })
    return { metadata: out.metadata, resourceVersion: Number(out.resource_version) }
  }

  async inconsistentMetadata(): Promise<unknown[]> {
    const out = await this.metadata('get_inconsistent_metadata')
    return (out?.inconsistent_objects ?? []) as unknown[]
  }

  async replaceMetadata(metadata: unknown): Promise<void> {
    await this.metadata('replace_metadata', metadata)
  }

  withRole(role: string, userId?: number, adminSecret?: string): HasuraClient {
    return new HasuraClient({
      baseUrl: this.baseUrl,
      adminSecret: adminSecret ?? this.headers['x-hasura-admin-secret'] ?? '',
      role,
      userId,
      timeoutMs: this.timeoutMs,
    })
  }
}

export async function waitHealthy(client: HasuraClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'never attempted'
  while (Date.now() < deadline) {
    if (await client.healthz()) return
    lastErr = 'healthz not OK'
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${client.baseUrl} to be healthy (${lastErr})`)
}
