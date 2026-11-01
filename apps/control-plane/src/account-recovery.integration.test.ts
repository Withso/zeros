import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approveAccountRecovery } from "./account-recovery.js";
import {
  ensureUser,
  resolveAuthenticatedUser,
  type AuthedUser,
} from "./auth.js";
import {
  createDeletionLifecycleRoutes,
  DeletionLifecycleProcessor,
} from "./deletion-lifecycle.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { applyWorkOSIdentityEvent } from "./workos-events.js";
import {
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
} from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

async function waitForDeletionState(
  pool: pg.Pool,
  requestId: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM deletion_requests WHERE id = $1`,
      [requestId],
    );
    if (state.rows[0]?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Deletion request did not reach ${expected}`);
}

async function waitForBlockedOutboxDelete(pool: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%DELETE FROM workos_command_outbox command%'
       ) AS blocked`,
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Deletion finalizer did not block on its outbox cleanup");
}

d("reviewed WorkOS account recovery", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await resetMigratedTestDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("neither links nor migrates an account whose only identity is from the retired Auth0 provider", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const email = `retired-provider-${suffix}@example.test`;
    const now = Math.floor(Date.now() / 1_000);
    const retired = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name)
       VALUES ($1, 'Retired Provider') RETURNING id`,
      [email],
    );
    const retiredUserId = retired.rows[0]!.id;
    const retiredIdentity = await pool.query<{ id: string }>(
      `INSERT INTO user_identities (
         user_id, provider, provider_sub, email_at_link, email_verified_at,
         linked_via
       ) VALUES ($1, 'auth0', $2, $3, now(), 'jit')
       RETURNING id`,
      [retiredUserId, `github|${suffix}`, email],
    );

    const candidateSubject = `user_candidate_${suffix}`;
    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: candidateSubject,
        email,
        displayName: "Retired Provider",
        session: {
          id: `session_retired_candidate_${suffix}`,
          clientKind: "web",
          authTime: now,
          tokenExpiresAt: now + 300,
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "account_exists" });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
         FROM account_recovery_requests WHERE target_user_id = $1`,
        [retiredUserId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    // A migration request filed before the retirement can no longer be approved.
    const publicCode = "ZR-RETI-REDX";
    await pool.query(
      `INSERT INTO account_recovery_requests (
         public_code, candidate_provider_sub, candidate_session_id,
         candidate_email, candidate_auth_time, target_user_id,
         target_identity_id
       ) VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
      [
        publicCode,
        candidateSubject,
        `session_retired_candidate_${suffix}`,
        email,
        now,
        retiredUserId,
        retiredIdentity.rows[0]!.id,
      ],
    );
    const operator = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_retired_operator_${suffix}`,
      email: `retired-operator-${suffix}@example.test`,
      displayName: "Platform Owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [operator.id],
    );
    await expect(
      approveAccountRecovery(
        pool,
        {
          operator: {
            ...operator,
            staffRole: "platform_owner",
            authentication: {
              sessionId: `session_retired_operator_${suffix}`,
              clientKind: "web",
              authTime: now,
              tokenExpiresAt: now + 300,
            },
          },
          publicCode,
        },
        {
          supportCaseReference: "CASE-RETIRED-PROVIDER",
          ownershipVerification: "confirmed_out_of_band",
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "recovery_state_changed" });
    await expect(
      pool.query(
        `SELECT provider, status FROM user_identities WHERE user_id = $1`,
        [retiredUserId],
      ),
    ).resolves.toMatchObject({ rows: [{ provider: "auth0", status: "active" }] });
  });

  it("requires fresh candidate and operator authentication, then atomically supersedes identity without restoring collaboration", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const oldSubject = `user_old_${suffix}`;
    const newSubject = `user_new_${suffix}`;
    const email = `recover-${suffix}@example.com`;
    const original = await ensureUser(pool, {
      provider: "workos",
      providerSubject: oldSubject,
      email,
      displayName: "Recovery Target",
    });
    const collaborative = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'Temporary Organization', $2, false, true)
       RETURNING id`,
      [`recovery-${suffix}`, original.id],
    );
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [collaborative.rows[0]!.id, original.id],
    );

    await applyWorkOSIdentityEvent(pool, {
      eventId: `event_delete_${suffix}`,
      eventType: "user.deleted",
      createdAt: new Date().toISOString(),
      user: {
        id: oldSubject,
        email,
        emailVerified: true,
        name: "Recovery Target",
        profilePictureUrl: null,
      },
    });

    const now = Math.floor(Date.now() / 1_000);
    let recoveryCode = "";
    await expect(
      ensureUser(pool, {
        provider: "workos",
        providerSubject: newSubject,
        email,
        displayName: "Recovery Target",
        session: {
          id: `session_candidate_${suffix}`,
          clientKind: "web",
          authTime: now,
          tokenExpiresAt: now + 300,
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const candidate = error as {
        status?: number;
        code?: string;
        details?: { recoveryCode?: string };
      };
      recoveryCode = candidate.details?.recoveryCode ?? "";
      return (
        candidate.status === 409 &&
        candidate.code === "account_recovery_required" &&
        /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(recoveryCode)
      );
    });

    const staff = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_staff_${suffix}`,
      email: `staff-${suffix}@example.test`,
      displayName: "Staff",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'developer' WHERE id = $1`,
      [staff.id],
    );
    const operator: AuthedUser = {
      ...staff,
      staffRole: "developer",
      authentication: {
        sessionId: `session_staff_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 300,
      },
    };
    const review = {
      supportCaseReference: "CASE-IDENTITY-1001",
      ownershipVerification: "confirmed_out_of_band" as const,
    };

    await expect(
      approveAccountRecovery(
        pool,
        {
          operator,
          publicCode: recoveryCode,
        },
        review,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [staff.id],
    );
    const ownerOperator: AuthedUser = {
      ...operator,
      staffRole: "platform_owner",
    };

    await expect(
      approveAccountRecovery(
        pool,
        {
          operator: {
            ...ownerOperator,
            authentication: {
              ...ownerOperator.authentication,
              authTime: now - 301,
            },
          },
          publicCode: recoveryCode,
        },
        review,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "reauthentication_required",
    });

    expect(
      await approveAccountRecovery(
        pool,
        {
          operator: ownerOperator,
          publicCode: recoveryCode,
        },
        review,
      ),
    ).toEqual({ accountId: original.id, state: "consumed" });

    await expect(
      pool.query(
        `SELECT support_case_reference, ownership_verification_method,
                ownership_verified_at
         FROM account_recovery_requests WHERE public_code = $1`,
        [recoveryCode],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          support_case_reference: review.supportCaseReference,
          ownership_verification_method: review.ownershipVerification,
          ownership_verified_at: expect.any(Date),
        },
      ],
    });

    const resolved = await ensureUser(pool, {
      provider: "workos",
      providerSubject: newSubject,
      email,
      displayName: "Recovery Target",
    });
    expect(resolved.id).toBe(original.id);

    const identities = await pool.query(
      `SELECT provider_sub, status, linked_via
       FROM user_identities WHERE user_id = $1 ORDER BY created_at, id`,
      [original.id],
    );
    expect(identities.rows).toEqual([
      {
        provider_sub: oldSubject,
        status: "superseded",
        linked_via: "jit",
      },
      {
        provider_sub: newSubject,
        status: "active",
        linked_via: "operator_recovery",
      },
    ]);
    const memberships = await pool.query<{ is_personal: boolean }>(
      `SELECT o.is_personal
       FROM organization_members om
       JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = $1`,
      [original.id],
    );
    expect(memberships.rows).toEqual([{ is_personal: true }]);
  });

  it("recovers a provider identity without silently cancelling a pending account deletion", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const oldSubject = `user_deleting_old_${suffix}`;
    const newSubject = `user_deleting_new_${suffix}`;
    const email = `recover-deleting-${suffix}@example.test`;
    const now = Math.floor(Date.now() / 1_000);
    const original = await ensureUser(pool, {
      provider: "workos",
      providerSubject: oldSubject,
      email,
      displayName: "Deleting Recovery Target",
    });
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'Recoverable Pro', $2, false, true)
       RETURNING id`,
      [`recoverable-pro-${suffix}`, original.id],
    );
    const organizationId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (
         org_id, user_id, role, workos_membership_id
       ) VALUES ($1, $2, 'owner', $3)`,
      [organizationId, original.id, `om_old_${suffix}`],
    );
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, `org_${suffix}`],
    );
    const directoryOwner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_directory_owner_${suffix}`,
      email: `directory-owner-${suffix}@example.test`,
      displayName: "Directory Owner",
    });
    const directoryOrganization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'Directory Business', $2, false, true)
       RETURNING id`,
      [`directory-business-${suffix}`, directoryOwner.id],
    );
    const directoryOrganizationId = directoryOrganization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (
         org_id, user_id, role, workos_membership_id, membership_source
       ) VALUES ($1, $2, 'owner', $3, 'zeros'),
                ($1, $4, 'member', $5, 'scim')`,
      [
        directoryOrganizationId,
        directoryOwner.id,
        `om_directory_owner_${suffix}`,
        original.id,
        `om_directory_scim_${suffix}`,
      ],
    );
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [directoryOrganizationId, `org_directory_${suffix}`],
    );

    let actor: AuthedUser = {
      ...original,
      authentication: {
        sessionId: `session_deleting_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 300,
      },
    };
    const lifecycle = new Hono();
    lifecycle.use("/v1/*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    lifecycle.route("/", createDeletionLifecycleRoutes(pool));
    const scheduled = await lifecycle.request("/v1/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
    expect(scheduled.status).toBe(202);
    const deletion = (await scheduled.json()) as {
      deletion: { id: string; state: string };
    };

    await applyWorkOSIdentityEvent(pool, {
      eventId: `event_deleting_delete_${suffix}`,
      eventType: "user.deleted",
      createdAt: new Date().toISOString(),
      user: {
        id: oldSubject,
        email,
        emailVerified: true,
        name: "Deleting Recovery Target",
        profilePictureUrl: null,
      },
    });
    await expect(
      pool.query(
        `SELECT membership_source FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [directoryOrganizationId, original.id],
      ),
    ).resolves.toMatchObject({ rows: [] });

    const candidateInput = {
      provider: "workos" as const,
      providerSubject: newSubject,
      email,
      displayName: "Deleting Recovery Target",
      session: {
        id: `session_deleting_candidate_${suffix}`,
        clientKind: "web" as const,
        authTime: now,
        tokenExpiresAt: now + 300,
      },
    };
    let recoveryCode = "";
    await expect(ensureUser(pool, candidateInput)).rejects.toSatisfy(
      (error: unknown) => {
        const candidate = error as {
          status?: number;
          code?: string;
          details?: { recoveryCode?: string };
        };
        recoveryCode = candidate.details?.recoveryCode ?? "";
        return (
          candidate.status === 409 &&
          candidate.code === "account_recovery_required" &&
          /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(recoveryCode)
        );
      },
    );

    const platformOwner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_deleting_owner_${suffix}`,
      email: `owner-deleting-${suffix}@example.test`,
      displayName: "Platform Owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [platformOwner.id],
    );
    await expect(
      approveAccountRecovery(
        pool,
        {
          operator: {
            ...platformOwner,
            staffRole: "platform_owner",
            authentication: {
              sessionId: `session_deleting_owner_${suffix}`,
              clientKind: "web",
              authTime: now,
              tokenExpiresAt: now + 300,
            },
          },
          publicCode: recoveryCode,
        },
        {
          supportCaseReference: "CASE-DELETION-RECOVERY-1001",
          ownershipVerification: "confirmed_out_of_band",
        },
      ),
    ).resolves.toEqual({ accountId: original.id, state: "consumed" });

    await expect(
      pool.query(
        `SELECT u.auth_status, r.state AS deletion_state,
                om.role, om.workos_membership_id,
                old_identity.status AS old_identity_status,
                new_identity.status AS new_identity_status
         FROM users u
         JOIN deletion_requests r ON r.id = u.deletion_request_id
         JOIN organization_members om
           ON om.user_id = u.id AND om.org_id = $2
         JOIN user_identities old_identity
           ON old_identity.user_id = u.id
          AND old_identity.provider_sub = $3
         JOIN user_identities new_identity
           ON new_identity.user_id = u.id
          AND new_identity.provider_sub = $4
         WHERE u.id = $1`,
        [original.id, organizationId, oldSubject, newSubject],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          auth_status: "deletion_pending",
          deletion_state: "scheduled",
          role: "owner",
          workos_membership_id: null,
          old_identity_status: "superseded",
          new_identity_status: "active",
        },
      ],
    });

    actor = await resolveAuthenticatedUser(pool, candidateInput, {
      allowDeletionPending: true,
    });
    expect(actor.accountStatus).toBe("deletion_pending");
    const restored = await lifecycle.request("/v1/account/deletion/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: deletion.deletion.id }),
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      deletion: { id: deletion.deletion.id, state: "restored" },
    });
    await expect(
      pool.query(
        `SELECT u.auth_status, o.lifecycle_status, om.role
         FROM users u
         JOIN organization_members om
           ON om.user_id = u.id AND om.org_id = $2
         JOIN organizations o ON o.id = om.org_id
         WHERE u.id = $1`,
        [original.id, organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          auth_status: "active",
          lifecycle_status: "active",
          role: "owner",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT operation, provider_object_id, payload->>'workosUserId' AS workos_user_id
         FROM workos_command_outbox
         WHERE operation = 'membership.create'
           AND organization_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [organizationId, original.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: "membership.create",
          provider_object_id: null,
          workos_user_id: newSubject,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
         FROM workos_command_outbox
         WHERE operation = 'membership.create'
           AND organization_id = $1 AND user_id = $2`,
        [directoryOrganizationId, original.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("lets purge win a concurrent recovery review and fences the late candidate token", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const oldSubject = `user_purge_race_old_${suffix}`;
    const candidateSubject = `user_purge_race_candidate_${suffix}`;
    const email = `purge-race-${suffix}@example.test`;
    const now = Math.floor(Date.now() / 1_000);
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: oldSubject,
      email,
      displayName: "Purge Race Target",
      session: {
        id: `session_purge_race_old_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    });

    const lifecycle = new Hono();
    lifecycle.use("/v1/*", async (c, next) => {
      c.set("user", target);
      await next();
    });
    lifecycle.route("/", createDeletionLifecycleRoutes(pool));
    const scheduled = await lifecycle.request("/v1/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
    expect(scheduled.status).toBe(202);
    const deletion = (await scheduled.json()) as {
      deletion: { id: string };
    };

    await applyWorkOSIdentityEvent(pool, {
      eventId: `event_purge_race_delete_${suffix}`,
      eventType: "user.deleted",
      createdAt: new Date().toISOString(),
      user: {
        id: oldSubject,
        email,
        emailVerified: true,
        name: "Purge Race Target",
        profilePictureUrl: null,
      },
    });
    const candidateInput = {
      provider: "workos" as const,
      providerSubject: candidateSubject,
      email,
      displayName: "Purge Race Target",
      session: {
        id: `session_purge_race_candidate_${suffix}`,
        clientKind: "web" as const,
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    };
    let recoveryCode = "";
    await expect(
      resolveAuthenticatedUser(pool, candidateInput),
    ).rejects.toSatisfy((error: unknown) => {
      const candidate = error as {
        code?: string;
        details?: { recoveryCode?: string };
      };
      recoveryCode = candidate.details?.recoveryCode ?? "";
      return (
        candidate.code === "account_recovery_required" &&
        /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(recoveryCode)
      );
    });

    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_purge_race_owner_${suffix}`,
      email: `purge-race-owner-${suffix}@example.test`,
      displayName: "Purge Race Owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [owner.id],
    );
    const operator: AuthedUser = {
      ...owner,
      staffRole: "platform_owner",
      authentication: {
        sessionId: `session_purge_race_owner_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    };

    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [target.id],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [deletion.deletion.id],
    );

    const blocker = await pool.connect();
    const oldSubjectLock = workOSProviderSubjectLockKey({
      kind: "user",
      id: oldSubject,
    });
    await blocker.query(
      `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`,
      [oldSubjectLock],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `recovery-race-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const processing = processor.tick(1);
    await waitForDeletionState(pool, deletion.deletion.id, "purging");

    const recoveryPool = new pg.Pool({ connectionString: url, max: 3 });
    const reviewOutcome = await approveAccountRecovery(
      recoveryPool,
      { operator, publicCode: recoveryCode },
      {
        supportCaseReference: "CASE-PURGE-RACE-1001",
        ownershipVerification: "confirmed_out_of_band",
      },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await blocker.query(
      `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
      [oldSubjectLock],
    );
    blocker.release();
    await recoveryPool.end();
    await expect(processing).resolves.toBe(1);
    expect(reviewOutcome).toMatchObject({
      error: { status: 409, code: "recovery_state_changed" },
    });

    const command = await pool.query<{ purge_command_id: string }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [deletion.deletion.id],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 OR payload->>'deletionRequestId' = $2::text`,
      [command.rows[0]!.purge_command_id, deletion.deletion.id],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [deletion.deletion.id],
    );
    expect(await processor.tick(1)).toBe(1);

    await expect(
      resolveAuthenticatedUser(pool, candidateInput),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM user_identities
            WHERE provider = 'workos' AND provider_sub = $1) AS identities,
           (SELECT count(*)::int FROM account_recovery_requests
            WHERE candidate_provider_sub = $1) AS recoveries,
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE provider = 'workos' AND subject_kind = 'user'
              AND subject_hash = $2) AS fences`,
        [
          candidateSubject,
          workOSProviderSubjectHash({ kind: "user", id: candidateSubject }),
        ],
      ),
    ).resolves.toMatchObject({
      rows: [{ identities: 0, recoveries: 0, fences: 1 }],
    });
  });

  it("lets a never-seen direct bearer subject sign up when final erasure wins", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const oldSubject = `user_direct_race_old_${suffix}`;
    const candidateSubject = `user_direct_race_candidate_${suffix}`;
    const email = `direct-race-${suffix}@example.test`;
    const now = Math.floor(Date.now() / 1_000);
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: oldSubject,
      email,
      displayName: "Direct Bearer Race Target",
      session: {
        id: `session_direct_race_old_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    });

    const lifecycle = new Hono();
    lifecycle.use("/v1/*", async (c, next) => {
      c.set("user", target);
      await next();
    });
    lifecycle.route("/", createDeletionLifecycleRoutes(pool));
    const scheduled = await lifecycle.request("/v1/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
    expect(scheduled.status).toBe(202);
    const deletion = (await scheduled.json()) as {
      deletion: { id: string };
    };

    await applyWorkOSIdentityEvent(pool, {
      eventId: `event_direct_race_delete_${suffix}`,
      eventType: "user.deleted",
      createdAt: new Date().toISOString(),
      user: {
        id: oldSubject,
        email,
        emailVerified: true,
        name: "Direct Bearer Race Target",
        profilePictureUrl: null,
      },
    });
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [target.id],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [deletion.deletion.id],
    );

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `direct-auth-race-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    const command = await pool.query<{ purge_command_id: string }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [deletion.deletion.id],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 OR payload->>'deletionRequestId' = $2::text`,
      [command.rows[0]!.purge_command_id, deletion.deletion.id],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [deletion.deletion.id],
    );

    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM workos_command_outbox WHERE id = $1 FOR UPDATE`,
      [command.rows[0]!.purge_command_id],
    );
    const finalizing = processor.tick(1);
    const authenticationPool = new pg.Pool({ connectionString: url, max: 3 });
    await waitForBlockedOutboxDelete(authenticationPool);

    let authenticationSettled = false;
    const authentication = resolveAuthenticatedUser(authenticationPool, {
      provider: "workos",
      providerSubject: candidateSubject,
      email,
      displayName: "Direct Bearer Race Target",
      session: {
        id: `session_direct_race_candidate_${suffix}`,
        clientKind: "desktop",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        authenticationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(authenticationSettled).toBe(false);

    await blocker.query("ROLLBACK");
    blocker.release();
    await expect(finalizing).resolves.toBe(1);
    const authenticationOutcome = await authentication;
    expect(authenticationOutcome).toMatchObject({
      value: {
        accountStatus: "active",
        identity: { provider: "workos", subject: candidateSubject },
      },
    });
    if (!("value" in authenticationOutcome)) {
      throw new Error("Expected finalizer-winning authentication to sign up");
    }
    expect(authenticationOutcome.value.id).not.toBe(target.id);
    await authenticationPool.end();

    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM user_identities
            WHERE provider = 'workos' AND provider_sub = $1) AS identities,
           (SELECT count(*)::int FROM account_recovery_requests
            WHERE candidate_provider_sub = $1) AS recoveries,
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE provider = 'workos' AND subject_kind = 'user'
              AND subject_hash = $2) AS fences,
           (SELECT count(*)::int FROM workos_command_outbox
            WHERE operation = 'user.delete' AND user_id = $3
              AND provider_object_id = $1
              AND payload->>'workosUserId' = $1
              AND payload->>'deletionRequestId' = $4::text
              AND state = 'queued') AS delete_commands`,
        [
          candidateSubject,
          workOSProviderSubjectHash({ kind: "user", id: candidateSubject }),
          target.id,
          deletion.deletion.id,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        { identities: 1, recoveries: 0, fences: 0, delete_commands: 0 },
      ],
    });

    await expect(
      resolveAuthenticatedUser(pool, {
        provider: "workos",
        providerSubject: candidateSubject,
        email,
        displayName: "Direct Bearer Race Target",
        session: {
          id: `session_direct_race_retry_${suffix}`,
          clientKind: "desktop",
          authTime: now,
          tokenExpiresAt: now + 3_600,
        },
      }),
    ).resolves.toMatchObject({ id: authenticationOutcome.value.id });
  });
});
