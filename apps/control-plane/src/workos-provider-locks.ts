import { createHash } from "node:crypto";
import type pg from "pg";

import type { Tx } from "./db.js";

export type WorkOSProviderSubject = {
  kind: "user" | "organization";
  id: string;
};

export type WorkOSProviderTargetReferences = {
  userIds?: readonly string[];
  organizationIds?: readonly string[];
  organizationExternalIds?: readonly string[];
};

export type WorkOSProviderLockOptions = {
  /** Bounds lock acquisition only; protected work keeps the lock until done. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type WorkOSProviderErasureFenceStatus =
  | "fenced"
  | "unfenced"
  | "not_ready";

export class WorkOSProviderLockTimeoutError extends Error {
  readonly code = "workos_provider_lock_timeout";

  constructor() {
    super("Timed out waiting for a WorkOS provider lock");
    this.name = "WorkOSProviderLockTimeoutError";
  }
}

export class WorkOSProviderLockAbortedError extends Error {
  readonly code = "workos_provider_lock_aborted";

  constructor() {
    super("WorkOS provider lock acquisition was aborted");
    this.name = "WorkOSProviderLockAbortedError";
  }
}

export class WorkOSProviderErasureNotReadyError extends Error {
  readonly code = "workos_provider_erasure_reconciliation_pending";

  constructor() {
    super("WorkOS provider-erasure reconciliation is not ready");
    this.name = "WorkOSProviderErasureNotReadyError";
  }
}

type PermitWaiter = {
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | undefined;
  abort: (() => void) | null;
};

type LockCoordinator = {
  active: number;
  limit: number;
  queue: PermitWaiter[];
};

const lockCoordinators = new WeakMap<pg.Pool, LockCoordinator>();
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

function lockCoordinator(pool: pg.Pool): LockCoordinator {
  const existing = lockCoordinators.get(pool);
  if (existing) return existing;
  const poolMax = pool.options.max ?? 10;
  if (!Number.isInteger(poolMax) || poolMax < 2) {
    throw new Error("WorkOS provider locks require a pool with max >= 2");
  }
  // A session advisory lock consumes one connection while its callback uses
  // ordinary transactions. Bound lock holders to at most half the pool and
  // retain an extra slot at odd sizes so protected callbacks can make progress.
  const coordinator: LockCoordinator = {
    active: 0,
    limit: Math.max(1, Math.floor((poolMax - 1) / 2)),
    queue: [],
  };
  lockCoordinators.set(pool, coordinator);
  return coordinator;
}

function cleanupWaiter(waiter: PermitWaiter): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abort) {
    waiter.signal.removeEventListener("abort", waiter.abort);
  }
  waiter.timer = null;
  waiter.abort = null;
}

function nextPermit(coordinator: LockCoordinator): void {
  while (coordinator.active < coordinator.limit) {
    const waiter = coordinator.queue.shift();
    if (!waiter) return;
    if (waiter.settled) continue;
    waiter.settled = true;
    cleanupWaiter(waiter);
    coordinator.active += 1;
    waiter.resolve(releasePermit(coordinator));
  }
}

function releasePermit(coordinator: LockCoordinator): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    coordinator.active -= 1;
    nextPermit(coordinator);
  };
}

async function acquirePermit(
  pool: pg.Pool,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  if (signal?.aborted) throw new WorkOSProviderLockAbortedError();
  const coordinator = lockCoordinator(pool);
  if (coordinator.active < coordinator.limit) {
    coordinator.active += 1;
    return releasePermit(coordinator);
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new WorkOSProviderLockTimeoutError();
  return new Promise<() => void>((resolve, reject) => {
    const waiter: PermitWaiter = {
      settled: false,
      resolve,
      reject,
      timer: null,
      signal,
      abort: null,
    };
    const rejectWaiter = (error: unknown) => {
      if (waiter.settled) return;
      waiter.settled = true;
      cleanupWaiter(waiter);
      const index = coordinator.queue.indexOf(waiter);
      if (index >= 0) coordinator.queue.splice(index, 1);
      reject(error);
    };
    waiter.timer = setTimeout(
      () => rejectWaiter(new WorkOSProviderLockTimeoutError()),
      remainingMs,
    );
    if (signal) {
      waiter.abort = () => rejectWaiter(new WorkOSProviderLockAbortedError());
      signal.addEventListener("abort", waiter.abort, { once: true });
    }
    coordinator.queue.push(waiter);
  });
}

function throwIfAcquisitionExpired(
  deadline: number,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) throw new WorkOSProviderLockAbortedError();
  if (Date.now() >= deadline) throw new WorkOSProviderLockTimeoutError();
}

async function connectBeforeDeadline(
  pool: pg.Pool,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<pg.PoolClient> {
  throwIfAcquisitionExpired(deadline, signal);
  const remainingMs = deadline - Date.now();
  return new Promise<pg.PoolClient>((resolve, reject) => {
    let settled = false;
    let abort: (() => void) | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && abort) signal.removeEventListener("abort", abort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(
      () => rejectOnce(new WorkOSProviderLockTimeoutError()),
      remainingMs,
    );
    if (signal) {
      abort = () => rejectOnce(new WorkOSProviderLockAbortedError());
      signal.addEventListener("abort", abort, { once: true });
    }
    pool.connect().then((client) => {
      if (settled) {
        client.release();
        return;
      }
      settled = true;
      cleanup();
      resolve(client);
    }, rejectOnce);
  });
}

async function waitBeforeRetry(
  delayMs: number,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAcquisitionExpired(deadline, signal);
  const waitMs = Math.min(delayMs, deadline - Date.now());
  await new Promise<void>((resolve, reject) => {
    let abort: (() => void) | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && abort) signal.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, waitMs);
    if (signal) {
      abort = () => {
        cleanup();
        reject(new WorkOSProviderLockAbortedError());
      };
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  throwIfAcquisitionExpired(deadline, signal);
}

async function unlockProviderKeys(
  client: pg.PoolClient,
  acquired: readonly string[],
): Promise<unknown> {
  let unlockError: unknown = null;
  for (const key of [...acquired].reverse()) {
    try {
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended($1::text, 0)
         ) AS unlocked`,
        [key],
      );
      if (!unlocked.rows[0]?.unlocked) {
        throw new Error("WorkOS provider lock ownership was lost");
      }
    } catch (error) {
      unlockError ??= error;
    }
  }
  return unlockError;
}

export function workOSProviderSubjectHash(
  subject: WorkOSProviderSubject,
): string {
  return createHash("sha256")
    .update(`workos:${subject.kind}:${subject.id}`, "utf8")
    .digest("hex");
}

/** Stable even after local provider mappings are erased. */
export function workOSProviderSubjectLockKey(
  subject: WorkOSProviderSubject,
): string {
  return `workos-provider-subject:${workOSProviderSubjectHash(subject)}`;
}

export async function workOSProviderErasureFenceStatus(
  tx: Tx,
  subjects: readonly WorkOSProviderSubject[],
): Promise<WorkOSProviderErasureFenceStatus> {
  const uniqueSubjects = Array.from(
    new Map(
      subjects.map((subject) => [`${subject.kind}\0${subject.id}`, subject]),
    ).values(),
  );
  if (uniqueSubjects.length === 0) return "unfenced";

  const evidenceRelations = await tx.query<{
    fences: string | null;
    reconciliations: string | null;
  }>(
    `SELECT
       to_regclass('public.workos_provider_erasure_fences')::text AS fences,
       to_regclass(
         'public.workos_provider_erasure_reconciliations'
       )::text AS reconciliations`,
  );
  const evidenceAvailable =
    typeof evidenceRelations.rows[0]?.fences === "string" &&
    typeof evidenceRelations.rows[0]?.reconciliations === "string";

  if (evidenceAvailable) {
    const requested = uniqueSubjects.map((subject) => ({
      subject_kind: subject.kind,
      subject_hash: workOSProviderSubjectHash(subject),
    }));
    // Fence presence and historical readiness must share one READ COMMITTED
    // statement snapshot. Separate statements could admit a subject once if
    // an operator committed its fence and final reconciliation between them.
    const evidence = await tx.query<{ fenced: boolean; ready: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM workos_provider_erasure_fences fence
           JOIN jsonb_to_recordset($1::jsonb)
             AS requested(subject_kind text, subject_hash text)
             ON requested.subject_kind = fence.subject_kind
            AND requested.subject_hash = fence.subject_hash
           WHERE fence.provider = 'workos' AND fence.hash_version = 1
         ) AS fenced,
         NOT EXISTS (
           SELECT 1
           FROM deletion_requests request
           WHERE request.state = 'purged'
             AND NOT EXISTS (
               SELECT 1
               FROM workos_provider_erasure_reconciliations reconciliation
               WHERE reconciliation.deletion_request_id = request.id
             )
         ) AS ready`,
      [JSON.stringify(requested)],
    );
    if (evidence.rows[0]?.fenced === true) return "fenced";
    if (evidence.rows[0]?.ready === true) return "unfenced";
  }

  // A withheld 0061 migration or unresolved historical purge must not disrupt
  // already-bound accounts and Organizations. Only exact active mappings are
  // allowed through; an unknown subject remains fail-closed without scanning
  // or persisting the provider payload.
  const userIds = uniqueSubjects
    .filter((subject) => subject.kind === "user")
    .map((subject) => subject.id);
  const organizationIds = uniqueSubjects
    .filter((subject) => subject.kind === "organization")
    .map((subject) => subject.id);
  const known = await tx.query<{ subject_kind: string; subject_id: string }>(
    `SELECT 'user'::text AS subject_kind,
            identity.provider_sub AS subject_id
     FROM user_identities identity
     WHERE identity.provider = 'workos' AND identity.status = 'active'
       AND identity.provider_sub = ANY($1::text[])
     UNION ALL
     SELECT 'organization'::text AS subject_kind,
            link.workos_organization_id AS subject_id
     FROM workos_organization_links link
     WHERE link.state = 'active'
       AND link.workos_organization_id = ANY($2::text[])`,
    [userIds, organizationIds],
  );
  const knownSubjects = new Set(
    known.rows.map((row) => `${row.subject_kind}\0${row.subject_id}`),
  );
  return uniqueSubjects.every((subject) =>
    knownSubjects.has(`${subject.kind}\0${subject.id}`),
  )
    ? "unfenced"
    : "not_ready";
}

export async function workOSProviderErasureFenced(
  tx: Tx,
  subjects: readonly WorkOSProviderSubject[],
): Promise<boolean> {
  const status = await workOSProviderErasureFenceStatus(tx, subjects);
  if (status === "not_ready") {
    throw new WorkOSProviderErasureNotReadyError();
  }
  return status === "fenced";
}

export function workOSOrganizationProviderLockKey(
  organizationId: string,
): string {
  return `workos-provider-org:${organizationId}`;
}

export function workOSUserProviderLockKey(userId: string): string {
  return `workos-provider-user:${userId}`;
}

export const MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS = 256;

export async function assertAccountWorkOSProviderErasureSubjectLimit(
  database: pg.Pool | Tx,
  deletionRequestId: string,
  subjects: readonly string[],
): Promise<void> {
  const existing = await database.query<{
    subject_hash: string | null;
    provider_subject: string | null;
  }>(
    `SELECT fence.subject_hash, NULL::text AS provider_subject
     FROM workos_provider_erasure_fences fence
     WHERE fence.deletion_request_id = $1 AND fence.provider = 'workos'
       AND fence.subject_kind = 'user' AND fence.hash_version = 1
     UNION ALL
     SELECT NULL::text AS subject_hash,
            command.payload->>'workosUserId' AS provider_subject
     FROM workos_command_outbox command
     WHERE command.operation = 'user.delete'
       AND command.payload->>'deletionRequestId' = $1::text
       AND command.payload->>'workosUserId' IS NOT NULL`,
    [deletionRequestId],
  );
  const hashes = new Set(
    existing.rows.flatMap((row) =>
      row.subject_hash ? [row.subject_hash] : [],
    ),
  );
  for (const row of existing.rows) {
    if (row.provider_subject) {
      hashes.add(
        workOSProviderSubjectHash({ kind: "user", id: row.provider_subject }),
      );
    }
  }
  for (const subject of subjects) {
    hashes.add(workOSProviderSubjectHash({ kind: "user", id: subject }));
  }
  if (hashes.size > MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS) {
    throw new Error("workos_user_erasure_subject_limit_exceeded");
  }
}

/**
 * The exact WorkOS user subjects presently owned by one local account purge.
 * The extra row distinguishes the supported bound from truncation: callers
 * must stop the purge and surface an operator-visible error rather than omit a
 * provider identity. An unbound browser shell is associated only by the
 * target's still-live email; a shell already bound to another account is never
 * captured by that fallback.
 */
export async function accountWorkOSProviderSubjects(
  database: pg.Pool | Tx,
  userId: string,
): Promise<string[]> {
  const subjects = await database.query<{ provider_sub: string }>(
    `SELECT captured.provider_sub
     FROM (
       SELECT identity.provider_sub
       FROM user_identities identity
       WHERE identity.user_id = $1 AND identity.provider = 'workos'
       UNION
       SELECT recovery.candidate_provider_sub AS provider_sub
       FROM account_recovery_requests recovery
       WHERE recovery.target_user_id = $1 AND recovery.state = 'pending'
       UNION
       SELECT session.provider_sub
       FROM auth_sessions session
       WHERE session.provider = 'workos' AND session.user_id = $1
       UNION
       SELECT browser.provider_sub
       FROM workos_browser_sessions browser
       WHERE browser.kind = 'session' AND (
         browser.account_user_id = $1
         OR (
           browser.account_user_id IS NULL
           AND lower(browser.email::text) = (
             SELECT lower(account.email::text)
             FROM users account WHERE account.id = $1
           )
         )
       )
     ) captured
     WHERE NOT EXISTS (
       SELECT 1 FROM user_identities foreign_identity
       WHERE foreign_identity.provider = 'workos'
         AND foreign_identity.provider_sub = captured.provider_sub
         AND foreign_identity.user_id <> $1
     )
     ORDER BY captured.provider_sub
     LIMIT $2`,
    [userId, MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS + 1],
  );
  if (subjects.rows.length > MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS) {
    throw new Error("workos_user_erasure_subject_limit_exceeded");
  }
  return subjects.rows.map((row) => row.provider_sub);
}

/** Resolve provider references to the stable local targets used for locks. */
export async function resolveWorkOSProviderLockKeys(
  pool: pg.Pool,
  references: WorkOSProviderTargetReferences,
): Promise<string[]> {
  const userIds = Array.from(new Set(references.userIds ?? []));
  const organizationIds = Array.from(new Set(references.organizationIds ?? []));
  const organizationExternalIds = Array.from(
    new Set(references.organizationExternalIds ?? []),
  );
  const keys: string[] = [
    ...userIds.map((id) => workOSProviderSubjectLockKey({ kind: "user", id })),
    ...organizationIds.map((id) =>
      workOSProviderSubjectLockKey({ kind: "organization", id }),
    ),
  ];
  if (userIds.length > 0) {
    const users = await pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
       FROM user_identities
       WHERE provider = 'workos' AND provider_sub = ANY($1::text[])`,
      [userIds],
    );
    keys.push(
      ...users.rows.map((row) => workOSUserProviderLockKey(row.user_id)),
    );
  }
  if (organizationIds.length > 0 || organizationExternalIds.length > 0) {
    const organizations = await pool.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id
       FROM workos_organization_links
       WHERE ($1::text[] <> '{}'::text[]
              AND workos_organization_id = ANY($1::text[]))
          OR ($2::text[] <> '{}'::text[]
              AND external_id = ANY($2::text[]))`,
      [organizationIds, organizationExternalIds],
    );
    keys.push(
      ...organizations.rows.map((row) =>
        workOSOrganizationProviderLockKey(row.organization_id),
      ),
    );
  }
  return Array.from(new Set(keys)).sort();
}

/**
 * Serialize an external WorkOS mutation with target deletion. These are
 * session locks (rather than transaction locks) because the protected HTTP
 * request necessarily runs outside a database transaction. Every caller must
 * acquire the complete, sorted target set in one invocation.
 */
export async function withWorkOSProviderLocks<T>(
  pool: pg.Pool,
  keys: readonly string[],
  work: () => Promise<T>,
  options: WorkOSProviderLockOptions = {},
): Promise<T> {
  const ordered = Array.from(new Set(keys)).sort();
  if (ordered.length === 0) return work();

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("WorkOS provider lock timeoutMs must be positive");
  }
  const deadline = Date.now() + timeoutMs;
  const releaseLocalPermit = await acquirePermit(
    pool,
    deadline,
    options.signal,
  );

  try {
    let retryDelayMs = 5;
    for (;;) {
      const client = await connectBeforeDeadline(
        pool,
        deadline,
        options.signal,
      );
      const acquired: string[] = [];
      let contended = false;
      try {
        for (const key of ordered) {
          throwIfAcquisitionExpired(deadline, options.signal);
          const result = await client.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_lock(
               hashtextextended($1::text, 0)
             ) AS acquired`,
            [key],
          );
          if (!result.rows[0]?.acquired) {
            contended = true;
            break;
          }
          acquired.push(key);
        }
      } catch (error) {
        // Closing the connection releases any session locks acquired before the
        // failed query without trusting a connection in an unknown state.
        client.release(true);
        throw error;
      }

      if (contended) {
        const unlockError = await unlockProviderKeys(client, acquired);
        client.release(unlockError ? true : undefined);
        if (unlockError) throw unlockError;

        // A blocking advisory-lock query would pin one pool connection per
        // waiter. Release before backing off so the holder can use the same pool
        // to checkpoint and durably complete the protected operation.
        await waitBeforeRetry(retryDelayMs, deadline, options.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 100);
        continue;
      }

      throwIfAcquisitionExpired(deadline, options.signal);
      let workFailed = false;
      try {
        return await work();
      } catch (error) {
        workFailed = true;
        throw error;
      } finally {
        const unlockError = await unlockProviderKeys(client, acquired);
        client.release(unlockError ? true : undefined);
        if (unlockError && !workFailed) throw unlockError;
      }
    }
  } finally {
    releaseLocalPermit();
  }
}
