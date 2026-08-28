import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approveAccountRecovery } from "./account-recovery.js";
import { ensureUser, type AuthedUser } from "./auth.js";
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
      email: `staff-${suffix}@example.com`,
      displayName: "Staff",
    });
    await pool.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [
      staff.id,
    ]);
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

    await expect(
      approveAccountRecovery(pool, {
        operator: {
          ...operator,
          authentication: {
            ...operator.authentication,
            authTime: now - 301,
          },
        },
        publicCode: recoveryCode,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "reauthentication_required",
    });

    expect(
      await approveAccountRecovery(pool, {
        operator,
        publicCode: recoveryCode,
      }),
    ).toEqual({ accountId: original.id, state: "consumed" });

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
});
