import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureUser } from "./auth.js";
import { manageStaffRole, validateStaffRoleRequest } from "./manage-staff.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("staff bootstrap organization ownership", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await resetMigratedTestDatabase(pool);
  });
  afterAll(async () => { await pool.end(); });

  async function fixture() {
    const suffix = randomUUID().replaceAll("-", "");
    const expectedEmail = `bootstrap-subject-${suffix}@example.test`;
    const subject = await ensureUser(pool, { provider: "workos", providerSubject: `bootstrap_subject_${suffix}`,
      email: expectedEmail, displayName: "Bootstrap subject" });
    const actor = await ensureUser(pool, { provider: "workos", providerSubject: `bootstrap_actor_${suffix}`,
      email: `bootstrap-actor-${suffix}@example.test`, displayName: "Bootstrap actor" });
    const ownerOrganizationId = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal)
      VALUES ($1,$2,'Bootstrap organization',$3,false)`, [ownerOrganizationId, `bootstrap-${suffix}`, subject.id]);
    await pool.query("INSERT INTO organization_members (org_id,user_id,role) VALUES ($1,$2,'owner')", [ownerOrganizationId, subject.id]);
    const input = { databaseUrl: databaseUrl!, channel: "beta", execute: false, subjectUserId: subject.id,
      expectedEmail, actorUserId: actor.id, nextRole: "platform_owner", ownerOrganizationId,
      reason: "Bootstrap the reviewed active Beta organization owner." };
    return { input, subject, actor, ownerOrganizationId };
  }

  async function assertNoGrant(subjectUserId: string) {
    expect((await pool.query("SELECT staff_role FROM users WHERE id=$1", [subjectUserId])).rows[0].staff_role).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM staff_role_changes WHERE subject_user_id=$1", [subjectUserId])).rows[0].count).toBe(0);
  }

  it("uses the existing audited utility for an active exact nonpersonal organization owner", async () => {
    const test = await fixture();
    const plan = await manageStaffRole(pool, validateStaffRoleRequest(test.input));
    expect(plan.state).toBe("planned"); expect(plan.approval).toContain(test.ownerOrganizationId);
    const result = await manageStaffRole(pool, validateStaffRoleRequest({ ...test.input, execute: true, approval: plan.approval! }));
    expect(result.state).toBe("changed"); expect(result.nextRole).toBe("platform_owner");
    expect((await pool.query("SELECT next_role, deployment_channel, actor_user_id FROM staff_role_changes WHERE subject_user_id=$1", [test.subject.id])).rows)
      .toEqual([{ next_role: "platform_owner", deployment_channel: "beta", actor_user_id: test.actor.id }]);
    const unchanged = await manageStaffRole(pool, validateStaffRoleRequest(test.input));
    expect(unchanged.state).toBe("unchanged"); expect(unchanged.approval).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM staff_role_changes WHERE subject_user_id=$1", [test.subject.id])).rows[0].count).toBe(1);
  });

  it.each(["missing", "different-owner", "admin", "personal", "deleted", "purging"])("refuses %s organization authority before any staff grant", async rejection => {
    const test = await fixture();
    if (rejection === "missing") test.input.ownerOrganizationId = randomUUID();
    if (rejection === "different-owner") {
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [test.ownerOrganizationId, test.subject.id]);
      await pool.query("INSERT INTO organization_members (org_id,user_id,role) VALUES ($1,$2,'owner')", [test.ownerOrganizationId, test.actor.id]);
    }
    if (rejection === "admin") await pool.query("UPDATE organization_members SET role='admin' WHERE org_id=$1", [test.ownerOrganizationId]);
    if (rejection === "personal") {
      const personal = (await pool.query("SELECT id FROM organizations WHERE created_by=$1 AND is_personal AND deleted_at IS NULL", [test.subject.id])).rows[0];
      test.input.ownerOrganizationId = personal.id;
    }
    if (rejection === "deleted") await pool.query("UPDATE organizations SET deleted_at=now() WHERE id=$1", [test.ownerOrganizationId]);
    if (rejection === "purging") await pool.query("UPDATE organizations SET lifecycle_status='purging' WHERE id=$1", [test.ownerOrganizationId]);
    await expect(manageStaffRole(pool, validateStaffRoleRequest(test.input))).rejects.toThrow("Organization");
    await assertNoGrant(test.subject.id);
  });

  it("rechecks ownership on apply and refuses the same plan after ownership changes", async () => {
    const test = await fixture();
    const plan = await manageStaffRole(pool, validateStaffRoleRequest(test.input));
    await pool.query("UPDATE organization_members SET role='admin' WHERE org_id=$1", [test.ownerOrganizationId]);
    await expect(manageStaffRole(pool, validateStaffRoleRequest({ ...test.input, execute: true, approval: plan.approval! }))).rejects.toThrow("Organization");
    await assertNoGrant(test.subject.id);
  });

  it("refuses an approval from another otherwise valid owned organization", async () => {
    const test = await fixture(), other = randomUUID();
    await pool.query(`INSERT INTO organizations (id,slug,name,created_by,is_personal)
      VALUES ($1,$2,'Other bootstrap organization',$3,false)`, [other, `other-${other}`, test.subject.id]);
    await pool.query("INSERT INTO organization_members (org_id,user_id,role) VALUES ($1,$2,'owner')", [other, test.subject.id]);
    const plan = await manageStaffRole(pool, validateStaffRoleRequest(test.input));
    await expect(manageStaffRole(pool, validateStaffRoleRequest({ ...test.input, ownerOrganizationId: other,
      execute: true, approval: plan.approval! }))).rejects.toThrow("current target-bound plan");
    await assertNoGrant(test.subject.id);
  });

  it("keeps organization and owner membership locked throughout the role-change transaction", async () => {
    const test = await fixture();
    const plan = await manageStaffRole(pool, validateStaffRoleRequest(test.input));
    const client = await pool.connect();
    let resume: () => void = () => {};
    let observed: () => void = () => {};
    const held = new Promise<void>(resolve => { observed = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const wrapped = {
      async query(sql: string, parameters?: unknown[]) {
        const result = await client.query(sql, parameters);
        if (sql.includes("FROM organizations")) { observed(); await gate; }
        return result;
      },
      release: () => client.release(),
    };
    const operation = manageStaffRole({ connect: async () => wrapped } as unknown as pg.Pool,
      validateStaffRoleRequest({ ...test.input, execute: true, approval: plan.approval! }));
    const contender = await pool.connect();
    try {
      await Promise.race([held, operation.then(() => { throw new Error("Organization ownership was never locked"); })]);
      for (const sql of ["UPDATE organization_members SET role='admin' WHERE org_id=$1", "UPDATE organizations SET deleted_at=now() WHERE id=$1"]) {
        await contender.query("BEGIN"); await contender.query("SET LOCAL lock_timeout='100ms'");
        await expect(contender.query(sql, [test.ownerOrganizationId])).rejects.toThrow(/lock timeout/);
        await contender.query("ROLLBACK");
      }
    } finally {
      resume(); contender.release();
      await operation;
    }
    expect((await pool.query("SELECT staff_role FROM users WHERE id=$1", [test.subject.id])).rows[0].staff_role).toBe("platform_owner");
  });
});
