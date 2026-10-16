# Control-plane job queue

Status: the queue core is implemented and tested, but **nothing runs it yet**.
No production module imports `JobRunner` or enqueues a job, so a control-plane
deploy that carries migration `0148_control_plane_jobs.sql` adds an empty
table, two triggers and a policy, and nothing else changes. Later slices move
the reconciler's due work onto it (see [next slice](#next-slice-the-six-due-kinds)).

Source: `apps/control-plane/src/job-queue.ts` (SQL operations),
`apps/control-plane/src/job-runner.ts` (runner), migration
`apps/control-plane/migrations/0148_control_plane_jobs.sql`. Tests:
`src/job-queue.test.ts` and `src/job-queue.integration.test.ts`.

## Semantics

- **At least once.** A job can run again after a process crash, a lost or
  expired lease, a handler timeout or a shutdown release. Handlers re-read and
  fence their domain state (generation, epoch, lease) exactly as today's
  claims do. A notification or a job row never grants authority.
- **States.** `queued` → `running` → deleted on success. A retryable failure
  returns to `queued` with a later `run_at`. `failed` is terminal and retained
  until `purgeFailedJobs` removes it. Completed jobs are not retained.
- **Dedupe.** At most one active (`queued` or `running`) job per
  `(kind, dedupe_key)` (partial unique index). A `failed` job does not block a
  new one. Encode the scope in the key (for example `workspace:<id>`); a
  re-enqueue keeps the original `org_id` and `workspace_id`.
- **Earliest wins.** Re-enqueueing a queued job can only move `run_at`
  earlier; the payload is replaced by the latest one. Identical re-enqueues
  write nothing and return `unchanged`. A handler that finds work not yet due
  enqueues it again with the later time after it completes.
- **Rerun during a run.** Re-enqueueing a `running` job records `rerun_at`.
  Completion then requeues the job at that time with a fresh attempt budget
  instead of deleting it, so a change committed during a run is never absorbed
  by a run that read older state. Completion locks the row before it decides,
  so a rerun that commits while completion waits is still honored (covered by
  a regression test). A failed run clears `rerun_at` because its retry is
  itself a later run; a final failed attempt with a pending rerun starts a
  fresh job instead of failing.
- **Leases.** A claim sets `lease_owner`, a new `lease_token` and
  `locked_until = now() + leaseMs` (default 60 s, per kind) and increments
  `attempts`. Every completion, failure, extension and release is fenced by
  `id` and `lease_token`, so a previous holder can never settle a reclaimed
  job. The runner extends a held lease at half its length. When a lease
  expires, the job becomes claimable again (`last_error_code = lease_expired`);
  if that was the final attempt, the next claim marks it `failed` instead.
- **Retries.** Exponential backoff with equal jitter: the ceiling is
  `min(maxMs, baseMs × 2^(attempt−1))`, the delay is half the ceiling plus a
  random share of the other half. Defaults: 5 s base, 15 min cap, 10 attempts.
  A `JobError` can carry `retryAfterMs` (for example a provider `Retry-After`),
  which raises the delay, and can be marked non-retryable, which fails at once.
- **Error codes.** `last_error_code` is a closed vocabulary
  (`JOB_ERROR_CODES` plus `lease_expired`). Handlers report a specific failure
  only through `JobError`; any other exception is stored as `handler_failed`,
  and unavailable-database errors as `database_unavailable`. Raw messages are
  never persisted, and the column's check rejects free text.
- **Payloads** are JSON objects of at most 4 KiB holding identifiers, never
  credentials. Keys that look like secrets (`token`, `secret`, `password`,
  `credential` and similar) are rejected before any SQL runs.

## Runner

`JobRunner` takes a handler registry keyed by kind, a concurrency bound
(default 4, at most 32) and a pool. It claims only registered kinds, at most
the number of free slots, and claims again when a slot frees up only if the
previous claim filled every slot. Handlers receive an `AbortSignal` that fires
on timeout (default 5 min), lease loss and shutdown. A handler that ignores the
signal loses its slot and lease at that point, and its late result is
discarded.

Shutdown (`stop()`) stops claiming, unsubscribes, waits for in-flight
handlers up to `drainTimeoutMs` (default 10 s), then aborts the rest and
returns their leases in one statement. Released jobs are due immediately for
another replica and the interrupted attempt is not counted.

## Wake-ups

- **NOTIFY by trigger.** `AFTER INSERT` and `AFTER UPDATE OF state, run_at`
  triggers send an empty hint on `zeros_control_plane_job_work` (reusing
  `notify_cloud_worker_available` from `0134`) when a job becomes or stays
  `queued` with a changed state or `run_at`. Triggers rather than explicit
  `pg_notify` calls: every writer, including a transactional enqueue inside
  another worker's transaction, an operator repair or a later slice, wakes
  runners, and the hint is delivered only after commit. Idempotent
  re-enqueues, claims and deletions stay silent.
- **Shared LISTEN session.** The runner subscribes through
  `postgresNotificationSubscription`, the process's existing dedicated
  listener. Its reconnect behavior is unchanged: on loss it reconnects after
  1 s (doubling to 30 s), and every successful (re)subscription calls the
  runner's flush, which re-reads the queue. Hints sent during the gap are lost;
  rows are not.
- **Due times.** Each claim also returns the earliest `run_at` among unclaimed
  queued jobs of the runner's kinds, using one ordered index probe per kind.
  The runner sets one timer for the earlier of that time and the fallback
  poll. When due rows were skipped because another worker held their locks,
  it retries after 1 s.
- **Fallback poll.** 45 s by default with 75–100 % jitter (configurable from
  1 s to 5 min; never sub-second). It covers lost hints and expired leases,
  which are deliberately not part of the due-time hint: lease extensions
  would otherwise wake every replica on each extension.

Measured locally (PostgreSQL 18, loopback): commit-to-handler latency of
1.7 ms median and 2.6 ms max over 10 notified jobs. A job committed with its
hint suppressed ran on the 1 s test poll, and a job enqueued while the LISTEN
session was down ran on the resubscription flush long before the 60 s poll.

## Database cost

All queue operations other than enqueue run as one simple-protocol batch
(`withSystemStatement` in `src/db.ts`): `BEGIN`, `SET LOCAL ROLE zeros_app`,
`set_config('app.system', 'on', true)`, the statement and `COMMIT`. That is
the same role and RLS context as `withSystemTx` in one round trip instead of
three. Because the simple protocol cannot bind parameters, these statements
interpolate only integers, UUIDs, kinds, owner IDs and error codes, each
validated against a closed character set without quotes.

| Operation | Round trips | Statements |
| --- | --- | --- |
| Claim (any batch size, including an empty one) | 1 | 5 |
| Complete (delete or requeue) | 1 | 5 |
| Fail (retry or terminal) | 1 | 5 |
| Extend lease | 1 | 5 |
| Release leases at shutdown (up to 100) | 1 | 5 |
| Purge failed jobs | 1 | 5 |
| Enqueue inside a caller's system transaction | 1 | 1 |
| Standalone enqueue (`withSystemTx`) | 3 | 5 |

A notified job therefore costs exactly one claim and one completion: 2 round
trips and 10 statements, asserted end to end in the integration suite. A
failed batch adds one `ROLLBACK`. Every operation reports its cost through the
optional `JobQueueObserver` hook (`operation`, `roundTrips`, `statements`,
`rows`) for the load simulator's budgets; the integration suite checks the
reported numbers against what actually crosses the wire.

With 20,000 queued rows, a claim of 4 due jobs executes in about 0.6 ms
locally, through the `control_plane_jobs_due` and `control_plane_jobs_leases`
partial indexes. Ordering a very large backlog of jobs that are already due
needs a sort over that backlog, which is acceptable for the expected sizes.

## Security

The table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with a single
`system_only` policy (`app_is_system()`), like every other worker-owned table,
and `zeros_app` has DML but not `TRUNCATE`. User transactions see no rows and
cannot insert. The scope columns `org_id` and `workspace_id` have no foreign
keys on purpose: a foreign-key check takes a key-share lock on the parent
row, which would block enqueue behind the reconciler's `FOR UPDATE` claims on
`cloud_workspaces`. Handlers already re-read and fence the workspace, so a job
for a deleted workspace completes as a no-op.

## Next slice: the six due kinds

Today `readLifecycleDeadlines` (`src/cloud-workspaces/lifecycle-deadlines.ts`)
runs one six-branch `UNION ALL` read in a repeatable-read transaction before
and after every reconciler tick, joining intents, generations, bindings, engine
instances, compute leases, runtime transitions and diagnostics to compute a
due time per kind, even when nothing is due. Then `tick()` runs each due
kind's own claim. On the queue, each source row's writer enqueues (or a
trigger enqueues) a job with the row's deadline as `run_at`, and the runner
claims due jobs directly. The union read and the reconciler's deadline
bookkeeping are removed. With nothing due, these kinds then cost one
indexed claim per replica per fallback poll instead of the six-branch join
before and after every tick.

| Current kind | Job kind | Dedupe key | `run_at` source | Handler |
| --- | --- | --- | --- | --- |
| `lifecycle` | `cloud_lifecycle_intent` | `workspace:<workspace_id>` (one dispatch per workspace at a time) | intent `next_attempt_at`, or `lease_expires_at` while dispatching; prerequisites, checkpoint requests and local-to-cloud forks re-enqueue on completion (today's `0134`/`0143` triggers) | the existing fenced `claimIntent` + dispatch, scoped to that workspace |
| `paidAuthority` | `cloud_paid_authority_check` | `workspace:<workspace_id>` (the table's primary key) | `cloud_workspace_paid_authority_checks.next_check_at` | `DatabaseCloudWorkspacePaidAuthorityReconciler.runOnce`, scoped to the workspace |
| `engineHealth` | `cloud_engine_health` | `workspace:<workspace_id>:generation:<n>` | latest ready engine `lease_expires_at` for the current generation; the handler re-enqueues for the renewed expiry when the engine is still live | `stopUnavailableCloudEngine`, scoped to the workspace |
| `compute` | `cloud_compute_lease` | `lease:<managed_compute_allocation_leases.id>` | `greatest(next_check_at, lease_expires_at while held, runtime activation or rollback deadline)` | `CloudWorkspaceComputeLeaseCoordinator.runOnce`, scoped to the lease |
| `drift` | `cloud_provider_drift_sweep` (then `cloud_workspace_drift_inspect` per mismatch) | `provider:<name>`; `workspace:<workspace_id>` | sweep: previous sweep + 60 s (one paged provider list); inspect: now | list-based drift: compare the list with bindings, enqueue an inspect only on mismatch, replacing per-binding `next_drift_check_at` polling |
| `diagnostics` | `cloud_diagnostic_cleanup` | `singleton` | `cloud_workspace_diagnostic_cleanup.next_run_at`, or now when an unrecovered incident is recorded | `runCloudDiagnosticCleanup` |

Open design points for that slice:

- `engineHealth` deadlines move later on every engine lease renewal. Under
  earliest-wins, the job runs at the old expiry, sees the renewal and
  reschedules itself: one claim and completion per renewal period per running
  workspace. That is interim cost; track C replaces database engine liveness
  with uplink presence. An explicit `postpone` enqueue mode is the alternative
  if measurement says otherwise.
- Whether to enqueue from the existing writers or from triggers on the source
  tables. Triggers cover every writer and match the existing hint triggers;
  explicit enqueues keep the logic in TypeScript. Either way the enqueue
  commits with the domain write.
- Cutover: run the queue path and the union path side by side behind a flag
  for the fixture organization, compare due decisions, then delete the union
  read (each slice ends with the old path deleted).

The P0.10 timer inventory also lists idle timers that later become queue- or
event-driven: **C03** (the mirror idle timer, about 60 empty mirror checks a
minute) and **E13** (replica and fork idle timers, about 4 + 4 empty job
checks a minute). Their target is commit-, job- or acknowledgement-driven
scheduling with zero empty timers and bounded retries while durable work
remains. Where those flows have a control-plane side (mirror ingestion, fork
and checkpoint completion), it can enqueue jobs on this queue so the timer
waits on a completion instead of polling. Converting the timers themselves,
and their seal, drain and checkpoint-wake regressions, is not part of this
slice.

## Local and cloud impact

- **Local workspace impact:** none. The queue is control-plane only. Local
  Personal and organization-local workspaces never reach it, and the desktop
  app and engine are unchanged.
- **Cloud workspace impact:** none until a later slice registers handlers and
  starts a runner. The migration is expand-only and older control-plane
  replicas ignore the new table and channel.

## Rejected alternatives

- **Separate `SELECT … FOR UPDATE SKIP LOCKED` and `UPDATE` statements, or
  `withSystemTx` per claim:** three round trips and longer row locks for the
  same result.
- **A dedicated pool whose sessions start as `zeros_app` with
  `app.system=on`:** one statement per operation instead of five, but a
  session-wide system context on pooled connections breaks the repository's
  rule that role and identity are transaction-scoped. Revisit only if the
  statement count matters more than that invariant.
- **A `SECURITY DEFINER` claim function:** it would bypass forced RLS, which
  is meant as defense in depth.
- **Explicit `pg_notify` in TypeScript:** misses writers that do not go
  through the queue module.
- **Per-kind notification channels:** more LISTEN state for little benefit at
  a few replicas; runners already claim only their own kinds.
- **Retaining succeeded jobs:** table growth and vacuum work for no consumer.
  Audit-worthy outcomes belong to the domain tables.
- **A database-enforced error-code list:** each new code would need a
  constraint-replacing migration. The column check enforces the code shape and
  the TypeScript vocabulary is closed.
