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

## 2026-08-28 — Design session (continued)

| # | Question | Decision |
|---|----------|----------|
| 7 | Traffic-switch mechanism | **HAProxy blue/green driven by the Runtime API.** Chosen over Caddy and single-node Swarm because drain is a first-class server state and `show stat` lets the orchestrator *observe* drain completion rather than sleeping. `retry-on conn-failure` only — safe to replay because the request provably never reached the server. |
| 8 | Metadata database | **Split into its own database** (separate DB on the same Postgres server, not a separate server). Confirmed from Hasura docs: event-trigger state (`event_log`, `event_invocation_logs`) lives in the **source** DB's `hdb_catalog`, so splitting metadata does *not* isolate the event catalog. Cron/scheduled events *do* live in the metadata store. |
| 9 | Metadata clone timing | **Build the clone up front.** Green boots against a clone of the metadata DB so blue's catalog is never migrated; rollback is "point HAProxy back at blue". Clone rather than fresh, to preserve cron/scheduled-event state. *Trade-off accepted knowingly:* this is complexity ahead of evidence — we will not learn whether plain shared-metadata blue/green would have sufficed for 2.48.4→2.50.1. |
| 10 | Verdict model | **Rates and peaks, not a boolean.** Measurement is primary; thresholds are named policies in config (`strict`, `zero-downtime`, `informational`). Rates computed per window (pre / during / post upgrade) since a whole-run denominator dilutes a real outage into noise. Longest contiguous unavailability (ms) is the headline downtime number, since rate alone cannot distinguish spread-out flakiness from one solid outage. |

## Residual risks (named, not solved)

- Blue and green share the **source** database's `hdb_catalog` during overlap. If v2.50.1 migrates the event-log schema on source init, blue is exposed. The harness measures whether this actually bites.
- The deliverable carries two one-time prerequisites, each needing a planned maintenance window: introduce HAProxy, and split the metadata database. Performing those migrations is a documented procedure, not something the harness covers.

| # | Question | Decision |
|---|----------|----------|
| 11 | Run duration | **Long runs are fine.** Named profiles: `fast` (90s, upgrade @30s), `default` (5m, upgrade @2m), `soak` (20m, upgrade @4m, rollback @12m). All overridable by env. |
| 12 | Upgrade triggering | **A schedule of timed actions**, not a single trigger point. Enables upgrade-then-rollback in one continuous run with probes never stopping. Measurement windows derive from the marker timeline rather than being three hardcoded phases. |

### What longer runs specifically buy

- **Cron across the metadata clone.** Hasura pre-generates future cron events into
  `hdb_cron_events` in the metadata store. Cloning (rather than starting green fresh)
  exists to preserve them. Only a multi-minute run can assert that events scheduled by
  blue *before* the upgrade actually fire on green *after* it — i.e. it tests the thing
  decision #9 was made to protect.
- **Event retry across the upgrade boundary.** The sidecar deliberately fails a delivery;
  Hasura's backoff retry should land after the switch — scheduled by the old instance,
  delivered by the new one.
- **Rollback has a test at all.** Previously designed but unasserted. Confidence is not
  that upgrades succeed, it is that failures are recoverable.

Deferred (YAGNI): chaining 2.48.4 → 2.49.5 → 2.50.1 in one run. The timed-action schedule
permits it, but it forces blue/green role alternation across three versions and there is
no evidence yet that we need it.
