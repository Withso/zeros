import type pg from "pg";
import { withSystemStatement, withSystemTx, type Tx } from "./db.js";

/** Durable control-plane job queue. Delivery is at least once: a handler can
 * run again after a crash, lease loss or shutdown release, so handlers re-read
 * and fence their domain state. Scheduling is "earliest wins": re-enqueueing
 * an active job can only move it earlier, and a request that arrives during a
 * run guarantees one more run after it. Handlers reschedule later work by
 * enqueueing it. See docs/cloud-workspace/job-queue.md. */

export const JOB_NOTIFICATION_CHANNEL = "zeros_control_plane_job_work";

export const JOB_ERROR_CODES = [
  "handler_failed",
  "handler_timeout",
  "invalid_payload",
  "dependency_unavailable",
  "database_unavailable",
  "provider_unavailable",
  "provider_rate_limited",
  "precondition_failed",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** The only way a handler reports a specific failure. Raw error messages are
 * never persisted: anything else is recorded as `handler_failed`. */
export class JobError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(readonly code: JobErrorCode, options: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(code);
    this.name = "JobError";
    if (!JOB_ERROR_CODES.includes(code)) throw new Error("job_error_code_invalid");
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs === undefined ? null : boundedInteger(options.retryAfterMs, 0, MAX_DELAY_MS);
  }
}

export type JobJson = string | number | boolean | null | readonly JobJson[] | { readonly [key: string]: JobJson };
export type JobPayload = { readonly [key: string]: JobJson };

export type EnqueueJobInput = {
  kind: string;
  dedupeKey: string;
  payload?: JobPayload;
  /** Defaults to the database's current time. */
  runAt?: Date;
  orgId?: string | null;
  workspaceId?: string | null;
  maxAttempts?: number;
};
export type EnqueueJobResult = {
  outcome: "inserted" | "updated" | "unchanged";
  /** Null only when an identical active job already covered the request. */
  id: string | null;
};

export type ClaimedJob = {
  id: string;
  kind: string;
  dedupeKey: string;
  orgId: string | null;
  workspaceId: string | null;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  lockedUntil: Date;
  runAt: Date;
  createdAt: Date;
};

export type JobKindPolicy = { kind: string; leaseMs: number };

export type JobQueueOperation = "enqueue" | "claim" | "complete" | "fail" | "extend" | "release" | "purge";
/** Client-observed database cost of one successful queue operation. A batch
 * that fails adds one ROLLBACK round trip and is not reported. */
export type JobQueueCost = Readonly<{ operation: JobQueueOperation; roundTrips: number; statements: number; rows: number }>;
export type JobQueueObserver = (cost: JobQueueCost) => void;

// BEGIN, SET LOCAL ROLE, set_config, the statement and COMMIT in one batch.
const BATCH_COST = { roundTrips: 1, statements: 5 } as const;
// withSystemTx: one setup batch (three statements), the statement, COMMIT.
const TRANSACTION_COST = { roundTrips: 3, statements: 5 } as const;
const IN_TRANSACTION_COST = { roundTrips: 1, statements: 1 } as const;

export const DEFAULT_JOB_LEASE_MS = 60_000;
export const DEFAULT_JOB_MAX_ATTEMPTS = 10;
export const DEFAULT_JOB_BACKOFF = { baseMs: 5_000, maxMs: 15 * 60_000 } as const;
const MAX_DELAY_MS = 24 * 60 * 60_000;
const MAX_PAYLOAD_BYTES = 4_096;

const KIND = /^[a-z][a-z0-9_]{0,62}$/;
const OWNER = /^[A-Za-z0-9:._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Payloads carry identifiers, never credentials. Refuse the obvious mistakes.
const SECRET_KEY = /secret|token|password|passphrase|credential|private|bearer|cookie|authorization/i;

export function isValidJobKind(kind: string): boolean { return KIND.test(kind); }
export function isValidJobOwner(owner: string): boolean { return OWNER.test(owner); }

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("job_queue_integer_invalid");
  return value;
}

// The literal helpers below are the only values interpolated into the
// one-round-trip batches; each accepts a closed character set without quotes.
function integerLiteral(value: number, min: number, max: number): string { return String(boundedInteger(value, min, max)); }
function patternLiteral(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error("job_queue_literal_invalid");
  return `'${value}'`;
}
const kindLiteral = (kind: string) => patternLiteral(kind, KIND);
const uuidLiteral = (id: string) => `${patternLiteral(id, UUID)}::uuid`;
const ownerLiteral = (owner: string) => patternLiteral(owner, OWNER);
function errorCodeLiteral(code: JobErrorCode): string {
  if (!JOB_ERROR_CODES.includes(code)) throw new Error("job_error_code_invalid");
  return `'${code}'`;
}

function validatePayload(payload: JobPayload): string {
  const visit = (value: JobJson, depth: number): void => {
    if (depth > 8) throw new Error("job_payload_too_deep");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("job_payload_invalid"); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("job_payload_invalid");
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new Error("job_payload_secret_key");
      visit(item as JobJson, depth + 1);
    }
  };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("job_payload_invalid");
  visit(payload, 0);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) throw new Error("job_payload_too_large");
  return encoded;
}

/** Equal jitter: half of the exponential ceiling is fixed, half is random, so
 * retries spread out without ever collapsing to an immediate retry. */
export function jobRetryDelayMs(
  attempt: number,
  policy: { baseMs: number; maxMs: number } = DEFAULT_JOB_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + jitter * (ceiling / 2));
}

const ENQUEUE_SQL = `
  INSERT INTO control_plane_jobs AS job (kind, dedupe_key, org_id, workspace_id, payload, run_at, max_attempts)
  VALUES ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), $7)
  ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
    payload = EXCLUDED.payload,
    run_at = CASE WHEN job.state = 'queued' THEN least(job.run_at, EXCLUDED.run_at) ELSE job.run_at END,
    rerun_at = CASE WHEN job.state = 'running' THEN least(job.rerun_at, EXCLUDED.run_at) END,
    updated_at = clock_timestamp()
  WHERE job.payload IS DISTINCT FROM EXCLUDED.payload
    OR (job.state = 'queued' AND EXCLUDED.run_at < job.run_at)
    OR (job.state = 'running' AND (job.rerun_at IS NULL OR EXCLUDED.run_at < job.rerun_at))
  RETURNING job.id, (job.xmax = 0) AS inserted`;

function enqueueParameters(input: EnqueueJobInput): unknown[] {
  if (!KIND.test(input.kind)) throw new Error("job_kind_invalid");
  if (typeof input.dedupeKey !== "string" || input.dedupeKey.length < 1 || input.dedupeKey.length > 200) {
    throw new Error("job_dedupe_key_invalid");
  }
  for (const id of [input.orgId, input.workspaceId]) {
    if (id !== undefined && id !== null && !UUID.test(id)) throw new Error("job_scope_invalid");
  }
  if (input.runAt !== undefined && !Number.isFinite(input.runAt.getTime())) throw new Error("job_run_at_invalid");
  return [
    input.kind,
    input.dedupeKey,
    input.orgId ?? null,
    input.workspaceId ?? null,
    validatePayload(input.payload ?? {}),
    input.runAt?.toISOString() ?? null,
    boundedInteger(input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS, 1, 100),
  ];
}

function enqueueResult(rows: { id: string; inserted: boolean }[]): EnqueueJobResult {
  const row = rows[0];
  if (!row) return { outcome: "unchanged", id: null };
  return { outcome: row.inserted ? "inserted" : "updated", id: row.id };
}

/** Enqueue inside the caller's system transaction, so the job commits or
 * rolls back with the domain write that requires it. */
export async function enqueueJob(tx: Tx, input: EnqueueJobInput, observe?: JobQueueObserver): Promise<EnqueueJobResult> {
  const result = await tx.query<{ id: string; inserted: boolean }>(ENQUEUE_SQL, enqueueParameters(input));
  observe?.({ operation: "enqueue", ...IN_TRANSACTION_COST, rows: result.rowCount ?? 0 });
  return enqueueResult(result.rows);
}

/** Standalone enqueue for callers without a domain transaction. */
export async function enqueueJobStandalone(
  pool: pg.Pool,
  input: EnqueueJobInput,
  observe?: JobQueueObserver,
): Promise<EnqueueJobResult> {
  const parameters = enqueueParameters(input);
  const result = await withSystemTx(pool, tx => tx.query<{ id: string; inserted: boolean }>(ENQUEUE_SQL, parameters));
  observe?.({ operation: "enqueue", ...TRANSACTION_COST, rows: result.rowCount ?? 0 });
  return enqueueResult(result.rows);
}

type ClaimRow = {
  id: string | null;
  kind: string;
  dedupe_key: string;
  org_id: string | null;
  workspace_id: string | null;
  payload: JobPayload;
  state: "running" | "failed";
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  locked_until: Date | null;
  run_at: Date;
  created_at: Date;
  next_due_ms: string | number | null;
};

/** Claim up to `limit` due jobs of the given kinds in one round trip. A lease
 * that expired is claimable again; one that expired on its final attempt
 * becomes a terminal `lease_expired` failure instead. `nextDueInMs` is the
 * earliest queued run_at among unclaimed jobs (null when none, at most zero
 * when due work was skipped because another worker holds its row lock).
 * Lease expiries are found by the runner's fallback poll, not this hint. */
export async function claimJobs(
  pool: pg.Pool,
  input: { owner: string; kinds: readonly JobKindPolicy[]; limit: number },
  observe?: JobQueueObserver,
): Promise<{ jobs: ClaimedJob[]; expired: number; nextDueInMs: number | null }> {
  if (!input.kinds.length) throw new Error("job_kinds_required");
  const kinds = input.kinds.map(policy => kindLiteral(policy.kind));
  if (new Set(kinds).size !== kinds.length) throw new Error("job_kinds_duplicate");
  const policy = input.kinds
    .map((entry, index) => `(${kinds[index]}, ${integerLiteral(entry.leaseMs, 1_000, 3_600_000)})`)
    .join(", ");
  const kindArray = `ARRAY[${kinds.join(", ")}]::text[]`;
  const exhausted = "(due.expired AND due.exhausted AND NOT due.rerun)";
  const result = await withSystemStatement<ClaimRow>(pool, `
    WITH policy(kind, lease_ms) AS (VALUES ${policy}),
    due AS (
      SELECT job.id, job.state = 'running' AS expired, job.attempts >= job.max_attempts AS exhausted,
        job.rerun_at IS NOT NULL AS rerun
      FROM control_plane_jobs job
      WHERE job.kind = ANY(${kindArray})
        AND ((job.state = 'queued' AND job.run_at <= now()) OR (job.state = 'running' AND job.locked_until <= now()))
      ORDER BY job.run_at, job.id
      LIMIT ${integerLiteral(input.limit, 1, 100)}
      FOR UPDATE OF job SKIP LOCKED
    ), claimed AS (
      UPDATE control_plane_jobs job SET
        state = CASE WHEN ${exhausted} THEN 'failed' ELSE 'running' END,
        attempts = CASE WHEN ${exhausted} THEN job.attempts
          WHEN due.expired AND due.exhausted THEN 1 ELSE job.attempts + 1 END,
        lease_owner = CASE WHEN ${exhausted} THEN NULL ELSE ${ownerLiteral(input.owner)} END,
        lease_token = CASE WHEN ${exhausted} THEN NULL ELSE gen_random_uuid() END,
        locked_until = CASE WHEN ${exhausted} THEN NULL ELSE now() + policy.lease_ms * interval '1 millisecond' END,
        last_error_code = CASE WHEN due.expired THEN 'lease_expired' ELSE job.last_error_code END,
        finished_at = CASE WHEN ${exhausted} THEN clock_timestamp() END,
        rerun_at = NULL,
        updated_at = clock_timestamp()
      FROM due, policy
      WHERE job.id = due.id AND policy.kind = job.kind
      RETURNING job.id, job.kind, job.dedupe_key, job.org_id, job.workspace_id, job.payload, job.state,
        job.attempts, job.max_attempts, job.lease_token, job.locked_until, job.run_at, job.created_at
    ), next AS (
      -- One ordered probe of the due index per kind, not a scan of the queue.
      SELECT min(earliest.run_at) AS due_at FROM policy CROSS JOIN LATERAL (
        SELECT job.run_at FROM control_plane_jobs job
        WHERE job.state = 'queued' AND job.kind = policy.kind AND job.id NOT IN (SELECT id FROM due)
        ORDER BY job.run_at LIMIT 1
      ) earliest
    )
    SELECT claimed.*, extract(epoch FROM (next.due_at - now())) * 1000 AS next_due_ms
    FROM next LEFT JOIN claimed ON true`);
  const rows = result.rows.filter(row => row.id !== null);
  observe?.({ operation: "claim", ...BATCH_COST, rows: rows.length });
  const next = result.rows[0]?.next_due_ms;
  return {
    jobs: rows.filter(row => row.state === "running").map(row => ({
      id: row.id!,
      kind: row.kind,
      dedupeKey: row.dedupe_key,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseToken: row.lease_token!,
      lockedUntil: row.locked_until!,
      runAt: row.run_at,
      createdAt: row.created_at,
    })),
    expired: rows.filter(row => row.state === "failed").length,
    nextDueInMs: next === null || next === undefined ? null : Number(next),
  };
}

export type JobLease = Pick<ClaimedJob, "id" | "leaseToken">;
function leaseMatch(lease: JobLease): string {
  return `job.id = ${uuidLiteral(lease.id)} AND job.lease_token = ${uuidLiteral(lease.leaseToken)} AND job.state = 'running'`;
}

/** Delete a finished job, or requeue it when another request arrived during
 * the run. `lost` means the lease was no longer this worker's. */
export async function completeJob(
  pool: pg.Pool,
  lease: JobLease,
  observe?: JobQueueObserver,
): Promise<"deleted" | "requeued" | "lost"> {
  // The locking CTE observes the newest rerun_at even when an enqueue
  // committed after this statement's snapshot; the sibling writes recheck it.
  const result = await withSystemStatement<{ requeued: number; deleted: number }>(pool, `
    WITH target AS (
      SELECT job.id, job.rerun_at FROM control_plane_jobs job WHERE ${leaseMatch(lease)} FOR UPDATE
    ), requeued AS (
      UPDATE control_plane_jobs job SET state = 'queued', run_at = target.rerun_at, rerun_at = NULL, attempts = 0,
        lease_owner = NULL, lease_token = NULL, locked_until = NULL, last_error_code = NULL, updated_at = clock_timestamp()
      FROM target WHERE job.id = target.id AND target.rerun_at IS NOT NULL
      RETURNING job.id
    ), deleted AS (
      DELETE FROM control_plane_jobs job USING target WHERE job.id = target.id AND target.rerun_at IS NULL
      RETURNING job.id
    )
    SELECT (SELECT count(*) FROM requeued)::integer AS requeued, (SELECT count(*) FROM deleted)::integer AS deleted`);
  const row = result.rows[0];
  const outcome = row?.requeued ? "requeued" : row?.deleted ? "deleted" : "lost";
  observe?.({ operation: "complete", ...BATCH_COST, rows: outcome === "lost" ? 0 : 1 });
  return outcome;
}

/** Record a failed attempt. A retryable failure with attempts left is queued
 * after `delayMs`; otherwise the job is terminally failed. A request that
 * arrived during the failing run still gets a fresh run after the delay. */
export async function failJob(
  pool: pg.Pool,
  lease: JobLease,
  failure: { code: JobErrorCode; retryable: boolean; delayMs: number },
  observe?: JobQueueObserver,
): Promise<"retrying" | "failed" | "lost"> {
  const terminal = `(${failure.retryable ? "false" : "true"} OR job.attempts >= job.max_attempts)`;
  const final = `(${terminal} AND job.rerun_at IS NULL)`;
  const result = await withSystemStatement<{ state: "queued" | "failed" }>(pool, `
    UPDATE control_plane_jobs job SET
      state = CASE WHEN ${final} THEN 'failed' ELSE 'queued' END,
      attempts = CASE WHEN ${terminal} AND NOT ${final} THEN 0 ELSE job.attempts END,
      run_at = CASE WHEN ${final} THEN job.run_at
        ELSE now() + ${integerLiteral(failure.delayMs, 0, MAX_DELAY_MS)} * interval '1 millisecond' END,
      finished_at = CASE WHEN ${final} THEN clock_timestamp() END,
      last_error_code = ${errorCodeLiteral(failure.code)},
      lease_owner = NULL, lease_token = NULL, locked_until = NULL, rerun_at = NULL, updated_at = clock_timestamp()
    WHERE ${leaseMatch(lease)}
    RETURNING job.state`);
  const state = result.rows[0]?.state;
  observe?.({ operation: "fail", ...BATCH_COST, rows: result.rowCount ?? 0 });
  return state === "queued" ? "retrying" : state === "failed" ? "failed" : "lost";
}

/** Extend a held lease. False means the lease was lost and the handler must
 * stop: another worker may already own the job. */
export async function extendJobLease(
  pool: pg.Pool,
  lease: JobLease,
  leaseMs: number,
  observe?: JobQueueObserver,
): Promise<boolean> {
  const result = await withSystemStatement(pool, `
    UPDATE control_plane_jobs job SET
      locked_until = now() + ${integerLiteral(leaseMs, 1_000, 3_600_000)} * interval '1 millisecond',
      updated_at = clock_timestamp()
    WHERE ${leaseMatch(lease)}`);
  observe?.({ operation: "extend", ...BATCH_COST, rows: result.rowCount ?? 0 });
  return result.rowCount === 1;
}

/** Return unfinished leases to the queue at shutdown. The interrupted attempt
 * is not counted, and the jobs are due at once for another worker. */
export async function releaseJobs(pool: pg.Pool, leases: readonly JobLease[], observe?: JobQueueObserver): Promise<number> {
  if (!leases.length) return 0;
  if (leases.length > 100) throw new Error("job_release_too_large");
  const values = leases.map(lease => `(${uuidLiteral(lease.id)}, ${uuidLiteral(lease.leaseToken)})`).join(", ");
  const result = await withSystemStatement(pool, `
    UPDATE control_plane_jobs job SET state = 'queued', run_at = now(), attempts = greatest(job.attempts - 1, 0),
      lease_owner = NULL, lease_token = NULL, locked_until = NULL, rerun_at = NULL, updated_at = clock_timestamp()
    FROM (VALUES ${values}) AS lease(id, token)
    WHERE job.id = lease.id AND job.lease_token = lease.token AND job.state = 'running'`);
  observe?.({ operation: "release", ...BATCH_COST, rows: result.rowCount ?? 0 });
  return result.rowCount ?? 0;
}

/** Delete terminal failures older than the retention window, boundedly. */
export async function purgeFailedJobs(
  pool: pg.Pool,
  input: { olderThanMs: number; limit: number },
  observe?: JobQueueObserver,
): Promise<number> {
  const result = await withSystemStatement(pool, `
    DELETE FROM control_plane_jobs WHERE id IN (
      SELECT job.id FROM control_plane_jobs job
      WHERE job.state = 'failed'
        AND job.finished_at < now() - ${integerLiteral(input.olderThanMs, 60_000, 365 * 24 * 60 * 60_000)} * interval '1 millisecond'
      ORDER BY job.finished_at LIMIT ${integerLiteral(input.limit, 1, 1_000)})`);
  observe?.({ operation: "purge", ...BATCH_COST, rows: result.rowCount ?? 0 });
  return result.rowCount ?? 0;
}
