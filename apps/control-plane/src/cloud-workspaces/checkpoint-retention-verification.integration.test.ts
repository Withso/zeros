import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { requireCloudRecoveryPoint } from "./automatic-recovery.js";
import { loadStoppedCheckpointSnapshot, verifyStoppedWorkspaceCheckpoint } from "./checkpoint-retention-verification.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("retained checkpoint object proof", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let store: MemoryCloudWorkspaceObjectStore, blobs: DatabaseCloudWorkspaceBlobService;
  let checkpointId: string, nativeBlobId: string, slug: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    store = new MemoryCloudWorkspaceObjectStore();
    blobs = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: store, workosEnabled: false,
      encryptionKeyV1: randomBytes(32).toString("base64url") });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const file = await blobs.put({ ...scope, bytes: Buffer.from("retained file") });
    const native = await blobs.put({ ...scope, bytes: Buffer.from("synthetic native v2 chunk") });
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from('{"synthetic":"manifest"}') });
    nativeBlobId = native.id;
    const appended = await content.append({ ...scope, expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "retained.txt", operation: "upsert", entryType: "file", mode: 33188,
        blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: file.sizeBytes }] });
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    const directive = (await new DatabaseCloudIdleStop(pool, false).request(scope, randomUUID()))!;
    checkpointId = (await content.commitCheckpoint({ ...scope, requestId: directive.id, idempotencyKey: randomUUID(),
      contentRevision: appended.revision, reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null,
      artifactBlobIds: [native.id], inclusionPolicy: {}, fileCount: 1, totalBytes: file.sizeBytes,
      integritySha256: manifest.plaintextSha256 })).checkpointId;
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopped',last_observed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
  });
  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    actorUserId: fixture.userId, expectedOrganizationSlug: slug });
  const verify = (execute = true) => verifyStoppedWorkspaceCheckpoint({
    readSnapshot: () => loadStoppedCheckpointSnapshot(pool, scope()),
    readBlob: blobId => blobs.getSystem({ blobId, organizationId: fixture.organizationId }),
  }, { verify: execute });

  it("verifies real encrypted manifest, file and native-v2 objects without changing lifecycle", async () => {
    const before = (await pool.query("SELECT version,authority_epoch,status,desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0];
    const get = vi.spyOn(store, "get");
    expect(await verify(false)).toMatchObject({ state: "planned", verifiedAt: null, blobCount: 3 });
    expect(get).not.toHaveBeenCalled();
    expect(await verify()).toMatchObject({ state: "verified", checkpointId, blobCount: 3, coverage: "final_checkpoint" });
    expect(get).toHaveBeenCalledTimes(3);
    expect((await pool.query("SELECT version,authority_epoch,status,desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0]).toEqual(before);
  });

  it("refuses recovery when only a native-v2 artifact reference is unavailable", async () => {
    expect((await pool.query("SELECT reference_id FROM workspace_blob_references WHERE blob_id=$1", [nativeBlobId])).rows)
      .toContainEqual({ reference_id: `${checkpointId}:v2` });
    await pool.query("UPDATE workspace_blobs SET state='quarantined' WHERE id=$1", [nativeBlobId]);
    await expect(withSystemTx(pool, tx => requireCloudRecoveryPoint(tx, { workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId, sourceGeneration: 1, checkpointId })))
      .rejects.toMatchObject({ code: "cloud_recovery_checkpoint_unavailable" });
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_object_unavailable" });
  });

  it("refuses a missing object even while its database metadata remains available", async () => {
    const key = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [nativeBlobId])).rows[0].object_key;
    await store.delete(key);
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_object_unavailable" });
  });

  it("refuses ciphertext corruption rather than certifying metadata alone", async () => {
    const original = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation(async (key, options) => {
      const bytes = await original(key, options);
      if (!bytes) return bytes;
      const corrupt = Buffer.from(bytes); corrupt[0] = corrupt[0]! ^ 1; return corrupt;
    });
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_object_unavailable" });
  });

  it("withholds verification after authority changes during an object read", async () => {
    const original = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (key, options) => {
      await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
      return original(key, options);
    });
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_verification_changed" });
  });

  it.each(["workspace_content_heads", "workspace_record_heads"] as const)("withholds verification when %s advances beyond an already periodic checkpoint", async table => {
    await pool.query(`INSERT INTO ${table}(workspace_id,org_id,current_revision) VALUES($1,$2,10)
      ON CONFLICT(workspace_id) DO UPDATE SET current_revision=10`, [fixture.workspaceId, fixture.organizationId]);
    expect(await verify(false)).toMatchObject({ coverage: "checkpoint_only" });
    const original = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (key, options) => {
      await pool.query(`UPDATE ${table} SET current_revision=current_revision+1 WHERE workspace_id=$1`, [fixture.workspaceId]);
      return original(key, options);
    });
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_verification_changed" });
  });

  it("rechecks actor authorization after I/O and never exposes plaintext", async () => {
    const original = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (key, options) => {
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, fixture.userId]);
      return original(key, options);
    });
    await expect(verify()).rejects.toMatchObject({ code: "checkpoint_scope_unavailable" });
  });

  it.each(["wrong owner", "personal", "running", "unconfirmed stop"])("refuses %s before any payload read", async kind => {
    const get = vi.spyOn(store, "get");
    if (kind === "wrong owner") slug = "another-organization";
    if (kind === "personal") {
      const personalId = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,'local-fixture','Local',$2,true,false)",
        [personalId, fixture.userId]);
      fixture = { ...fixture, organizationId: personalId }; slug = "local-fixture";
    }
    if (kind === "running") await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1", [fixture.workspaceId]);
    if (kind === "unconfirmed stop") await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='running' WHERE workspace_id=$1", [fixture.workspaceId]);
    await expect(verify()).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("retains the current checkpoint and native objects beyond the provider's 14-day clock", async () => {
    await pool.query("UPDATE workspace_checkpoints SET created_at=now()-interval '30 days',durable_at=now()-interval '30 days' WHERE id=$1", [checkpointId]);
    await pool.query("UPDATE workspace_checkpoint_requests SET completed_at=now()-interval '30 days' WHERE checkpoint_id=$1", [checkpointId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '31 days',registered_at=now()-interval '31 days' WHERE id=$1", [fixture.engineInstanceId]);
    await pool.query(`INSERT INTO workspace_retention_policies(workspace_id,org_id,checkpoint_days) VALUES($1,$2,1)
      ON CONFLICT(workspace_id) DO UPDATE SET checkpoint_days=1`, [fixture.workspaceId, fixture.organizationId]);
    await new CloudWorkspaceOperationsWorker(pool, blobs, { workerId: "retention-proof-fixture" }).applyRetentionOnce();
    expect(await verify()).toMatchObject({ state: "verified", checkpointId, blobCount: 3 });
  });
});
