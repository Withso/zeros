import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { lockWorkspaceObjectStorage } from "./storage-lock.js";
import { HttpError } from "../authz.js";
import type { AuthedUser } from "../auth.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import {
  deliverWorkspaceCheckpointRequest,
  enqueueWorkspaceCheckpointRequest,
} from "./checkpoint-requests.js";
import {
  DatabaseCloudWorkspaceContentService,
  WorkspaceContentError,
} from "./content-record.js";
import {
  DatabaseCloudWorkspaceBlobService,
  type CloudWorkspaceObjectStore,
} from "./object-store.js";
import type {
  CloudProviderResource,
  CloudWorkspaceProvider,
} from "./provider.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import {
  DatabaseCloudWorkspaceSetupRecoveryService,
  issueWorkspaceSetupRecoveryGrant,
} from "./setup-recovery.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

class InspectableObjectStore implements CloudWorkspaceObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly fencedKeys = new Set<string>();
  failNextPut = false;

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected object-store outage");
    }
    if (this.fencedKeys.has(key)) {
      throw new Error("workspace object key is permanently fenced");
    }
    if (this.objects.has(key)) return "already_exists";
    this.objects.set(key, Uint8Array.from(bytes));
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (this.fencedKeys.has(key)) return null;
    const value = this.objects.get(key);
    return value ? Uint8Array.from(value) : null;
  }

  async delete(key: string): Promise<void> {
    if (this.fencedKeys.has(key)) return;
    this.objects.delete(key);
  }

  async deleteAndFence(key: string): Promise<void> {
    this.objects.delete(key);
    this.fencedKeys.add(key);
  }

  async sweepAbandonedUploads(): Promise<number> {
    return 0;
  }
}

d("cloud workspace content durability", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let objectStore: InspectableObjectStore;
  let blobs: DatabaseCloudWorkspaceBlobService;
  let content: DatabaseCloudWorkspaceContentService;
  const encryptionKeyV1 = randomBytes(32).toString("base64url");

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    objectStore = new InspectableObjectStore();
    blobs = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore,
      encryptionKeyV1,
      workosEnabled: false,
    });
    content = new DatabaseCloudWorkspaceContentService({
      pool,
      workosEnabled: false,
    });
  });

  function engineAuthority() {
    return {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
    };
  }





  it("authenticates upload ingress by the live indexed engine capability and rechecks publication after revocation", async () => {
    await expect(blobs.authorizeUpload(`zwh_${"x".repeat(43)}`)).rejects.toMatchObject({ code: "engine_authority_rejected" });
    await expect(blobs.authorizeUpload(fixture.heartbeatToken)).resolves.toBeUndefined();
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    await expect(blobs.authorizeUpload(fixture.heartbeatToken)).rejects.toMatchObject({ code: "engine_authority_rejected" });
    await expect(blobs.putBatch({ ...engineAuthority(), entries: [Buffer.from("revoked after ingress")] })).rejects.toMatchObject({ code: "engine_authority_rejected" });
    expect(objectStore.objects.size).toBe(0);
  });

  it("rejects an expired or generation-fenced capability before upload ingress", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute' WHERE id=$1", [fixture.engineInstanceId]);
    await expect(blobs.authorizeUpload(fixture.heartbeatToken)).rejects.toMatchObject({ code: "engine_authority_rejected" });
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now(),lease_expires_at=now()+interval '5 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopping',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    await expect(blobs.authorizeUpload(fixture.heartbeatToken)).rejects.toMatchObject({ code: "engine_authority_rejected" });
  });

  it("canonicalizes storage advisory locks and current-entry references across UUID casing", async () => {
    await withSystemTx(pool, async tx => {
      await lockWorkspaceObjectStorage(tx, fixture.organizationId.toUpperCase());
      const other = await pool.connect();
      try {
        const lock = await other.query("SELECT pg_try_advisory_lock(hashtextextended('workspace-object-storage:' || $1::text,0)) AS acquired", [fixture.organizationId]);
        try { expect(lock.rows[0].acquired).toBe(false); }
        finally { if (lock.rows[0].acquired) await other.query("SELECT pg_advisory_unlock(hashtextextended('workspace-object-storage:' || $1::text,0))", [fixture.organizationId]); }
      } finally { other.release(); }
    });
    const blob = await blobs.put({ ...engineAuthority(), bytes: Buffer.from("entry") });
    const request = { ...engineAuthority(), expectedRevision: 0, idempotencyKey: "canonical.references.1", gitBaseCommit: null, gitHeadRef: null,
      mutations: [{ operation: "upsert" as const, path: "entry.txt", entryType: "file" as const, mode: 33188 as const,
        blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: blob.sizeBytes }] };
    await content.append({ ...request, workspaceId: fixture.workspaceId.toUpperCase(), organizationId: fixture.organizationId.toUpperCase() });
    await content.append({ ...request, expectedRevision: 1, idempotencyKey: "canonical.references.2" });
    expect((await pool.query("SELECT reference_count FROM workspace_blobs WHERE id=$1", [blob.id])).rows[0].reference_count).toBe("3");
  });

  it.each(["single", "batch"] as const)("round-trips uppercase scope UUIDs through canonical recovery for a %s upload", async kind => {
    const bytes = Buffer.from("canonical UUID encryption binding");
    const scope = { ...engineAuthority(), organizationId: fixture.organizationId.toUpperCase(), workspaceId: fixture.workspaceId.toUpperCase(), engineInstanceId: fixture.engineInstanceId.toUpperCase() };
    const blob = kind === "single" ? await blobs.put({ ...scope, bytes }) : (await blobs.putBatch({ ...scope, entries: [bytes] })).blobs[0]!;
    expect(await blobs.getSystem({ organizationId: fixture.organizationId, blobId: blob.id })).toEqual(bytes);
    const row = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [blob.id])).rows[0];
    expect(row.object_key).toBe(row.object_key.toLowerCase());
  });

  it("keeps cold small-file checkpoint uploads concurrent instead of serializing behind four objects", async () => {
    let active=0,release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const put=objectStore.putIfAbsent.bind(objectStore);
    objectStore.putIfAbsent=async(key,bytes)=>{active++;try{await pending;return await put(key,bytes);}finally{active--;}};
    const transfers=Promise.all(Array.from({length:2},(_,batch)=>blobs.putBatch({...engineAuthority(),
      entries:Array.from({length:64},(_,index)=>Buffer.from(`cold-concurrency-${batch}-${index}`))})));
    try{await vi.waitFor(()=>expect(active).toBeGreaterThanOrEqual(16),{timeout:1500});}
    finally{release();await transfers;}
    expect(objectStore.objects.size).toBe(128);
  });

  it("shares the object I/O budget across scalar and batch uploads", async () => {
    let admitted = 0, active = 0, maximum = 0, open!: () => void, reachedCapacity!: () => void;
    const release = new Promise<void>(resolve => { open = resolve; });
    const entered = new Promise<void>(resolve => { reachedCapacity = resolve; });
    const put = objectStore.putIfAbsent.bind(objectStore);
    objectStore.putIfAbsent = async (key, bytes) => {
      admitted += 1; active += 1; maximum = Math.max(maximum, active);
      if (admitted === 32) reachedCapacity();
      try { await release; return await put(key, bytes); } finally { active -= 1; }
    };
    const transfers = Promise.all([
      ...Array.from({ length: 3 }, (_, n) => blobs.putBatch({ ...engineAuthority(), entries: Array.from({length:16},(_,index)=>Buffer.from(`batch-${n}-${index}`)) })),
      ...Array.from({ length: 2 }, (_, n) => blobs.put({ ...engineAuthority(), bytes: Buffer.from(`single-${n}`) })),
    ]);
    try { await entered;
      await vi.waitFor(async () => expect((await pool.query("SELECT count(*)::integer count FROM workspace_blobs WHERE org_id=$1", [fixture.organizationId])).rows[0].count).toBe(50));
      await new Promise(resolve => setTimeout(resolve, 50)); expect(maximum).toBeLessThanOrEqual(32); }
    finally { open(); await transfers; }
  });

  it.each(["single", "batch"] as const)("passes the exact %s readback budget and keeps failed publications pending", async kind => {
    const bytes = Buffer.from("tiny readback");
    const read = vi.spyOn(objectStore, "get").mockImplementation(async (...args: Parameters<CloudWorkspaceObjectStore["get"]>) => {
      expect(args[1]?.expectedBytes).toBe(bytes.byteLength);
      expect(args[1]?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("workspace object length differs from metadata");
    });
    await expect(kind === "single"
      ? blobs.put({ ...engineAuthority(), bytes })
      : blobs.putBatch({ ...engineAuthority(), entries: [bytes] })).rejects.toMatchObject({ code: "object_store_unavailable" });
    expect(read).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT state,reference_count FROM workspace_blobs WHERE org_id=$1", [fixture.organizationId])).rows)
      .toEqual([{ state: "pending_upload", reference_count: "0" }]);
    read.mockRestore();
    await expect(blobs.put({ ...engineAuthority(), bytes })).resolves.toMatchObject({ sizeBytes: bytes.byteLength });
  });

  it.each(["single", "batch"] as const)("charges and fences abandoned ciphertext when a %s upload reclaims a pending key", async kind => {
    const bytes = Buffer.from("12345678");
    const originalPut = objectStore.putIfAbsent.bind(objectStore);
    objectStore.putIfAbsent = async (key, value) => { await originalPut(key, value); throw new Error("lost upload reply"); };
    await expect(blobs.put({ ...engineAuthority(), bytes })).rejects.toMatchObject({ code: "object_store_unavailable" });
    objectStore.putIfAbsent = originalPut;
    const before = (await pool.query("SELECT id,object_key FROM workspace_blobs WHERE org_id=$1", [fixture.organizationId])).rows[0];
    const next = new DatabaseCloudWorkspaceBlobService({ pool, objectStore,
      encryptionKeys: { 1: encryptionKeyV1, 2: randomBytes(32).toString("base64url") }, keyVersion: 2, workosEnabled: false });
    const retry = () => kind === "single" ? next.put({ ...engineAuthority(), bytes }) : next.putBatch({ ...engineAuthority(), entries: [bytes] });
    await pool.query("UPDATE cloud_workspace_object_storage_limits SET max_organization_bytes=8,max_workspace_bytes=8 WHERE org_id=$1", [fixture.organizationId]);
    await expect(retry()).rejects.toMatchObject({ code: "organization_object_storage_limit_exceeded" });
    expect((await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [before.id])).rows[0].object_key).toBe(before.object_key);
    await pool.query("UPDATE cloud_workspace_object_storage_limits SET max_organization_bytes=16 WHERE org_id=$1", [fixture.organizationId]);
    await retry();
    const receipt = (await pool.query("SELECT reserved_bytes,fenced_at FROM workspace_blob_object_deletions WHERE object_key=$1", [before.object_key])).rows[0];
    expect(receipt).toMatchObject({ reserved_bytes: "8", fenced_at: null });
    expect((await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [before.id])).rows[0].object_key).toMatch(/k2-retry-[a-f0-9]{32}$/);
    expect(await next.collectGarbageOnce()).toBe(true);
    expect(objectStore.fencedKeys.has(before.object_key)).toBe(true);
    expect((await pool.query("SELECT reserved_bytes FROM workspace_blob_object_deletions WHERE object_key=$1", [before.object_key])).rows[0].reserved_bytes).toBe("0");
    expect(await next.getSystem({ blobId: before.id, organizationId: fixture.organizationId })).toEqual(bytes);
  });


  it("publishes a cold baseline of 4000 distinct blobs with linear quota accounting", async () => {
    const mutations: Array<{ operation: "upsert"; path: string; entryType: "file"; mode: 33188; blobId: string; contentSha256: string; sizeBytes: number }> = [];
    let totalBytes = 0;
    for (let offset = 0; offset < 4000; offset += 64) {
      const entries = Array.from({ length: Math.min(64, 4000 - offset) }, (_, index) => Buffer.from(`distinct-${offset + index}`));
      const batch = await blobs.putBatch({ ...engineAuthority(), entries });
      for (const blob of batch.blobs) {
        totalBytes += blob.sizeBytes;
        mutations.push({ operation: "upsert", path: `cold/${offset + blob.index}.txt`, entryType: "file", mode: 33188,
          blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: blob.sizeBytes });
      }
    }
    const queries = vi.spyOn(pg.Client.prototype, "query");
    try {
      await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: "cold.distinct.baseline", gitBaseCommit: null, gitHeadRef: null, mutations });
      expect(queries.mock.calls.length).toBeLessThan(40);
    } finally { queries.mockRestore(); }
    expect((await pool.query("SELECT count(*)::integer count FROM workspace_blobs WHERE org_id=$1 AND reference_count=2 AND state='available'", [fixture.organizationId])).rows[0].count).toBe(4000);
    expect(Number((await pool.query("SELECT sum(reserved_bytes) bytes FROM workspace_blob_storage_reservations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].bytes)).toBe(totalBytes);
  }, 45_000);

  it("publishes a 4000-file cold revision with bounded database round trips and exact references", async () => {
    const bytes = Buffer.from("shared baseline bytes");
    const blob = await blobs.put({ ...engineAuthority(), bytes });
    const mutations = Array.from({ length: 4000 }, (_, index) => ({
      operation: "upsert" as const, path: `baseline/${index}.txt`, entryType: "file" as const,
      mode: 33188 as const, blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: bytes.length,
    }));
    const request = { ...engineAuthority(), expectedRevision: 0, idempotencyKey: "cold.baseline.batch",
      gitBaseCommit: null, gitHeadRef: null, mutations };
    const queries = vi.spyOn(pg.Client.prototype, "query");
    let calls: number;
    try { await expect(content.append(request)).resolves.toEqual({ revision: 1, replayed: false }); calls = queries.mock.calls.length; }
    finally { queries.mockRestore(); }
    expect(calls!).toBeLessThan(40);
    expect((await pool.query("SELECT count(*)::integer count FROM workspace_file_events WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe(4000);
    expect((await pool.query("SELECT reference_count FROM workspace_blobs WHERE id=$1", [blob.id])).rows[0].reference_count).toBe("8000");
    await expect(content.append(request)).resolves.toEqual({ revision: 1, replayed: true });
    expect((await pool.query("SELECT count(*)::integer count FROM workspace_blob_storage_reservations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe(1);
  }, 30_000);

  it("batch uploads deduplicate bytes and renew existing reservations with bounded queries", async () => {
    const entries = Array.from({ length: 62 }, (_, index) => Buffer.from(`batch-${index}`));
    entries.push(Buffer.from("batch-0"), Buffer.alloc(0));
    const queries = vi.spyOn(pg.Client.prototype, "query");
    let result: Awaited<ReturnType<DatabaseCloudWorkspaceBlobService["putBatch"]>>;
    let calls: number;
    try { result = await blobs.putBatch({ ...engineAuthority(), entries }); calls = queries.mock.calls.length; }
    finally { queries.mockRestore(); }
    expect(calls!).toBeLessThan(40);
    expect(result!.blobs).toHaveLength(64);
    expect(result!.blobs[0]!.id).toBe(result!.blobs[62]!.id);
    expect(objectStore.objects.size).toBe(63);
    await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: "batch.upload.references", gitBaseCommit: null, gitHeadRef: null,
      mutations: result!.blobs.map((blob, index) => ({ operation: "upsert", path: `batch/${index}.txt`, entryType: "file", mode: 33188,
        blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: blob.sizeBytes })) });
    for (const [index, blob] of result!.blobs.entries()) {
      expect(blob).toMatchObject({ index, plaintextSha256: createHash("sha256").update(entries[index]!).digest("hex"), sizeBytes: entries[index]!.length });
      expect(await blobs.getForEngine({ ...engineAuthority(), blobId: blob.id })).toEqual(entries[index]);
    }
    const reused = await blobs.putBatch({ ...engineAuthority(), entries });
    expect(reused.blobs.every(blob => blob.reused)).toBe(true);
  });

  it("rejects oversized batches before storage or reservation and rolls quota admission back as a whole", async () => {
    await expect(blobs.putBatch({ ...engineAuthority(), entries: Array.from({ length: 65 }, () => Buffer.alloc(0)) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(blobs.putBatch({ ...engineAuthority(), entries: [Buffer.alloc(4 * 1024 * 1024 + 1)] })).rejects.toMatchObject({ code: "invalid_input" });
    await pool.query("UPDATE cloud_workspace_object_storage_limits SET max_workspace_bytes=10 WHERE org_id=$1", [fixture.organizationId]);
    await expect(blobs.putBatch({ ...engineAuthority(), entries: [Buffer.from("first-8!"), Buffer.from("second-8")] })).rejects.toMatchObject({ code: "workspace_object_storage_limit_exceeded" });
    expect(objectStore.objects.size).toBe(0);
    expect((await pool.query("SELECT count(*)::integer count FROM workspace_blobs WHERE org_id=$1", [fixture.organizationId])).rows[0].count).toBe(0);
  });

  it("retains pending receipts after ambiguous batch object I/O and safely retries", async () => {
    objectStore.failNextPut = true;
    const input = { ...engineAuthority(), entries: [Buffer.from("one"), Buffer.from("two")] };
    await expect(blobs.putBatch(input)).rejects.toMatchObject({ code: "object_store_unavailable" });
    const before = (await pool.query("SELECT id,state FROM workspace_blobs WHERE org_id=$1 ORDER BY id", [fixture.organizationId])).rows;
    expect(before).toHaveLength(2);
    expect(before.every(row => row.state === "pending_upload")).toBe(true);
    const result = await blobs.putBatch(input);
    expect(result.blobs.map(blob => blob.id).sort()).toEqual(before.map(row => row.id));
    expect((await pool.query("SELECT count(*)::integer count FROM workspace_blobs WHERE org_id=$1 AND state='available'", [fixture.organizationId])).rows[0].count).toBe(2);
  });

  it("rechecks engine revocation after batch I/O without holding database locks", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const put = objectStore.putIfAbsent.bind(objectStore);
    objectStore.putIfAbsent = async (key, bytes) => { entered(); await paused; return put(key, bytes); };
    const pending = blobs.putBatch({ ...engineAuthority(), entries: [Buffer.from("revoke during put")] });
    const failure = expect(pending).rejects.toMatchObject({ code: "engine_authority_rejected" });
    await waiting;
    try { await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]); }
    finally { release(); }
    await failure;
    expect((await pool.query("SELECT state FROM workspace_blobs WHERE org_id=$1", [fixture.organizationId])).rows[0].state).toBe("pending_upload");
  });

  it.each(["failed", "stopped", "expired engine"])("replaces a %s allocation from a selected durable checkpoint without asking the dead engine to checkpoint", async status => {
    await pool.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,1,1,4000,8192,40960)`, [fixture.organizationId]);
    const file = await blobs.put({ ...engineAuthority(), bytes: Buffer.from("durable") });
    const manifest = await blobs.put({ ...engineAuthority(), bytes: Buffer.from("{}") });
    const appended = await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "file.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 7 }] });
    const checkpoint = await content.commitCheckpoint({ ...engineAuthority(), idempotencyKey: randomUUID(), contentRevision: appended.revision,
      reason: "periodic", manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: 7, integritySha256: manifest.plaintextSha256 });
    const config: CloudWorkspaceBackendConfig = { provider: "daytona", apiKey: "fixture", apiUrl: "https://api.example.test", target: "eu", snapshotId: "recovery-image", imageRef: "recovery-image",
      architecture: "linux/amd64", cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), operationTimeoutSeconds: 30,
      autoArchiveMinutes: 10080, reconcileIntervalMs: 1000, providerCredentialKeys: {}, settingsSecretEncryptionKeys: {}, currentSettingsSecretEncryptionKeyVersion: null,
      settingsSecretKeyV1: null, access: { allowedSshHosts: [], allowedPreviewHostSuffixes: [], previewBaseDomain: "preview.example.test" }, durability: null, outbox: null, setupExecution: null };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    app.onError((error, c) => { if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status); throw error; });
    const route = `/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/generations`;
    const send = (body: unknown, key = randomUUID()) => app.request(route, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    const body = { operation: "recover", sourceGeneration: 1, checkpointId: checkpoint.checkpointId };
    expect((await send(body)).status).toBe(409); // Healthy work requires a normal final checkpoint.
    if (status === "expired engine") {
      await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute' WHERE id=$1", [fixture.engineInstanceId]);
    } else {
      await pool.query("UPDATE cloud_workspaces SET status=$2::cloud_workspace_status, desired_state=$3::cloud_workspace_desired_state WHERE id=$1", [fixture.workspaceId, status, status === "stopped" ? "stopped" : "running"]);
    }
    expect((await send({ ...body, sourceGeneration: 2 })).status).toBe(409);
    expect((await send({ ...body, checkpointId: randomUUID() })).status).toBe(404);
    const key = randomUUID(); const accepted = await send(body, key);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect((await send(body, key)).status).toBe(200);
    expect((await send({ ...body, checkpointId: randomUUID() }, key)).status).toBe(409);
    expect((await pool.query("SELECT count(*)::integer AS count FROM workspace_checkpoint_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows).toEqual([{ count: 0 }]);
    expect((await pool.query("SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows).toEqual([{ recovery_checkpoint_id: checkpoint.checkpointId }]);
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]?.state).not.toBe("ready");
    let stops = 0, creates = 0;
    let observed: CloudProviderResource | null = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: "eu", metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "daytona", async inspect(id) { return observed?.resourceId === id ? observed : null; }, async find() { return []; },
      async create(input) { creates++; return { ...input, resourceId: "replacement", state: "running", target: "eu", metadata: {} }; },
      async stop() { stops++; observed = { ...observed!, state: "stopped" }; return observed; }, async start() { throw new Error("source must not restart"); },
      async archive() { throw new Error("unexpected archive"); }, async delete() {}, async *listManaged() {} };
    const worker = new CloudWorkspaceReconciler({ pool, provider, workosEnabled: false, intervalMs: 1000 });
    await worker.runOnce(); expect(stops).toBe(1); expect(creates).toBe(0);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0]?.current_generation).toBe(2);
    await worker.runOnce(); expect(creates).toBe(1);
    await expect(content.headForEngine({ ...engineAuthority(), afterPath: null })).rejects.toMatchObject({ code: "engine_authority_rejected" });
  });

  it("fails closed when durable object-storage limits are not configured", async () => {
    await pool.query(
      `DELETE FROM cloud_workspace_object_storage_limits WHERE org_id = $1`,
      [fixture.organizationId],
    );
    await expect(
      blobs.put({
        ...engineAuthority(),
        bytes: Buffer.from("unadmitted", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "object_storage_limit_not_configured" });
    await expect(
      pool.query(`SELECT count(*)::integer AS count FROM workspace_blobs`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("serializes cumulative organization admission without double-charging retries", async () => {
    await pool.query(
      `UPDATE cloud_workspace_object_storage_limits
       SET max_organization_bytes = 9, max_workspace_bytes = 9,
           updated_by = $2, updated_at = now()
       WHERE org_id = $1`,
      [fixture.organizationId, fixture.userId],
    );

    const results = await Promise.allSettled([
      blobs.put({ ...engineAuthority(), bytes: Buffer.from("first!", "utf8") }),
      blobs.put({ ...engineAuthority(), bytes: Buffer.from("second", "utf8") }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([
      { reason: { code: "organization_object_storage_limit_exceeded" } },
    ]);

    const admitted = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof blobs.put>>
      > => result.status === "fulfilled",
    )!.value;
    const admittedBytes =
      Buffer.from("first!", "utf8").length === admitted.sizeBytes
        ? Buffer.from("first!", "utf8")
        : Buffer.from("second", "utf8");
    await expect(
      blobs.put({ ...engineAuthority(), bytes: admittedBytes }),
    ).resolves.toMatchObject({ id: admitted.id, reused: true });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count,
                coalesce(sum(reserved_bytes), 0)::integer AS bytes
         FROM workspace_blob_storage_reservations
         WHERE workspace_id = $1`,
        [fixture.workspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ count: 1, bytes: admitted.sizeBytes }],
    });
  });

  it("enforces the workspace durable-storage limit independently", async () => {
    await pool.query(
      `UPDATE cloud_workspace_object_storage_limits
       SET max_organization_bytes = 64, max_workspace_bytes = 9,
           updated_by = $2, updated_at = now()
       WHERE org_id = $1`,
      [fixture.organizationId, fixture.userId],
    );

    const results = await Promise.allSettled([
      blobs.put({ ...engineAuthority(), bytes: Buffer.from("first!", "utf8") }),
      blobs.put({ ...engineAuthority(), bytes: Buffer.from("second", "utf8") }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([
      { reason: { code: "workspace_object_storage_limit_exceeded" } },
    ]);
  });

  it("does not release workspace capacity until an abandoned blob is collected", async () => {
    await pool.query(
      `UPDATE cloud_workspace_object_storage_limits
       SET max_organization_bytes = 64, max_workspace_bytes = 9,
           updated_by = $2, updated_at = now()
       WHERE org_id = $1`,
      [fixture.organizationId, fixture.userId],
    );
    await blobs.put({
      ...engineAuthority(),
      bytes: Buffer.from("first!", "utf8"),
    });
    await pool.query(
      `UPDATE workspace_blob_storage_reservations
       SET expires_at = now() - interval '1 second'
       WHERE workspace_id = $1 AND state = 'uploading'`,
      [fixture.workspaceId],
    );

    await expect(
      blobs.put({
        ...engineAuthority(),
        bytes: Buffer.from("second", "utf8"),
      }),
    ).rejects.toMatchObject({
      code: "workspace_object_storage_limit_exceeded",
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workspace_blob_storage_reservations WHERE workspace_id = $1`,
        [fixture.workspaceId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await pool.query(
      `UPDATE workspace_blobs
       SET created_at = now() - interval '2 hours'
       WHERE org_id = $1`,
      [fixture.organizationId],
    );
    await expect(blobs.collectGarbageOnce(60_000)).resolves.toBe(true);
    await expect(
      blobs.put({
        ...engineAuthority(),
        bytes: Buffer.from("second", "utf8"),
      }),
    ).resolves.toMatchObject({ sizeBytes: 6 });
  });

  it("resumes an interrupted upload, deduplicates exact bytes, and supports empty objects", async () => {
    const bytes = Buffer.from("durable working tree\n", "utf8");
    objectStore.failNextPut = true;
    await expect(
      blobs.put({ ...engineAuthority(), bytes }),
    ).rejects.toMatchObject({
      code: "object_store_unavailable",
    });

    const pending = await pool.query(
      `SELECT id, object_key, nonce, state FROM workspace_blobs`,
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].state).toBe("pending_upload");

    const uploaded = await blobs.put({ ...engineAuthority(), bytes });
    expect(uploaded.reused).toBe(false);
    expect(uploaded.id).toBe(pending.rows[0].id);
    await expect(
      blobs.getSystem({
        blobId: uploaded.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toEqual(bytes);

    await expect(
      blobs.put({ ...engineAuthority(), bytes }),
    ).resolves.toMatchObject({
      id: uploaded.id,
      reused: true,
    });
    const empty = await blobs.put({
      ...engineAuthority(),
      bytes: Buffer.alloc(0),
    });
    await expect(
      blobs.getSystem({
        blobId: empty.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toEqual(Buffer.alloc(0));
  });

  it("does not let one engine read an unreferenced tenant blob", async () => {
    const bytes = Buffer.from("not attached to this workspace yet\n", "utf8");
    const uploaded = await blobs.put({ ...engineAuthority(), bytes });

    await expect(
      blobs.getForEngine({
        ...engineAuthority(),
        blobId: uploaded.id,
      }),
    ).rejects.toMatchObject({ code: "object_unavailable" });

    await pool.query(
      `INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       ) VALUES ($1, $2, $3, 'transcript_artifact', 'read-boundary-test')`,
      [uploaded.id, fixture.organizationId, fixture.workspaceId],
    );
    await expect(
      blobs.getForEngine({
        ...engineAuthority(),
        blobId: uploaded.id,
      }),
    ).resolves.toEqual(bytes);
  });

  it("rejects checkpoint idempotency reuse with different durable inputs", async () => {
    const file = Buffer.from("const durable = true;\n", "utf8");
    const manifest = Buffer.from('{"version":1}', "utf8");
    const fileBlob = await blobs.put({ ...engineAuthority(), bytes: file });
    const manifestBlob = await blobs.put({
      ...engineAuthority(),
      bytes: manifest,
    });
    const appended = await content.append({
      ...engineAuthority(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "src/durable.ts",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    const idempotencyKey = `checkpoint-${randomUUID()}`;
    const checkpoint = {
      ...engineAuthority(),
      idempotencyKey,
      contentRevision: appended.revision,
      reason: "manual" as const,
      manifestBlobId: manifestBlob.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256").update(manifest).digest("hex"),
    };
    const first = await content.commitCheckpoint(checkpoint);
    await expect(content.commitCheckpoint(checkpoint)).resolves.toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      content.commitCheckpoint({
        ...checkpoint,
        inclusionPolicy: { ignored: "included" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workspace_checkpoints`,
        )
      ).rows[0].count,
    ).toBe(1);

    await expect(
      content.read({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        accountUserId: fixture.userId,
        afterRevision: 0,
      }),
    ).resolves.toMatchObject({
      currentRevision: 1,
      durableRevision: 1,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      events: [
        {
          revision: 1,
          sequence: 1,
          path: "src/durable.ts",
          operation: "upsert",
          blobId: fileBlob.id,
        },
      ],
      checkpoint: {
        id: first.checkpointId,
        contentRevision: 1,
        manifestBlobId: manifestBlob.id,
      },
      hasMore: false,
    });
    await expect(
      content.readRecoveryCheckpointSystem({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toMatchObject({
      checkpointId: first.checkpointId,
      contentRevision: 1,
      generation: 1,
      manifestBlobId: manifestBlob.id,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
    });
  });

  it("fences later mutations when a requested final checkpoint becomes durable and permits its exact replay", async () => {
    const file = Buffer.from("final durable state\n", "utf8");
    const manifest = Buffer.from(
      '{"audience":"zeros-workspace-checkpoint-v1"}',
      "utf8",
    );
    const fileBlob = await blobs.put({ ...engineAuthority(), bytes: file });
    const manifestBlob = await blobs.put({
      ...engineAuthority(),
      bytes: manifest,
    });
    const appended = await content.append({
      ...engineAuthority(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "src/final.ts",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    const intentId = randomUUID();
    const request = await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, state
         ) VALUES ($1, $2, 1, $3, $4, 'stop', $5, $6, 'queued')`,
        [
          intentId,
          fixture.workspaceId,
          fixture.organizationId,
          fixture.userId,
          `stop-${randomUUID()}`,
          createHash("sha256").update("stop").digest(),
        ],
      );
      return enqueueWorkspaceCheckpointRequest(tx, {
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        requestedBy: fixture.userId,
        lifecycleIntentId: intentId,
        reason: "before_stop",
        idempotencyKey: `lifecycle.${intentId}`,
      });
    });
    await expect(
      withSystemTx(pool, (tx) =>
        deliverWorkspaceCheckpointRequest(tx, {
          workspaceId: fixture.workspaceId,
          organizationId: fixture.organizationId,
          generation: 1,
        }),
      ),
    ).resolves.toMatchObject({ id: request.id, reason: "before_stop" });

    const checkpoint = {
      ...engineAuthority(),
      requestId: request.id,
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "before_stop" as const,
      manifestBlobId: manifestBlob.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256").update(manifest).digest("hex"),
    };
    const committed = await content.commitCheckpoint(checkpoint);
    await expect(content.commitCheckpoint(checkpoint)).resolves.toEqual({
      ...committed,
      replayed: true,
    });
    await expect(
      content.append({
        ...engineAuthority(),
        expectedRevision: appended.revision,
        idempotencyKey: `content-${randomUUID()}`,
        gitBaseCommit: "a".repeat(40),
        gitHeadRef: "refs/heads/main",
        mutations: [{ operation: "delete", path: "src/final.ts" }],
      }),
    ).rejects.toMatchObject({ code: "engine_authority_rejected" });

    const state = await pool.query(
      `SELECT request.state AS request_state, request.checkpoint_id,
              workspace.status, workspace.desired_state, engine.state AS engine_state
       FROM workspace_checkpoint_requests request
       JOIN cloud_workspaces workspace ON workspace.id = request.workspace_id
       JOIN cloud_workspace_engine_instances engine
         ON engine.workspace_id = request.workspace_id
        AND engine.generation = request.generation
       WHERE request.id = $1`,
      [request.id],
    );
    expect(state.rows).toEqual([
      expect.objectContaining({
        request_state: "succeeded",
        checkpoint_id: committed.checkpointId,
        status: "ready",
        desired_state: "running",
        engine_state: "ready",
      }),
    ]);

    let stopCount = 0;
    let resource: CloudProviderResource | null = {
      resourceId: `sandbox-${fixture.workspaceId}`,
      workspaceId: fixture.workspaceId,
      generation: 1,
      state: "running",
      target: "test",
      metadata: {},
    };
    const provider: CloudWorkspaceProvider = {
      name: "daytona",
      async find() {
        return resource ? [resource] : [];
      },
      async create() {
        throw new Error("unexpected create");
      },
      async inspect() {
        return resource;
      },
      async start() {
        throw new Error("unexpected start");
      },
      async stop() {
        stopCount += 1;
        resource = { ...resource!, state: "stopped" };
        return resource;
      },
      async archive() {
        throw new Error("unexpected archive");
      },
      async delete() {
        throw new Error("unexpected delete");
      },
      async *listManaged() {
        if (resource) yield resource;
      },
    };
    const reconciler = new CloudWorkspaceReconciler({
      pool,
      provider,
      intervalMs: 1_000,
    });
    await expect(reconciler.runOnce()).resolves.toBe(true);
    expect(stopCount).toBe(1);
    const stopped = await pool.query(
      `SELECT workspace.status, workspace.desired_state,
              workspace.authority_epoch, intent.state AS intent_state,
              engine.state AS engine_state
       FROM cloud_workspaces workspace
       JOIN cloud_workspace_lifecycle_intents intent
         ON intent.workspace_id = workspace.id
       JOIN cloud_workspace_engine_instances engine
         ON engine.workspace_id = workspace.id
       WHERE workspace.id = $1`,
      [fixture.workspaceId],
    );
    expect(stopped.rows).toEqual([
      {
        status: "stopped",
        desired_state: "stopped",
        authority_epoch: "2",
        intent_state: "succeeded",
        engine_state: "revoked",
      },
    ]);
  });

  it("maps malformed blob identities to a bounded content error", async () => {
    await expect(
      content.append({
        ...engineAuthority(),
        expectedRevision: 0,
        idempotencyKey: `content-${randomUUID()}`,
        gitBaseCommit: null,
        gitHeadRef: null,
        mutations: [
          {
            operation: "upsert",
            path: "src/invalid.ts",
            entryType: "file",
            mode: 33188,
            blobId: "not-a-uuid",
            contentSha256: "0".repeat(64),
            sizeBytes: 0,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkspaceContentError);
  });

  it("rejects a cross-revision file/directory path collision", async () => {
    const bytes = Buffer.from("collision", "utf8");
    const blob = await blobs.put({ ...engineAuthority(), bytes });
    const descriptor = {
      operation: "upsert" as const,
      entryType: "file" as const,
      mode: 33188 as const,
      blobId: blob.id,
      contentSha256: blob.plaintextSha256,
      sizeBytes: bytes.length,
    };
    await content.append({
      ...engineAuthority(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [{ ...descriptor, path: "src" }],
    });
    await expect(
      content.append({
        ...engineAuthority(),
        expectedRevision: 1,
        idempotencyKey: `content-${randomUUID()}`,
        gitBaseCommit: "a".repeat(40),
        gitHeadRef: "refs/heads/main",
        mutations: [{ ...descriptor, path: "src/index.ts" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an organization blob without an upload or reference bound to this workspace", async () => {
    const bytes = Buffer.from("belongs to another upload scope");
    const blob = await blobs.put({ ...engineAuthority(), bytes });
    await withSystemTx(pool, tx => tx.query(`DELETE FROM workspace_blob_storage_reservations WHERE workspace_id=$1 AND blob_id=$2`, [fixture.workspaceId, blob.id]));
    await expect(content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ operation: "upsert", path: "foreign.txt", entryType: "file", mode: 33188,
        blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: bytes.length }],
    })).rejects.toMatchObject({ code: "blob_unavailable" });
    const appended = await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "a".repeat(40), gitHeadRef: null, mutations: [] });
    await expect(content.commitCheckpoint({ ...engineAuthority(), idempotencyKey: randomUUID(), contentRevision: appended.revision,
      reason: "manual", manifestBlobId: blob.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 0,
      totalBytes: 0, integritySha256: blob.plaintextSha256,
    })).rejects.toMatchObject({ code: "blob_unavailable" });
  });

  it("selects a newer durable checkpoint after a previous recovery in the same generation", async () => {
    const manifest = await blobs.put({ ...engineAuthority(), bytes: Buffer.from('{"recovery":true}') });
    const appended = await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: randomUUID(),
      gitBaseCommit: "a".repeat(40), gitHeadRef: null, mutations: [] });
    const input = { ...engineAuthority(), contentRevision: appended.revision, reason: "manual" as const,
      manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 0, totalBytes: 0, integritySha256: manifest.plaintextSha256 };
    const first = await content.commitCheckpoint({ ...input, idempotencyKey: randomUUID() });
    await pool.query(`UPDATE cloud_workspace_generations SET recovery_checkpoint_id=$2 WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId, first.checkpointId]);
    const updated = await content.append({ ...engineAuthority(), expectedRevision: appended.revision, idempotencyKey: randomUUID(),
      gitBaseCommit: "b".repeat(40), gitHeadRef: null, mutations: [] });
    const second = await content.commitCheckpoint({ ...input, contentRevision: updated.revision, idempotencyKey: randomUUID() });
    const setup = (await pool.query(`SELECT id, execution_fence FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId])).rows[0];
    const grant = await withSystemTx(pool, tx => issueWorkspaceSetupRecoveryGrant(tx, {
      workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      setupRunId: setup.id, executionFence: Number(setup.execution_fence),
      endpoint: "https://control.example.test/internal/v1/cloud-workspaces/setup/recovery", ttlSeconds: 600,
    }));
    expect(grant?.checkpointId).toBe(second.checkpointId);
    expect((await pool.query(`SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId])).rows[0].recovery_checkpoint_id).toBe(second.checkpointId);
  });

  it.each(["revoked", "expired", "fenced", "stopped"])("does not release recovery plaintext after a %s capability changes during storage I/O", async change => {
    const bytes = Buffer.from("private recovery bytes");
    const blob = await blobs.put({ ...engineAuthority(), bytes });
    const appended = await content.append({ ...engineAuthority(), expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: null, gitHeadRef: null,
      mutations: [{ operation: "upsert", path: "recovered.txt", entryType: "file", mode: 33188, blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: bytes.length }] });
    await content.commitCheckpoint({ ...engineAuthority(), idempotencyKey: randomUUID(), contentRevision: appended.revision, reason: "manual", manifestBlobId: blob.id,
      artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: bytes.length, integritySha256: blob.plaintextSha256 });
    const setup = (await pool.query("SELECT id,execution_fence FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [fixture.workspaceId]);
    const grant = await withSystemTx(pool, tx => issueWorkspaceSetupRecoveryGrant(tx, { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      setupRunId: setup.id, executionFence: Number(setup.execution_fence), endpoint: "https://control.example.test/internal/v1/cloud-workspaces/setup/recovery", ttlSeconds: 600 }));
    const original = blobs.getSystem.bind(blobs);
    let entered!: () => void, release!: () => void, fetched!: Buffer;
    const blocked = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(blobs, "getSystem").mockImplementation(async input => { fetched = await original(input); entered(); await barrier; return fetched; });
    const recovery = new DatabaseCloudWorkspaceSetupRecoveryService(pool, blobs);
    const pending = recovery.blob({ token: grant!.token, blobId: blob.id });
    void pending.catch(() => {});
    try {
      await blocked;
      if (change === "revoked") await pool.query("UPDATE workspace_setup_recovery_grants SET revoked_at=now() WHERE setup_run_id=$1", [setup.id]);
      if (change === "expired") await pool.query("UPDATE workspace_setup_recovery_grants SET expires_at=created_at+interval '1 microsecond' WHERE setup_run_id=$1", [setup.id]);
      if (change === "fenced") {
        await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
        await pool.query("UPDATE cloud_workspace_setup_runs SET execution_fence=execution_fence+1 WHERE id=$1", [setup.id]);
      }
      if (change === "stopped") await pool.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    } finally { release(); }
    await expect(pending).rejects.toMatchObject({ code: "recovery_capability_rejected" });
    expect(fetched.every(byte => byte === 0)).toBe(true);
    read.mockRestore();
  });

  it.each([false, true])("binds fresh setup recovery to one checkpoint, including chunked artifacts (%s)", async (chunked) => {
    const file = Buffer.from("recover me\n", "utf8");
    const manifest = Buffer.from('{"version":1,"kind":"checkpoint"}', "utf8");
    const unrelated = await blobs.put({
      ...engineAuthority(),
      bytes: Buffer.from("not in checkpoint", "utf8"),
    });
    const fileBlob = await blobs.put({ ...engineAuthority(), bytes: file });
    const manifestBlob = await blobs.put({
      ...engineAuthority(),
      bytes: manifest,
    });
    const artifactBytes = Buffer.from("native recovery chunk");
    const artifact = chunked ? await blobs.put({ ...engineAuthority(), bytes: artifactBytes }) : null;
    const appended = await content.append({
      ...engineAuthority(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "src/recovered.ts",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    const checkpoint = await content.commitCheckpoint({
      ...engineAuthority(),
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "manual",
      manifestBlobId: manifestBlob.id,
      artifactBlobId: null,
      ...(artifact ? { artifactBlobIds: [artifact.id] } : {}),
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256").update(manifest).digest("hex"),
    });
    const setup = await pool.query<{
      id: string;
      execution_fence: string | number;
    }>(
      `SELECT id, execution_fence FROM cloud_workspace_setup_runs
       WHERE workspace_id = $1 AND generation = 1`,
      [fixture.workspaceId],
    );
    await pool.query(
      `UPDATE cloud_workspaces SET status = 'setting_up' WHERE id = $1`,
      [fixture.workspaceId],
    );
    const grant = await withSystemTx(pool, (tx) =>
      issueWorkspaceSetupRecoveryGrant(tx, {
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        setupRunId: setup.rows[0]!.id,
        executionFence: Number(setup.rows[0]!.execution_fence),
        endpoint:
          "https://control.example.test/internal/v1/cloud-workspaces/setup/recovery",
        ttlSeconds: 600,
      }),
    );
    expect(grant).toMatchObject({ checkpointId: checkpoint.checkpointId });
    const recovery = new DatabaseCloudWorkspaceSetupRecoveryService(
      pool,
      blobs,
    );
    if (artifact) {
      await expect(recovery.manifestPage({ token: grant!.token, afterPath: null }))
        .rejects.toMatchObject({ code: "recovery_format_unsupported" });
    }
    await expect(
      recovery.manifestPage({
        token: grant!.token,
        afterPath: null,
        ...(chunked ? { version: 2 as const } : {}),
      }),
    ).resolves.toMatchObject({
      checkpointId: checkpoint.checkpointId,
      contentRevision: 1,
      fileCount: 1,
      totalBytes: file.length,
      entries: [
        {
          operation: "upsert",
          path: "src/recovered.ts",
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
        },
      ],
      nextAfterPath: null,
      ...(artifact ? {
        version: 2,
        manifest: { blobId: manifestBlob.id, contentSha256: manifestBlob.plaintextSha256, sizeBytes: manifest.length },
        artifacts: [{ blobId: artifact.id, contentSha256: artifact.plaintextSha256, sizeBytes: artifactBytes.length }],
      } : {}),
    });
    const usesBefore = Number((await pool.query("SELECT use_count FROM workspace_setup_recovery_grants WHERE setup_run_id=$1 AND revoked_at IS NULL", [setup.rows[0]!.id])).rows[0].use_count);
    await expect(
      recovery.blob({ token: grant!.token, blobId: fileBlob.id }),
    ).resolves.toEqual(file);
    expect(Number((await pool.query("SELECT use_count FROM workspace_setup_recovery_grants WHERE setup_run_id=$1 AND revoked_at IS NULL", [setup.rows[0]!.id])).rows[0].use_count)).toBe(usesBefore + 1);
    if (artifact) {
      await expect(recovery.blob({ token: grant!.token, blobId: artifact.id })).resolves.toEqual(artifactBytes);
      const references = await withSystemTx(pool, tx => tx.query(`SELECT reference_count FROM workspace_blobs WHERE id=$1`, [artifact.id]));
      expect(Number(references.rows[0].reference_count)).toBe(1);
    }
    await expect(
      recovery.blob({ token: grant!.token, blobId: unrelated.id }),
    ).rejects.toMatchObject({ code: "recovery_capability_rejected" });
  });
});
