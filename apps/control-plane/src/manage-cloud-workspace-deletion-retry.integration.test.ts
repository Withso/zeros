import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmWorkspaceDeletion, seedWorkspaceDeletionGraph } from "./cloud-workspaces/deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { manageCloudWorkspaceDeletion, validateCloudWorkspaceDeletionRequest,
  type CloudWorkspaceDeletionRequestInput } from "./manage-cloud-workspace-deletion.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner-approved failed record-purge retry", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedWorkspaceDeletionGraph>>;
  let jobId: string, slug: string, approvalId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Record-purge retry must not call a provider"); }));
    await resetMigratedTestDatabase(pool);
    fixture = await seedWorkspaceDeletionGraph(pool);
    await confirmWorkspaceDeletion(pool, fixture);
    jobId = randomUUID(); approvalId = randomUUID();
    slug = (await pool.query("SELECT slug::text FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
    await pool.query(`INSERT INTO workspace_deletion_jobs(id,workspace_id,org_id,requested_by,idempotency_key,
      state,attempt_count,error_code,completed_at) VALUES($1,$2,$3,$4,'synthetic-failed-record-purge',
      'failed',10,'workspace_deletion_unknown_failure',now())`, [jobId, fixture.workspaceId, fixture.organizationId, fixture.userId]);
    await pool.query("DELETE FROM workspace_blob_references WHERE workspace_id=$1", [fixture.workspaceId]);
    await fixture.objects.deleteUnreferencedSystem({ blobId: fixture.blobId, organizationId: fixture.organizationId });
    await pool.query(`INSERT INTO workspace_deletion_blob_targets(job_id,blob_id,org_id,requires_physical_delete,completed_at)
      VALUES($1,$2,$3,true,now())`, [jobId, fixture.blobId, fixture.organizationId]);
  });

  const request = (overrides: Partial<CloudWorkspaceDeletionRequestInput> = {}) => validateCloudWorkspaceDeletionRequest({
    databaseUrl: process.env.TEST_DATABASE_URL!, channel: "alpha", execute: false, retryRecords: true, approvalId,
    organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
    workspaceIds: fixture.workspaceId, reason: "Retry a failed record purge after the dependency fix", ...overrides,
  });
  const job = async () => (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE id=$1", [jobId])).rows[0];
  const plan = async () => manageCloudWorkspaceDeletion(pool, request());
  const execute = async (approval: string) => manageCloudWorkspaceDeletion(pool, request({ execute: true, approval }));

  it("plans without changes, then requeues only the approved job and preserves completed targets and provider journals", async () => {
    const before = await job();
    const targets = (await pool.query("SELECT * FROM workspace_deletion_blob_targets WHERE job_id=$1", [jobId])).rows;
    const bindings = (await pool.query("SELECT * FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 ORDER BY generation", [fixture.workspaceId])).rows;
    const planned = await plan();
    expect(planned).toMatchObject({ state: "planned", workspaces: [{ outcome: "planned", deletionJobId: jobId }] });
    expect(await job()).toEqual(before);
    expect((await execute(planned.approval)).state).toBe("requested");
    expect(await job()).toMatchObject({ id: jobId, state: "deleting_records", attempt_count: 0, error_code: null,
      idempotency_key: before.idempotency_key, requested_by: before.requested_by, lease_owner: null, completed_at: null });
    expect((await pool.query("SELECT * FROM workspace_deletion_blob_targets WHERE job_id=$1", [jobId])).rows).toEqual(targets);
    expect((await pool.query("SELECT * FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 ORDER BY generation", [fixture.workspaceId])).rows).toEqual(bindings);
    const audit = (await pool.query("SELECT actor_id,subject FROM audit_log WHERE action='cloud_workspace.operator_deletion_records_retried'")).rows;
    expect(audit).toEqual([{ actor_id: fixture.userId, subject: expect.objectContaining({ approvalId, approval: planned.approval,
      jobs: [expect.objectContaining({ id: jobId, attemptCount: 10, errorCode: "workspace_deletion_unknown_failure" })] }) }]);
    expect((await execute(planned.approval)).state).toBe("replayed");
    const logger = { error: vi.fn() };
    await new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: "retry-fixture", logger }).runOnce();
    expect((await job()).state).toBe("succeeded");
    expect(logger.error).not.toHaveBeenCalled();
    expect((await execute(planned.approval)).state).toBe("replayed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves an already-deleted failed job unchanged unless the retry option is explicit", async () => {
    const before = await job();
    expect((await manageCloudWorkspaceDeletion(pool, request({ retryRecords: false }))).state).toBe("unchanged");
    expect(await job()).toEqual(before);
  });

  it.each([
    ["provider evidence", "UPDATE cloud_workspace_provider_bindings SET deletion_verified_at=NULL WHERE workspace_id=$1"],
    ["pending blob", "UPDATE workspace_deletion_blob_targets SET completed_at=NULL WHERE job_id=(SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1)"],
    ["workspace hold", "INSERT INTO workspace_retention_policies(workspace_id,org_id,legal_hold) SELECT id,org_id,true FROM cloud_workspaces WHERE id=$1 ON CONFLICT(workspace_id) DO UPDATE SET legal_hold=true"],
    ["checkpoint hold", "UPDATE workspace_checkpoints SET legal_hold=true WHERE workspace_id=$1"],
    ["target blob hold", "UPDATE workspace_blobs SET legal_hold=true WHERE id IN (SELECT blob_id FROM workspace_deletion_blob_targets WHERE job_id=(SELECT id FROM workspace_deletion_jobs WHERE workspace_id=$1))"],
    ["active lease", "UPDATE workspace_deletion_jobs SET lease_owner='other-worker',lease_expires_at=now()+interval '1 minute' WHERE workspace_id=$1"],
    ["live workspace", "UPDATE cloud_workspaces SET status='archived',desired_state='archived',deleted_at=NULL WHERE id=$1"],
    ["completed purge", "UPDATE cloud_workspaces SET data_deleted_at=now() WHERE id=$1"],
    ["different failure", "UPDATE workspace_deletion_jobs SET error_code='other_failure' WHERE workspace_id=$1"],
  ])("refuses %s", async (_label, sql) => {
    await pool.query(sql, [fixture.workspaceId]);
    const before = await job();
    await expect(plan()).rejects.toThrow(/retry|purge|deleted|evidence/i);
    expect(await job()).toEqual(before);
  });

  it("binds approval to the failed attempt and refuses silent replay after another failure", async () => {
    const planned = await plan();
    await pool.query("UPDATE workspace_deletion_jobs SET attempt_count=11 WHERE id=$1", [jobId]);
    await expect(execute(planned.approval)).rejects.toThrow(/approval|plan/i);
    const fresh = await plan();
    await execute(fresh.approval);
    await pool.query("UPDATE workspace_deletion_jobs SET state='failed',attempt_count=1,completed_at=now() WHERE id=$1", [jobId]);
    expect((await execute(fresh.approval)).state).toBe("replayed");
    expect(await job()).toMatchObject({ state: "failed", attempt_count: 1 });
  });

  it("refuses a changed actor, foreign workspace, Production or application role", async () => {
    const planned = await plan();
    await expect(manageCloudWorkspaceDeletion(pool, request({ workspaceIds: randomUUID() }))).rejects.toThrow();
    expect(() => request({ channel: "production" })).toThrow(/Production/);
    expect(() => request({ allowRunning: true })).toThrow(/retry|running/i);
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 1 });
    try { await expect(manageCloudWorkspaceDeletion(appPool, request())).rejects.toThrow(/owner|role/); }
    finally { await appPool.end(); }
    const personal = (await pool.query("SELECT id,slug::text FROM organizations WHERE is_personal AND created_by=$1", [fixture.userId])).rows[0];
    await expect(manageCloudWorkspaceDeletion(pool, request({ organizationId: personal.id, expectedOrganizationSlug: personal.slug })))
      .rejects.toThrow(/Personal|local/i);
    await pool.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1", [fixture.userId]);
    await expect(execute(planned.approval)).rejects.toThrow(/actor|active|not found/i);
    expect((await job()).state).toBe("failed");
  });
});
