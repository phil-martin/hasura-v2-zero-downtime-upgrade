# Findings

Everything here was measured on this stack, not inferred. Where a number is
machine-dependent it says so.

Environment: Intel i9 (16 cores), Colima VM with 6 CPUs / 10 GB, Postgres 16,
HAProxy 2.9, upgrade path `v2.48.4` → `v2.50.1`, all images pre-pulled.

---

## 1. v2.48.4 and v2.50.1 share catalog version 48

```sql
SELECT version FROM hdb_catalog.hdb_version;
-- hasura_metadata:            48
-- hasura_metadata_<clone>:    48   (after v2.50.1 booted against it)
```

Two minor versions apart, and the metadata catalog does not move.

**This means the metadata clone bought nothing for this version pair.** Plain
blue/green sharing one metadata database would have worked, and would not have
introduced the async-action defect in §6.

This was the trade-off accepted knowingly in decision #9: the clone was built up
front rather than after a failing test. The evidence now says it was not needed
*here*. It remains correct insurance for pairs that do cross a catalog bump, and
it is what makes rollback a proxy flip rather than a database repair — but it is
not free, and this project paid for it.

## 2. Event-trigger state lives in the source database, not the metadata database

Confirmed by inspection: after firing triggers, `hdb_catalog.event_log` has rows
in **appdb**, not in `hasura_metadata`.

So splitting the metadata database — the prerequisite that makes cloning
possible — does **not** isolate event state. Blue and green share the source
`hdb_catalog` for the whole overlap. This was named as a residual risk in the
design and it remains one; we simply measured that it caused no observable
damage for this version pair (0 lost events across every run).

## 3. Hasura pre-generates 200 future cron events into the metadata store

```
SELECT count(*) FROM hdb_catalog.hdb_cron_events;  -- 200
```

This is the concrete justification for cloning the metadata database rather than
booting green against an empty one: a fresh metadata database would silently
discard all 200 scheduled events. The `metadata.cloned` marker records
`cronEventsPreserved: 200` on every run.

## 4. Hasura keeps serving HTTP throughout graceful shutdown

The naive upgrade's timeline:

```
+120008ms  upgrade.start
+190874ms  naive.stopped   { ms: 70866 }   ← docker compose stop returned
+191479ms  naive.started   { ms: 605 }
+192238ms  naive.healthy   { ms: 759 }
```

`docker compose stop` took **70.9 seconds**, yet the measured outage was only
**1566ms**. Hasura continues answering requests for the entire graceful-shutdown
period; the outage is just the gap between the container finally exiting and the
replacement listening.

This is better than expected, and it is worth saying plainly: Hasura's shutdown
behaviour is good.

## 5. On a busy system, graceful shutdown always runs to its full timeout

`naive.stopped` took 70866ms — which is exactly `stop_grace_period: 70s`. Hasura
did not exit on its own; Docker SIGKILLed it.

With event triggers firing continuously there are always in-flight events, so
the graceful-shutdown wait never completes early. Two consequences for
operators:

- `docker compose stop` will block for the full grace period on any busy
  deployment. Budget for it.
- Because the process is ultimately SIGKILLed rather than exiting cleanly, the
  "events are marked pending, not dropped" guarantee is not actually exercised.
  We measured zero lost events anyway, but that is Hasura's re-delivery working,
  not graceful shutdown working.

## 6. The metadata clone orphans in-flight async actions

Found by the harness, not by inspection. The first zero-downtime run reported a
single unexplained `timeout` among 34,404 requests. Investigating:

```
hasura_metadata            hdb_action_log:  81 rows
hasura_metadata_<clone>    hdb_action_log: 193 rows
```

The two diverged. Green reads the clone, but blue keeps serving until it is
drained and stopped — roughly 100 seconds later. An async action created on blue
in that window writes its result to blue's `hdb_action_log`, where green can
never see it. The client polls until it gives up, and the result is lost.

This is caused *by* the clone. Without it, both engines would share one
`hdb_action_log` and the problem would not exist.

**Fix:** the upgrader now syncs `hdb_action_log` from blue into the clone every
second, from the traffic switch until blue stops, plus a final pass afterwards.
That reduces the exposure to about one second.

The general lesson is worth more than the specific bug: a single failure in
34,404 requests was a real design defect, and the only reason it was findable is
that the bar was zero. An error budget of "less than 0.01%" would have called
this run a success and shipped the defect.

## 7. Measured comparison

| | Naive (stop, retag, start) | Zero-downtime (blue/green) |
|---|---|---|
| Probe target | published port, no proxy | via HAProxy |
| Longest contiguous outage | **1566 ms** | **see §8** |
| Failed requests | **177** | |
| Requests observed | 34,400 | 34,404 |
| Incorrect results | 0 | 0 |
| Lost events | 0 | 0 |
| Missed subscription rows | 0 | 0 |
| Subscription drops | 14 | 2 |
| Max reconnect | 262 ms | 114 ms |

The naive figure is the **best case**: images pre-pulled, fast host, small
catalog migration. A real upgrade that has to pull a ~600 MB image would be down
for minutes.

The naive path was measured against the directly-published port, because that is
what a community deployment exposes. Measuring it from behind HAProxy — as the
first attempt did — produced a false "zero downtime" result, because the proxy's
`retry-on conn-failure` silently absorbed the container gap. That correction is
the difference between a harness that flatters the fix and one that tests it.

## 8. Where the time actually goes in a zero-downtime upgrade

```
+120010ms  upgrade.start
+120022ms  preflight.blue.ok           12ms
+120471ms  metadata.cloned            420ms   (200 cron events preserved)
+122104ms  green.ready               1633ms
+122229ms  green.verified             118ms   (26 correctness probes)
+122264ms  traffic.switch              35ms
+152297ms  drain.complete           30033ms   (timed out, 2 residual)
+222738ms  blue.stopped             70441ms
```

The switch itself takes **35 milliseconds**. Everything else is waiting: 30s for
the drain to time out on two held websockets, and 70s for blue's grace period.

Both are configurable and neither affects availability — traffic has already
moved. But it means a "zero-downtime upgrade" takes about 100 seconds of
wall-clock, almost all of it deliberate patience.

The drain reaching its timeout with 2 residual connections is expected: those
are the two subscription websockets, which hold until their client disconnects.
This is exactly the trade the design named — wait longer and clients keep their
subscriptions longer; force-close sooner and they reconnect sooner.

## 9. The zeroes are not proxy artefacts

```
PROXY INTEGRITY
  retries=0 redispatches=0 connErrors=0 respErrors=0
```

HAProxy retried nothing and saw no connection errors during the zero-downtime
run. The switch was clean at the backend level, not merely papered over. This
counter exists because "0 failed requests" is otherwise indistinguishable from
"the proxy hid a real gap", and the first naive run proved that failure mode is
not hypothetical.
