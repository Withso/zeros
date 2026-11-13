import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureCloudTeamOwnership, SYSTEM_DATABASE_CONTEXT } from "../../db-context.js";
import { withSystemTx, withUserTx } from "../../db.js";
import { manageAccountPro } from "../../manage-account-pro.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const report = (facts: unknown) => {
  if (process.env.CLOUD_TEAM_OWNERSHIP_SQL_PROOF) appendFileSync(process.env.CLOUD_TEAM_OWNERSHIP_SQL_PROOF, `${JSON.stringify(facts)}\n`);
};
database("0246 Creator loss, write switch and migration cost", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 15000 }); });
  beforeEach(async () => {
    f = await teamSharingFixture(pool, { ownership: true });
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspace.id]);
  });
  afterAll(() => pool.end());
  const row = async () => (await pool.query("SELECT creator_user_id,creator_revision::text,creator_absent_reason,state,access_epoch,stop_generation,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];

  it.each(["account", "security"])("clears a Creator on %s revocation without touching the VM", async kind => {
    const before = await row();
    await withSystemTx(pool, tx => kind === "account"
      ? tx.query("UPDATE users SET auth_status='identity_disabled',auth_revision=auth_revision+1 WHERE id=$1", [f.creator.id])
      : tx.query("INSERT INTO security_events(kind,user_id,payload) VALUES('account.revoked',$1,'{}')", [f.creator.id]));
    expect(await row()).toEqual({ ...before, creator_user_id: null, creator_revision: "2", creator_absent_reason: "account_revoked" });
    await withSystemTx(pool, tx => tx.query("UPDATE users SET auth_status='active' WHERE id=$1", [f.creator.id]));
    expect((await row()).creator_user_id).toBeNull();
  });

  it("records Hold durably and does not restore the Creator when paid access returns", async () => {
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      await withSystemTx(pool, async tx => {
        await tx.query("INSERT INTO users(id,email) VALUES($1,$2)", [id, `${id}@example.test`]);
        await tx.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')", [f.organizationId, id]);
      });
    }
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    const change = async (enabled: boolean) => {
      const input = { operationId: randomUUID(), channel: "development", actorUserId: f.admin.id, subjectUserId: f.creator.id,
        expectedEmail: f.creator.email, enabled, validFrom: new Date(Date.now()-60_000).toISOString(), validUntil: null,
        reason: "Verify Creator loss stays durable across entitlement restoration" };
      const options = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "development" };
      const plan = await manageAccountPro(pool, input, options);
      return manageAccountPro(pool, input, { ...options, execute: true, approval: plan.planSha256 });
    };
    const before = await row();
    await change(false);
    expect(await row()).toEqual({ ...before, creator_user_id: null, creator_revision: "2", creator_absent_reason: "hold" });
    await change(true);
    expect((await row()).creator_user_id).toBeNull();
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0].creator_user_id).toBe(f.viewer.id);
  });

  it("keeps receipts system-only and refuses forged Creator metadata", async () => {
    const request = { requestId: randomUUID(), toUserId: f.viewer.id, expectedCreatorUserId: f.creator.id, expectedCreatorRevision: "1" };
    await f.sharing.ownership.reassign(f.workspace.id, f.creator, request);
    expect((await withUserTx(pool, f.creator.id, tx => tx.query("SELECT 1 FROM cloud_v2_reassignments"))).rowCount).toBe(0);
    await expect(withUserTx(pool, f.creator.id, tx => tx.query(`INSERT INTO cloud_v2_reassignments(workspace_id,org_id,caller_user_id,request_id,request_hash,to_user_id,creator_revision)
      VALUES($1,$2,$3,$4,repeat('a',64),$3,1)`, [f.workspace.id,f.organizationId,f.creator.id,randomUUID()])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_revision=creator_revision+1 WHERE id=$1", [f.workspace.id])))
      .rejects.toMatchObject({ code: "23514", message: "cloud_creator_identity_unchanged" });
    configureCloudTeamOwnership(pool, false);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id,f.creator.id])))
      .rejects.toMatchObject({ code: "23514", message: "team_ownership_required" });
    for (const signature of ["guard_cloud_creator_ownership()", "clear_cloud_creator_ownership(uuid,uuid,text,uuid)", "fence_cloud_creator_loss()"]) {
      expect((await pool.query("SELECT has_function_privilege('public',$1,'execute') AS allowed", [signature])).rows[0].allowed).toBe(false);
    }
  });

  it("does not lend the enabled write switch to a later disabled transaction", async () => {
    const one = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      configureCloudTeamOwnership(one, true);
      const enabled = await withSystemTx(one, tx => tx.query("SELECT pg_backend_pid() AS pid,current_setting('app.cloud_team_ownership') AS enabled"));
      configureCloudTeamOwnership(one, false);
      const disabled = await withUserTx(one, f.creator.id, tx => tx.query("SELECT pg_backend_pid() AS pid,current_setting('app.cloud_team_ownership') AS enabled"));
      expect(disabled.rows[0]).toEqual({ pid: enabled.rows[0].pid, enabled: "0" });
    } finally { await one.end(); }
  });

  it("measures the expand over history, zero-row loss paths and the hot workspace guard", async () => {
    const tx = await pool.connect();
    try {
      await tx.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
        SELECT gen_random_uuid(),org_id,creator_user_id,'Fixture history',repository,'history-'||n,base_branch,'stopped'
        FROM cloud_v2_workspaces w,generate_series(1,10000) n WHERE w.id=$1`, [f.workspace.id]);
      await tx.query("ANALYZE cloud_v2_workspaces");
      await tx.query(`DROP TABLE cloud_v2_reassignments;
        DROP FUNCTION guard_cloud_creator_ownership(),fence_cloud_creator_loss(),clear_cloud_creator_ownership(uuid,uuid,text,uuid) CASCADE;
        DROP INDEX cloud_team_current_creator;
        ALTER TABLE cloud_v2_workspaces DROP CONSTRAINT cloud_creator_presence,DROP COLUMN creator_revision,DROP COLUMN creator_absent_reason,DROP COLUMN creator_absent_at;
        ALTER TABLE cloud_v2_workspaces ALTER COLUMN creator_user_id SET NOT NULL`);
      const heap = (await tx.query("SELECT relfilenode FROM pg_class WHERE oid='cloud_v2_workspaces'::regclass")).rows[0].relfilenode;
      await tx.query(`COMMIT; BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const sql = readFileSync(new URL("../../../migrations/0246_cloud_team_ownership.sql", import.meta.url), "utf8");
      const started = performance.now(); await tx.query(sql); const milliseconds = performance.now()-started;
      const rows = (await tx.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces")).rows[0].n;
      expect(rows).toBe(10002);
      expect((await tx.query("SELECT relfilenode FROM pg_class WHERE oid='cloud_v2_workspaces'::regclass")).rows[0].relfilenode).toBe(heap);
      report({ path: "expand", rows, milliseconds, rewritten: false, backfilled: 0,
        locks: (await tx.query("SELECT relation::regclass::text AS relation,mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation='cloud_v2_workspaces'::regclass AND granted ORDER BY mode")).rows });
      await tx.query(`COMMIT; BEGIN; SET LOCAL ROLE zeros_app; ${SYSTEM_DATABASE_CONTEXT}; SELECT set_config('app.cloud_team_ownership','1',true)`);
      const plan = (await tx.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM cloud_v2_workspaces
        WHERE execution_mode='active' AND creator_user_id=$1 AND org_id=$2 ORDER BY id FOR UPDATE`, [f.outsider.id,f.organizationId])).rows[0]["QUERY PLAN"][0];
      expect(JSON.stringify(plan.Plan)).toContain("cloud_team_current_creator");
      report({ path: "empty-loss-lookup", plan });
      const guard = (await tx.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
        SELECT gen_random_uuid(),org_id,creator_user_id,'Fixture insert',repository,'cost-'||n,base_branch,'stopped'
        FROM cloud_v2_workspaces w,generate_series(1,250) n WHERE w.id=$1`, [f.workspace.id])).rows[0]["QUERY PLAN"][0];
      report({ path: "workspace-insert", rows: 250, milliseconds: guard["Execution Time"],
        trigger: guard.Triggers.find((value: { "Trigger Name": string }) => value["Trigger Name"] === "cloud_creator_ownership_guard") });
      for (const enabled of [false,true]) {
        await tx.query("SELECT set_config('app.cloud_team_ownership',$1,true)", [enabled ? "1" : "0"]);
        const account = (await tx.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) UPDATE users SET auth_status=auth_status WHERE id=$1", [f.outsider.id])).rows[0]["QUERY PLAN"][0];
        const event = (await tx.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) INSERT INTO security_events(kind,user_id,payload) VALUES('account.revoked',$1,'{}')", [f.outsider.id])).rows[0]["QUERY PLAN"][0];
        report({ path: "empty-loss-events", enabled, account, event });
      }
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  }, 30_000);
});
