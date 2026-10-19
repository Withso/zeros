import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudWorkspaceCheckpointRequestWorker, enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { prepareCloudWorkspaceStopSeal } from "./stop-seal.js";
import { seedReadyCloudWorkspace, seedSupportedCloudWorkspaceGeneration, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { commitFinalSaveFixture } from "./final-save-test-fixtures.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { finalSaveProven } from "./final-save-recovery.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const operations = ["stop", "archive", "delete"] as const;

suite("accepted final saves survive finite capture attempts", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken });

  async function admit(operation: typeof operations[number], capture = true) {
    const intentId = randomUUID();
    return withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [fixture.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1,$2,1,$3,$4,$5,$6,$7)`, [intentId, fixture.workspaceId, fixture.organizationId,
        fixture.userId, operation, intentId, createHash("sha256").update(intentId).digest()]);
      const request = capture ? await enqueueWorkspaceCheckpointRequest(tx, { ...scope(), requestedBy: fixture.userId,
        lifecycleIntentId: intentId, reason: `before_${operation}`, idempotencyKey: `final.${intentId}` }) : null;
      return { intentId, request };
    });
  }
  const intent = async (id: string) => (await pool.query(
    "SELECT state,completed_at,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [id])).rows[0];
  const expire = async (id: string) => {
    await pool.query(`UPDATE workspace_checkpoint_requests SET created_at=now()-interval '6 minutes',
      deadline_at=now()-interval '1 second' WHERE id=$1`, [id]);
    return new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce();
  };
  async function save(operation: typeof operations[number]) {
    const { intentId, request } = await admit(operation);
    const objects = new Map<string, Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false,
      encryptionKeyV1: randomBytes(32).toString("base64url"), objectStore: {
        async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key, value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; },
      } });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const manifest = await blobs.put({ ...scope(), bytes: Buffer.from("{}") });
    const file = await blobs.put({ ...scope(), bytes: Buffer.from("saved") });
    const appended = await content.append({ ...scope(), expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "a".repeat(40), gitHeadRef: null, mutations: [{ path: "file.txt", operation: "upsert", entryType: "file",
        mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 5 }] });
    const receipt = await content.commitCheckpoint({ ...scope(), requestId: request!.id, idempotencyKey: `commit.${request!.id}`,
      contentRevision: appended.revision, reason: `before_${operation}`, manifestBlobId: manifest.id, artifactBlobId: null,
      inclusionPolicy: {}, fileCount: 1, totalBytes: 5, integritySha256: manifest.plaintextSha256 });
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, intentId))).toBe(true);
    return { intentId, request: request!, receipt };
  }
  function provider() {
    let current: CloudProviderResource | null = { resourceId: `sandbox-${fixture.workspaceId}`, state: "running",
      workspaceId: fixture.workspaceId, generation: 1, target: "test-region", metadata: {} };
    const provider = {
      name: "boat", find: vi.fn(async () => current ? [current] : []), inspect: vi.fn(async () => current),
      create: vi.fn(), start: vi.fn(), stop: vi.fn(async () => (current = { ...current!, state: "stopped" })),
      archive: vi.fn(async () => (current = { ...current!, state: "archived" })), delete: vi.fn(async () => { current = null; }),
      async *listManaged() { if (current) yield current; }, verifyManagedResourceOwnership: vi.fn(async () => true),
    } satisfies CloudWorkspaceProvider;
    return provider;
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); fixture = await seedReadyCloudWorkspace(pool); });

  it("cancels an upgrade for a later explicit Stop while preserving its unsaved source drain", async () => {
    const drain = await admit("stop"), transitionId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await seedSupportedCloudWorkspaceGeneration(tx, {...scope(),ownerUserId:fixture.userId,generation:2});
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions(id,workspace_id,org_id,requested_by,operation,
        source_generation,template_generation,candidate_generation,state,drain_intent_id)
        VALUES($1,$2,$3,$4,'upgrade',1,1,2,'draining',$5)`,
      [transitionId,fixture.workspaceId,fixture.organizationId,fixture.userId,drain.intentId]);
      await tx.query("UPDATE cloud_workspace_lifecycle_intents SET generation_transition_id=$2,affects_workspace=false WHERE id=$1", [drain.intentId,transitionId]);
    });
    const stop = await admit("stop");
    await withSystemTx(pool, tx => cancelCloudWorkspaceGenerationTransition(tx, {
      ...scope(),reason:"workspace_stop_requested",
    }));
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1", [transitionId])).rows)
      .toEqual([{state:"cancelled"}]);
    expect((await intent(drain.intentId)).state).toBe("queued");
    expect((await intent(stop.intentId)).state).toBe("queued");
    const p=provider(), reconciler=new CloudWorkspaceReconciler({pool,provider:p,workosEnabled:false});
    await reconciler.runOnce(fixture.workspaceId);
    expect(p.stop).not.toHaveBeenCalled();
    await commitFinalSaveFixture(pool, scope(), {intentId:drain.intentId,userId:fixture.userId,reason:"before_stop"});
    for (let pass=0;pass<3;pass++) await reconciler.runOnce(fixture.workspaceId);
    expect((await intent(stop.intentId)).state).toBe("succeeded");
    expect(p.create).not.toHaveBeenCalled();
    expect((await pool.query("SELECT current_generation,desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows)
      .toEqual([{current_generation:1,desired_state:"stopped"}]);
  });

  it.each(operations)("truthfully retires a legacy %s capture without erasing the accepted operation", async operation => {
    const { intentId, request } = await admit(operation);
    await new DatabaseCloudIdleStop(pool, false).cancel(scope(), request!.id);
    expect((await pool.query("SELECT state,completed_at FROM workspace_checkpoint_requests WHERE id=$1", [request!.id])).rows[0])
      .toEqual({ state: "cancelled", completed_at: expect.any(Date) });
    expect(await intent(intentId)).toEqual({ state: "queued", completed_at: null, error_code: null });
    // The legacy ACK remains truthful and replayable; the logical operation is separate.
    await new DatabaseCloudIdleStop(pool, false).cancel(scope(), request!.id);
    expect((await intent(intentId)).state).toBe("queued");
  });

  it.each(operations)("expires the %s attempt, not its accepted lifecycle", async operation => {
    const { intentId, request } = await admit(operation);
    expect(await expire(request!.id)).toBe(1);
    expect((await pool.query("SELECT state,checkpoint_id FROM workspace_checkpoint_requests WHERE id=$1", [request!.id])).rows[0])
      .toEqual({ state: "expired", checkpoint_id: null });
    expect(await intent(intentId)).toEqual({ state: "queued", completed_at: null, error_code: null });
  });

  it("keeps a dependent wake blocked when its mandatory source capture expires", async () => {
    const { intentId, request } = await admit("stop");
    await withSystemTx(pool, async tx => {
      await tx.query("UPDATE cloud_workspace_lifecycle_intents SET affects_workspace=false WHERE id=$1", [intentId]);
      const key = randomUUID();
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,resume_after_intent_id)
        VALUES($1,1,$2,$3,'wake',$4,$5,$6)`, [fixture.workspaceId, fixture.organizationId,
        fixture.userId, key, createHash("sha256").update(key).digest(), intentId]);
    });
    expect(await expire(request!.id)).toBe(1);
    expect((await pool.query("SELECT state,error_code FROM workspace_checkpoint_requests WHERE id=$1", [request!.id])).rows[0])
      .toEqual({ state: "expired", error_code: "checkpoint_deadline_exceeded" });
    expect((await intent(intentId)).state).toBe("queued");
    expect(await withSystemTx(pool, tx => prepareCloudWorkspaceStopSeal(tx, { ...scope(), intentId, operation: "stop" }))).toBe(false);
  });

  it.each(operations)("never treats absent request/writer as %s proof", async operation => {
    const { intentId } = await admit(operation, false);
    expect(await withSystemTx(pool, tx => prepareCloudWorkspaceStopSeal(tx, { ...scope(), intentId, operation }))).toBe(false);
  });

  for (const legacy of ["absent", "live", "stop_unsealed"] as const) {
    it.each(operations)(`rejects an old %s dispatch UPDATE with ${legacy} proof before provider I/O`, async operation => {
      const { intentId, request } = await admit(operation, legacy !== "absent");
      if (legacy === "stop_unsealed") await pool.query(`UPDATE workspace_checkpoint_requests SET
        state='cancelled',completed_at=now(),error_code='stop_unsealed' WHERE id=$1`, [request!.id]);
      // Retain the old writer's actual SQL shape. It ignores RETURNING, so a
      // silent state rewrite is not a safe refusal: this transaction must fail.
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents
        SET state='dispatching',lease_owner='old-worker',lease_expires_at=now()+interval '1 minute'
        WHERE id=$1 RETURNING state`, [intentId]))).rejects.toMatchObject({ code: "40001" });
      expect((await intent(intentId)).state).toBe("queued");
    });
  }

  it("retains real idle activity cancellation before final proof", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    const idle = new DatabaseCloudIdleStop(pool, false);
    const request = await idle.request(scope(), randomUUID());
    expect(request?.idleStop).toBe(true);
    await idle.cancel(scope(), request!.id);
    const row = (await pool.query(`SELECT request.state,intent.state AS intent_state FROM workspace_checkpoint_requests request
      JOIN cloud_workspace_lifecycle_intents intent ON intent.id=request.lifecycle_intent_id WHERE request.id=$1`, [request!.id])).rows[0];
    expect(row).toEqual({ state: "cancelled", intent_state: "superseded" });
  });

  it.each(operations)("dispatches exactly one %s after a real durable final commit", async operation => {
    const saved = await save(operation);
    const p = provider();
    await new CloudWorkspaceReconciler({ pool, provider: p, workosEnabled: false }).runOnce(fixture.workspaceId);
    expect(p[operation]).toHaveBeenCalledTimes(1);
    expect((await intent(saved.intentId)).state).toBe("succeeded");
  });

  it("records final proof in the commit transaction, without a recovery worker turn", async () => {
    const saved = await save("stop");
    expect((await pool.query(`SELECT state,proven_request_id,checkpoint_id FROM cloud_workspace_final_save_recoveries
      WHERE lifecycle_intent_id=$1`, [saved.intentId])).rows[0]).toEqual({ state: "proven",
      proven_request_id: saved.request.id, checkpoint_id: saved.receipt.checkpointId });
  });

  it.each(["archive", "delete"] as const)("reuses the saved, unchanged stopped source for %s without a new capture", async operation => {
    const saved = await save("stop");
    const p = provider();
    await new CloudWorkspaceReconciler({ pool, provider: p, workosEnabled: false }).runOnce(fixture.workspaceId);
    const next = await admit(operation, false);
    expect(await withSystemTx(pool, tx => prepareCloudWorkspaceStopSeal(tx, { ...scope(), intentId: next.intentId, operation }))).toBe(true);
    expect((await pool.query(`SELECT proven_request_id,checkpoint_id FROM cloud_workspace_final_save_recoveries
      WHERE lifecycle_intent_id=$1`, [next.intentId])).rows[0]).toEqual({ proven_request_id: saved.request.id,
      checkpoint_id: saved.receipt.checkpointId });
    expect((await pool.query("SELECT id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [next.intentId])).rowCount).toBe(0);
    // The public admission route publishes this destination when it reuses a
    // committed final source (no new capture needs the running projection).
    await pool.query("UPDATE cloud_workspaces SET desired_state=$2,authority_epoch=authority_epoch+1 WHERE id=$1",
      [fixture.workspaceId, operation === "archive" ? "archived" : "deleted"]);
    await new CloudWorkspaceReconciler({ pool, provider: p, workosEnabled: false }).runOnce(fixture.workspaceId);
    expect(p[operation]).toHaveBeenCalledTimes(1);
  });

  it.each(["ordinal", "link"] as const)("rejects a null %s on a successor instead of accepting SQL UNKNOWN", async missing => {
    const { intentId, request } = await admit("stop");
    await expire(request!.id);
    await expect(pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,org_id,generation,reason,state,idempotency_key,deadline_at,final_save_recovery_id,final_save_attempt_ordinal)
      VALUES($1,$2,$3,1,'before_stop','recovery_queued',$4,now()+interval '1 minute',$5,$6)`,
    [randomUUID(),fixture.workspaceId,fixture.organizationId,randomUUID(),missing === "link" ? null : intentId,
      missing === "ordinal" ? null : 1])).rejects.toMatchObject({ code: "23514" });
  });

  for (const boundary of ["inspect", "rollback cache"] as const) {
    it.each(["claim", "proof"] as const)(`rechecks %s after held ${boundary} before destructive I/O`, async fence => {
      const saved = await save("stop");
      const p = provider();
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const originalInspect = p.inspect.getMockImplementation()!;
      if (boundary === "inspect") p.inspect.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return originalInspect(); });
      const reconciler = new CloudWorkspaceReconciler({ pool, provider: p, workosEnabled: false,
        ...(boundary === "rollback cache" ? { runtimeRollbackCache: { async beforeStop() { entered.resolve(); await release.promise; return true; } } } : {}) });
      const running = reconciler.runOnce(fixture.workspaceId);
      await entered.promise;
      try {
        if (fence === "claim") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_owner='replacement-worker' WHERE id=$1", [saved.intentId]);
        else await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=now() WHERE id=$1", [saved.receipt.checkpointId]);
      } finally { release.resolve(); }
      await running;
      expect(p.stop).not.toHaveBeenCalled();
    });
  }
});
