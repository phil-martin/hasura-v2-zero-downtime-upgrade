# Zero-downtime upgrades for single-instance Hasura v2 — design

Status: approved for planning
Date: 2026-08-28

## 1. Purpose

Make it possible to upgrade a self-hosted, single-instance Hasura v2 deployment
with zero downtime, and to *know* it worked rather than hope it did.

The confidence comes from a wide-coverage test harness that drives every major
Hasura v2 feature continuously while an upgrade happens underneath it, and
measures exactly what broke. The harness is built and proven first; the
zero-downtime mechanism is built against it second.

## 2. Success criteria

The harness measures; thresholds are policy applied on top (§8). The bar the
project is driving toward:

- **HTTP queries and mutations**: zero failed requests, zero incorrect results.
- **Subscriptions**: connections may drop, but must reconnect within a budget
  and miss zero data.
- **Event triggers**: zero lost events. At-least-once delivery; duplicates are
  recorded but acceptable.
- **Cron/scheduled triggers**: events scheduled before the upgrade still fire
  after it.
- **Rollback**: recoverable at any point, with no worse impact than the upgrade
  itself.

Subscription continuity is explicitly *not* claimed. A GraphQL websocket is
stateful against one process; when that process goes away the socket dies and no
proxy can migrate it. Fast reconnect with no missed data is the achievable goal.

## 3. Scope

**In scope**

- Docker Compose on a single host (the classic community self-host shape).
- Upgrade path parameterised by env, defaulting to `v2.48.4` (2025-08-19) →
  `v2.50.1` (2026-08-18). Two minor versions apart, so likely to cross a catalog
  version bump — the interesting case.
- Feature coverage: core queries + mutations + RBAC; subscriptions (live and
  streaming); event triggers + cron triggers; Actions + remote schemas + remote
  relationships + RESTified endpoints.

**Out of scope**

- Kubernetes, Swarm, multi-host, and Hasura EE-only features (query caching,
  read replicas).
- Non-Postgres sources (MSSQL, BigQuery, Citus).
- Hasura v3 / DDN.
- Performing the two prerequisite migrations (§11) against a live production
  deployment. These are documented as procedures, not automated or harnessed.

## 4. Prerequisites the design imposes

Two one-time changes to a deployment, each needing a planned maintenance window.
After they are done, every subsequent upgrade is zero-downtime.

1. **Introduce HAProxy** in front of Hasura. Nothing can hold a client
   connection while the process behind it is replaced unless such a layer
   exists.
2. **Split metadata into its own database.** Required so green can boot against
   a *clone* of the metadata store, leaving blue's catalog untouched.

## 5. Topology

One Postgres server hosting several databases:

| Database | Purpose |
|---|---|
| `appdb` | The tracked data source. Its `hdb_catalog` schema holds `event_log` and `event_invocation_logs`. |
| `hasura_metadata` | Metadata store — tracked tables, permissions, triggers, and `hdb_cron_events`. |
| `hasura_metadata_<runid>` | Clone created per upgrade; becomes canonical on success. |

Separate *databases* on one server, not separate servers: this is what Hasura
means by a separate metadata store, it matches a single-host community box, and
it makes cloning cheap.

Compose services:

- `postgres` — Postgres 16.
- `hasura-blue` — `hasura/graphql-engine:$FROM_VERSION`, internal `:8080`.
- `hasura-green` — `hasura/graphql-engine:$TO_VERSION`, started on demand.
- `haproxy` — publishes host `:8080`; Runtime API on `127.0.0.1:9999`.
- `sidecar` — one Node service hosting the event webhook, cron webhook, Actions
  handler, and remote schema, recording every delivery with timestamps.

The harness runs on the host, not in Compose, so it observes the stack from
outside and survives anything that happens inside it.

### 5.1 HAProxy configuration essentials

- `mode http`, `option httpchk GET /healthz`.
- `timeout tunnel 1h` so subscriptions are not severed by the idle timeout.
- `stats socket ipv4@0.0.0.0:9999 level admin` for the Runtime API.
- `server green ... disabled` at boot.
- `retry-on conn-failure` **only**. That case fires when the connection never
  established, so the request provably never reached the server and replaying it
  is safe. Broader retry conditions such as `empty-response` would risk
  double-applying a mutation, and every GraphQL call here is a POST.

### 5.2 A Compose default that must be overridden

Compose's default `stop_grace_period` is **10s**. Hasura's
`HASURA_GRAPHQL_GRACEFUL_SHUTDOWN_TIMEOUT` defaults to **60s** and is what
allows in-flight event triggers, scheduled triggers, and async actions to finish
(events not completed in time are marked *pending*, not dropped).

Left at defaults, Compose SIGKILLs Hasura ten seconds into a sixty-second
graceful shutdown, straight through in-flight event processing. Both Hasura
services set `stop_grace_period: 70s`.

## 6. The tested surface

### 6.1 Schema — partitioned by mutability

The oracle depends on a strict split. Read correctness must never depend on
concurrent write state; that is the flakiness class most likely to sink the
project.

**Immutable partition** — seeded once, never written by any probe. Every read
probe against these has an exact expected result, checked by deep equality.

- `authors` (50 rows), `books` (500 rows), `reviews` (2000 rows) with object and
  array relationships between them.
- `genres` as an enum table.
- `book_stats` — a view.
- `search_books(search text)` — a stable SETOF function, exposed as a query.
- `books.discounted_price(pct)` — a computed field.
- JSONB (`books.tags`), numeric, boolean, and timestamp columns.

Seed data is fixed and deterministic: literal ids, no `now()`, no randomness.

**Mutable partition** — only ever touched by mutation probes.

- `orders` (uuid pk, unique `probe_key`, jsonb `payload`).
- `counters` for `_inc` mutations.
- `seq_stream` (bigserial, monotonic `seq`) — the source for streaming
  subscription gap detection.
- `events_source` — the table event triggers fire from.

### 6.2 Metadata

- **Roles**: `admin`, `user` (row permission on `X-Hasura-User-Id`, one column
  denied), `anonymous` (filtered to `in_print = true`, limited columns).
- **Event triggers**: on `events_source` INSERT and on `orders` UPDATE, both to
  the sidecar, with `num_retries: 3`, `interval_sec: 5`, `timeout_sec: 10`.
- **Cron trigger**: `heartbeat`, `* * * * *`, to the sidecar. One minute is
  Hasura's finest cron granularity.
- **Actions**: `computeQuote` (sync, deterministic, exactly verifiable) and
  `slowEcho` (async).
- **Remote schema**: served by the sidecar, plus a remote relationship from
  `books`.
- **RESTified endpoint**: `/api/rest/book/:id`.

### 6.3 Probes

Roughly 35 probes across nine groups. Request/response probes run repeatedly on
a schedule; subscription probes are long-lived.

| Group | Probes |
|---|---|
| `query` | simple select; nested object rel; nested array rel; `_and`/`_or`/`_not`; order+limit+offset; aggregates; `distinct_on`; JSONB containment; computed field; SQL function; view; enum filter; variables; aliases+fragments |
| `mutation` | insert+returning; multi-row insert; upsert `on_conflict`; `_set`; `_inc`; JSONB `_append`; delete+returning; two mutations in one request |
| `rbac` | row filter for `user`; denied column; `anonymous` restriction; cross-user access denied |
| `subscription` | live query on `max(seq)`; **streaming subscription with cursor over `seq`**; live aggregate |
| `event` | insert fires delivery; update fires delivery; retry lands after deliberate sidecar failure |
| `cron` | heartbeat fires observed vs expected |
| `action` | sync `computeQuote` exact result; async `slowEcho` create-then-poll |
| `remote` | remote schema query; remote relationship join |
| `rest` | RESTified endpoint |

Mutation probes generate a unique `probe_key` per invocation and assert
round-trip: the `returning` payload must echo what was sent, a follow-up read
must find it, counts are monotonic, and an upsert yields exactly one row.

The **streaming subscription with a cursor** is the only construction here that
proves "missed zero data" rather than assuming it: a writer probe advances `seq`
at fixed cadence, and any gap in the received sequence is data loss.

### 6.4 Probe outcomes

```ts
type ProbeOutcome =
  | { ok: true;  latencyMs: number }
  | { ok: false; latencyMs: number; kind: FailureKind; detail: unknown }

type FailureKind =
  | 'unavailable'    // ECONNREFUSED, ECONNRESET, 502, 503, 504
  | 'graphql-error'  // well-formed response carrying `errors`
  | 'wrong-result'   // 200 OK, wrong data
  | 'timeout'
```

Classification is part of the design, not of the reporting. These point at
different bugs and must never be blurred together.

## 7. Timeline and windows

Every outcome is recorded as `{ t, probeId, group, ok, kind, latencyMs }`.

Upgraders emit markers into the same timeline — `upgrade.start`,
`metadata.cloned`, `green.ready`, `green.verified`, `traffic.switch`,
`drain.complete`, `upgrade.end`, `upgrade.aborted`, `rollback.*`.

Measurement windows are **derived from the marker timeline**, not hardcoded: one
window per action, plus the quiet stretches between them. This falls out
naturally once the upgrade trigger becomes a schedule (§10).

## 8. Scorecard and policies

Measurement is primary. Thresholds are named policies in config.

Rates are computed **per window**, never only across the whole run: an
eight-second outage inside a five-minute run is about 2.6% of requests, which
reads as almost fine. The quiet window before an action is the control the
action window is compared against.

Rate alone also hides shape — 2% spread evenly is flakiness, 2% in one
contiguous block is downtime. So peaks are recorded alongside rates.

| Dimension | Measures |
|---|---|
| Availability | failed-request rate per window; **longest contiguous unavailability (ms)**; worst 1-second bucket |
| Correctness | incorrect-result rate; GraphQL-error rate (kept separate) |
| Latency | p50/p95/p99/max per window, action window vs preceding quiet window |
| Subscriptions | drop count; reconnect p50/max; missed rows, count and rate |
| Events | lost count and rate; duplicate rate; delivery latency percentiles |
| Cron | fires observed vs expected |

**Longest contiguous unavailability is the headline downtime number.**

Policies:

- `strict` — zero of everything.
- `zero-downtime` — 0 lost events, 0 missed subscription rows, 0 incorrect
  results, contiguous outage ≤ configured ms, error rate ≤ configured %.
- `informational` — no thresholds; report only.

Test files assert against a named policy rather than hardcoded numbers, so the
bar can be dialled without touching test code.

### 8.1 Event reconciliation needs a settle window

Because graceful shutdown marks unfinished events *pending* rather than dropping
them, an event may legitimately arrive after the new instance picks it up.
Reconciliation therefore runs after a post-run drain-settle period, not at the
instant the run ends.

## 9. Proving the harness has teeth

Until this passes, a green result from this harness means nothing.

`harness-teeth.test.ts` injects faults and asserts the harness **catches** each:

| Injected fault | Must be detected as |
|---|---|
| `docker pause hasura-blue` for 2s | `unavailable` failures, contiguous outage ≈2s |
| `docker kill -s SIGKILL hasura-blue` | unavailability *and* lost/delayed events |
| A deliberately corrupted expected result | `wrong-result` |
| Sidecar paused during event delivery | event delivery delay |
| Hasura killed mid-subscription | subscription drop with reconnect recorded |

Alongside these, `naive-upgrade.test.ts` asserts the naive path's measured damage
**exceeds a floor** — a real contiguous outage of at least a few seconds, real
event damage. If the naive path's damage ever falls below that floor, either the
harness lost detection power or something changed underneath us. Either way we
want to be told.

Baseline must pass **three consecutive runs** before it is trusted. A flaky
harness is worse than none, because it turns every real regression into a shrug.

## 10. Upgraders

Both implement one interface and emit markers into the shared timeline.

### 10.1 Naive — the red baseline

What a community user does today: stop the Hasura container, retag, start it. It
does not touch green; using blue/green would be cheating the baseline. Expected
damage is stop time plus boot time plus catalog migration, plus in-flight events.

### 10.2 Zero-downtime

A sequence of gates, each observable:

1. **Pre-flight on blue** — record version, `export_metadata`, assert
   `get_inconsistent_metadata` is empty. Never start from a broken state. Record
   the metadata `resource_version` so drift during the window can be detected.
2. **Clone the metadata DB** — `pg_dump | psql` into `hasura_metadata_<runid>`.
   (`CREATE DATABASE ... TEMPLATE` is faster but requires zero connections to
   the template, and blue is connected.)
3. **Boot green against the clone** — green migrates the clone's catalog; blue's
   is untouched.
4. **Gate on green** — health; version equals `$TO_VERSION`;
   `get_inconsistent_metadata` empty; then **run the entire probe suite once
   against green directly, bypassing HAProxy**. Correctness is verified on the
   new version before a single user request reaches it. On any gate failure:
   stop green, drop the clone, emit `upgrade.aborted`, leave blue serving. A
   failed upgrade is a non-event.
5. **Switch** — `set server hasura/green state ready`, *then* `set server
   hasura/blue state drain`. In that order, so there is never an instant without
   a ready backend.
6. **Drain** — poll `show stat` for blue's current sessions until zero or
   timeout. Subscriptions hold their sockets, so this is where the reconnect
   budget is spent: waiting longer preserves subscriptions but lengthens the
   upgrade. Configurable, 30s default. Emit `drain.complete` with duration and
   residual connection count.
7. **Stop blue** — SIGTERM with `stop_grace_period` ≥ Hasura's graceful shutdown
   timeout (§5.2).
8. **Post-conditions** — green is the only ready backend; metadata
   `resource_version` unchanged since pre-flight; blue's original metadata DB
   retained until explicit cleanup.

### 10.3 Rollback

Before step 7: flip the HAProxy states back. Blue's metadata was never migrated.
After step 7: restart blue against its original metadata DB, still intact.

### 10.4 Role alternation

After a successful upgrade, green's clone is the canonical metadata DB, so the
roles alternate. Rather than track this in a state file that can drift, the
orchestrator discovers the current metadata DB by inspecting the running
container's environment — stateless, and it cannot disagree with reality.

## 11. Execution model

A CLI drives everything: `--profile`, `--schedule`, `--policy`.

The upgrade trigger is a **schedule of timed actions**, not a single point. This
is what makes rollback testable at all — probes never stop, and one continuous
run can cover upgrade, settle, rollback, settle.

| Profile | Duration | Schedule |
|---|---|---|
| `fast` | 90s | upgrade @30s |
| `default` | 5m | upgrade @2m |
| `soak` | 20m | upgrade @4m, rollback @12m |

All overridable by env, along with `FROM_VERSION` / `TO_VERSION`.

Long runs are what make three assertions possible at all:

- **Cron across the metadata clone.** Hasura pre-generates future cron events
  into `hdb_cron_events` in the metadata store, which is exactly what cloning
  (rather than starting green fresh) exists to preserve. Only a multi-minute run
  can assert that events scheduled by blue *before* the upgrade fire on green
  *after* it.
- **Event retry across the upgrade boundary.** The sidecar deliberately fails a
  delivery; the backoff retry should land after the switch — scheduled by the
  old instance, delivered by the new one.
- **Rollback tested at all.** Confidence is not that upgrades succeed; it is
  that failures are recoverable.

Test files:

- `baseline.test.ts` — no upgrade, policy `strict`, three consecutive runs.
- `naive-upgrade.test.ts` — asserts damage exceeds the detection floor.
- `zero-downtime.test.ts` — policy `zero-downtime`.
- `rollback.test.ts` — upgrade then rollback in one run.
- `harness-teeth.test.ts` — fault injection (§9).

## 12. Repo layout

```
compose/          docker-compose.yml, haproxy/haproxy.cfg
seed/             schema SQL, deterministic seed data, Hasura metadata
sidecar/          event + cron webhooks, Actions handler, remote schema
src/
  config/         profiles, policies, version pins
  stack/          compose lifecycle, health waiting
  haproxy/        Runtime API client (setState, showStat, waitDrained)
  hasura/         admin client (metadata API, healthz, version)
  probes/         one module per group
  oracle/         expected results and invariants
  runner/         scheduler, concurrency, timeline recorder
  report/         scorecard, policy evaluation, timeline rendering
  upgraders/      naive.ts, zero-downtime.ts
tests/
docs/
```

## 13. Build phases

1. **Scaffold** — Compose stack, seed schema and metadata, stack up/down/health.
2. **Harness** — probes, oracle, runner, scorecard. Exit criterion: baseline
   green three consecutive runs.
3. **Red baseline and teeth** — naive upgrader, fault injection tests. **This is
   the checkpoint that makes the harness trustworthy**; do not proceed early.
4. **Zero-downtime upgrader** — including abort and rollback paths.
5. **Docs** — prerequisite migration procedures, upgrade runbook, and the
   measured findings.

## 14. Residual risks

- **Shared source catalog.** Blue and green share `appdb`'s `hdb_catalog` during
  overlap. Hasura stores `event_log` and `event_invocation_logs` in the source
  database, not the metadata database, so splitting the metadata store does not
  isolate them. If v2.50.1 migrates the event-log schema on source
  initialisation, blue is exposed during the overlap. The harness measures
  whether this actually bites; it is not solved by design.
- **Clone built ahead of evidence.** The clone was chosen up front rather than
  after a failing test. If 2.48.4 and 2.50.1 turn out to share a catalog
  version, plain shared-metadata blue/green would have sufficed and the clone is
  unneeded complexity. We will not learn this unless we later test it
  explicitly. Recorded as an accepted trade-off.
- **Metadata changes during an upgrade** are not supported. The orchestrator
  detects drift via `resource_version` and aborts, but cannot prevent it.
- **Subscription continuity** is not achievable and is not claimed (§2).
