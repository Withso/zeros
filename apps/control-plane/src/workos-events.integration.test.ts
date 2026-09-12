import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import {
  applyWorkOSIdentityEvent,
  type WorkOSIdentityEvent,
} from "./workos-events.js";
import { workOSProviderSubjectHash } from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("WorkOS user lifecycle events", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const event = (
    eventType: "user.updated" | "user.deleted",
    subject: string,
    email: string,
    overrides: Partial<WorkOSIdentityEvent> = {},
  ): WorkOSIdentityEvent => ({
    eventId: `event_${randomUUID().replaceAll("-", "")}`,
    eventType,
    createdAt: new Date().toISOString(),
    user: {
      id: subject,
      email,
      emailVerified: true,
      name: "Lifecycle User",
      profilePictureUrl: "https://images.example.test/profile.png",
    },
    ...overrides,
  });

  it("updates a linked profile idempotently without changing its internal owner id", async () => {
    const subject = `user_${randomUUID().replaceAll("-", "")}`;
    const originalEmail = `before-${randomUUID()}@example.com`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: originalEmail,
      displayName: "Before",
    });
    const update = event(
      "user.updated",
      subject,
      `after-${randomUUID()}@example.com`,
    );

    expect(await applyWorkOSIdentityEvent(pool, update)).toEqual({
      status: "applied",
    });
    expect(await applyWorkOSIdentityEvent(pool, update)).toEqual({
      status: "duplicate",
    });
    const stored = await pool.query(
      `SELECT id, email, display_name, avatar_url FROM users WHERE id = $1`,
      [user.id],
    );
    expect(stored.rows[0]).toMatchObject({
      id: user.id,
      email: update.user.email,
      display_name: "Lifecycle User",
      avatar_url: "https://images.example.test/profile.png",
    });
  });

  it("records an email collision for operator recovery without transferring ownership", async () => {
    const firstSubject = `user_${randomUUID().replaceAll("-", "")}`;
    const secondSubject = `user_${randomUUID().replaceAll("-", "")}`;
    const firstEmail = `first-${randomUUID()}@example.com`;
    const occupiedEmail = `occupied-${randomUUID()}@example.com`;
    const first = await ensureUser(pool, {
      provider: "workos",
      providerSubject: firstSubject,
      email: firstEmail,
      displayName: "First",
    });
    const second = await ensureUser(pool, {
      provider: "workos",
      providerSubject: secondSubject,
      email: occupiedEmail,
      displayName: "Second",
    });

    const result = await applyWorkOSIdentityEvent(
      pool,
      event("user.updated", firstSubject, occupiedEmail),
    );
    expect(result).toEqual({ status: "email_conflict" });
    const owners = await pool.query(
      `SELECT id, email FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[first.id, second.id]],
    );
    expect(owners.rows.find((row) => row.id === first.id)?.email).toBe(
      firstEmail,
    );
    expect(owners.rows.find((row) => row.id === second.id)?.email).toBe(
      occupiedEmail,
    );
  });

  it("soft-deletes authentication only and rejects later tokens for that subject", async () => {
    const subject = `user_${randomUUID().replaceAll("-", "")}`;
    const email = `deleted-${randomUUID()}@example.com`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email,
      displayName: "Delete Me",
    });
    await pool.query(
      `INSERT INTO workos_browser_sessions (
         credential_hash, kind, sealed_session, provider_session_id,
         provider_sub, email, display_name, access_token_expires_at,
         expires_at, revision
       ) VALUES (
         decode(md5(random()::text) || md5(random()::text), 'hex'),
         'session', 'sealed-session-for-delete-test', 'session_delete_test',
         $1, $2, 'Delete Me', now() + interval '5 minutes',
         now() + interval '30 days', 1
       )`,
      [subject, email],
    );

    expect(
      await applyWorkOSIdentityEvent(
        pool,
        event("user.deleted", subject, email),
      ),
    ).toEqual({ status: "applied" });
    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: subject,
        email,
        displayName: "Delete Me",
      }),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    const productRows = await pool.query(
      `SELECT count(*)::int AS count FROM organizations WHERE created_by = $1`,
      [user.id],
    );
    expect(productRows.rows[0]?.count).toBe(1);
    const browserSessions = await pool.query(
      `SELECT count(*)::int AS count
       FROM workos_browser_sessions WHERE provider_sub = $1`,
      [subject],
    );
    expect(browserSessions.rows[0]?.count).toBe(0);
  });

  it("requires reviewed recovery when WorkOS recreates a deleted user with the same verified email", async () => {
    const originalSubject = `user_${randomUUID().replaceAll("-", "")}`;
    const replacementSubject = `user_${randomUUID().replaceAll("-", "")}`;
    const email = `recreated-${randomUUID()}@example.com`;
    const original = await ensureUser(pool, {
      provider: "workos",
      providerSubject: originalSubject,
      email,
      displayName: "Recreated User",
    });

    await applyWorkOSIdentityEvent(
      pool,
      event("user.deleted", originalSubject, email),
    );

    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: replacementSubject,
        email,
        displayName: "Recreated User",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "account_recovery_required",
    });

    const preserved = await pool.query(
      `SELECT id, email FROM users WHERE id = $1`,
      [original.id],
    );
    expect(preserved.rows).toEqual([{ id: original.id, email }]);
    const replacementBinding = await pool.query(
      `SELECT 1 FROM user_identities
       WHERE provider = 'workos' AND provider_sub = $1`,
      [replacementSubject],
    );
    expect(replacementBinding.rowCount).toBe(0);
  });

  it("records an unlinked event without provisioning an account", async () => {
    const subject = `user_${randomUUID().replaceAll("-", "")}`;
    const before = await pool.query(`SELECT count(*)::int AS count FROM users`);
    expect(
      await applyWorkOSIdentityEvent(
        pool,
        event("user.updated", subject, `unknown-${randomUUID()}@example.com`),
      ),
    ).toEqual({ status: "unlinked" });
    const after = await pool.query(`SELECT count(*)::int AS count FROM users`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("acknowledges an erased subject without rebuilding the identity event ledger", async () => {
    const subject = `user_erased_${randomUUID().replaceAll("-", "")}`;
    const email = `erased-${randomUUID()}@example.com`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email,
      displayName: "Erased Identity",
    });
    const request = await pool.query<{ id: string }>(
      `INSERT INTO deletion_requests (
         public_code, target_kind, target_id, target_user_id, state,
         purge_started_at, next_attempt_at
       ) VALUES ('ZD-STND-ALON', 'account', $1, $1,
                 'provider_deleting', now(), now())
       RETURNING id`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, action, metadata
       ) VALUES ($1, 'purge.provider_erasure_fenced', $2::jsonb)`,
      [
        request.rows[0]!.id,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [
            workOSProviderSubjectHash({ kind: "user", id: subject }),
          ],
        }),
      ],
    );
    await pool.query(
      `DELETE FROM user_identities
       WHERE provider = 'workos' AND provider_sub = $1`,
      [subject],
    );
    const delayed = event("user.updated", subject, email);

    await expect(applyWorkOSIdentityEvent(pool, delayed)).resolves.toEqual({
      status: "ignored_deleted",
    });
    await expect(
      pool.query(`SELECT 1 FROM identity_provider_events WHERE event_id = $1`, [
        delayed.eventId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("returns retryable failures for unknown auth and events until historical purge evidence is reconciled", async () => {
    const requestId = randomUUID();
    const subject = `user_pending_${randomUUID().replaceAll("-", "")}`;
    const email = `pending-${randomUUID()}@example.com`;
    const delayed = event("user.updated", subject, email);
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES ($1, 'ZD-RTRY-PEND', 'account', $1, 'purged',
                 '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
                 '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z')`,
      [requestId],
    );

    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: subject,
        email,
        displayName: "Pending Reconciliation",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "authentication_temporarily_unavailable",
    });
    await expect(applyWorkOSIdentityEvent(pool, delayed)).rejects.toMatchObject(
      {
        status: 503,
        code: "workos_provider_erasure_reconciliation_pending",
      },
    );
    await expect(
      pool.query(`SELECT 1 FROM identity_provider_events WHERE event_id = $1`, [
        delayed.eventId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(
        `SELECT 1 FROM user_identities
         WHERE provider = 'workos' AND provider_sub = $1`,
        [subject],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    await pool.query(
      `INSERT INTO workos_provider_erasure_reconciliations (
         deletion_request_id, disposition, evidence_source,
         evidence_reference
       ) VALUES ($1, 'no_workos_subject', 'operator_reconciliation',
                 'test:provider-audit-confirmed-local-only')`,
      [requestId],
    );
    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: subject,
        email,
        displayName: "Reconciled Signup",
      }),
    ).resolves.toMatchObject({ identity: { subject } });
  });
});
