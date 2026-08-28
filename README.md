# Zero-downtime upgrades for single-instance Hasura v2

Upgrading a self-hosted community Hasura v2 deployment without dropping a single
request — and, more importantly, a test harness that can *prove* it.

The harness came first. The upgrade mechanism was built against it.

## The result

`v2.48.4` → `v2.50.1`, five-minute runs, ~34,400 requests each, every major
Hasura v2 feature exercised continuously throughout.

| | Naive (stop, retag, start) | Zero-downtime (blue/green) |
|---|---|---|
| **Longest contiguous outage** | **1566 ms** | **0 ms** |
| **Failed requests** | **177** | **0** |
| Incorrect results | 0 | 0 |
| Lost events (of ~750) | 0 | 0 |
| Missed subscription rows (of ~1187) | 0 | 0 |
| Subscription drops | 14 | 2 |
| Max reconnect | 262 ms | 116 ms |
| Proxy retries | n/a | 0 |

Subscription drops are expected and permitted: a GraphQL websocket is stateful
against one process, so when that process goes away the socket dies and no proxy
can migrate it. What the bar requires is that clients reconnect quickly and miss
**zero** rows, which is asserted by a streaming subscription with a cursor over a
monotonic sequence written directly to Postgres — so rows keep being produced
during any outage and the subscriber must back-fill every one.

## What's tested

Continuously, throughout the upgrade: nested relationships, aggregates,
`distinct_on`, JSONB operators, computed fields, custom SQL functions, views,
enum tables, variables, fragments; inserts with `on_conflict` upsert, `_set`,
`_inc`, JSONB `_append`, deletes, multiple mutations per request; three roles
with row and column permissions, including probes whose *success condition is a
permission denial*; live and streaming subscriptions; event triggers with forced
retries; cron triggers; sync and async Actions; a remote schema and a remote
relationship; a RESTified endpoint.

## Does the harness have teeth?

An instrument that has never been observed responding to a known input is not
evidence. `tests/harness-teeth.test.ts` injects faults and asserts the harness
reports each one's specific signature:

| Injected fault | Must be detected as |
|---|---|
| `docker pause` for 2s | unavailability, sized between 1s and 30s |
| `SIGKILL` | unavailability **and** subscription drops |
| A deliberately corrupted expectation | `wrong-result`, and **not** as downtime |
| Sidecar rejecting deliveries past the retry budget | permanently lost events |
| Restart mid-subscription | drop, with a recorded reconnect |

`tests/naive-upgrade.test.ts` asserts the naive path's damage **exceeds a
floor** — not merely that it failed. If that damage ever drops below the floor,
either the harness lost detection power or something changed underneath us.

## Quick start

```bash
npm install
npm run stack:up        # postgres, sidecar, haproxy, hasura-blue
npm run seed            # schema, deterministic data, metadata
npm run snapshot        # capture oracle expectations

npm run harness -- --profile=fast --policy=strict --upgrader=none
npm run harness -- --profile=default --policy=zero-downtime --upgrader=zero-downtime
npm test                # full suite: baseline ×3, naive, teeth, zero-downtime, rollback
```

`FROM_VERSION` / `TO_VERSION` select the upgrade path. Profiles are `fast` (90s),
`default` (5 min) and `soak` (20 min, with a rollback at 12 min). Policies are
`strict`, `zero-downtime` and `informational`.

## How it works

**Measurement is primary; thresholds are policy.** A run always produces the full
set of numbers. Rates are computed per window — before, during and after each
orchestrator action — because a whole-run denominator hides everything: an
8-second outage inside a 5-minute run is 2.6% of requests, which reads as almost
fine. And because rate alone cannot distinguish evenly-spread flakiness from one
solid block, the headline number is **longest contiguous outage**.

**The oracle rests on a partition split.** Immutable tables are seeded once and
never written by any probe, so every read has an exact expected result checked by
deep equality. Mutable tables are only touched by mutation probes and asserted by
round-trip. Read correctness therefore never depends on concurrent write state.

**The upgrade is a sequence of gates.** Green boots against a *clone* of the
metadata database, so its catalog migration never touches the database blue is
serving from. Before any traffic moves, the entire correctness suite runs against
green directly — if the new version disagrees with the oracle about anything, the
upgrade aborts with blue still serving and nobody affected.

## Two things worth knowing before you copy this

**The clone was not needed for this version pair.** v2.48.4 and v2.50.1 both use
catalog version 48, so plain shared-metadata blue/green would have worked — and
would have avoided a real defect the clone introduced (see below). The clone
remains correct insurance for version pairs that *do* cross a catalog bump, and
it is what makes rollback a proxy flip rather than a database repair. But it is
not free.

**The bar being zero is what made this work.** The first zero-downtime run
reported one failure in 34,404 requests. That single failure was a genuine design
defect: green reads the metadata clone, but blue keeps serving for ~100 more
seconds, so an async action created on blue in that window wrote its result
somewhere green could never see it. An error budget of "under 0.01%" would have
called that run a success and shipped the bug — twice, because the first attempt
at fixing it had a bug of its own.

## Documentation

- [`docs/prerequisites.md`](docs/prerequisites.md) — the two one-time migrations, and a Compose default that silently breaks event processing
- [`docs/runbook.md`](docs/runbook.md) — the upgrade procedure, abort and rollback paths
- [`docs/findings.md`](docs/findings.md) — everything measured, including the surprises
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — the design this was built from
