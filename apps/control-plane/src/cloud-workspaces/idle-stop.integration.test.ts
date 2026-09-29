import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudWorkspaceProvider, CloudProviderResource } from "./provider.js";
import { CloudProviderError } from "./provider.js";
import { previousBackendWake } from "./lifecycle-compatibility-fixtures.js";
import { previousBackendReconciler } from "./previous-reconciler-fixture.js";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { completeWorkspaceCheckpointRequest, deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("verified inactivity shutdown", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, service: DatabaseCloudIdleStop;
  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken });
  const request = () => service.request(scope(), randomUUID());
  const oldEngine = () => pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
  const lifecycle = (operation: string, key = randomUUID()) => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId }); await next(); });
    const config = { provider: "daytona", imageRef: "fixture-image", architecture: "linux/amd64", cpuMillicores: 2000,
      memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "unexpected_error" }, 500));
    return app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}${operation === "delete" ? "" : `/${operation}`}`,
      { method: operation === "delete" ? "DELETE" : "POST", headers: { "idempotency-key": key } });
  };
  async function finalCheckpoint() {
    await oldEngine();
    const objects = new Map<string, Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url"),
      objectStore: { async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key, value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; } } });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const manifest = await blobs.put({ ...scope(), bytes: Buffer.from("{}") });
    const file = await blobs.put({ ...scope(), bytes: Buffer.from("durable") });
    const appended = await content.append({ ...scope(), expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "file.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 7 }] });
    const directive = (await request())!;
    const commit = () => content.commitCheckpoint({ ...scope(), requestId: directive.id, idempotencyKey: directive.id,
      contentRevision: appended.revision, reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null,
      inclusionPolicy: {}, fileCount: 1, totalBytes: 7, integritySha256: manifest.plaintextSha256 });
    return { directive, commit };
  }
  async function githubWrite() {
    await pool.query(`INSERT INTO cloud_github_write_grants(grant_hash,workspace_id,org_id,generation,actor_user_id,actor_fingerprint,github_fingerprint,
      operation,params_sha256,repository_id,repository_owner,repository_name,token_sealed,admission_expires_at,lease_expires_at)
      VALUES($1,$2,$3,1,$4,'actor','github','git.push',$5,'123','sample','repo',$6,now()+interval '2 minutes',now()+interval '2 minutes')`,
    [Buffer.alloc(32), fixture.workspaceId, fixture.organizationId, fixture.userId, "a".repeat(64), Buffer.from("encrypted-test-fixture")]);
  }
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool); service = new DatabaseCloudIdleStop(pool, false);
    await pool.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,10,10,100000,100000,1000000) ON CONFLICT(org_id) DO NOTHING`,[fixture.organizationId]);
  });
  it("requires a full observation interval and gates Stop behind a final checkpoint", async () => {
    expect(await request()).toBeNull(); await oldEngine();
    const directive = await request(); expect(directive).toMatchObject({ reason: "before_stop", idleStop: true });
    expect(await request()).toEqual(directive);
    const workspace = (await pool.query("SELECT desired_state,status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0];
    expect(workspace).toEqual({ desired_state: "running", status: "ready" });
    const delivered = await withSystemTx(pool, tx => deliverWorkspaceCheckpointRequest(tx, scope()));
    expect(delivered).toEqual(directive);
    const intent = (await pool.query("SELECT state,operation FROM cloud_workspace_lifecycle_intents WHERE id=(SELECT lifecycle_intent_id FROM workspace_checkpoint_requests WHERE id=$1)", [directive!.id])).rows[0];
    expect(intent).toEqual({ state: "queued", operation: "stop" });
  });
  it("keeps a workspace alive during a PR write and after fresh work races the checkpoint", async () => {
    await oldEngine(); await githubWrite(); expect(await request()).toBeNull();
    await pool.query("DELETE FROM cloud_github_write_grants");
    const directive = (await request())!; await githubWrite();
    await expect(withSystemTx(pool, tx => completeWorkspaceCheckpointRequest(tx, { ...scope(), requestId: directive.id, reason: "before_stop", checkpointId: randomUUID() }))).rejects.toThrow("became active");
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1", [directive.id])).rows[0].state).toBe("queued");
    await service.cancel(scope(), directive.id);
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1", [directive.id])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].desired_state).toBe("running");
  });
  it("cannot request or cancel another engine's idle stop", async () => {
    await oldEngine(); const directive = (await request())!;
    await expect(service.request({ ...scope(), heartbeatToken: `zwh_${"a".repeat(43)}` }, randomUUID())).rejects.toBeDefined();
    await expect(service.cancel({ ...scope(), generation: 2 }, directive.id)).rejects.toBeDefined();
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1", [directive.id])).rows[0].state).toBe("queued");
  });
  it("allows cancellation after lease expiry without forcing a stop", async () => {
    await oldEngine(); const directive = (await request())!;
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 second' WHERE id=$1", [fixture.engineInstanceId]);
    await service.cancel(scope(), directive.id);
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1", [directive.id])).rows[0].state).toBe("cancelled");
  });
  it("finishes a committed idle stop before a wake from either device and preserves replay", async () => {
    const { directive, commit } = await finalCheckpoint(); await commit();
    const key = randomUUID();
    const first = await lifecycle("wake", key);
    expect(first.status).toBe(202);
    expect((await first.json()).intent.state).toBe("queued");
    expect((await (await lifecycle("wake", key)).json()).intent.state).toBe("queued");
    expect((await (await lifecycle("wake")).json()).intent.state).toBe("queued");
    const stop = (await pool.query(`SELECT intent.state,intent.affects_workspace FROM cloud_workspace_lifecycle_intents intent
      JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id WHERE request.id=$1`, [directive.id])).rows[0];
    expect(stop).toEqual({ state: "queued", affects_workspace: false });
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("waking");
    await expect(service.cancel(scope(), directive.id)).rejects.toThrow();
    // Retrying a lost checkpoint response returns its durable identity even after fencing.
    await expect(commit()).resolves.toBeDefined();
  });
  it("cancels capture before commit and rejects a stale final checkpoint", async () => {
    const { directive, commit } = await finalCheckpoint();
    expect((await (await lifecycle("wake")).json()).intent.state).toBe("succeeded");
    await expect(commit()).rejects.toThrow();
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1", [directive.id])).rows[0].state).toBe("cancelled");
  });
  it.each(["archive", "delete"])("reuses a committed final proof for %s without requesting the quiesced engine again", async operation => {
    const { commit } = await finalCheckpoint(); await commit();
    expect((await lifecycle(operation)).status).toBe(202);
    expect((await pool.query("SELECT count(*)::int AS count FROM workspace_checkpoint_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe(operation === "archive" ? "archiving" : "deleting");
  });
  it("keeps a wake waiting during provider stop and starts a fresh setup after the old response", async () => {
    const { commit } = await finalCheckpoint(); await commit();
    let entered!: () => void, finish!: () => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    let starts = 0;
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "daytona", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("same-generation wake"); }, async start() { starts++; resource = { ...resource, state: "running" }; return resource; },
      async stop() { entered(); await release; resource = { ...resource, state: "stopped" }; return resource; },
      async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 });
    const draining = reconciler.runOnce(); await stopping;
    try {
      const response = await lifecycle("wake"), body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(202);
      expect(body.intent.state).toBe("queued");
      expect(await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce()).toBe(false);
    } finally { finish(); }
    await draining;
    expect(await reconciler.runOnce()).toBe(true);
    expect(starts).toBe(1);
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("setting_up");
    expect((await pool.query("SELECT state,final_checkpoint_at IS NOT NULL AS fenced FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]).toEqual({ state: "revoked", fenced: true });
  });
  it("fails a dependent wake visibly when its final drain fails and retries the drain on a fresh wake", async () => {
    const { commit } = await finalCheckpoint(); await commit();
    expect((await lifecycle("wake")).status).toBe(202);
    const resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "daytona", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("unused"); }, async start() { throw new Error("must finish stop first"); },
      async stop() { throw new CloudProviderError("provider_request_invalid", "fixture", false); },
      async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce();
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: "failed", last_error_code: "workspace_drain_failed" });
    const response = await lifecycle("wake");
    expect(response.status).toBe(202);
    expect((await response.json()).intent.state).toBe("queued");
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [fixture.workspaceId])).rows[0].state).toBe("queued");
  });
  it.each([false, true])("handles an older reconciler's drain failure without stranding the wake (retryable: %s)", async retryable => {
    const { commit } = await finalCheckpoint(); await commit();
    const wakeId = await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    let stops = 0;
    const resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "daytona", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("unused"); }, async start() { throw new Error("must finish stop first"); },
      async stop() { stops++; throw new CloudProviderError("provider_resource_failed", "Stop failed", retryable, { retryAfterMs: 60_000 }); },
      async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    // Run the actual pre-W2 claim and failure handler through provider I/O.
    const older = previousBackendReconciler({ pool, provider, intervalMs: 1000 });
    expect(await older.runOnce()).toBe(true);
    expect(stops).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [fixture.workspaceId])).rows[0].state)
      .toBe(retryable ? "observing" : "failed");
    expect((await pool.query("SELECT state,error_code,lease_owner FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wakeId])).rows[0])
      .toEqual({ state: retryable ? "queued" : "failed", error_code: retryable ? null : "workspace_drain_failed", lease_owner: null });
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: retryable ? "waking" : "failed", last_error_code: retryable ? null : "workspace_drain_failed" });
    if (retryable) {
      // An old worker cannot bypass a still-retryable drain during its backoff.
      await expect(older.runOnce()).rejects.toMatchObject({ code: "40001" });
    } else {
      // The terminal wake no longer poisons the older worker's next claim.
      expect(await older.runOnce()).toBe(false);
    }
    expect(await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce()).toBe(false);
    expect(stops).toBe(1);
  });
  it.each(["previous", "current"])("retains the final drain after a %s wake followed by an older replica wake", async first => {
    const { commit } = await finalCheckpoint(); await commit();
    if (first === "previous") await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    else expect((await lifecycle("wake")).status).toBe(202);
    const wakeId = await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    const stopId = (await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [fixture.workspaceId])).rows[0].id;
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1", [stopId]);
    let stops = 0;
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "daytona", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("unused"); }, async start() { resource = { ...resource, state: "running" }; return resource; },
      async stop() { stops++; resource = { ...resource, state: "stopped" }; return resource; }, async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 });
    const processed = await reconciler.runOnce();
    expect((await pool.query("SELECT resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wakeId])).rows[0].resume_after_intent_id).toBe(stopId);
    expect(processed).toBe(false); expect(stops).toBe(0);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now() WHERE id=$1", [stopId]);
    expect(await reconciler.runOnce()).toBe(true); expect(stops).toBe(1);
    expect(await reconciler.runOnce()).toBe(true);
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("setting_up");
  });
  it("retries a failed final drain for an older replica wake", async () => {
    const { commit } = await finalCheckpoint(); await commit();
    await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    const stopId = (await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [fixture.workspaceId])).rows[0].id;
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now(),next_attempt_at=now()+interval '1 hour' WHERE id=$1", [stopId]);
    const wakeId = await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    expect((await pool.query("SELECT resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wakeId])).rows[0].resume_after_intent_id).toBe(stopId);
    expect((await pool.query("SELECT state,next_attempt_at<=now() AS due FROM cloud_workspace_lifecycle_intents WHERE id=$1", [stopId])).rows[0]).toEqual({ state: "queued", due: true });
  });
  it("rejects an old worker claim even if a wake loses its explicit drain prerequisite", async () => {
    const { commit } = await finalCheckpoint(); await commit();
    const wakeId = await withSystemTx(pool, tx => previousBackendWake(tx, fixture));
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET resume_after_intent_id=NULL WHERE id=$1", [wakeId]);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='old-worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1", [wakeId])))
      .rejects.toThrow("workspace drain is not complete");
  });
  it.each(["stopped", "running"])("preserves the final drain when an older provider response supersedes it (%s)", async observed => {
    const { commit } = await finalCheckpoint(); await commit();
    const stopId = (await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [fixture.workspaceId])).rows[0].id;
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='previous-backend',lease_expires_at=now()+interval '1 minute' WHERE id=$1", [stopId]);
    expect((await lifecycle("wake")).status).toBe(202);
    // Previous backends captured affects_workspace before provider I/O. Their
    // response still attempts to supersede the now-independent final drain.
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state=$2,last_observed_at=clock_timestamp() WHERE workspace_id=$1", [fixture.workspaceId, observed]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [stopId]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [stopId])).rows[0].state)
      .toBe(observed === "stopped" ? "succeeded" : "observing");
  });
});
