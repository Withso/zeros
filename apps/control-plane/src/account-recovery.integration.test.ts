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
import { createDeletionLifecycleRoutes } from "./deletion-lifecycle.js";
import { runMigrations } from "./migrate.js";
import { applyWorkOSIdentityEvent } from "./workos-events.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("reviewed WorkOS account recovery", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
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
    const restored = await lifecycle.request(
      "/v1/account/deletion/restore",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: deletion.deletion.id }),
      },
    );
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
});
