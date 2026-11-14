import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
import { lifecycleExecution } from "./execution/lifecycle.js";
import { CloudRecoveryStore } from "./recovery-store.js";
import { sealPortToken } from "./worker-port-token.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("recovery through execution and worker routes", () => {
  let pool: pg.Pool, f: ExecutionFixture, recovery: CloudRecoveryStore;
  let features: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { lifecycle: true });
    await f.cp.loginChanges.stop();
    await f.activate(f.viewer);
    features = `${f.features},recovery-quiesce-v1,runtime-update-v1`;
    await f.cp.store.setWorkerRoute(f.workspace.id, "bx_fixture1234", "https://worker.example.test", sealPortToken("synthetic-port-token", f.workspace.id, f.keys));
    expect((await f.hello(features)).status).toBe(200);
    recovery = new CloudRecoveryStore(pool);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  async function begin() {
    const route = { ...(await f.cp.store.workerRoute(f.workspace.id))!, token: "synthetic-port-token" };
    const attempt = await recovery.begin(route);
    expect(attempt).not.toBeNull();
    return attempt!;
  }

  it("hints only capable workers, seals over the outbound route and keeps hello/boot-clean starting", async () => {
    const a = await begin();
    expect(await recovery.fence(a.id)).toBe(true);
    const pull = await f.worker("prompts/pull", { waitMs: 0, held: [] }, { features });
    expect(pull.status).toBe(200);
    expect(await pull.json()).toMatchObject({ prompts: [], recovery: { id: a.id } });
    const old = await f.worker("prompts/pull", { waitMs: 0, held: [] });
    expect(await old.json()).not.toHaveProperty("recovery");
    const seal = await f.worker("recovery", { op: "seal", id: a.id, generation: 4 }, { features });
    expect(seal.status).toBe(200);
    expect(await seal.json()).toEqual({ id: a.id, generation: 4, status: "sealed" });
    expect((await f.hello(features)).status).toBe(200);
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("starting");
  });

  it("uses the persisted initiator for recovery preflight while running and fences a subsequent Stop", async () => {
    const a = await begin(), workspace = (await recovery.workspace(a.id))!;
    const admission = vi.spyOn(f.cp.execution.deps.authority, "admit");
    await expect(lifecycleExecution(f.cp.execution, workspace)).rejects.toMatchObject({ code: "actor_changed" });
    const actor = await lifecycleExecution(f.cp.execution, workspace, { recoveryId: a.id });
    expect(actor?.userId).toBe(f.viewer.id);
    expect(admission.mock.calls.every(([id, user]) => id === workspace.id && user === f.viewer.id)).toBe(true);
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [workspace.id]);
    await expect(actor!.check()).rejects.toMatchObject({ code: "actor_changed" });
  });

  it.each([["starting", "running"], ["running", "starting"]] as const)(
    "keeps recovery authority when a concurrent hello changes %s to %s", async (before, after) => {
      const a = await begin();
      await recovery.fence(a.id);
      await pool.query("UPDATE cloud_v2_workspaces SET state=$2 WHERE id=$1", [f.workspace.id, before]);
      const workspace = (await recovery.workspace(a.id))!;
      const admit = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
      vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementationOnce(async (...args) => {
        const proof = await admit(...args);
        // An N-1 hello can publish running before the recovery setup finishes.
        await pool.query("UPDATE cloud_v2_workspaces SET state=$2 WHERE id=$1", [f.workspace.id, after]);
        return proof;
      });
      const actor = await lifecycleExecution(f.cp.execution, workspace, { recoveryId: a.id });
      expect(actor?.userId).toBe(f.viewer.id);
      await expect(actor!.check()).resolves.toBeUndefined();
      await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [workspace.id]);
      await expect(actor!.check()).rejects.toMatchObject({ code: "actor_changed" });
    });

  it("does not accept a different recovery id or let a removed initiator borrow the Creator's access", async () => {
    const a = await begin(), workspace = (await recovery.workspace(a.id))!;
    await expect(lifecycleExecution(f.cp.execution, workspace, { recoveryId: randomUUID() })).rejects.toMatchObject({ code: "actor_changed" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await expect(lifecycleExecution(f.cp.execution, workspace, { recoveryId: a.id })).rejects.toBeDefined();
  });

  it.each(["queued", "running"])("waits for a %s turn instead of sealing its worker", async state => {
    await f.login();
    if (state === "running") await f.dispatch(f.prompt(), f.viewer);
    else expect((await f.send(f.prompt(), f.viewer)).status).toBe(201);
    const a = await begin();
    expect(await recovery.canFence(a.id)).toBe(false);
    expect(await recovery.fence(a.id)).toBe(false);
    expect(await recovery.pull(f.token, f.boot, a.id)).toEqual({ hold: false });
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
  });

  it("accepts new sends after the fence while refusing a stale begin from the source", async () => {
    await f.login();
    const a = await begin();
    expect(await recovery.fence(a.id)).toBe(true);
    const input = f.prompt();
    expect((await f.send(input, f.viewer)).status).toBe(201);
    const response = await f.worker("prompts/begin", { userMessageId: input.userMessageId, deliveryId: randomUUID(), dispatchId: randomUUID() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_starting" } });
    expect((await pool.query("SELECT state,delivery_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, input.userMessageId])).rows[0])
      .toEqual({ state: "queued", delivery_id: null });
  });
});
