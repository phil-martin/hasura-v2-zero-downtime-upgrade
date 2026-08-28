# Prerequisites

Zero-downtime upgrades require two one-time changes to an existing deployment.
Each needs a short planned maintenance window. After both are done, every
subsequent upgrade is zero-downtime.

Be honest with yourself about the order: do these on a quiet day, separately,
verifying after each. They are not the risky part of the project, but doing both
at once while also upgrading Hasura would make any failure hard to attribute.

---

## Prerequisite A — split metadata into its own database

### Why

Hasura stores its metadata catalog in a `hdb_catalog` schema. By default, on a
single-instance community deployment, that lives in the same database as your
data, because only `HASURA_GRAPHQL_DATABASE_URL` is set.

A newer `graphql-engine` runs catalog migrations on boot. If the old and new
versions share one metadata store during a blue/green overlap, the new one
migrates the catalog out from under the old one — and
`HASURA_GRAPHQL_SCHEMA_SYNC_POLL_INTERVAL` defaults to 1000ms, so the old
instance will notice within a second.

Separating the metadata database lets green boot against a **clone**. Green
migrates the copy; blue's catalog is never touched. That is also what makes
rollback cheap: reverting is a proxy state change, not a database repair.

### What this does NOT fix

Event-trigger state does not live in the metadata database. Hasura stores
`event_log` and `event_invocation_logs` in the `hdb_catalog` schema of **the
database containing the source table**. That surface stays shared between the
two versions during the overlap. Splitting the metadata database does nothing
about it. See `docs/findings.md` for what we measured.

### Steps

```bash
# 1. Export current metadata. Keep this file; it is your rollback.
curl -s -X POST http://localhost:8080/v1/metadata \
  -H "x-hasura-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"type":"export_metadata","args":{}}' > metadata-backup.json

# 2. Confirm you are starting from a consistent state. If this is not empty,
#    fix that first — do not carry a broken metadata state into a migration.
curl -s -X POST http://localhost:8080/v1/metadata \
  -H "x-hasura-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"type":"get_inconsistent_metadata","args":{}}'

# 3. Create the metadata database.
psql "$DATABASE_URL" -c 'CREATE DATABASE hasura_metadata'

# 4. Add HASURA_GRAPHQL_METADATA_DATABASE_URL to the Hasura service and restart.
#    Hasura initialises a fresh catalog in the new database.
#    THIS IS THE MAINTENANCE WINDOW — expect a restart's worth of downtime.
docker compose up -d hasura

# 5. Reapply the metadata you exported in step 1.
python3 -c "import json;m=json.load(open('metadata-backup.json'));\
print(json.dumps({'type':'replace_metadata','args':m}))" > replace.json
curl -s -X POST http://localhost:8080/v1/metadata \
  -H "x-hasura-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' --data @replace.json

# 6. Verify consistency again. It must be empty.
```

### What you lose, and what you do not

Moving to a fresh metadata database discards anything that lived in the old
metadata catalog:

| State | Lives in | Survives? |
|---|---|---|
| Tracked tables, relationships, permissions | metadata (exported/reimported) | **Yes** |
| Event triggers and their queued events | *source* database | **Yes** — untouched |
| Future cron events (`hdb_cron_events`) | metadata | Regenerated automatically from the cron schedule |
| One-off scheduled events | metadata | **No** — re-create them manually |
| Async action logs (`hdb_action_log`) | metadata | **No** — historical only |

If you rely on one-off scheduled events, list them before you start:

```sql
SELECT id, webhook_conf, scheduled_time, status
FROM hdb_catalog.hdb_scheduled_events
WHERE status = 'scheduled';
```

---

## Prerequisite B — put HAProxy in front

### Why

Nothing can hold a client connection while the process behind it is replaced
unless such a layer exists. This is not optional: it is the entire mechanism.

HAProxy specifically, rather than nginx or Caddy, because draining is a
first-class server state and `show stat` lets the upgrade orchestrator *observe*
that a drain has completed rather than sleeping and hoping.

### Steps

1. Stop publishing Hasura's port to the host. On a compose deployment, change
   `ports: ["8080:8080"]` to nothing — the engine stays reachable inside the
   compose network by service name.
2. Add the HAProxy service, publishing `8080` and the runtime API on
   `127.0.0.1:9999`. Use `compose/haproxy/haproxy.cfg` in this repo as the
   starting point.
3. Bring both up. **THIS IS THE MAINTENANCE WINDOW** — the port moves from one
   process to another.

### Configuration that carries weight

These are not stylistic choices; each one exists for a reason.

| Setting | Why |
|---|---|
| `option httpchk` + `GET /healthz` | The switch is gated on the new engine actually answering, not on the container having started. |
| `timeout tunnel 1h` | Subscriptions are long-lived websockets. Without this they are cut at the idle timeout, which looks exactly like upgrade damage. |
| `option http-server-close` | Closes backend connections after each response. Without it, backend connections are pooled and a *drained* server keeps serving over them — `drain` would not actually move traffic, and waiting for the drain would be measuring nothing. |
| `retry-on conn-failure` **only** | Fires when the connection never established, so the request provably never reached Hasura and replaying it is safe. Broader conditions such as `empty-response` could double-apply a mutation, and every GraphQL call is a POST. |
| `resolvers docker` + `init-addr last,libc,none` | Green does not exist when the stack first boots. Without periodic re-resolution HAProxy resolves once, fails, and never finds green when it appears. |

---

## Prerequisite C — a Compose default you must override

Not a migration, but a one-line fix worth doing at the same time, and one many
community deployments are missing.

Compose defaults `stop_grace_period` to **10 seconds**. Hasura's
`HASURA_GRAPHQL_GRACEFUL_SHUTDOWN_TIMEOUT` defaults to **60 seconds**, and that
is what lets in-flight event triggers, scheduled triggers and async actions
finish — events not completed in time are marked *pending*, not dropped.

Left at defaults, Compose sends SIGKILL ten seconds into a sixty-second graceful
shutdown, straight through in-flight event processing.

```yaml
services:
  hasura:
    stop_grace_period: 70s          # must exceed the graceful shutdown timeout
    environment:
      HASURA_GRAPHQL_GRACEFUL_SHUTDOWN_TIMEOUT: "60"
```
