# Control-plane job queue

Status: the lifecycle reconciler runs its due work on this queue (see
[lifecycle due work](#lifecycle-due-work)). Migration `0150_cloud_lifecycle_jobs.sql`
adds the enqueue triggers; no other worker uses the queue yet.

Source: `apps/control-plane/src/job-queue.ts` (SQL operations),
`apps/control-plane/src/job-runner.ts` (runner),
`apps/control-plane/src/sql-fragment.ts` (statement builder), migration
`apps/control-plane/migrations/0148_control_plane_jobs.sql`. Tests:
`src/job-queue.test.ts`, `src/job-runner.test.ts` (runner timing on a fake
clock) and `src/job-queue.integration.test.ts`.

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
  enqueues it again with the later time before it returns: the enqueue
  records `rerun_at` on the running job, and completion requeues the job at
  that time.
- **Rerun during a run.** Re-enqueueing a `running` job records `rerun_at`.
  Completion then requeues the job at that time with a fresh attempt budget
  instead of deleting it, so a change committed during a run is never absorbed
  by a run that read older state. Completion locks the row before it decides,
  so a rerun that commits while completion waits is still honored (covered by
  a regression test). A failed run clears `rerun_at` because its retry is
  itself a later run; a final (or non-retryable) failed attempt with a
  pending rerun starts a fresh job at the requested time, or now if that has
  passed, without the failed run's backoff.
- **Leases.** A claim sets `lease_owner`, a new `lease_token` and
  `locked_until = now() + leaseMs` (default 60 s, per kind) and increments
  `attempts`. Every completion, failure, extension and release is fenced by
  `id` and `lease_token`, so a previous holder can never settle a reclaimed
  job. When a lease expires, the job becomes claimable again
  (`last_error_code = lease_expired`); if that was the final attempt, the next
  claim marks it `failed` instead.
- **Local lease deadline.** The runner extends a held lease at half its
  length, one extension at a time. It also keeps its own monotonic deadline
  (`performance.now()`), counted from the start of the claim request and
  moved only by a confirmed extension, counted from that extension's request
  start. Because the database lease began no earlier than the request that set
  it, this deadline never outlives the real one. When the deadline minus a
  safety margin (a tenth of the lease, between 1 s and 5 s) passes without a
  confirmed extension, including when extensions throw or hang, the runner
  aborts the handler and treats the lease as lost. Runner leases are at least
  30 s: extensions share the runner's pool, and one sent at half the lease can
  wait out a worker pool's 10 s acquisition deadline and still be confirmed
  in time.
- **Retries.** Exponential backoff with equal jitter: the ceiling is
  `min(maxMs, baseMs × 2^(attempt−1))`, the delay is half the ceiling plus a
  random share of the other half. Defaults: 5 s base, 15 min cap, 10 attempts.
  A `JobError` can carry `retryAfterMs` (a provider's requested wait, such as
  Boat's body-carried `retryAfterSeconds`), which is a floor on the delay: it
  is jittered by up to 20 percent so replicas sharing one rate limit spread
  out, and capped at 5 minutes so an hour- or day-long window never produces
  a tight retry loop. A `JobError` can also be marked non-retryable, which
  fails at once.
- **Error codes.** `last_error_code` is a closed vocabulary
  (`JOB_ERROR_CODES` plus `lease_expired`). Handlers report a specific failure
  only through `JobError`; any other exception is stored as `handler_failed`,
  and unavailable-database errors as `database_unavailable`. Raw messages are
  never persisted. The column's check enforces only the shape of a code
  (lowercase letters and underscores); the vocabulary itself is enforced in
  TypeScript.
- **Payloads** are JSON objects of at most 4 KiB holding identifiers, never
  credentials. Before any SQL runs, the queue rejects keys that name a secret
  (`token`, `secret`, `password`, `credential`, `apiKey`/`api_key`,
  `accessKey`, `session`, `auth`, `jwt`, `signature`, `dsn` and similar, but
  not `authorId`), string values and dedupe keys shaped like a credential
  (bearer and basic headers, JWTs, common provider token prefixes, AWS access
  key IDs, PEM blocks, URLs with a password, `token=` assignments), and keys,
  strings and dedupe keys containing NUL or unpaired UTF-16 surrogates, which
  PostgreSQL cannot store. These screens catch mistakes; they are not a
  secret scanner.

## Runner

`JobRunner` takes a handler registry keyed by kind, a concurrency bound
(default 4, at most 32) and a pool. It claims only registered kinds, at most
the number of free slots, and claims again when a slot frees up only if the
previous claim filled every slot. Handlers receive an `AbortSignal` that fires
on timeout (default 5 min), lease loss (including a missed local deadline)
and shutdown. A handler that ignores the signal loses its slot and lease at
that point, and its late result is discarded, but its code keeps running: it
can overlap the job's retry on another worker, so its side effects must be
fenced like any other at-least-once handler.

After a failed claim the runner waits 5 s before claiming again, and hints
that arrive meanwhile do not shorten that delay. Logs carry closed codes only
(`claim_failed`, `settlement_failed`, `database_unavailable`, a job error
code), never driver or handler messages, and a notification outage is logged
once until the listener is ready again.

Shutdown (`stop()`) stops claiming, unsubscribes, waits for in-flight
handlers up to `drainTimeoutMs` (default 10 s), then aborts the rest and
returns their leases in one statement. Released jobs are due immediately for
another replica and the interrupted attempt is not counted. A job whose
completion or failure is already in flight is not released; shutdown waits
for that write instead.

## Wake-ups

- **NOTIFY by trigger.** `AFTER INSERT` and `AFTER UPDATE OF state, run_at`
  triggers send an empty hint on `zeros_control_plane_job_work` (reusing
  `notify_cloud_worker_available` from `0134`) when a job is inserted, when a
  queued job's `run_at` changes (even to a future time, so idle runners learn
  the new earliest deadline), and when a running job returns to the queue due
  now (a due retry, a requeued completion, a shutdown release). A retry with
  backoff stays silent: the runner that failed it arms its own timer, and
  other replicas find it by their poll. Triggers rather than explicit
  `pg_notify` calls: every writer, including a transactional enqueue inside
  another worker's transaction, an operator repair or a later slice, wakes
  runners, and the hint is delivered only after commit. Idempotent
  re-enqueues, claims, extensions and deletions stay silent.
- **Coalescing.** A hint starts a claim after a 25 ms window, and hints in
  that window or during the claim share it. A burst of commits costs one
  claim, and a requeued completion, which wakes its own runner and then
  receives its own trigger hint, costs one claim rather than two.
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
27.6 ms median and 28.3 ms max over 10 notified jobs, almost all of it the
coalescing window (1.7 ms median without it). A job committed with its hint
suppressed ran on the 1 s test poll, and a job enqueued while the LISTEN
session was down ran on the resubscription flush long before the 60 s poll.

## Database cost

All queue operations other than enqueue run as one simple-protocol batch
(`withSystemStatement` in `src/db.ts`): `BEGIN`, `SET LOCAL ROLE zeros_app`,
`set_config('app.system', 'on', true)`, the statement and `COMMIT`. That is
the same role and RLS context as `withSystemTx` in one round trip instead of
three. Because the simple protocol cannot bind parameters, the statement
must be a `SqlFragment` (`src/sql-fragment.ts`): template text plus literal
helpers for integers, UUIDs, booleans and pattern-checked text such as kinds,
owner IDs and error codes, each limited to a closed character set without
quotes, backslashes, semicolons or NUL. `withSystemStatement` refuses plain
strings and any statement containing a semicolon. It is observed by the
request cost observer like `withSystemTx` (one transaction, five statements).

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

## Lifecycle due work

The reconciler's six due kinds run as jobs. They replaced the six-branch
`UNION ALL` read (`readLifecycleDeadlines`) that ran in a repeatable-read
transaction before and after every reconciler tick, even when nothing was due.

Source: `src/cloud-workspaces/lifecycle-jobs.ts` (kinds, per-kind due queries,
reschedule and audit), `CloudWorkspaceReconciler.runJob` in
`src/cloud-workspaces/reconciler.ts`, migration
`migrations/0150_cloud_lifecycle_jobs.sql`. Tests:
`src/cloud-workspaces/lifecycle-jobs.integration.test.ts`,
`worker-scheduling.test.ts` and `worker-idle.test.ts`.

| Kind | Job kind | Dedupe key | Enqueued by (trigger on) | Handler, scoped to the job's workspace |
| --- | --- | --- | --- | --- |
| `lifecycle` | `cloud_lifecycle_intent` | `workspace:<id>` | intents (`next_attempt_at`, dispatch lease, leaving the active states), checkpoint requests and local-to-cloud forks changing state | fenced `claimIntent` + dispatch |
| `paidAuthority` | `cloud_paid_authority_check` | `workspace:<id>` | `cloud_workspace_paid_authority_checks.next_check_at` | `DatabaseCloudWorkspacePaidAuthorityReconciler.runOnce` |
| `engineHealth` | `cloud_engine_health` | `workspace:<id>` | engine enrollment, state or revocation change, shortened lease; workspace becoming running and ready or busy, or a new generation; an intent leaving the active states | `stopUnavailableCloudEngine` |
| `compute` | `cloud_compute_lease` | `workspace:<id>` | allocation lease state, check time or lease; runtime transition phase or deadlines | `CloudWorkspaceComputeLeaseCoordinator.runOnce` |
| `drift` | `cloud_workspace_drift` | `workspace:<id>` | binding `next_drift_check_at`; restore incident state; an intent leaving the active states | `reconcileDriftOnce` |
| `diagnostics` | `cloud_diagnostic_cleanup` | `singleton` | cleanup `next_run_at`; recovery watermark or a publishable incident | `runCloudDiagnosticCleanup` |

- **Drift cadence follows the settled state.** Running and transitional
  workspaces re-observe every reconciler interval (60 s). A workspace whose
  desired and actual state have both settled into `stopped` or `archived`
  re-observes every `stoppedDriftIntervalMs` (default 6 h): both the due
  query and the claim apply the longer cadence, and the release reschedules
  on the candidate's own cadence. Any trigger enqueue (`next_drift_check_at`,
  an intent completing) still wakes it at once.
- **Inventory paces drift for providers with a paged list.** Boat's
  `GET /sandboxes` pages (200 per page) replace one inspect per sandbox per
  minute: the 60-second managed-resource sweep compares each scoped binding
  against the listing. A match pushes the binding's `next_drift_check_at`
  one fallback horizon out (`inventoryFallbackMs`, default 6 h); a missing
  or mismatched resource is forced due now, which the binding trigger turns
  into that workspace's drift job — the only runs that inspect. If sweeps
  stop, the fallback horizon expires and per-workspace drift inspects resume
  on their own. Boat calls drop from one inspect per workspace per minute to
  `ceil(sandboxes / 200)` list calls per minute per replica, far under the
  1000 requests/min/IP rate limit; a provider `retryAfterMs` wait floors the
  job retry (capped at 5 minutes, then jittered up to 20 percent).
- **Triggers, not TypeScript enqueues.** They cover every writer, including
  stored functions and operator repairs, and commit with the domain write.
  Every source table is written only in system transactions, so the
  `SECURITY INVOKER` functions satisfy the queue's `system_only` policy.
- **`run_at` is a lower bound.** A trigger never schedules later than the
  real due time. A job that runs early claims nothing, and the handler then
  reschedules it at the exact next due time from the same per-kind query the
  claim's eligibility mirrors. Nothing pending: the job completes and is
  deleted. Engine lease renewals therefore write no job: the job runs at the
  old expiry, sees the renewal and moves itself to the new one, about one run
  per lease period (90 s) per running workspace until engine liveness moves
  off the database.
- **Bounded runs.** A process runs one lifecycle job at a time by default
  (`jobConcurrency`), keeping the former tick's serial provider calls. A run
  makes at most 20 claims; one that hits the bound, or that a shutdown
  interrupts, reschedules itself now. Maintenance that enqueues a stop wakes the runner
  at once.
- **No spinning on contended rows.** When work is due but the run claimed
  nothing (rows locked elsewhere, `SKIP LOCKED`), the reschedule backs off
  1 s doubling to 60 s and keeps the streak in the payload
  (`{"emptyRuns": n}`). Any trigger enqueue resets the payload.
- **Audit.** Each replica runs `auditLifecycleJobs` hourly (first run jittered
  between 30 and 60 minutes after start): it gives every pending deadline
  without a job, or with a later one, a queued job at its due time and logs a
  warning with the count. Under correct operation it repairs nothing.
- **Wake-ups.** The process's shared worker LISTEN session wakes the runner on
  the queue channel and on the existing lifecycle hint; the runner's fallback
  poll is the reconciler interval, clamped to 1 s-5 min. The reconciler's own
  scheduler now only runs the 60 s orphan inventory sweep and the audit and
  reads nothing from the database until one is due.
- **Rollout.** Control-plane internal: the migration backfills one job per
  pending deadline, and older replicas during a deploy keep their own union
  polling and ignore the jobs; both paths claim through the same fenced
  transactions. Drift stays per binding until list-based reconciliation
  replaces it.

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
- **Cloud workspace impact:** lifecycle convergence is unchanged in outcome
  and timing; the work is found through jobs instead of a repeated scan. The
  migrations are expand-only and older control-plane replicas ignore the jobs.

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
