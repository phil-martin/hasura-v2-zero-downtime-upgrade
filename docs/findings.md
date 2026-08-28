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

**It took three attempts to fix, and each failure taught something.**

*First attempt.* Sync `hdb_action_log` from blue into the clone after blue stops.
Useless: that is ~100 seconds too late for a client polling for 8.

*Second attempt.* Sync every second from the traffic switch, using
`ON CONFLICT DO NOTHING`. Failed the same way. `hdb_action_log` rows are written
twice — once when the action is created, and again when the handler responds — so
a row copied while still in `created` state kept its null `response_payload` on
green permanently. The sync now upserts rows whose target copy is not yet
complete.

*Third attempt, and the actual root cause.* The sync still started at the traffic
switch, leaving the ~1.6 seconds of green's boot and verification uncovered — and
that gap is exactly where the orphaned action lands. The orphan window opens when
the **clone** is taken, not when traffic moves. Starting the sync there closes
it.

Instrumenting the loop proved the mechanism rather than merely observing a pass:

```
actionlog.reconciled { finalPass: 0, syncTicks: 201, syncCopied: 1, syncErrors: [] }
```

**Exactly one** action row per upgrade needs carrying across. That single row is
the entire bug, and it explains the intermittency precisely: whether it landed
inside the uncovered gap was close to a coin flip, which is why identical code
passed standalone and failed in the suite.

Worth noting what made this findable at all. The earlier versions swallowed sync
errors with `.catch(() => {})`, so a silently failing sync was indistinguishable
from a working one — and the probe's message, `output still null`, covered both
"green has no such row" and "green has the row but it is pending", which are
different bugs. Neither could be diagnosed until both were fixed.

The general lesson is worth more than the specific bug. One failure in 34,404
requests — 0.003% — was a real design defect, and the only reason it was findable
is that the bar was zero. An error budget of "less than 0.01%" would have called
those runs a success and shipped the defect three times over.

## 7. Measured comparison

| | Naive (stop, retag, start) | Zero-downtime (blue/green) |
|---|---|---|
| Probe target | published port, no proxy | via HAProxy |
| **Longest contiguous outage** | **1566 ms** | **0 ms** |
| **Failed requests** | **177** | **0** |
| Requests observed | 34,400 | 34,400 |
| Incorrect results | 0 | 0 |
| Lost events (of ~750) | 0 | 0 |
| Missed subscription rows (of ~1187) | 0 | 0 |
| Subscription drops | 14 | 2 |
| Max reconnect | 262 ms | 116 ms |
| Cron fires after upgrade | 3 | 5 |
| Proxy retries | n/a | 0 |

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
+120011ms  upgrade.start
+120023ms  preflight.blue.ok           12ms
+120411ms  metadata.cloned            354ms   (200 cron events preserved)
+121733ms  green.ready               1322ms
+121844ms  green.verified             104ms   (26 correctness probes)
+121885ms  traffic.switch              41ms
+152020ms  drain.complete           30135ms   (timed out, 2 residual)
+222465ms  blue.stopped             70445ms
+222860ms  actionlog.reconciled
+222865ms  upgrade.end             102854ms total
```

The switch itself takes **41 milliseconds**. Everything else is waiting: 30s for
the drain to time out on two held websockets, and 70s for blue's grace period.

Both are configurable and neither affects availability — traffic has already
moved. But it means a "zero-downtime upgrade" takes about 103 seconds of
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

## 10. What proving the harness had teeth revealed

Two of the five fault-injection tests initially failed, and in both cases the
harness was right and the test was wrong. Both are findings.

**A 2-second pause causes no failures at all.** A paused container still accepts
TCP but never answers, so requests hang for the duration and then complete once
it resumes. Against a 10-second client timeout that is a latency excursion — p99
went from 11 ms to 2011 ms — not an outage. The harness correctly reported zero
failures and zero downtime.

That distinction matters more than it looks. A harness that reported a 2-second
pause and a 15-second one identically would not be measuring anything useful, so
there are now two tests: the short pause asserts the excursion is visible *and*
that it is **not** misreported as downtime; the long pause asserts the
genuine-outage signature. The long one crosses two thresholds at once — HAProxy
marks the backend down after two failed 1-second checks, and hung requests exceed
the 10-second client timeout.

**A SIGKILL is invisible through HAProxy.** `retry-on conn-failure` retried the
refused connections against the restarted container, and every request
succeeded. That is the proxy doing exactly its job, but it means the fault tested
the proxy rather than the harness. The test now targets the published port
directly.

Both corrections rhyme with the naive-baseline correction in §7: any measurement
taken through the fix will flatter the fix.

**A note on measurement placement.** The short-pause assertion is made against
the run's overall maximum latency rather than the fault window's. A request that
starts before the pause and hangs through it is recorded when it *completes*,
which is after the fault window has closed — so which window catches the stall
depends on exactly when each probe happened to fire. This is a general hazard of
windowed measurement with long-running requests, and worth knowing about before
trusting any per-window latency figure for a fault shorter than the requests
themselves.

## 11. Recommended next step

The evidence in §1 and §6 points the same way: for this version pair the clone
was unnecessary and it introduced the only correctness defect found in the whole
project.

The natural next move is to make the metadata strategy a **choice** rather than a
constant, and to decide it from evidence at pre-flight:

1. Clone the metadata database into a throwaway and boot the new version against
   it.
2. Compare `hdb_catalog.hdb_version` before and after.
3. If the catalog version did not move, discard the throwaway and run a plain
   **shared-metadata** blue/green — no clone, and therefore no async-action
   orphan window to paper over.
4. If it did move, keep the clone. It is the correct tool for that case, and the
   action-log sync is the price.

This was deliberately not built: the clone-first approach was an explicit
decision (#9), and the scope here was a working upgrade, not a second strategy.
But the measurement now exists to justify it, which is the whole point of having
built the harness first.
