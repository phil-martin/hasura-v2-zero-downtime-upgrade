# Decisions log

Running record of choices made during brainstorming/design, so later sessions
don't re-litigate them.

## 2026-08-28 — Initial brainstorming

| # | Question | Decision |
|---|----------|----------|
| 1 | Deployment substrate being upgraded | **Docker Compose on a single host** (classic community self-host: `hasura/graphql-engine` + Postgres on one VPS) |
| 2 | Pass/fail bar | **Strict HTTP, resilient WS.** Zero failed HTTP queries/mutations (no connection-refused, no 5xx, no GraphQL errors, no wrong results). Subscriptions may drop but must reconnect within a budget and miss zero data. Event triggers: zero lost, at-least-once, duplicates allowed. |
| 3 | Version pair | **Parameterized via env**, default `v2.48.4` (2025-08-19) → `v2.50.1` (2026-08-18). Crosses two minors, so likely crosses a catalog-version bump — the interesting case. |
| 4 | Harness stack | **TypeScript / Node 22.** `graphql-ws` for subscriptions (the protocol Hasura v2 speaks), `pg` for direct DB oracle reads, vitest as runner. |
| 5 | Feature coverage | **All four groups:** core queries+mutations+RBAC; subscriptions (live + streaming); event triggers + cron triggers; actions + remote schemas + REST endpoints. |
| 6 | Front door | **Introducing a reverse proxy is an acceptable one-time change.** It is the only way to actually reach zero failed HTTP requests. |

## Open / deferred

- Which proxy (HAProxy vs Caddy vs Traefik) — decided in the approaches step.
- Metadata DB placement: model the community default (metadata co-located in the
  same Postgres as the data source), but keep it configurable.
- Harness run duration: configurable; short default for iteration, longer soak available.
