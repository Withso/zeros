import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "./authz.js";
import { enqueueWorkspaceCheckpointRequest } from "./cloud-workspaces/checkpoint-requests.js";
import { createCloudWorkspaceRoutes } from "./cloud-workspaces/routes.js";
import {
  seedCanonicalCloudWorkspaceAuthority,
  seedReadyCloudWorkspace,
  seedSupportedCloudWorkspaceGeneration,
  withCloudFixtureOwnerTx,
  type ReadyCloudWorkspaceFixture,
} from "./cloud-workspaces/test-fixtures.js";
import { withSystemTx, type Tx } from "./db.js";
import {
  manageCloudWorkspaceDeletion,
  validateCloudWorkspaceDeletionRequest,
  type CloudWorkspaceDeletionRequestInput,
} from "./manage-cloud-workspace-deletion.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("guarded organization cloud workspace deletion", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let slug: string;
  let approvalId: string;
  const reason = "Remove archived disposable cloud workspaces";

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Operator deletion must not call a provider"); }));
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    slug = (await pool.query("SELECT slug::text FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
    approvalId = randomUUID();
    await setStatus("archived");
  });

  const request = (overrides: Partial<CloudWorkspaceDeletionRequestInput> = {}) =>
    validateCloudWorkspaceDeletionRequest({
      databaseUrl: url!, channel: "alpha", execute: false, approvalId,
      organizationId: fixture.organizationId, expectedOrganizationSlug: slug,
      actorUserId: fixture.userId, workspaceIds: fixture.workspaceId, reason, ...overrides,
    });

  async function setStatus(status: string, workspaceId = fixture.workspaceId) {
    const desired = ["stopped", "archived", "deleted"].includes(status) ? status : "running";
    await pool.query(`UPDATE cloud_workspaces SET status=$2::cloud_workspace_status,desired_state=$3::cloud_workspace_desired_state,
      deleted_at=CASE WHEN $2='deleted' THEN now() END WHERE id=$1`, [workspaceId, status, desired]);
  }

  async function addWorkspace(status: string) {
    const workspaceId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces
        (id,org_id,team_id,created_by,owner_user_id,assignee_user_id,display_name,
         repository_id,repository_forge,repository_owner,repository_name,repository_revision)
        SELECT $2,org_id,team_id,created_by,owner_user_id,assignee_user_id,'Another fixture',
          repository_id,repository_forge,repository_owner,repository_name,repository_revision
        FROM cloud_workspaces WHERE id=$1`, [fixture.workspaceId, workspaceId]);
      await seedCanonicalCloudWorkspaceAuthority(tx, { workspaceId, organizationId: fixture.organizationId, ownerUserId: fixture.userId });
      await seedSupportedCloudWorkspaceGeneration(tx, { workspaceId, organizationId: fixture.organizationId, ownerUserId: fixture.userId });
      await tx.query(`INSERT INTO cloud_workspace_provider_bindings
        (workspace_id,generation,org_id,provider,provider_resource_id,observed_state)
        VALUES($1,1,$2,'boat',$3,'stopped')`, [workspaceId, fixture.organizationId, `sandbox-${workspaceId}`]);
    });
    await setStatus(status, workspaceId);
    return workspaceId;
  }

  async function approve(overrides: Partial<CloudWorkspaceDeletionRequestInput> = {}) {
    const plan = await manageCloudWorkspaceDeletion(pool, request(overrides));
    return request({ ...overrides, execute: true, approval: plan.approval! });
  }

  // Compare persisted lifecycle effects on the exact same workspace. HTTP's
  // transaction is held open for inspection, then rolled back before execution
  // of the operator; only its COMMIT/release are intercepted.
  async function routeEffects(key: string) {
    const client = await pool.connect();
    const held = {
      query: (sql: string, values?: unknown[]) => client.query(sql === "COMMIT" ? "SELECT 1" : sql, values),
      release() {},
    } as Tx;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId }); await next(); });
    app.route("/", createCloudWorkspaceRoutes({ connect: async () => held } as pg.Pool, null));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: error.code }, error.status);
      throw error;
    });
    try {
      const response = await app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}`, {
        method: "DELETE", headers: { "Idempotency-Key": key },
      });
      expect(response.status).toBe(202);
      return await effects(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function effects(tx: Tx) {
    const workspace = (await tx.query(`SELECT status,desired_state,version,authority_epoch
      FROM cloud_workspaces WHERE id=$1`, [fixture.workspaceId])).rows[0];
    const intents = (await tx.query(`SELECT id,workspace_id,generation,org_id,requested_by,operation,
      idempotency_key,encode(request_sha256,'hex') AS digest,state,attempt_count,affects_workspace,
      generation_transition_id,resume_after_intent_id,completed_at IS NOT NULL AS completed
      FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 ORDER BY created_at,id`, [fixture.workspaceId])).rows;
    const deletion = intents.find(intent => intent.operation === "delete");
    const jobs = (await tx.query(`SELECT workspace_id,org_id,requested_by,idempotency_key,state,
      attempt_count,error_code,completed_at IS NOT NULL AS completed
      FROM workspace_deletion_jobs WHERE workspace_id=$1`, [fixture.workspaceId])).rows;
    const checkpoints = (await tx.query(`SELECT id,reason,state,lifecycle_intent_id,
      deadline_at IS NOT NULL AS has_deadline FROM workspace_checkpoint_requests
      WHERE workspace_id=$1 ORDER BY created_at,id`, [fixture.workspaceId])).rows;
    const audits = (await tx.query(`SELECT org_id,actor_id,action,subject FROM audit_log
      WHERE org_id=$1 AND action='cloud_workspace.delete_requested' ORDER BY id`, [fixture.organizationId])).rows;
    const engine = (await tx.query(`SELECT revoked_at IS NOT NULL AS revoked FROM cloud_workspace_engine_instances
      WHERE workspace_id=$1`, [fixture.workspaceId])).rows;
    const setup = (await tx.query(`SELECT state,error_code FROM cloud_workspace_setup_runs
      WHERE workspace_id=$1`, [fixture.workspaceId])).rows;
    const grants = (await tx.query(`SELECT purpose,revoked_at IS NOT NULL AS revoked FROM cloud_workspace_endpoint_grants
      WHERE workspace_id=$1 ORDER BY purpose`, [fixture.workspaceId])).rows;
    const checkpoint = checkpoints.find(row => row.reason === "before_delete");
    // UUIDs and wall clocks are generated per transaction; all behavioral
    // columns, request digest, actor and target remain exact comparisons.
    return JSON.parse(JSON.stringify({ workspace, intents, jobs, checkpoints, audits, engine, setup, grants })
      .replaceAll(deletion?.id ?? "no-delete-id", "DELETE_INTENT")
      .replaceAll(checkpoint?.id ?? "no-checkpoint-id", "FINAL_CHECKPOINT")
      .replace(/"checkpointDeadlineAt":"[^"]+"/g, '"checkpointDeadlineAt":"DEADLINE"'));
  }

  async function mutationCounts() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM cloud_workspace_lifecycle_intents WHERE operation='delete') AS intents,
      (SELECT count(*) FROM workspace_deletion_jobs) AS jobs,
      (SELECT count(*) FROM audit_log WHERE action IN
        ('cloud_workspace.delete_requested','cloud_workspace.operator_deletion_requested')) AS audits`)).rows[0];
  }

  it("defaults to a read-only plan with exact states and leaves runtime authority intact", async () => {
    const before = await withSystemTx(pool, effects);
    const plan = await manageCloudWorkspaceDeletion(pool, request());
    expect(plan).toMatchObject({ state: "planned", workspaces: [{ workspaceId: fixture.workspaceId,
      status: "archived", version: "1", outcome: "planned", intentId: null }] });
    expect(plan.approval).toContain(approvalId);
    expect(await withSystemTx(pool, effects)).toEqual(before);
    expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["archived", "stopped", "failed"])("executes %s deletion with the HTTP route's exact lifecycle effects", async status => {
    await setStatus(status);
    const execution = await approve();
    const expected = await routeEffects(`operator-delete:${approvalId}:${fixture.workspaceId}`);
    const result = await manageCloudWorkspaceDeletion(pool, execution);
    expect(result).toMatchObject({ state: "requested", workspaces: [{ status: "deleting", outcome: "requested", intentState: "queued" }] });
    expect(await withSystemTx(pool, effects)).toEqual(expected);
    const receipts = (await pool.query(`SELECT actor_id,subject FROM audit_log
      WHERE action='cloud_workspace.operator_deletion_requested'`)).rows;
    expect(receipts).toEqual([{ actor_id: fixture.userId, subject: expect.objectContaining({
      approvalId, approval: execution.approval, reason, channel: "alpha",
      targetFingerprint: execution.targetFingerprint, actorUserId: fixture.userId,
      organizationId: fixture.organizationId, workspaces: [expect.objectContaining({ status, version: "1" })],
    }) }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays the same approval after version changes, reusing the intent and repairing a failed deletion job", async () => {
    const execution = await approve();
    const first = await manageCloudWorkspaceDeletion(pool, execution);
    await pool.query(`UPDATE workspace_deletion_jobs SET state='failed',error_code='synthetic_failure',
      attempt_count=5,completed_at=now() WHERE workspace_id=$1`, [fixture.workspaceId]);
    const replay = await manageCloudWorkspaceDeletion(pool, execution);
    expect(replay).toMatchObject({ state: "replayed", workspaces: [{
      intentId: first.workspaces[0]!.intentId, outcome: "replayed", status: "deleting", version: "2",
    }] });
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
    expect((await pool.query("SELECT state,attempt_count,error_code FROM workspace_deletion_jobs")).rows)
      .toEqual([{ state: "waiting_for_provider", attempt_count: 0, error_code: null }]);
  });

  it("serializes concurrent execution of one approval into one request and one replay", async () => {
    const execution = await approve();
    const results = await Promise.all([
      manageCloudWorkspaceDeletion(pool, execution), manageCloudWorkspaceDeletion(pool, execution),
    ]);
    expect(results.map(result => result.state).sort()).toEqual(["replayed", "requested"]);
    expect(results[0]!.workspaces[0]!.intentId).toBe(results[1]!.workspaces[0]!.intentId);
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
  });

  it("refuses an inactive-workspace approval replay after a newer lifecycle makes it ready", async () => {
    const execution = await approve();
    await manageCloudWorkspaceDeletion(pool, execution);
    await setStatus("ready");
    await expect(manageCloudWorkspaceDeletion(pool, execution)).rejects.toThrow(/allow-running/i);
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
  });

  it("skips deleted rows in a mixed batch and on replay after workers finish", async () => {
    const deletedId = await addWorkspace("deleted");
    const execution = await approve({ workspaceIds: `${deletedId},${fixture.workspaceId}` });
    const first = await manageCloudWorkspaceDeletion(pool, execution);
    expect(first.workspaces.find(row => row.workspaceId === deletedId)).toMatchObject({ outcome: "skipped_deleted", intentId: null });
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
    await setStatus("deleted");
    const replay = await manageCloudWorkspaceDeletion(pool, execution);
    expect(replay.workspaces.every(row => row.outcome === "skipped_deleted")).toBe(true);
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
  });

  it.each(["ready", "busy", "requested", "provisioning", "setting_up", "waking", "stopping", "archiving", "deleting"])(
    "refuses a fresh plan for a %s workspace by default", async status => {
      await setStatus(status);
      await expect(manageCloudWorkspaceDeletion(pool, request())).rejects.toThrow(/status|running/i);
      expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
    },
  );

  it.each(["ready", "busy"])("requires the route's final checkpoint when %s deletion is explicitly enabled", async status => {
    await setStatus(status);
    const execution = await approve({ allowRunning: true });
    const expected = await routeEffects(`operator-delete:${approvalId}:${fixture.workspaceId}`);
    const result = await manageCloudWorkspaceDeletion(pool, execution);
    expect(result.workspaces[0]).toMatchObject({ status, version: "1", intentState: "queued" });
    expect(await withSystemTx(pool, effects)).toEqual(expected);
    expect((await pool.query("SELECT reason,state FROM workspace_checkpoint_requests")).rows)
      .toEqual([{ reason: "before_delete", state: "queued" }]);
    expect((await pool.query("SELECT revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].revoked_at).toBeNull();
  });

  it("supersedes pending lifecycle work and its checkpoint exactly like HTTP deletion", async () => {
    await setStatus("ready");
    const previousIntent = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,state)
        VALUES($1,$2,$3,1,$4,'stop',$5,$6,'queued')`,
      [previousIntent, fixture.workspaceId, fixture.organizationId, fixture.userId, randomUUID(), Buffer.alloc(32)]);
      await enqueueWorkspaceCheckpointRequest(tx, {
        workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
        requestedBy: fixture.userId, lifecycleIntentId: previousIntent, reason: "before_stop", idempotencyKey: `lifecycle.${previousIntent}`,
      });
    });
    const execution = await approve({ allowRunning: true });
    const expected = await routeEffects(`operator-delete:${approvalId}:${fixture.workspaceId}`);
    await manageCloudWorkspaceDeletion(pool, execution);
    expect(await withSystemTx(pool, effects)).toEqual(expected);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [previousIntent])).rows)
      .toEqual([{ state: "superseded" }]);
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [previousIntent])).rows)
      .toEqual([{ state: "cancelled" }]);
  });

  it.each(["status", "version"])("rejects a stale %s before any workspace in the batch is mutated", async field => {
    const second = await addWorkspace("stopped");
    const execution = await approve({ workspaceIds: `${fixture.workspaceId},${second}` });
    if (field === "status") await setStatus("failed", second);
    else await pool.query("UPDATE cloud_workspaces SET version=version+1 WHERE id=$1", [second]);
    await expect(manageCloudWorkspaceDeletion(pool, execution)).rejects.toThrow(/approval|plan/i);
    expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
  });

  it("binds execution and replay to the exact target, channel, organization, actor, set, reason and running flag", async () => {
    const second = await addWorkspace("stopped");
    const execution = await approve();
    const changes: Partial<CloudWorkspaceDeletionRequestInput>[] = [
      { databaseUrl: "postgres://postgres@other-db.example.test:55440/test_astra_gate" },
      { channel: "beta" }, { reason: "A different approved cleanup reason" },
      { workspaceIds: `${fixture.workspaceId},${second}` }, { allowRunning: true }, { approvalId: randomUUID() },
    ];
    for (const change of changes) {
      await expect(manageCloudWorkspaceDeletion(pool, request({ execute: true, approval: execution.approval!, ...change })))
        .rejects.toThrow(/approval|plan/i);
    }
    await manageCloudWorkspaceDeletion(pool, execution);
    for (const change of changes.slice(0, -1)) {
      await expect(manageCloudWorkspaceDeletion(pool, request({ execute: true, approval: execution.approval!, ...change })))
        .rejects.toThrow(/approval|plan/i);
    }
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
  });

  it("refuses an ordinary org member even when they own the workspace", async () => {
    await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, fixture.userId]);
    await expect(manageCloudWorkspaceDeletion(pool, request())).rejects.toThrow(/admin|owner|role/i);
    expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
  });

  it("applies the same cleanup check to an org admin and refuses private owner-only workspaces", async () => {
    const admin = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Admin fixture')", [admin, `${admin}@example.test`]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')", [fixture.organizationId, admin]);
    await pool.query("UPDATE cloud_workspaces SET sharing_mode='private',single_member_mode=true WHERE id=$1", [fixture.workspaceId]);
    await expect(manageCloudWorkspaceDeletion(pool, request({ actorUserId: admin }))).rejects.toThrow("Cloud workspace not found");
    await pool.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1", [fixture.userId]);
    const execution = await approve({ actorUserId: admin });
    expect((await manageCloudWorkspaceDeletion(pool, execution)).state).toBe("requested");
  });

  it("rechecks live actor authorization on execution and replay", async () => {
    const execution = await approve();
    await pool.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1", [fixture.userId]);
    await expect(manageCloudWorkspaceDeletion(pool, execution)).rejects.toThrow(/actor|active|not found/i);
    await pool.query("UPDATE users SET auth_status='active' WHERE id=$1", [fixture.userId]);
    await manageCloudWorkspaceDeletion(pool, execution);
    await pool.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1", [fixture.userId]);
    await expect(manageCloudWorkspaceDeletion(pool, execution)).rejects.toThrow(/actor|active|not found/i);
    expect(await mutationCounts()).toEqual({ intents: "1", jobs: "1", audits: "2" });
  });

  it("rejects foreign cloud ids, missing/local ids, Personal tenants and an incorrect org slug", async () => {
    const foreign = await seedReadyCloudWorkspace(pool, { ownerUserId: fixture.userId });
    for (const workspaceIds of [foreign.workspaceId, randomUUID()]) {
      await expect(manageCloudWorkspaceDeletion(pool, request({ workspaceIds }))).rejects.toThrow(/workspace|organization/i);
    }
    await expect(manageCloudWorkspaceDeletion(pool, request({ expectedOrganizationSlug: "wrong-synthetic-org" }))).rejects.toThrow(/slug/i);
    const personal = randomUUID();
    await pool.query(`INSERT INTO organizations(id,slug,name,is_personal,cloud_workspaces_allowed,created_by)
      VALUES($1,$2,'Local fixture',true,false,$3)`, [personal, `personal-${personal}`, fixture.userId]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [personal, fixture.userId]);
    await expect(manageCloudWorkspaceDeletion(pool, request({ organizationId: personal, expectedOrganizationSlug: `personal-${personal}` })))
      .rejects.toThrow(/Personal/i);
    expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
  });

  it("refuses Production before planning or execution", async () => {
    for (const execute of [false, true]) {
      expect(() => request({ channel: "production", execute })).toThrow(/Production/i);
      expect(() => request({ railwayEnvironmentName: "production", execute })).toThrow(/Production|RAILWAY_ENVIRONMENT_NAME/i);
    }
    expect(await mutationCounts()).toEqual({ intents: "0", jobs: "0", audits: "0" });
  });

  it("refuses the application database role even for a plan", async () => {
    const appPool = new pg.Pool({ connectionString: url, options: "-c role=zeros_app", max: 1 });
    try {
      await expect(manageCloudWorkspaceDeletion(appPool, request())).rejects.toThrow(/database.*owner|application role/i);
    } finally { await appPool.end(); }
  });
});
