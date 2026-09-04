import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureUser, resolveAuthenticatedUser } from "./auth.js";
import { DeletionLifecycleProcessor } from "./deletion-lifecycle.js";
import { runMigrations } from "./migrate.js";
import {
  MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS,
  workOSProviderSubjectHash,
} from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function publicCode(): string {
  const suffix = randomUUID()
    .replaceAll("-", "")
    .replace(/[01]/g, "A")
    .slice(0, 8)
    .toUpperCase();
  return `ZD-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

async function stageAccountPurge(
  pool: pg.Pool,
  userId: string,
  state: "purging" | "provider_deleting",
): Promise<string> {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO deletion_requests (
       public_code, target_kind, target_id, target_user_id, state,
       requested_at, purge_after, purge_started_at, next_attempt_at
     ) VALUES (
       $1, 'account', $2, $2, $3,
       now() - interval '31 days', now() - interval '1 day', now(), now()
     ) RETURNING id`,
    [publicCode(), userId, state],
  );
  await pool.query(
    `UPDATE users
     SET auth_status = 'deletion_pending', deleted_at = now(),
         deletion_request_id = $2, deletion_scheduled_at = now(),
         purge_after = now() - interval '1 day'
     WHERE id = $1`,
    [userId, request.rows[0]!.id],
  );
  return request.rows[0]!.id;
}

function candidateInput(subject: string, email: string) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    provider: "workos" as const,
    providerSubject: subject,
    email,
    displayName: "Late WorkOS candidate",
    session: {
      id: `session_${subject}`,
      clientKind: "desktop" as const,
      authTime: now,
      tokenExpiresAt: now + 3_600,
    },
  };
}

async function markRequestCommandsSucceeded(
  pool: pg.Pool,
  requestId: string,
): Promise<void> {
  await pool.query(
    `UPDATE workos_command_outbox
     SET state = 'succeeded', completed_at = now(), updated_at = now(),
         lease_owner = NULL, lease_expires_at = NULL
     WHERE operation = 'user.delete'
       AND payload->>'deletionRequestId' = $1::text`,
    [requestId],
  );
}

d("late WorkOS authentication during account erasure", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("fails closed when a subject binding and an email fallback resolve to different accounts", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const deleting = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_ambiguous_deleting_${suffix}`,
      email: `ambiguous-deleting-${suffix}@example.test`,
      displayName: "Deleting target",
    });
    const recoveryTarget = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_ambiguous_recovery_${suffix}`,
      email: `ambiguous-recovery-${suffix}@example.test`,
      displayName: "Recovery target",
    });
    const deletionRequestId = await stageAccountPurge(
      pool,
      deleting.id,
      "provider_deleting",
    );
    const recoveryIdentity = await pool.query<{ id: string }>(
      `SELECT id FROM user_identities
       WHERE provider = 'workos' AND user_id = $1`,
      [recoveryTarget.id],
    );
    const candidateSubject = `user_ambiguous_candidate_${suffix}`;
    const recoverySuffix = suffix
      .replace(/[01]/g, "A")
      .slice(0, 8)
      .toUpperCase();
    await pool.query(
      `INSERT INTO account_recovery_requests (
         public_code, candidate_provider_sub, candidate_session_id,
         candidate_email, candidate_auth_time, target_user_id,
         target_identity_id
       ) VALUES ($1, $2, $3, $4, now(), $5, $6)`,
      [
        `ZR-${recoverySuffix.slice(0, 4)}-${recoverySuffix.slice(4)}`,
        candidateSubject,
        `session_ambiguous_candidate_${suffix}`,
        recoveryTarget.email,
        recoveryTarget.id,
        recoveryIdentity.rows[0]!.id,
      ],
    );

    await expect(
      resolveAuthenticatedUser(
        pool,
        candidateInput(candidateSubject, deleting.email),
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "authentication_temporarily_unavailable",
    });
    const hash = workOSProviderSubjectHash({
      kind: "user",
      id: candidateSubject,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE deletion_request_id = $1 AND subject_hash = $2) AS fences,
           (SELECT count(*)::int FROM workos_command_outbox
            WHERE operation = 'user.delete'
              AND provider_object_id = $3) AS commands`,
        [deletionRequestId, hash, candidateSubject],
      ),
    ).resolves.toMatchObject({ rows: [{ fences: 0, commands: 0 }] });
  });

  it("idempotently fences and queues one subject while provider deletion is active", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_repeat_original_${suffix}`,
      email: `repeat-${suffix}@example.test`,
      displayName: "Repeated candidate target",
    });
    const requestId = await stageAccountPurge(
      pool,
      target.id,
      "provider_deleting",
    );
    const subject = `user_repeat_candidate_${suffix}`;
    const input = candidateInput(subject, target.email);

    await expect(resolveAuthenticatedUser(pool, input)).rejects.toMatchObject({
      status: 401,
      code: "account_deleted",
    });
    await expect(resolveAuthenticatedUser(pool, input)).rejects.toMatchObject({
      status: 401,
      code: "account_deleted",
    });

    const hash = workOSProviderSubjectHash({ kind: "user", id: subject });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM deletion_request_events
            WHERE deletion_request_id = $1
              AND action = 'purge.provider_erasure_fenced'
              AND metadata->'workosSubjectHashes' ? $2) AS events,
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE deletion_request_id = $1 AND subject_hash = $2) AS fences,
           (SELECT count(*)::int FROM workos_command_outbox
            WHERE operation = 'user.delete' AND user_id = $3
              AND provider_object_id = $4
              AND payload->>'deletionRequestId' = $1::text) AS commands`,
        [requestId, hash, target.id, subject],
      ),
    ).resolves.toMatchObject({
      rows: [{ events: 1, fences: 1, commands: 1 }],
    });
  });

  it("rejects a new late subject atomically at the per-request erasure bound", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_bounded_original_${suffix}`,
      email: `bounded-${suffix}@example.test`,
      displayName: "Bounded candidate target",
    });
    const requestId = await stageAccountPurge(
      pool,
      target.id,
      "provider_deleting",
    );
    const existingHashes = Array.from(
      { length: MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS },
      (_, index) =>
        workOSProviderSubjectHash({
          kind: "user",
          id: `user_bounded_existing_${suffix}_${index}`,
        }),
    );
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action, metadata
       )
       SELECT $1, NULL, 'purge.provider_erasure_fenced',
              jsonb_build_object(
                'provider', 'workos',
                'workosSubjectHashes', jsonb_build_array(candidate.hash)
              )
       FROM unnest($2::text[]) AS candidate(hash)`,
      [requestId, existingHashes],
    );
    const subject = `user_bounded_overflow_${suffix}`;
    const hash = workOSProviderSubjectHash({ kind: "user", id: subject });

    await expect(
      resolveAuthenticatedUser(pool, candidateInput(subject, target.email)),
    ).rejects.toMatchObject({
      status: 503,
      code: "workos_user_erasure_subject_limit_exceeded",
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM deletion_request_events
            WHERE deletion_request_id = $1
              AND metadata->'workosSubjectHashes' ? $2) AS events,
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE deletion_request_id = $1 AND subject_hash = $2) AS fences,
           (SELECT count(*)::int FROM workos_command_outbox
            WHERE provider_object_id = $3) AS commands`,
        [requestId, hash, subject],
      ),
    ).resolves.toMatchObject({
      rows: [{ events: 0, fences: 0, commands: 0 }],
    });
  });

  it("keeps deletion command revisions stable when late auth wins before prepare", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const originalSubject = `user_revision_original_${suffix}`;
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: originalSubject,
      email: `revision-${suffix}@example.test`,
      displayName: "Revision target",
    });
    const requestId = await stageAccountPurge(pool, target.id, "purging");
    const lateSubject = `user_revision_late_${suffix}`;

    await expect(
      resolveAuthenticatedUser(pool, candidateInput(lateSubject, target.email)),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await markRequestCommandsSucceeded(pool, requestId);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `revision-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state,
                array_agg(command.provider_object_id
                          ORDER BY command.aggregate_revision) AS subjects,
                array_agg(command.aggregate_revision::int
                          ORDER BY command.aggregate_revision) AS revisions
         FROM deletion_requests request
         JOIN workos_command_outbox command
           ON command.payload->>'deletionRequestId' = request.id::text
         WHERE request.id = $1
         GROUP BY request.state`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "provider_deleting",
          subjects: [lateSubject, originalSubject],
          revisions: [1, 2],
        },
      ],
    });

    await markRequestCommandsSucceeded(pool, requestId);
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [requestId],
    );
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "purged" }] });
  });

  it("appends a lexicographically earlier durable subject on purge retry", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const originalSubject = `user_z_revision_original_${suffix}`;
    const candidateSubject = `user_a_revision_candidate_${suffix}`;
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: originalSubject,
      email: `retry-revision-${suffix}@example.test`,
      displayName: "Retry revision target",
    });
    const requestId = await stageAccountPurge(pool, target.id, "purging");
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `retry-revision-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await markRequestCommandsSucceeded(pool, requestId);

    const identity = await pool.query<{ id: string }>(
      `SELECT id FROM user_identities
       WHERE provider = 'workos' AND user_id = $1`,
      [target.id],
    );
    const recoverySuffix = suffix
      .replace(/[01]/g, "A")
      .slice(0, 8)
      .toUpperCase();
    await pool.query(
      `INSERT INTO account_recovery_requests (
         public_code, candidate_provider_sub, candidate_session_id,
         candidate_email, candidate_auth_time, target_user_id,
         target_identity_id
       ) VALUES ($1, $2, $3, $4, now(), $5, $6)`,
      [
        `ZR-${recoverySuffix.slice(0, 4)}-${recoverySuffix.slice(4)}`,
        candidateSubject,
        `session_retry_revision_${suffix}`,
        target.email,
        target.id,
        identity.rows[0]!.id,
      ],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'failed', last_error_code = 'captured_subject_expanded',
           lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = now()
       WHERE id = $1`,
      [requestId],
    );

    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state,
                array_agg(command.provider_object_id
                          ORDER BY command.aggregate_revision) AS subjects,
                array_agg(command.aggregate_revision::int
                          ORDER BY command.aggregate_revision) AS revisions
         FROM deletion_requests request
         JOIN workos_command_outbox command
           ON command.payload->>'deletionRequestId' = request.id::text
         WHERE request.id = $1
         GROUP BY request.state`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "provider_deleting",
          subjects: [originalSubject, candidateSubject],
          revisions: [1, 2],
        },
      ],
    });

    await markRequestCommandsSucceeded(pool, requestId);
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [requestId],
    );
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "purged" }] });
  });

  it("reconciles an initially empty capture as fenced after a late subject succeeds", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_empty_original_${suffix}`,
      email: `empty-${suffix}@example.test`,
      displayName: "Initially empty target",
    });
    const requestId = await stageAccountPurge(pool, target.id, "purging");
    await pool.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [
      target.id,
    ]);
    await pool.query(
      `DELETE FROM workos_browser_sessions
                      WHERE account_user_id = $1`,
      [target.id],
    );
    await pool.query(
      `DELETE FROM account_recovery_requests
                      WHERE target_user_id = $1`,
      [target.id],
    );
    await pool.query(`DELETE FROM user_identities WHERE user_id = $1`, [
      target.id,
    ]);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `empty-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state,
                (SELECT count(*)::int
                 FROM workos_provider_erasure_reconciliations reconciliation
                 WHERE reconciliation.deletion_request_id = request.id)
                  AS reconciliations
         FROM deletion_requests request WHERE request.id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "provider_deleting", reconciliations: 0 }],
    });

    const lateSubject = `user_empty_late_${suffix}`;
    await expect(
      resolveAuthenticatedUser(pool, candidateInput(lateSubject, target.email)),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await expect(
      pool.query(
        `INSERT INTO workos_provider_erasure_reconciliations (
           deletion_request_id, disposition, evidence_source,
           evidence_reference
         ) VALUES ($1, 'no_workos_subject', 'operator_reconciliation',
                   'test:contradictory-no-subject')`,
        [requestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await markRequestCommandsSucceeded(pool, requestId);
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [requestId],
    );
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state, reconciliation.disposition
         FROM deletion_requests request
         JOIN workos_provider_erasure_reconciliations reconciliation
           ON reconciliation.deletion_request_id = request.id
         WHERE request.id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "purged", disposition: "fenced" }],
    });
  });
});
