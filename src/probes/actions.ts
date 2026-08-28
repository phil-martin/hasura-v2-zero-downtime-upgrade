import { fail, ok, outcomeFromResult, type Probe } from './types.js'

/**
 * The synchronous Action is covered by the exact-match read specs, since its
 * output is fully deterministic. This file covers the asynchronous one, which
 * cannot be: it returns an action id that must then be polled, and the id
 * differs every time.
 *
 * Async actions are worth probing separately because their state lives in the
 * metadata store, which is the database the zero-downtime upgrader clones.
 */
export function actionProbes(): Probe[] {
  return [
    {
      id: 'a_async_slow_echo',
      group: 'action',
      async run(ctx) {
        const message = ctx.nextKey('echo')
        const created = await ctx.admin.graphql(
          `mutation Async($message: String!) { slowEcho(message: $message) }`,
          { message },
        )
        const createFailure = outcomeFromResult(created)
        if (createFailure) return createFailure
        if (created.kind !== 'ok') return fail(created.latencyMs, 'unavailable', 'unreachable branch')

        const actionId = (created.data as any)?.slowEcho
        if (typeof actionId !== 'string' || actionId.length === 0) {
          return fail(created.latencyMs, 'wrong-result', 'async action did not return an id')
        }

        // The handler sleeps 500ms; allow generous headroom without letting a
        // permanently stuck action hang the probe scheduler.
        const deadline = Date.now() + 8_000
        let lastDetail = 'never polled'
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250))
          const polled = await ctx.admin.graphql(
            `query Poll($id: uuid!) { slowEcho(id: $id) { output { echoed length } errors } }`,
            { id: actionId },
          )
          if (polled.kind === 'unavailable' || polled.kind === 'timeout') {
            // Mid-upgrade the poll itself can fail; that is genuine downtime.
            return outcomeFromResult(polled)!
          }
          if (polled.kind === 'graphql-error') {
            lastDetail = JSON.stringify(polled.errors).slice(0, 200)
            continue
          }
          const res = (polled.data as any)?.slowEcho
          if (res === null || res === undefined) {
            // Distinct from "still pending": the engine cannot see this action
            // at all. Across a metadata clone that means the row was never
            // carried over, which is a different bug entirely.
            lastDetail = 'action not visible to the serving engine'
            continue
          }
          if (res?.errors) {
            return fail(polled.latencyMs, 'wrong-result', `async action errored: ${JSON.stringify(res.errors).slice(0, 200)}`)
          }
          if (res?.output) {
            const latencyMs = created.latencyMs + polled.latencyMs
            if (res.output.echoed !== message) {
              return fail(latencyMs, 'wrong-result', `echoed "${res.output.echoed}", sent "${message}"`)
            }
            if (res.output.length !== message.length) {
              return fail(latencyMs, 'wrong-result', `length was ${res.output.length}, expected ${message.length}`)
            }
            return ok(latencyMs)
          }
          lastDetail = 'row present but output still null'
        }
        return fail(created.latencyMs, 'timeout', `async action never completed: ${lastDetail}`)
      },
    },
  ]
}
