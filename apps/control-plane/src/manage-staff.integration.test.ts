import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { withSystemTx } from "./db.js";
import {
  manageStaffRole,
  staffRoleApprovalText,
  validateStaffRoleRequest,
} from "./manage-staff.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

/** PostgreSQL identifiers cannot be query parameters. Escape the catalog-owned
 * current_user value so this test also works with hosted principals containing
 * characters such as `-`, without treating it as executable SQL. */
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

d("owner-managed staff roles", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("plans, target-binds, audits, publishes, and revokes developer authority", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_staff_actor_${suffix}`,
      email: `staff-actor-${suffix}@example.test`,
      displayName: "Staff owner",
    });
    const subjectEmail = `support-${suffix}@example.test`;
    const subject = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_support_${suffix}`,
      email: subjectEmail,
      displayName: "Support operator",
    });

    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [
          subject.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO staff_role_changes (
             subject_user_id, actor_user_id, previous_role, next_role,
             account_revision, deployment_channel, target_fingerprint,
             database_principal, reason
           ) VALUES ($1, $2, NULL, 'developer', 1, 'alpha',
                     '0000000000000000', 'zeros_app',
                     'Application roles cannot forge this audit record.')`,
          [subject.id, actor.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    const base = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      subjectUserId: subject.id,
      expectedEmail: subjectEmail,
      actorUserId: actor.id,
      nextRole: "developer",
      reason: "Bootstrap reviewed Alpha developer access.",
    } as const;

    // Possessing the two obvious SQL grants is still insufficient. Only the
    // migration/table owner may run the operational command, so a delegated
    // role cannot become an untracked alternate bootstrap path.
    const delegateRole = `staff_delegate_${suffix.slice(0, 16)}`;
    const delegatePassword = `delegate_${suffix.slice(16, 40)}`;
    await pool.query(
      `CREATE ROLE ${delegateRole} LOGIN PASSWORD '${delegatePassword}'`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${delegateRole}`);
    await pool.query(`GRANT UPDATE (staff_role) ON users TO ${delegateRole}`);
    await pool.query(`GRANT INSERT ON staff_role_changes TO ${delegateRole}`);
    const delegateUrl = new URL(url!);
    delegateUrl.username = delegateRole;
    delegateUrl.password = delegatePassword;
    const delegatePool = new pg.Pool({
      connectionString: delegateUrl.toString(),
      max: 1,
    });
    try {
      await expect(
        manageStaffRole(delegatePool, validateStaffRoleRequest(base)),
      ).rejects.toThrow(/database\/migration owner/i);
    } finally {
      await delegatePool.end();
      await pool.query(`DROP OWNED BY ${delegateRole}`);
      await pool.query(`DROP ROLE ${delegateRole}`);
    }

    const plannedRequest = validateStaffRoleRequest(base);
    const plan = await manageStaffRole(pool, plannedRequest);
    expect(plan).toMatchObject({
      state: "planned",
      previousRole: null,
      nextRole: "developer",
      subjectUserId: subject.id,
      actorUserId: actor.id,
    });
    expect(plan.approval).toBe(staffRoleApprovalText(plannedRequest, null));

    await expect(
      manageStaffRole(
        pool,
        validateStaffRoleRequest({
          ...base,
          execute: true,
          approval: `${plan.approval}-wrong`,
        }),
      ),
    ).rejects.toThrow(/approval/i);

    const before = await pool.query<{ staff_role: string | null }>(
      `SELECT staff_role FROM users WHERE id = $1`,
      [subject.id],
    );
    expect(before.rows[0]!.staff_role).toBeNull();

    const changed = await manageStaffRole(
      pool,
      validateStaffRoleRequest({
        ...base,
        execute: true,
        approval: plan.approval,
      }),
    );
    expect(changed).toMatchObject({
      state: "changed",
      previousRole: null,
      nextRole: "developer",
    });

    const evidence = await pool.query<{
      staff_role: string | null;
      change_count: string;
      event_count: string;
    }>(
      `SELECT u.staff_role,
              (SELECT count(*) FROM staff_role_changes c
               WHERE c.subject_user_id = u.id) AS change_count,
              (SELECT count(*) FROM security_events e
               WHERE e.user_id = u.id
                 AND e.kind = 'account.authorization_changed'
                 AND e.payload->>'reason' = 'staff_role_changed') AS event_count
       FROM users u WHERE u.id = $1`,
      [subject.id],
    );
    expect(evidence.rows[0]).toMatchObject({
      staff_role: "developer",
      change_count: "1",
      event_count: "1",
    });
    await expect(
      pool.query(
        `UPDATE staff_role_changes SET reason = reason
         WHERE subject_user_id = $1`,
        [subject.id],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`DELETE FROM staff_role_changes WHERE subject_user_id = $1`, [
        subject.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(pool.query(`TRUNCATE staff_role_changes`)).rejects.toThrow(
      /append-only/i,
    );

    const revokeBase = {
      ...base,
      execute: false,
      nextRole: "none",
      reason: "Revoke the temporary recovery operator grant.",
    } as const;
    const revokeRequest = validateStaffRoleRequest(revokeBase);
    const revokePlan = await manageStaffRole(pool, revokeRequest);
    expect(revokePlan.previousRole).toBe("developer");
    await manageStaffRole(
      pool,
      validateStaffRoleRequest({
        ...revokeBase,
        execute: true,
        approval: revokePlan.approval,
      }),
    );

    const after = await pool.query<{
      staff_role: string | null;
      change_count: string;
    }>(
      `SELECT u.staff_role,
              (SELECT count(*) FROM staff_role_changes c
               WHERE c.subject_user_id = u.id) AS change_count
       FROM users u WHERE u.id = $1`,
      [subject.id],
    );
    expect(after.rows[0]).toEqual({ staff_role: null, change_count: "2" });
  });

  it("binds the system RLS context for a non-superuser migration owner", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_staff_rls_actor_${suffix}`,
      email: `staff-rls-actor-${suffix}@example.test`,
      displayName: "Staff RLS actor",
    });
    const subjectEmail = `support-rls-${suffix}@example.test`;
    const subject = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_support_rls_${suffix}`,
      email: subjectEmail,
      displayName: "Support RLS operator",
    });
    const current = await pool.query<{ principal: string }>(
      `SELECT current_user AS principal`,
    );
    const originalOwner = current.rows[0]!.principal;
    const quotedOriginalOwner = quoteIdentifier(originalOwner);
    const migrationOwner = `staff_owner_${suffix.slice(0, 16)}`;
    const migrationPassword = `owner_${suffix.slice(16, 40)}`;
    // Both identifiers and the test-only password are bounded to randomUUID()
    // hex (plus fixed ASCII prefixes); no external input reaches this SQL.
    await pool.query(
      `CREATE ROLE ${migrationOwner} LOGIN PASSWORD '${migrationPassword}'`,
    );
    const ownerUrl = new URL(url!);
    ownerUrl.username = migrationOwner;
    ownerUrl.password = migrationPassword;
    const ownerPool = new pg.Pool({
      connectionString: ownerUrl.toString(),
      max: 1,
    });
    const base = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      subjectUserId: subject.id,
      expectedEmail: subjectEmail,
      actorUserId: actor.id,
      nextRole: "developer",
      reason: "Verify the non-superuser migration-owner RLS path.",
    } as const;
    try {
      await pool.query(`ALTER TABLE users OWNER TO ${migrationOwner}`);
      await pool.query(
        `ALTER TABLE staff_role_changes OWNER TO ${migrationOwner}`,
      );
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${migrationOwner}`);
      // The users RLS policy references this table even when its system branch
      // is true; PostgreSQL still performs relation privilege checks at plan time.
      await pool.query(
        `GRANT SELECT ON organization_members TO ${migrationOwner}`,
      );
      await pool.query(`GRANT INSERT ON security_events TO ${migrationOwner}`);
      await pool.query(
        `GRANT USAGE, SELECT ON SEQUENCE security_events_sequence_seq TO ${migrationOwner}`,
      );

      const plan = await manageStaffRole(
        ownerPool,
        validateStaffRoleRequest(base),
      );
      expect(plan.state).toBe("planned");
      await manageStaffRole(
        ownerPool,
        validateStaffRoleRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      );

      const result = await pool.query<{
        staff_role: string | null;
        event_count: string;
      }>(
        `SELECT u.staff_role,
                (SELECT count(*) FROM security_events e
                 WHERE e.user_id = u.id
                   AND e.kind = 'account.authorization_changed') AS event_count
         FROM users u WHERE u.id = $1`,
        [subject.id],
      );
      expect(result.rows[0]).toEqual({
        staff_role: "developer",
        event_count: "1",
      });
    } finally {
      await ownerPool.end();
      await pool.query(`ALTER TABLE users OWNER TO ${quotedOriginalOwner}`);
      await pool.query(
        `ALTER TABLE staff_role_changes OWNER TO ${quotedOriginalOwner}`,
      );
      await pool.query(`DROP OWNED BY ${migrationOwner}`);
      await pool.query(`DROP ROLE ${migrationOwner}`);
    }
  });
});
