import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudWorkspaceOutboxWorker } from "./outbox.js";
import { startCloudWorkerNotifications } from "./worker-notifications.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedWorkspaceDeletionGraph, confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("commit-bound worker wakeups", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  it("wakes on a committed future outbox deadline, never on an uncommitted or rolled-back write", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("DELETE FROM cloud_workspace_outbox");
    const listener = await pool.connect();
    const writer = await pool.connect();
    const notices: pg.Notification[] = [];
    listener.on("notification", notice => notices.push(notice));
    await listener.query("LISTEN zeros_cloud_outbox_work");
    const insert = () => writer.query(`INSERT INTO cloud_workspace_outbox
      (id,org_id,workspace_id,event_type,aggregate_key,aggregate_revision,idempotency_key,payload,next_attempt_at)
      VALUES($1,$2,$3,'workspace.test_event',$4,1,$5,'{}',now()+interval '5 minutes')`,
    [randomUUID(), fixture.organizationId, fixture.workspaceId, randomUUID(), randomUUID()]);
    try {
      await writer.query("BEGIN"); await insert();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(notices).toHaveLength(0);
      await writer.query("ROLLBACK");
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(notices).toHaveLength(0);
      await writer.query("BEGIN"); await insert(); await writer.query("COMMIT");
      await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 1_000, interval: 10 });
      expect(notices[0]).toMatchObject({ channel: "zeros_cloud_outbox_work", payload: "" });
    } finally {
      await writer.query("ROLLBACK"); writer.release(); listener.release(true);
    }
  });

  it("rearms an idle worker for an earlier future deadline and claims it within one second", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("DELETE FROM cloud_workspace_outbox");
    const sink = { deliver: vi.fn(async () => {}) };
    const worker = new CloudWorkspaceOutboxWorker(pool, sink);
    const stop = worker.start();
    const connected = vi.fn();
    const stopNotices = startCloudWorkerNotifications(pool, { outbox: () => { connected(); worker.notify(); } });
    try {
      await vi.waitFor(() => expect(connected).toHaveBeenCalled());
      // The startup/reconnect hint sees an empty queue before this transaction.
      await new Promise(resolve => setTimeout(resolve, 30));
      const id = randomUUID();
      const row = (await pool.query<{ due_at: Date }>(`INSERT INTO cloud_workspace_outbox
        (id,org_id,workspace_id,event_type,aggregate_key,aggregate_revision,idempotency_key,payload,next_attempt_at)
        VALUES($1,$2,$3,'workspace.test_event',$4,1,$5,'{}',clock_timestamp()+interval '200 milliseconds')
        RETURNING next_attempt_at AS due_at`, [id, fixture.organizationId, fixture.workspaceId, randomUUID(), randomUUID()])).rows[0]!;
      await vi.waitFor(() => expect(sink.deliver).toHaveBeenCalledOnce(), { timeout: 1_150, interval: 10 });
      expect(Date.now()).toBeGreaterThanOrEqual(row.due_at.getTime());
      expect(Date.now() - row.due_at.getTime()).toBeLessThan(1_000);
      expect((await pool.query("SELECT state FROM cloud_workspace_outbox WHERE id=$1", [id])).rows[0].state).toBe("succeeded");
    } finally { await stopNotices(); await stop(); }
  });

  it("drains retention and a newly confirmed deletion while the operations worker is sleeping", async () => {
    const f = await seedWorkspaceDeletionGraph(pool);
    const worker = new CloudWorkspaceOperationsWorker(pool, f.objects);
    const stop = worker.start();
    const stopNotices = startCloudWorkerNotifications(pool, { operations: () => worker.notify() });
    try {
      await vi.waitFor(async () => expect((await pool.query(`SELECT last_applied_at FROM workspace_retention_policies
        WHERE workspace_id=$1`, [f.workspaceId])).rows[0]?.last_applied_at).toBeInstanceOf(Date));
      await confirmWorkspaceDeletion(pool, f);
      await vi.waitFor(async () => expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId]))
        .rows[0]?.state).toBe("succeeded"), { timeout: 1_000, interval: 10 });
      expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].data_deleted_at).toBeInstanceOf(Date);
    } finally { await stopNotices(); await stop(); }
  });

  it.each(["local_to_cloud", "cloud_to_local"] as const)("only a completed Local import releases a lifecycle prerequisite (%s)", async operation => {
    const f = await seedReadyCloudWorkspace(pool), id = randomUUID();
    await pool.query(`INSERT INTO workspace_fork_intents
      (id,org_id,requested_by,operation,source_local_workspace_id,source_cloud_workspace_id,target_local_workspace_id,
       target_cloud_workspace_id,source_revision,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,0,$1::text,$9)`, [id, f.organizationId, f.userId, operation,
      operation === "local_to_cloud" ? randomUUID() : null, operation === "cloud_to_local" ? f.workspaceId : null,
      operation === "cloud_to_local" ? randomUUID() : null, operation === "local_to_cloud" ? f.workspaceId : null,
      Buffer.alloc(32, 1)]);
    const listener = await pool.connect();
    const notices: pg.Notification[] = [];
    listener.on("notification", notice => notices.push(notice));
    await listener.query("LISTEN zeros_cloud_lifecycle_work");
    try {
      await pool.query("UPDATE workspace_fork_intents SET state='succeeded',completed_at=now() WHERE id=$1", [id]);
      if (operation === "local_to_cloud") {
        await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 1_000, interval: 10 });
        expect(notices[0]).toMatchObject({ channel: "zeros_cloud_lifecycle_work", payload: "" });
      } else {
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(notices).toHaveLength(0);
      }
    } finally { listener.release(true); }
  });
});
