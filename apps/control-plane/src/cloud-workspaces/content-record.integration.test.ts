import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
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

  it("binds fresh setup recovery to one checkpoint and serves only its immutable entries", async () => {
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
    await expect(
      recovery.manifestPage({
        token: grant!.token,
        afterPath: null,
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
    });
    await expect(
      recovery.blob({ token: grant!.token, blobId: fileBlob.id }),
    ).resolves.toEqual(file);
    await expect(
      recovery.blob({ token: grant!.token, blobId: unrelated.id }),
    ).rejects.toMatchObject({ code: "recovery_capability_rejected" });
  });
});
