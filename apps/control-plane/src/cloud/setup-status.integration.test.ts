import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2CapabilitiesSchema } from "./contract.js";
import { cloudWorkspaceReportFixture, type CloudWorkspaceReportFixture } from "./workspace-report-test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("setup reports through real routers and PostgreSQL", () => {
  let pool: pg.Pool, f: CloudWorkspaceReportFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await cloudWorkspaceReportFixture(pool); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); });
  const report = (body: unknown, boot = f.boot, feature = "setup-status-v1") => f.worker("setup", body, { boot, feature });

  it("exposes the optional status on single, list and API documents while asleep, without changing capabilities or activity", async () => {
    const initial = await f.document();
    expect(initial).not.toHaveProperty("setup");
    expect(await f.apiDocument()).not.toHaveProperty("setup");
    const running = { state: "running", startedAt: 100 };
    expect((await report(running)).status).toBe(204);
    expect((await f.document()).setup).toEqual(running);
    const completed = { state: "succeeded", startedAt: 100, finishedAt: 200, exitCode: 0 };
    expect((await report(completed)).status).toBe(204);
    expect(await f.document()).toEqual({ ...initial, setup: completed });
    await f.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.store.transition(f.workspaceId, ["stopping"], "stopped");
    const document = await f.document();
    expect(document).toMatchObject({ state: "stopped", setup: completed, activeAt: initial.activeAt });
    expect(CloudV2CapabilitiesSchema.parse(document.capabilities)).toEqual(initial.capabilities);
    expect(document.capabilities).not.toHaveProperty("setup");
    const list = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`);
    expect((await list.json()).workspaces).toEqual([document]);
    expect(await f.apiDocument()).toMatchObject({ state: "stopped", setup: completed });
    expect((await f.store.get(f.workspaceId, f.owner.id)).state).toBe("stopped");
  });

  it("retains the newest attempt and never lets a late running report replace its terminal status", async () => {
    const failed = { state: "failed", startedAt: 100, finishedAt: 200, reason: "timed_out" };
    expect((await report(failed)).status).toBe(204);
    const saved = await f.document();
    for (const late of [failed, { state: "running", startedAt: 100 }, { state: "succeeded", startedAt: 99, finishedAt: 300 }]) {
      expect((await report(late)).status).toBe(204);
      expect(await f.document()).toEqual(saved);
    }
    const next = { state: "running", startedAt: 301 };
    expect((await report(next)).status).toBe(204);
    const interrupted = { state: "interrupted", startedAt: 301, finishedAt: 302 };
    expect((await report(interrupted)).status).toBe(204);
    expect((await f.document()).setup).toEqual(interrupted);
  });

  it("refuses unnegotiated, malformed and stale reports without accepting scripts, paths or logs", async () => {
    const valid = { state: "running", startedAt: 100 };
    expect((await report(valid, f.boot, "")).status).toBe(404);
    for (const value of [undefined, { ...valid, state: "unknown" }, { ...valid, startedAt: -1 }, { ...valid, finishedAt: 0.5 },
      { ...valid, exitCode: null }, { ...valid, reason: "arbitrary failure" }, ...["path", "script", "log", "workspaceId"].map(key => ({ ...valid, [key]: "private" }))]) {
      expect((await report(value)).status).toBe(400);
    }
    expect((await report(valid, randomUUID())).status).toBe(401);
    expect(await f.document()).not.toHaveProperty("setup");
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
    expect((await report(valid)).status).toBe(401);
    expect((await pool.query("SELECT setup_status FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].setup_status).toBeNull();
  });

  it("hides reports from another member and fences a stopped run even after wake", async () => {
    expect((await report({ state: "succeeded", startedAt: 1, exitCode: 0 })).status).toBe(204);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}`, "GET", undefined, { "x-test-actor": f.other.id })).status).toBe(404);
    await f.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.store.transition(f.workspaceId, ["stopping"], "stopped");
    expect((await report({ state: "running", startedAt: 2 })).status).toBe(401);
    await f.store.requestLifecycle(f.workspaceId, f.owner.id, "start");
    await f.store.rotateWorkerToken(f.workspaceId);
    expect((await report({ state: "running", startedAt: 2 })).status).toBe(401);
    expect((await f.apiDocument()).setup).toEqual({ state: "succeeded", startedAt: 1, exitCode: 0 });
  });

  it("rechecks the access epoch after a workspace mutation lock wait", async () => {
    const lock = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      const entered = vi.spyOn(f.store, "reportWorkerSetup");
      pending = report({ state: "running", startedAt: 1 });
      await expect.poll(() => entered.mock.calls.length).toBe(1);
      await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%worker_token_hash%'`)).rows[0].count)).toBe(1);
      await lock.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(401);
      expect(await f.document()).not.toHaveProperty("setup");
    } finally {
      await lock.query("ROLLBACK"); lock.release();
      await pending;
    }
  });
});
