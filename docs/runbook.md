# Upgrade runbook

Assumes both prerequisites in `docs/prerequisites.md` are done: metadata lives
in its own database, and HAProxy fronts the engine.

## The shape of it

```
blue (old, serving)                          green (new)
       │
       ├─ 1. pre-flight: export metadata, assert consistent
       ├─ 2. clone metadata DB ──────────────────► hasura_metadata_<id>
       │                                             │
       │                                    3. boot green against the clone
       │                                       (green migrates the COPY's
       │                                        catalog; blue's is untouched)
       │                                             │
       │                                    4. GATE: health, version,
       │                                       consistency, and run the full
       │                                       correctness suite against green
       │                                       directly — before any traffic
       │                                             │
       ├──────── 5. green ready, THEN blue drain ────┤
       ├─ 6. wait for blue's sessions to reach zero  │
       ├─ 7. SIGTERM blue with full grace period     │
       │                                             ▼
                                          green is now canonical
```

## Why the order matters

**Green becomes `ready` before blue starts draining.** Reversing this leaves an
instant with no ready backend, which is exactly the downtime we are trying to
avoid.

**The gate at step 4 is the point of the whole exercise.** It converts "upgrade
and hope" into "prove, then switch". If the new version disagrees with the
oracle about anything — a changed numeric format, a permission that silently
widened, a broken remote relationship — you find out while blue is still serving
every user request, and abort with nobody affected. A failed upgrade becomes a
non-event.

**The clone is a copy, not a fresh database.** Hasura pre-generates future cron
events into `hdb_cron_events` in the metadata store. On this stack that is 200
events sitting there at any moment. Booting green against an empty metadata
database would silently discard all of them.

## Running it

```bash
npm run stack:up
npm run harness -- --profile=default --policy=zero-downtime --upgrader=zero-downtime
```

Versions come from `FROM_VERSION` / `TO_VERSION`, defaulting to `v2.48.4` →
`v2.50.1`.

## Reading the result

The headline number is **longest contiguous outage**. Failure *rate* cannot
distinguish 2% spread evenly across a run (flakiness) from 2% concentrated in
one solid block (an outage) — only the contiguous measure can.

Check the **PROXY INTEGRITY** section too. A clean switch should need no
retries. Non-zero `retries` or `connErrors` alongside "0 failed requests" means
HAProxy absorbed a real backend gap, and the zero is partly the proxy rather
than purely the switch.

## Abort

The upgrade aborts itself, before any traffic moves, if:

- blue's metadata is already inconsistent at pre-flight
- green reports an unexpected version
- green finds the existing metadata inconsistent
- any correctness probe fails against green

On abort: green is stopped, the clone is dropped, `upgrade.aborted` is recorded,
and blue keeps serving. There is nothing to clean up and no user impact.

## Rollback

**Before blue has stopped** — a proxy state change only. Blue's metadata
database was never migrated, so there is nothing to repair:

```
set server be_hasura/blue state ready
set server be_hasura/green state drain
```

**After blue has stopped** — restart blue against its original, untouched
metadata database, then flip the proxy back. The old metadata database is
retained until you explicitly clean it up, precisely so this stays possible.

```bash
npm run harness -- --profile=soak --policy=zero-downtime --upgrader=zero-downtime
```

The `soak` profile schedules an upgrade at 4 minutes and a rollback at 12, with
probes never stopping, so the rollback is measured the same way the upgrade is.

## Afterwards

Green's clone is now the canonical metadata database, so blue and green
alternate roles between upgrades. The orchestrator discovers which is current by
inspecting the running container's environment rather than tracking it in a
state file — a file can drift from reality, a running container cannot.

Clean up the superseded metadata database only once you are confident you will
not roll back:

```sql
DROP DATABASE hasura_metadata_<old_id>;
```

## What this does not give you

**Subscription continuity.** A GraphQL websocket is stateful against one
process. When that process goes away the socket dies, and no proxy can migrate
it. What you get is a fast reconnect with no missed data — the streaming
subscription resumes from its cursor and back-fills everything written while it
was gone. Clients must handle reconnection; most GraphQL clients do by default.

**Safety while metadata is changing.** Do not apply metadata changes during an
upgrade. The orchestrator detects drift by comparing `resource_version` before
and after and records a `metadata.drift` marker, but it cannot prevent it.
