import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { runtimeBase, runtimeWitness, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { reserveLocalCloudCommandWriter, activateLocalCloudCommandWriter } from "./commands.js";
import { DatabaseRuntimeRollbackStore, type RuntimeRollbackStopClaim } from "./runtime-rollback-store.js";
import type { RuntimeRollbackOffer } from "./runtime-rollback-contract.js";
import { CloudRuntimeRollbackCache } from "./runtime-rollback.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudWorkspaceProvider, CloudProviderResource } from "./provider.js";

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("durable rollback retention at sealed stop", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let claim: RuntimeRollbackStopClaim, offer: RuntimeRollbackOffer, store: DatabaseRuntimeRollbackStore;
  let head: ReturnType<typeof vi.fn>, writerEpoch: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query(`INSERT INTO cloud_runtime_base_contracts(base_compatibility_id,contract_sha256,contract)
      VALUES($1,$2,'{"schema":"zeros.base-compatibility/v1","runtimeRollbackCacheVersion":1}')`,
    [runtimeBase.compatibilityId, runtimeBase.compatibilityId.slice(4)]);
    f = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    const runtime = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3 }));
    await pool.query(`UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_rollback' WHERE workspace_id=$1`, [f.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (
      setup_run_id,workspace_id,generation,org_id,execution_fence,image_ref,image_source_commit,
      repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT run.id,run.workspace_id,run.generation,run.org_id,run.execution_fence,g.image_ref,g.source_commit,
        'main',$2,1,spec.settings_snapshot_sha256,engine.id,engine.protocol_version,'ready',true,
        g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,g.runtime_profile,g.runtime_engine_protocol_version,
        engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
      FROM cloud_workspace_setup_runs run JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id WHERE run.workspace_id=$1`, [f.workspaceId, "c".repeat(40)]);
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1`, [f.workspaceId]);
    const scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken };
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: new MemoryCloudWorkspaceObjectStore(),
      workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url") });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const file = await blobs.put({ ...scope, bytes: Buffer.from("retained user file") });
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from('{"fixture":"checkpoint"}') });
    const appended = await content.append({ ...scope, expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "c".repeat(40), gitHeadRef: null, mutations: [{ path: "retained.txt", operation: "upsert",
        entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: file.sizeBytes }] });
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [f.engineInstanceId]);
    const checkpoint = (await new DatabaseCloudIdleStop(pool, false).request(scope, randomUUID()))!;
    // The native writer's exact seal is independent of the filesystem checkpoint.
    await withSystemTx(pool, async tx => {
      writerEpoch = await reserveLocalCloudCommandWriter(tx, scope, runtimeWitness.bootId, f.userId, 1);
      await activateLocalCloudCommandWriter(tx, scope, { bootId: runtimeWitness.bootId, writerEpoch });
      const seal = { version: 1, scope: { ...scope, heartbeatToken: undefined, bootId: runtimeWitness.bootId, writerEpoch,
        fundingOwnerUserId: f.userId, fundingOwnerEpoch: 1 }, sealId: randomUUID(), sequence: 0,
        recordSequence: 0, eventSequence: 0, inventorySha256: "a".repeat(64), sha256: "b".repeat(64) };
      const { scope: _scope, ...ack } = seal;
      await tx.query(`UPDATE cloud_workspace_local_command_writers SET sealed_sequence=0,seal_record_sequence=0,seal_event_sequence=0,
        seal=$2,seal_ack=$3 WHERE writer_epoch=$1`, [writerEpoch, JSON.stringify(seal), JSON.stringify({ ...ack, writerEpoch })]);
    });
    await content.commitCheckpoint({ ...scope, requestId: checkpoint.id, idempotencyKey: randomUUID(), contentRevision: appended.revision,
      reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1,
      totalBytes: file.sizeBytes, integritySha256: manifest.plaintextSha256 });
    const intent = (await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='rollback-test',
      lease_expires_at=now()+interval '10 minutes',dispatched_at=now(),attempt_count=1 WHERE workspace_id=$1 RETURNING id`, [f.workspaceId])).rows[0];
    const workspace = (await pool.query(`UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1 RETURNING authority_epoch,agent_boot_id`, [f.workspaceId])).rows[0];
    await pool.query(`INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,
      provider,provider_resource_id,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,provider_expires_at)
      VALUES(gen_random_uuid(),$1,$2,1,1,$3,$4,'boat','bx_rollback','rollback-fixture',3600,1,1,900,'funding',now()+interval '10 minutes',now()+interval '10 minutes')`,
    [f.workspaceId, f.organizationId, f.userId, intent.id]);
    claim = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, providerResourceId: "bx_rollback",
      authorityEpoch: workspace.authority_epoch, intentId: intent.id, workerId: "rollback-test", sourceBindingId: workspace.agent_boot_id };
    const receipt = Buffer.from(JSON.stringify({ schema: "zeros.runtime-install-receipt/v1", runtimeId: runtime.descriptor.runtimeId,
      manifestSha256: runtime.descriptor.manifestSha256, archiveSha256: runtime.descriptor.archiveSha256,
      baseCompatibilityId: runtimeBase.compatibilityId, bootstrapVersion: 1, expandedBytes: runtime.descriptor.expandedBytes,
      fileCount: 1, installedAt: "2026-10-01T00:00:00Z" }) + "\n");
    const { workerId: _workerId, sourceBindingId: _binding, ...retainedScope } = claim;
    offer = { runtime: runtime.descriptor, baseCompatibilityId: runtimeBase.compatibilityId, scope: retainedScope,
      currentRuntimeId: runtimeWitness.runtimeId, bootId: runtimeWitness.bootId, diskEpoch: 3,
      installerReceipt: receipt.toString("base64url"), installerReceiptSha256: createHash("sha256").update(receipt).digest("hex") };
    head = vi.fn(async () => ({ exists: true, bytes: runtime.descriptor.archiveBytes }));
    store = new DatabaseRuntimeRollbackStore({ pool, artifacts: { head } });
  });

  it("commits exact immutable proof before ACK and replays the same pin", async () => {
    const plan = await store.readStop(claim); expect(plan).not.toBeNull();
    expect(plan!.current.installerReceiptSha256).toBe(runtimeWitness.installerReceiptSha256);
    const id = await store.retain(claim, offer); expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(await store.retain(claim, offer)).toBe(id);
    expect((await pool.query("SELECT proof FROM cloud_workspace_runtime_rollback_refs WHERE id=$1", [id])).rows[0].proof).toEqual(offer);
    expect((await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_runtime_rollback_refs SET proof='{}' WHERE id=$1", [id]))).rowCount).toBe(0);
    expect((await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_runtime_rollback_refs WHERE id=$1", [id]))).rowCount).toBe(0);
    await expect(pool.query("UPDATE cloud_workspace_runtime_rollback_refs SET proof='{}' WHERE id=$1", [id])).rejects.toThrow();
    await expect(pool.query("DELETE FROM cloud_workspace_runtime_rollback_refs WHERE id=$1", [id])).rejects.toThrow();
    expect((await withUserTx(pool, f.userId, tx => tx.query("SELECT id FROM cloud_workspace_runtime_rollback_refs"))).rows).toEqual([]);
  });

  it("rejects a SQL retention row whose proof omits its scope identity", async () => {
    const missing = { ...offer, scope: {} };
    await expect(pool.query(`INSERT INTO cloud_workspace_runtime_rollback_refs(workspace_id,org_id,generation,provider_resource_id,
      intent_id,runtime_id,base_compatibility_id,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [claim.workspaceId,claim.organizationId,claim.generation,claim.providerResourceId,claim.intentId,
      offer.runtime.runtimeId,offer.baseCompatibilityId,JSON.stringify(missing)])).rejects.toMatchObject({ code: "23514" });
  });

  it("does not run hosted maintenance through a retired provider credential version", async () => {
    await pool.query(`UPDATE provider_connection_versions SET retired_at=now() WHERE connection_id IN
      (SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1)`, [f.workspaceId]);
    expect(await store.readStop(claim)).toBeNull();
    expect(await store.retain(claim, offer)).toBeNull();
    expect(head).not.toHaveBeenCalled();
    expect(await store.isStopCurrent(claim)).toBe(true);
  });

  it("does not pin missing objects, wrong lengths or a mismatched immutable descriptor", async () => {
    head.mockResolvedValueOnce({ exists: false, bytes: null }); expect(await store.retain(claim, offer)).toBeNull();
    head.mockResolvedValueOnce({ exists: true, bytes: 99 }); expect(await store.retain(claim, offer)).toBeNull();
    const changed = structuredClone(offer); changed.runtime.sourceCommit = "0".repeat(40);
    expect(await store.retain(claim, changed)).toBeNull();
    expect((await pool.query("SELECT id FROM cloud_workspace_runtime_rollback_refs")).rows).toEqual([]);
  });

  it("rechecks epoch after object I/O without holding the workspace lock", async () => {
    head.mockImplementationOnce(async () => {
      await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [f.workspaceId]);
      return { exists: true, bytes: offer.runtime.archiveBytes };
    });
    expect(await store.retain(claim, offer)).toBeNull();
    expect(await store.isStopCurrent(claim)).toBe(false);
    expect((await pool.query("SELECT id FROM cloud_workspace_runtime_rollback_refs")).rows).toEqual([]);
  });

  it.each(["foreign organization", "stale worker", "new wake", "no committed setup", "unsealed stop", "TTL force threshold", "spent stop budget"])("does not evict on %s", async change => {
    if (change === "foreign organization") claim.organizationId = randomUUID();
    if (change === "stale worker") claim.workerId = "other-worker";
    if (change === "new wake") await pool.query("UPDATE cloud_workspaces SET desired_state='running' WHERE id=$1", [f.workspaceId]);
    if (change === "no committed setup") await pool.query("DELETE FROM cloud_workspace_setup_attestations WHERE workspace_id=$1", [f.workspaceId]);
    if (change === "unsealed stop") await pool.query(`UPDATE workspace_checkpoint_requests SET state='cancelled',checkpoint_id=NULL,error_code='stop_unsealed' WHERE lifecycle_intent_id=$1`, [claim.intentId]);
    if (change === "TTL force threshold") await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=now()+interval '40 seconds' WHERE workspace_id=$1", [f.workspaceId]);
    if (change === "spent stop budget") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET dispatched_at=now()-interval '3 minutes' WHERE id=$1", [claim.intentId]);
    expect(await store.readStop(claim)).toBeNull();
    expect(await store.retain(claim, offer)).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });

  it("release retirement cannot erase a workspace's acknowledged rollback archive pin", async () => {
    const id = await store.retain(claim, offer);
    await pool.query("UPDATE cloud_runtime_channel_releases SET revoked_at=now() WHERE runtime_id=$1", [offer.runtime.runtimeId]);
    await expect(pool.query("DELETE FROM cloud_runtime_bundles WHERE runtime_id=$1", [offer.runtime.runtimeId])).rejects.toThrow();
    expect((await pool.query("SELECT proof FROM cloud_workspace_runtime_rollback_refs WHERE id=$1", [id])).rows[0].proof).toEqual(offer);
  });

  it.each(["retained", "unavailable", "plan unavailable", "new wake"])("orders optional maintenance before provider stop: %s", async outcome => {
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [claim.intentId]);
    const events: string[] = [];
    const resource: CloudProviderResource = { resourceId: claim.providerResourceId, workspaceId: f.workspaceId,
      generation: 1, state: "running", target: null, metadata: {} };
    const provider = { name: "boat", inspect: vi.fn(async () => resource), find: vi.fn(async () => [resource]),
      stop: vi.fn(async () => { events.push("provider-stop"); return { ...resource, state: "stopped" }; }) } as unknown as CloudWorkspaceProvider;
    if (outcome === "plan unavailable") vi.spyOn(store, "readStop").mockRejectedValueOnce(new Error("closed metadata refusal"));
    const cache = new CloudRuntimeRollbackCache({ store, run: async input => {
      events.push("cache");
      if (outcome === "new wake") await pool.query("UPDATE cloud_workspaces SET desired_state='running',authority_epoch=authority_epoch+1 WHERE id=$1", [f.workspaceId]);
      if (outcome !== "retained") throw new Error("closed refusal");
      return { schema: input.schema, scope: input.scope, fence: input.fence, outcome: "unchanged" };
    } });
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, workerId: "rollback-test", runtimeRollbackCache: cache });
    await reconciler.runOnce(f.workspaceId);
    expect(events).toEqual(outcome === "new wake" ? ["cache"] : outcome === "plan unavailable" ? ["provider-stop"] : ["cache", "provider-stop"]);
  });
});
