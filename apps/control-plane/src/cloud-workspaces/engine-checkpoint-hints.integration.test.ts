import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { CloudEngineCheckpointHintRejected, CloudEngineCheckpointHints,
  startCloudEngineCheckpointHintNotifications } from "./engine-checkpoint-hints.js";
import { CLOUD_WORKSPACE_ENGINE_CHECKPOINT_HINT_PATH, createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService } from "./internal-routes.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("engine checkpoint hints with PostgreSQL", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const input = () => ({ token: fixture.heartbeatToken, workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId, generation: 1, engineInstanceId: fixture.engineInstanceId });
  const enqueue = (reason: "before_stop" | "before_archive" = "before_stop") => withSystemTx(pool, tx => enqueueWorkspaceCheckpointRequest(tx, {
    workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
    requestedBy: fixture.userId, reason, idempotencyKey: `hint-${randomUUID()}` }));
  const requests = () => withSystemTx(pool, async tx => (await tx.query(
    "SELECT state, delivery_count FROM workspace_checkpoint_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows);

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
  });

  it("answers at once for an undelivered request and never delivers it itself", async () => {
    await enqueue();
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 10_000 });
    const started = Date.now();
    await expect(hints.wait(input(), new AbortController().signal)).resolves.toEqual({
      version: 1, audience: "zeros-cloud-workspace-engine-checkpoint-hint-v1", pending: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await requests()).toEqual([{ state: "queued", delivery_count: 0 }]);
  });

  it("is released by the queue notification while it waits", async () => {
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 15_000 });
    const listener = new pg.Pool({ connectionString: url, max: 1 });
    const stop = startCloudEngineCheckpointHintNotifications(listener, hints, { warn: () => {} });
    try {
      // Let LISTEN become active before the commit under test.
      await new Promise(resolve => setTimeout(resolve, 300));
      const started = Date.now();
      const waiting = hints.wait(input(), new AbortController().signal);
      await new Promise(resolve => setTimeout(resolve, 200));
      await enqueue("before_archive");
      await expect(waiting).resolves.toMatchObject({ pending: true });
      // Well before the five-second fallback recheck.
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await stop();
      await listener.end();
    }
  });

  it("ends without a hint when nothing is queued or the request was already delivered", async () => {
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 300 });
    await expect(hints.wait(input(), new AbortController().signal)).resolves.toMatchObject({ pending: false });
    await enqueue();
    await withSystemTx(pool, tx => tx.query(
      "UPDATE workspace_checkpoint_requests SET state='delivered', delivery_count=1, last_delivered_at=now() WHERE workspace_id=$1",
      [fixture.workspaceId]));
    await expect(hints.wait(input(), new AbortController().signal)).resolves.toMatchObject({ pending: false });
  });

  it("returns promptly when its caller goes away", async () => {
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 15_000 });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = hints.wait(input(), controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(waiting).resolves.toMatchObject({ pending: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("releases held hints at once when the control plane shuts down", async () => {
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 15_000 });
    const started = Date.now();
    const waiting = hints.wait(input(), new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 200));
    hints.close();
    await expect(waiting).resolves.toMatchObject({ pending: false });
    await expect(hints.wait(input(), new AbortController().signal)).resolves.toMatchObject({ pending: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each([
    ["another token", () => ({ token: `zwh_${"X".repeat(43)}` }), undefined],
    ["another generation", () => ({ generation: 2 }), undefined],
    ["another engine", () => ({ engineInstanceId: randomUUID() }), undefined],
    ["a malformed token", () => ({ token: "not-a-token" }), undefined],
    ["an expired lease", () => ({}), `UPDATE cloud_workspace_engine_instances
      SET last_heartbeat_at=now()-interval '2 minutes', lease_expires_at=now()-interval '1 second' WHERE id=$1`],
    ["a revoked engine", () => ({}), "UPDATE cloud_workspace_engine_instances SET state='revoked', revoked_at=now() WHERE id=$1"],
  ] as const)("refuses %s", async (_label, override, sql) => {
    await enqueue();
    if (sql) await withSystemTx(pool, tx => tx.query(sql, [fixture.engineInstanceId]));
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 300 });
    await expect(hints.wait({ ...input(), ...override() }, new AbortController().signal))
      .rejects.toBeInstanceOf(CloudEngineCheckpointHintRejected);
  });

  it("serves the optional route with closed errors and is absent without the service", async () => {
    const hints = new CloudEngineCheckpointHints(pool, { waitMs: 300 });
    const base = { heartbeat: async () => ({}) } as unknown as CloudWorkspaceInternalSetupService;
    const routes = createCloudWorkspaceInternalRoutes({ ...base,
      waitForCheckpointHint: (value, signal) => hints.wait(value, signal) } as CloudWorkspaceInternalSetupService);
    const { token, ...body } = input();
    const post = (headers: Record<string, string>, payload: unknown) => routes.request(CLOUD_WORKSPACE_ENGINE_CHECKPOINT_HINT_PATH, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
    expect((await post({}, body)).status).toBe(401);
    expect((await post({ authorization: `Bearer ${token}` }, { ...body, extra: true })).status).toBe(422);
    const rejected = await post({ authorization: `Bearer zwh_${"X".repeat(43)}` }, body);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: { code: "engine_checkpoint_hint_rejected" } });
    await enqueue();
    const ok = await post({ authorization: `Bearer ${token}` }, body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: 1, audience: "zeros-cloud-workspace-engine-checkpoint-hint-v1", pending: true });
    const legacy = createCloudWorkspaceInternalRoutes(base);
    expect((await legacy.request(CLOUD_WORKSPACE_ENGINE_CHECKPOINT_HINT_PATH, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(404);
  });
});
