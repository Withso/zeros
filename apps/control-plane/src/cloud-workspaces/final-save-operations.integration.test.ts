import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedFinalSave } from "./final-save-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { CloudWorkspaceHealthAlertWorker, type CloudWorkspaceHealthAlert } from "./health-alerts.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("final-save erasure and operator ownership", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedFinalSave>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); f = await seedFinalSave(pool); });
  const health = () => new DatabaseCloudWorkspaceHealthService(pool, {
    backgroundWorkersEnabled: false, setupExecutionEnabled: true, durabilityEnabled: true, outboxDeliveryEnabled: true,
  }).read();
  async function deletionJob(state: string) {
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1", [f.scope.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now() WHERE workspace_id=$1", [f.scope.workspaceId]);
    return (await pool.query(`INSERT INTO workspace_deletion_jobs(workspace_id,org_id,requested_by,idempotency_key,state)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [f.scope.workspaceId,f.scope.organizationId,f.fixture.userId,randomUUID(),state])).rows[0].id as string;
  }

  it.each(["waiting_for_provider", "deleting_objects", "deleting_records"])("preserves unsaved data in an old %s job after external source loss", async state => {
    await deletionJob(state);
    const objects = { deleteUnreferencedSystem: vi.fn(), sweepAbandonedUploads: vi.fn(async () => 0) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects as never, { logger: { error: vi.fn() } });
    expect(await worker.processDeletionOnce()).toBe(false);
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.scope.workspaceId])).rows[0].data_deleted_at).toBeNull();
    expect((await f.row()).state).not.toBe("resolved");
  });

  it("rolls back an N-1 erasure claim instead of silently changing its RETURNING state", async () => {
    const job = await deletionJob("deleting_objects");
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE workspace_deletion_jobs SET lease_owner='legacy-erasure',
      lease_expires_at=now()+interval '1 minute' WHERE id=$1 RETURNING id`, [job]))).rejects.toMatchObject({ code: "40001" });
  });

  it("keeps first-failure audit immutable without relying on optional progress", async () => {
    await f.send();
    const before = await f.row();
    await expect(pool.query("UPDATE cloud_workspace_final_save_recoveries SET first_failure='journal' WHERE lifecycle_intent_id=$1", [f.intentId]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await pool.query("SELECT subject->>'reason' AS reason FROM audit_log WHERE action='cloud_workspace.final_save_recovery' AND org_id=$1", [f.scope.organizationId])).rows)
      .toEqual([{ reason: before.first_failure }]);
    expect((await pool.query("SELECT id FROM audit_log WHERE action='cloud_workspace.checkpoint_progress' AND org_id=$1", [f.scope.organizationId])).rowCount).toBe(0);
  });

  it("projects persisted retry, blocked and stalled work while lifecycle workers are paused", async () => {
    await f.send();
    expect((await health()).reasons).toContain("final_save_retrying");
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked' WHERE lifecycle_intent_id=$1", [f.intentId]);
    expect((await health()).reasons).toContain("final_save_blocked");
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=now()-interval '6 minutes' WHERE lifecycle_intent_id=$1", [f.intentId]);
    expect((await health()).reasons).toContain("final_save_worker_stalled");
  });

  it("owns failed-send retry, dedupe and proof-only resolution across alert-worker restarts", async () => {
    await f.send();
    let now = Date.now();
    const sent: CloudWorkspaceHealthAlert[] = [];
    const send = vi.fn(async (alert: CloudWorkspaceHealthAlert) => { sent.push(alert); });
    const worker = () => new CloudWorkspaceHealthAlertWorker({ pool, environment: "alpha", read: health, send, now: () => now });
    const tick = async () => { now += 60_000; return worker().runOnce(); };
    expect(await tick()).toBe("pending");
    send.mockRejectedValueOnce(new Error("synthetic operator mailbox outage"));
    await expect(tick()).rejects.toThrow("synthetic operator mailbox outage");
    expect(await tick()).toBe("alerted");
    expect(await worker().runOnce()).toBe("skipped");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("final_save_retrying");
    const receipt = await (await f.prepareCommit()).run();
    expect(receipt.checkpointId).toBeTruthy();
    expect(await tick()).toBe("pending");
    expect(await tick()).toBe("recovered");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toContain("recovered");
  });
});
