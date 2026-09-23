import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {assertDatabaseLockOrder} from "./lock-order-test-utils.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "./durable-record.js";
import {
  CloudWorkspaceForkWorker,
  DatabaseCloudWorkspaceForkService,
} from "./forks.js";
import {
  DatabaseCloudWorkspaceBlobService,
  MemoryCloudWorkspaceObjectStore,
} from "./object-store.js";
import {
  cloudWorkspaceDeviceProofMessage,
  DatabaseCloudWorkspaceReplicaService,
  type CloudWorkspaceDeviceProof,
} from "./replicas.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

type DeviceSigner = {
  privateKey: KeyObject;
  publicKey: string;
  deviceId: string;
  keyVersion: number;
};

class PausedUploadObjectStore extends MemoryCloudWorkspaceObjectStore {
  private nextUpload:
    | {
        started: (objectKey: string) => void;
        released: Promise<void>;
      }
    | undefined;

  pauseNextUpload(): {
    started: Promise<string>;
    resume: () => void;
  } {
    if (this.nextUpload) throw new Error("an upload is already paused");
    let started!: (objectKey: string) => void;
    let resume!: () => void;
    const gate = {
      started: new Promise<string>((resolve) => {
        started = resolve;
      }),
      resume: () => resume(),
    };
    this.nextUpload = {
      started,
      released: new Promise<void>((resolve) => {
        resume = resolve;
      }),
    };
    return gate;
  }

  override async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    const paused = this.nextUpload;
    if (paused) {
      this.nextUpload = undefined;
      paused.started(key);
      await paused.released;
    }
    return super.putIfAbsent(key, bytes);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function localForkSnapshotSha256(input: {
  gitBaseCommit: string;
  gitHeadRef: string | null;
  entries: Array<{
    operation: "upsert" | "delete";
    path: string;
    entryType?: "file" | "symlink";
    mode?: number;
    contentSha256?: string;
    sizeBytes?: number;
  }>;
  records: Array<{
    ordinal: number;
    entityKind: string;
    entityId: string;
    occurredAt: string;
    document: Record<string, unknown>;
  }>;
}): string {
  const upserts = input.entries
    .filter((entry) => entry.operation === "upsert")
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    )
    .map((entry) => ({
      path: entry.path,
      entryType: entry.entryType,
      mode: entry.mode,
      contentSha256: entry.contentSha256,
      sizeBytes: entry.sizeBytes,
    }));
  const deletions = input.entries
    .filter((entry) => entry.operation === "delete")
    .map((entry) => entry.path)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
  const fileFingerprint = createHash("sha256")
    .update(input.gitBaseCommit, "utf8")
    .update("\0", "utf8")
    .update(input.gitHeadRef ?? "", "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(upserts), "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(deletions), "utf8")
    .digest("hex");
  const snapshot = createHash("sha256")
    .update("zeros-local-to-cloud-snapshot-v1\0", "utf8")
    .update(fileFingerprint, "utf8");
  for (const record of input.records.sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    snapshot
      .update("\0", "utf8")
      .update(record.entityKind, "utf8")
      .update("\0", "utf8")
      .update(record.entityId, "utf8")
      .update("\0", "utf8")
      .update(record.occurredAt, "utf8")
      .update("\0", "utf8")
      .update(canonicalJson(record.document), "utf8");
  }
  return snapshot.digest("hex");
}

d("cloud workspace immutable forks", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let blobs: DatabaseCloudWorkspaceBlobService;
  let forks: DatabaseCloudWorkspaceForkService;
  let content: DatabaseCloudWorkspaceContentService;
  let records: DatabaseCloudWorkspaceDurableRecordService;
  let replicas: DatabaseCloudWorkspaceReplicaService;
  let objectStore: PausedUploadObjectStore;

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
    objectStore = new PausedUploadObjectStore();
    blobs = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    forks = new DatabaseCloudWorkspaceForkService(pool, blobs, false);
    content = new DatabaseCloudWorkspaceContentService({
      pool,
      workosEnabled: false,
    });
    records = new DatabaseCloudWorkspaceDurableRecordService({
      pool,
      workosEnabled: false,
    });
    replicas = new DatabaseCloudWorkspaceReplicaService(pool, blobs, false);
  });

  it("locks organization before workspace when requesting a local export", async () => {
    await assertDatabaseLockOrder(pool, {
      parentSql: 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE', parentId: fixture.organizationId,
      childSql: 'SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE', childId: fixture.workspaceId,
      parentQuery: /FROM organizations[\s\S]*FOR (?:UPDATE|SHARE)/,
      action: controlled => new DatabaseCloudWorkspaceForkService(controlled, blobs, false).requestCloudToLocal({
        organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, accountUserId: fixture.userId,
        targetLocalWorkspaceId: randomUUID(), idempotencyKey: randomUUID(), includeChats: false,
      }),
    });
  });

  it("skips a busy workspace before locking an expired fork", async () => {
    const source = await seedLocalToCloudFork();
    await pool.query("UPDATE cloud_workspaces SET status='requested' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE workspace_fork_intents SET created_at=now()-interval '25 hours',deadline_at=now()-interval '1 hour' WHERE id=$1", [source.forkIntentId]);
    await assertDatabaseLockOrder(pool, {
      parentSql: 'SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE', parentId: fixture.workspaceId,
      childSql: 'SELECT id FROM workspace_fork_intents WHERE id=$1 FOR UPDATE', childId: source.forkIntentId,
      parentQuery: /(?:FROM|UPDATE) cloud_workspaces/,
      action: controlled => new CloudWorkspaceForkWorker(controlled, blobs, {workerId: 'expiry-lock-order-test'}).runOnce(),
    });
  });

  it("locks the coordinator upload scope before its storage advisory lock", async () => {
    await assertDatabaseLockOrder(pool, {
      parentSql: 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE', parentId: fixture.organizationId,
      childSql: "SELECT pg_advisory_xact_lock(hashtextextended('workspace-object-storage:' || $1::text,0))", childId: fixture.organizationId,
      parentQuery: /FROM organizations|INSERT INTO workspace_blobs/,
      action: controlled => new DatabaseCloudWorkspaceBlobService({pool: controlled, objectStore,
        encryptionKeyV1: randomBytes(32).toString('base64url'), workosEnabled: false}).putCoordinator({
        workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, bytes: Buffer.from('coordinator upload'),
      }),
    });
  });

  it("locks the engine organization before workspace-backed content publication", async () => {
    const bytes = Buffer.from('engine lock order');
    const blob = await blobs.put({...engine(), bytes});
    await assertDatabaseLockOrder(pool, {
      parentSql: 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE', parentId: fixture.organizationId,
      childSql: 'SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE', childId: fixture.workspaceId,
      // The engine authority function takes the organization lock first.
      parentQuery: /cloud_workspace_engine_authority_current|FROM organizations|INSERT INTO workspace_content_heads/,
      action: controlled => new DatabaseCloudWorkspaceContentService({pool: controlled, workosEnabled: false}).append({
        ...engine(), expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: null, gitHeadRef: null,
        mutations: [{operation: 'upsert', path: 'scope.txt', entryType: 'file', mode: 33188,
          blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: bytes.length}],
      }),
    });
  });

  it("takes the storage advisory lock before checkpoint blob row locks", async () => {
    const bytes = Buffer.from('deduplicated checkpoint content');
    const blob = await blobs.put({...engine(), bytes});
    await assertDatabaseLockOrder(pool, {
      parentSql: "SELECT pg_advisory_xact_lock(hashtextextended('workspace-object-storage:' || $1::text,0))", parentId: fixture.organizationId,
      childSql: 'SELECT id FROM workspace_blobs WHERE id=$1 FOR NO KEY UPDATE', childId: blob.id,
      parentQuery: /pg_advisory_xact_lock|INSERT INTO workspace_blob_references/,
      action: controlled => new DatabaseCloudWorkspaceContentService({pool: controlled, workosEnabled: false}).append({
        ...engine(), expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: null, gitHeadRef: null,
        mutations: [{operation: 'upsert', path: 'storage.txt', entryType: 'file', mode: 33188,
          blobId: blob.id, contentSha256: blob.plaintextSha256, sizeBytes: bytes.length}],
      }),
    });
  });

  const engine = () => ({
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    generation: 1,
    engineInstanceId: fixture.engineInstanceId,
    heartbeatToken: fixture.heartbeatToken,
  });

  const copiedChatId = (workspaceId: string, sourceChatId: string) =>
    `chat_f_${createHash("sha256")
      .update("zeros-workspace-fork-chat-v1\0", "utf8")
      .update(workspaceId.toLowerCase(), "utf8")
      .update("\0", "utf8")
      .update(sourceChatId, "utf8")
      .digest("hex")
      .slice(0, 40)}`;

  async function registerDevice(): Promise<DeviceSigner> {
    const pair = generateKeyPairSync("ed25519");
    const jwk = pair.publicKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string")
      throw new Error("missing Ed25519 public key");
    const registered = await replicas.registerDevice({
      accountUserId: fixture.userId,
      label: "Fork export test Mac",
      platform: "macos",
      publicKey: jwk.x,
      idempotencyKey: `device-${randomUUID()}`,
    });
    return {
      privateKey: pair.privateKey,
      publicKey: jwk.x,
      deviceId: registered.device.id,
      keyVersion: registered.device.keyVersion,
    };
  }

  function proof(
    signer: DeviceSigner,
    action: string,
    payload: unknown,
  ): CloudWorkspaceDeviceProof {
    const timestampMs = Date.now();
    const nonce = randomBytes(24).toString("base64url");
    const signature = sign(
      null,
      cloudWorkspaceDeviceProofMessage({
        accountUserId: fixture.userId,
        deviceId: signer.deviceId,
        keyVersion: signer.keyVersion,
        action,
        timestampMs,
        nonce,
        payload,
      }),
      signer.privateKey,
    ).toString("base64url");
    return {
      deviceId: signer.deviceId,
      keyVersion: signer.keyVersion,
      timestampMs,
      nonce,
      signature,
    };
  }

  async function seedLocalToCloudFork(
    sourceSnapshotSha256 = createHash("sha256")
      .update("local-snapshot")
      .digest("hex"),
  ) {
    const forkIntentId = randomUUID();
    const sourceLocalWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_fork_intents (
         id, org_id, requested_by, operation, source_local_workspace_id,
         target_cloud_workspace_id, source_revision, include_chats,
         include_settings, idempotency_key, request_sha256,
         source_snapshot_sha256, source_git_base_commit, source_git_head_ref
       ) VALUES ($1, $2, $3, 'local_to_cloud', $4, $5, 17, true, true,
                 $6, $7, $8, $9, 'refs/heads/zeros-copy')`,
      [
        forkIntentId,
        fixture.organizationId,
        fixture.userId,
        sourceLocalWorkspaceId,
        fixture.workspaceId,
        `fork-${randomUUID()}`,
        createHash("sha256").update("local-copy").digest(),
        Buffer.from(sourceSnapshotSha256, "hex"),
        "c".repeat(40),
      ],
    );
    return { forkIntentId, sourceLocalWorkspaceId };
  }

  it("seals a local snapshot into a distinct cloud identity and replays exactly", async () => {
    const bytes = Buffer.from("export const copied = true;\n", "utf8");
    const sourceChatId = "chat-local-1";
    const targetChatId = copiedChatId(fixture.workspaceId, sourceChatId);
    const occurredAt = new Date().toISOString();
    const document = {
      version: 1,
      chat: {
        id: targetChatId,
        folder: ".",
        agentId: "codex",
        agentName: "Codex",
        model: null,
        effort: "medium",
        permissionMode: "default",
        lastModeId: null,
        prePlanModeId: null,
        fast: false,
        additionalDirectories: [],
        title: "Copied chat",
        createdAt: 1,
        updatedAt: 1,
        sessionId: null,
        providerBinding: null,
        providerMetadata: null,
        pinned: false,
        archived: false,
        sourceChatId,
        kind: "code",
      },
    };
    const source = await seedLocalToCloudFork(
      localForkSnapshotSha256({
        gitBaseCommit: "c".repeat(40),
        gitHeadRef: "refs/heads/zeros-copy",
        entries: [
          {
            operation: "upsert",
            path: "src/copied.ts",
            entryType: "file",
            mode: 33188,
            contentSha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
          },
          { operation: "delete", path: "src/removed.ts" },
        ],
        records: [
          {
            ordinal: 0,
            entityKind: "chat",
            entityId: targetChatId,
            occurredAt,
            document,
          },
        ],
      }),
    );
    expect(source.sourceLocalWorkspaceId).not.toBe(fixture.workspaceId);
    const blob = await forks.uploadImportBlob({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      bytes,
    });
    await expect(
      forks.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: [
          {
            operation: "upsert",
            path: "src/copied.ts",
            entryType: "file",
            mode: 33188,
            blobId: blob.id,
            contentSha256: blob.plaintextSha256,
            sizeBytes: bytes.length,
          },
          { operation: "delete", path: "src/removed.ts" },
        ],
      }),
    ).resolves.toEqual({ accepted: 2 });
    await expect(
      forks.stageImportRecords({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        records: [
          {
            ordinal: 0,
            entityKind: "chat",
            entityId: targetChatId,
            operation: "upsert",
            schemaVersion: 1,
            document,
            occurredAt,
          },
        ],
      }),
    ).resolves.toEqual({ accepted: 1 });

    const idempotencyKey = `finalize-${randomUUID()}`;
    const finalized = await forks.finalizeLocalImport({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      idempotencyKey,
    });
    expect(finalized.replayed).toBe(false);
    await expect(
      forks.finalizeLocalImport({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        idempotencyKey,
      }),
    ).resolves.toEqual({ ...finalized, replayed: true });

    const state = await pool.query(
      `SELECT fork.state, fork.source_local_workspace_id,
              fork.target_cloud_workspace_id,
              generation.recovery_checkpoint_id,
              content.current_revision AS content_revision,
              content.durable_revision,
              records.current_revision AS record_revision,
              entry.normalized_path, entity.entity_id
       FROM workspace_fork_intents fork
       JOIN cloud_workspace_generations generation
         ON generation.workspace_id = fork.target_cloud_workspace_id
        AND generation.generation = 1
       JOIN workspace_content_heads content
         ON content.workspace_id = fork.target_cloud_workspace_id
       JOIN workspace_record_heads records
         ON records.workspace_id = fork.target_cloud_workspace_id
       JOIN workspace_file_entries entry
         ON entry.workspace_id = fork.target_cloud_workspace_id
       JOIN workspace_record_entities entity
         ON entity.workspace_id = fork.target_cloud_workspace_id
       WHERE fork.id = $1`,
      [source.forkIntentId],
    );
    expect(state.rows[0]).toMatchObject({
      state: "succeeded",
      source_local_workspace_id: source.sourceLocalWorkspaceId,
      target_cloud_workspace_id: fixture.workspaceId,
      recovery_checkpoint_id: finalized.checkpointId,
      content_revision: "1",
      durable_revision: "1",
      record_revision: "1",
      normalized_path: "src/copied.ts",
      entity_id: targetChatId,
    });
    const checkpointManifest = (
      await pool.query<{
        manifest_blob_id: string;
        integrity_sha256: Buffer;
      }>(
        `SELECT manifest_blob_id, integrity_sha256
         FROM workspace_checkpoints WHERE id = $1`,
        [finalized.checkpointId],
      )
    ).rows[0]!;
    const checkpointManifestBytes = await blobs.getSystem({
      blobId: checkpointManifest.manifest_blob_id,
      organizationId: fixture.organizationId,
    });
    expect(
      createHash("sha256").update(checkpointManifestBytes).digest(),
    ).toEqual(checkpointManifest.integrity_sha256);
    expect(JSON.parse(checkpointManifestBytes.toString("utf8"))).toEqual({
      version: 1,
      audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
      gitBaseCommit: "c".repeat(40),
      gitHeadRef: "refs/heads/zeros-copy",
      entries: [
        {
          path: "src/copied.ts",
          entryType: "file",
          mode: 33188,
          contentSha256: blob.plaintextSha256,
          sizeBytes: bytes.length,
        },
      ],
      deletions: ["src/removed.ts"],
    });
    await expect(
      pool.query(
        `SELECT checkpoint.file_count, checkpoint.total_bytes,
                entry.operation, entry.entry_type, entry.blob_id
           FROM workspace_checkpoints checkpoint
           JOIN workspace_checkpoint_entries entry
             ON entry.checkpoint_id = checkpoint.id
          WHERE checkpoint.id = $1 AND entry.normalized_path = 'src/removed.ts'`,
        [finalized.checkpointId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          file_count: 1,
          total_bytes: String(bytes.length),
          operation: "delete",
          entry_type: null,
          blob_id: null,
        },
      ],
    });
    await expect(
      forks.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: [
          {
            operation: "upsert",
            path: "src/late.ts",
            entryType: "file",
            mode: 33188,
            blobId: blob.id,
            contentSha256: blob.plaintextSha256,
            sizeBytes: bytes.length,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("fails closed and releases staged objects when the uploaded snapshot does not match the create request", async () => {
    const source = await seedLocalToCloudFork("f".repeat(64));
    const bytes = Buffer.from("snapshot mismatch\n", "utf8");
    const blob = await forks.uploadImportBlob({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      bytes,
    });
    await forks.stageImportEntries({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      entries: [
        {
          operation: "upsert",
          path: "mismatch.txt",
          entryType: "file",
          mode: 33188,
          blobId: blob.id,
          contentSha256: blob.plaintextSha256,
          sizeBytes: bytes.length,
        },
      ],
    });

    await expect(
      forks.finalizeLocalImport({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        idempotencyKey: `finalize-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "import_conflict" });

    const state = await pool.query(
      `SELECT fork.state, fork.error_code, blob.reference_count,
              (SELECT count(*)::integer FROM workspace_fork_import_entries
               WHERE fork_intent_id = fork.id) AS staged_entries
       FROM workspace_fork_intents fork
       JOIN workspace_blobs blob ON blob.id = $2
       WHERE fork.id = $1`,
      [source.forkIntentId, blob.id],
    );
    expect(state.rows[0]).toEqual({
      state: "failed",
      error_code: "fork_snapshot_mismatch",
      reference_count: "0",
      staged_entries: 0,
    });
  });

  it("rejects excluded and cross-batch file/directory paths during local import", async () => {
    const source = await seedLocalToCloudFork();
    const bytes = Buffer.from("unsafe projection", "utf8");
    const blob = await forks.uploadImportBlob({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      bytes,
    });
    const entry = (entryPath: string) => ({
      operation: "upsert" as const,
      path: entryPath,
      entryType: "file" as const,
      mode: 33188 as const,
      blobId: blob.id,
      contentSha256: blob.plaintextSha256,
      sizeBytes: bytes.length,
    });

    await expect(
      forks.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: [entry(".env")],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      forks.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: [entry("src")],
      }),
    ).resolves.toEqual({ accepted: 1 });
    await expect(
      forks.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: [entry("src/index.ts")],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("bounds uploaded objects, staged entries, and portable records before finalization", async () => {
    const source = await seedLocalToCloudFork();
    const uploadLimited = new DatabaseCloudWorkspaceForkService(
      pool,
      blobs,
      false,
      {
        maxImportEntries: 10,
        maxImportBytes: 5,
        maxImportRecords: 10,
        maxImportRecordBytes: 1_000_000,
      },
    );
    const first = await uploadLimited.uploadImportBlob({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      bytes: Buffer.from("1234"),
    });
    await expect(
      uploadLimited.uploadImportBlob({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        bytes: Buffer.from("5678"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const rejectedUpload = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM workspace_blobs
       WHERE org_id = $1 AND plaintext_sha256 = digest($2, 'sha256')`,
      [fixture.organizationId, Buffer.from("5678")],
    );
    expect(rejectedUpload.rows[0]!.count).toBe("0");

    const entryLimited = new DatabaseCloudWorkspaceForkService(
      pool,
      blobs,
      false,
      {
        maxImportEntries: 1,
        maxImportBytes: 1_000,
        maxImportRecords: 10,
        maxImportRecordBytes: 1_000_000,
      },
    );
    await expect(
      entryLimited.stageImportEntries({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        entries: ["a.txt", "b.txt"].map((entryPath) => ({
          operation: "upsert" as const,
          path: entryPath,
          entryType: "file" as const,
          mode: 33188 as const,
          blobId: first.id,
          contentSha256: first.plaintextSha256,
          sizeBytes: first.sizeBytes,
        })),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const recordLimited = new DatabaseCloudWorkspaceForkService(
      pool,
      blobs,
      false,
      {
        maxImportEntries: 10,
        maxImportBytes: 1_000,
        maxImportRecords: 1,
        maxImportRecordBytes: 1_000_000,
      },
    );
    const occurredAt = new Date().toISOString();
    const chatRecord = (sourceChatId: string, ordinal: number) => {
      const entityId = copiedChatId(fixture.workspaceId, sourceChatId);
      return {
        ordinal,
        entityKind: "chat" as const,
        entityId,
        operation: "upsert" as const,
        schemaVersion: 1,
        document: {
          version: 1,
          chat: {
            id: entityId,
            sourceChatId,
            folder: ".",
            additionalDirectories: [],
            sessionId: null,
            providerBinding: null,
            providerMetadata: null,
          },
        },
        occurredAt,
      };
    };
    await expect(
      recordLimited.stageImportRecords({
        forkIntentId: source.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        records: [chatRecord("source-a", 0), chatRecord("source-b", 1)],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const stored = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM workspace_blob_references
          WHERE reference_kind = 'fork_import' AND reference_id = $1) AS uploads,
         (SELECT count(*)::integer FROM workspace_fork_import_entries
          WHERE fork_intent_id = $2) AS entries,
         (SELECT count(*)::integer FROM workspace_fork_import_records
          WHERE fork_intent_id = $2) AS records`,
      [source.forkIntentId, source.forkIntentId],
    );
    expect(stored.rows[0]).toEqual({ uploads: 1, entries: 0, records: 0 });
  });

  it("serializes concurrent fork uploads before publishing aggregate over-quota objects", async () => {
    const source = await seedLocalToCloudFork();
    const uploadLimited = new DatabaseCloudWorkspaceForkService(
      pool,
      blobs,
      false,
      {
        maxImportEntries: 10,
        maxImportBytes: 5,
        maxImportRecords: 10,
        maxImportRecordBytes: 1_000_000,
      },
    );
    const attempts = await Promise.allSettled(
      [Buffer.from("race"), Buffer.from("lock")].map((bytes) =>
        uploadLimited.uploadImportBlob({
          forkIntentId: source.forkIntentId,
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          accountUserId: fixture.userId,
          bytes,
        }),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      attempts.find((attempt) => attempt.status === "rejected"),
    ).toMatchObject({ reason: { code: "invalid_input" } });

    const stored = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM workspace_blob_references
          WHERE reference_kind = 'fork_import' AND reference_id = $1) AS uploads,
         (SELECT count(*)::integer FROM workspace_blobs
          WHERE org_id = $2 AND (
            plaintext_sha256 = digest($3, 'sha256')
            OR plaintext_sha256 = digest($4, 'sha256')
          )) AS objects`,
      [
        source.forkIntentId,
        fixture.organizationId,
        Buffer.from("race"),
        Buffer.from("lock"),
      ],
    );
    expect(stored.rows[0]).toEqual({ uploads: 1, objects: 1 });
  });

  it("expires abandoned local imports and releases their quota and staging data", async () => {
    const source = await seedLocalToCloudFork();
    const bytes = Buffer.from("abandoned\n", "utf8");
    const blob = await forks.uploadImportBlob({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      bytes,
    });
    await forks.stageImportEntries({
      forkIntentId: source.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      entries: [
        {
          operation: "upsert",
          path: "abandoned.txt",
          entryType: "file",
          mode: 33188,
          blobId: blob.id,
          contentSha256: blob.plaintextSha256,
          sizeBytes: blob.sizeBytes,
        },
      ],
    });
    await pool.query(
      `UPDATE workspace_fork_intents
       SET created_at = now() - interval '25 hours',
           deadline_at = now() - interval '1 hour'
       WHERE id = $1`,
      [source.forkIntentId],
    );

    const worker = new CloudWorkspaceForkWorker(pool, blobs, {
      workerId: "fork-expiry-test",
    });
    expect(await worker.runOnce()).toBe(true);

    const state = await pool.query(
      `SELECT fork.state, fork.error_code, blob.reference_count,
              (SELECT count(*)::integer FROM workspace_fork_import_entries
               WHERE fork_intent_id = fork.id) AS staged_entries
       FROM workspace_fork_intents fork
       JOIN workspace_blobs blob ON blob.id = $2
       WHERE fork.id = $1`,
      [source.forkIntentId, blob.id],
    );
    expect(state.rows[0]).toEqual({
      state: "failed",
      error_code: "fork_deadline_exceeded",
      reference_count: "0",
      staged_entries: 0,
    });
  });

  it("rejects every local import step after current paid scope is revoked", async () => {
    const source = await seedLocalToCloudFork();
    const before = Number(
      (
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM workspace_blobs`,
        )
      ).rows[0]!.count,
    );
    await pool.query(
      `DELETE FROM team_members WHERE org_id = $1 AND user_id = $2`,
      [fixture.organizationId, fixture.userId],
    );

    await expect(
      forks.uploadImportBlob({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        forkIntentId: source.forkIntentId,
        accountUserId: fixture.userId,
        bytes: Buffer.from("must not be stored\n"),
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(
      forks.stageImportEntries({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        forkIntentId: source.forkIntentId,
        accountUserId: fixture.userId,
        entries: [{ operation: "delete", path: "removed.txt" }],
      }),
    ).rejects.toMatchObject({ code: "cloud_workspace_scope_not_found" });
    expect(
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM workspace_blobs`,
          )
        ).rows[0]!.count,
      ),
    ).toBe(before);
  });

  it("copies a durable cloud checkpoint to a new local identity without stopping the source", async () => {
    const file = Buffer.from("cloud remains authoritative\n", "utf8");
    const fileBlob = await blobs.put({ ...engine(), bytes: file });
    const appended = await content.append({
      ...engine(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "README.md",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    await records.append({
      ...engine(),
      expectedRevision: 0,
      idempotencyKey: `records-${randomUUID()}`,
      mutations: [
        {
          entityKind: "chat",
          entityId: "cloud-chat-1",
          operation: "upsert",
          schemaVersion: 1,
          document: { title: "Cloud chat" },
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    const targetLocalWorkspaceId = randomUUID();
    const requested = await forks.requestCloudToLocal({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      targetLocalWorkspaceId,
      accountUserId: fixture.userId,
      idempotencyKey: `copy-${randomUUID()}`,
      includeChats: true,
    });
    const delivery = await withSystemTx(pool, (tx) =>
      deliverWorkspaceCheckpointRequest(tx, {
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
      }),
    );
    expect(delivery?.id).toBe(requested.checkpointRequestId);
    const manifestBytes = Buffer.from('{"kind":"before-fork"}', "utf8");
    const manifestBlob = await blobs.put({ ...engine(), bytes: manifestBytes });
    const committed = await content.commitCheckpoint({
      ...engine(),
      requestId: requested.checkpointRequestId,
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "before_fork",
      manifestBlobId: manifestBlob.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
    const worker = new CloudWorkspaceForkWorker(pool, blobs, {
      workerId: "fork-export-test",
    });
    expect(await worker.runOnce()).toBe(true);

    const device = await registerDevice();
    const grantPayload = {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      forkIntentId: requested.forkIntentId,
    };
    const grant = await forks.issueExportGrant({
      forkIntentId: requested.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      proof: proof(device, "fork.export.grant", grantPayload),
    });
    expect(grant).toMatchObject({
      deviceId: device.deviceId,
      deviceKeyVersion: 1,
    });
    expect(grant.grantToken).toMatch(/^zwe_[A-Za-z0-9_-]{43}$/);

    const exported = await forks.readExportManifest({
      forkIntentId: requested.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      grantToken: grant.grantToken,
      afterPath: null,
      proof: proof(device, "fork.export.manifest.read", {
        ...grantPayload,
        afterPath: null,
        limit: 500,
      }),
    });
    expect(exported).toMatchObject({
      sourceCloudWorkspaceId: fixture.workspaceId,
      targetLocalWorkspaceId,
      checkpointId: committed.checkpointId,
      exportManifestBlobId: expect.any(String),
      exportManifestSha256: expect.any(String),
      manifestBlobId: manifestBlob.id,
      integritySha256: createHash("sha256").update(manifestBytes).digest("hex"),
      contentRevision: 1,
      recordRevision: 1,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      includeChats: true,
      entries: [
        {
          path: "README.md",
          operation: "upsert",
          blobId: fileBlob.id,
        },
      ],
    });
    await expect(
      forks.readExportBlob({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        blobId: fileBlob.id,
        proof: proof(device, "fork.export.blob.read", {
          ...grantPayload,
          blobId: fileBlob.id,
        }),
      }),
    ).resolves.toEqual(file);
    await expect(
      forks.readExportBlob({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        blobId: manifestBlob.id,
        proof: proof(device, "fork.export.blob.read", {
          ...grantPayload,
          blobId: manifestBlob.id,
        }),
      }),
    ).resolves.toEqual(manifestBytes);
    const exportManifestBytes = await forks.readExportBlob({
      forkIntentId: requested.forkIntentId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      grantToken: grant.grantToken,
      blobId: exported.exportManifestBlobId,
      proof: proof(device, "fork.export.blob.read", {
        ...grantPayload,
        blobId: exported.exportManifestBlobId,
      }),
    });
    expect(exportManifestBytes).toEqual(
      Buffer.from(
        canonicalJson({
          audience: "zeros-cloud-to-local-fork-v1",
          forkIntentId: requested.forkIntentId,
          sourceCloudWorkspaceId: fixture.workspaceId,
          targetLocalWorkspaceId,
          checkpointId: committed.checkpointId,
          contentRevision: 1,
          recordRevision: 1,
          includeChats: true,
          fileCount: 1,
          totalBytes: file.length,
        }),
        "utf8",
      ),
    );
    expect(exported.exportManifestSha256).toBe(
      createHash("sha256").update(exportManifestBytes).digest("hex"),
    );
    await expect(
      forks.readExportRecords({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        afterRevision: 0,
        proof: proof(device, "fork.export.records.read", {
          ...grantPayload,
          afterRevision: 0,
          limit: 20,
        }),
      }),
    ).resolves.toMatchObject({
      recordRevision: 1,
      events: [{ entityId: "cloud-chat-1" }],
      hasMore: false,
    });
    expect(
      (
        await pool.query(
          `SELECT status, desired_state FROM cloud_workspaces WHERE id = $1`,
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({ status: "ready", desired_state: "running" });
    expect(targetLocalWorkspaceId).not.toBe(fixture.workspaceId);

    await pool.query(
      `UPDATE workspace_exports
       SET state = 'expired', checkpoint_id = NULL
       WHERE fork_intent_id = $1`,
      [requested.forkIntentId],
    );
    await expect(
      forks.readExportManifest({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        afterPath: null,
        proof: proof(device, "fork.export.manifest.read", {
          ...grantPayload,
          afterPath: null,
          limit: 500,
        }),
      }),
    ).rejects.toMatchObject({ code: "grant_rejected" });
    await expect(
      forks.readExportRecords({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        afterRevision: 0,
        proof: proof(device, "fork.export.records.read", {
          ...grantPayload,
          afterRevision: 0,
          limit: 20,
        }),
      }),
    ).rejects.toMatchObject({ code: "grant_rejected" });
    await expect(
      forks.readExportBlob({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        blobId: fileBlob.id,
        proof: proof(device, "fork.export.blob.read", {
          ...grantPayload,
          blobId: fileBlob.id,
        }),
      }),
    ).rejects.toMatchObject({ code: "grant_rejected" });
    await expect(
      forks.issueExportGrant({
        forkIntentId: requested.forkIntentId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        proof: proof(device, "fork.export.grant", grantPayload),
      }),
    ).rejects.toMatchObject({ code: "export_unavailable" });
  });

  it("does not publish an export whose fork expires during its manifest upload", async () => {
    const file = Buffer.from("export deadline race\n", "utf8");
    const fileBlob = await blobs.put({ ...engine(), bytes: file });
    const appended = await content.append({
      ...engine(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "e".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "deadline.txt",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    const checkpointManifestBytes = Buffer.from(
      '{"kind":"fork-deadline-race"}',
      "utf8",
    );
    const checkpointManifest = await blobs.put({
      ...engine(),
      bytes: checkpointManifestBytes,
    });
    const requested = await forks.requestCloudToLocal({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      targetLocalWorkspaceId: randomUUID(),
      accountUserId: fixture.userId,
      idempotencyKey: `deadline-${randomUUID()}`,
      includeChats: false,
    });
    expect(
      await withSystemTx(pool, (tx) =>
        deliverWorkspaceCheckpointRequest(tx, {
          workspaceId: fixture.workspaceId,
          organizationId: fixture.organizationId,
          generation: 1,
        }),
      ),
    ).toMatchObject({ id: requested.checkpointRequestId });
    await content.commitCheckpoint({
      ...engine(),
      requestId: requested.checkpointRequestId,
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "before_fork",
      manifestBlobId: checkpointManifest.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256")
        .update(checkpointManifestBytes)
        .digest("hex"),
    });

    const upload = objectStore.pauseNextUpload();
    const exporter = new CloudWorkspaceForkWorker(pool, blobs, {
      workerId: "stale-fork-exporter",
    });
    const exporting = exporter.runOnce();
    const exportObjectKey = await upload.started;
    await pool.query(
      `UPDATE workspace_fork_intents
       SET created_at = now() - interval '2 seconds',
           deadline_at = now() - interval '1 second'
       WHERE id = $1`,
      [requested.forkIntentId],
    );
    const expirer = new CloudWorkspaceForkWorker(pool, blobs, {
      workerId: "concurrent-fork-expirer",
    });
    const expired = await expirer.runOnce().finally(upload.resume);
    const exported = await exporting;

    expect(expired).toBe(true);
    expect(exported).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT state, error_code FROM workspace_fork_intents WHERE id = $1`,
          [requested.forkIntentId],
        )
      ).rows[0],
    ).toEqual({ state: "failed", error_code: "fork_deadline_exceeded" });
    expect(
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM workspace_exports
             WHERE fork_intent_id = $1`,
            [requested.forkIntentId],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM audit_log
             WHERE org_id = $1
               AND action = 'cloud_workspace.local_copy_ready'
               AND subject ->> 'forkIntentId' = $2`,
            [fixture.organizationId, requested.forkIntentId],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);
    expect(
      (
        await pool.query<{
          state: string;
          reference_count: string;
          references: string;
          reservations: string;
        }>(
          `SELECT blob.state, blob.reference_count::text,
                  count(reference.blob_id)::text AS references,
                  count(reservation.blob_id)::text AS reservations
           FROM workspace_blobs blob
           LEFT JOIN workspace_blob_references reference
             ON reference.blob_id = blob.id AND reference.org_id = blob.org_id
           LEFT JOIN workspace_blob_storage_reservations reservation
             ON reservation.blob_id = blob.id AND reservation.org_id = blob.org_id
           WHERE blob.object_key = $1
           GROUP BY blob.id`,
          [exportObjectKey],
        )
      ).rows[0],
    ).toEqual({
      state: "deleted",
      reference_count: "0",
      references: "0",
      reservations: "0",
    });
    await expect(objectStore.get(exportObjectKey)).resolves.toBeNull();
  });

  it("rejects a cloud-to-local copy that reuses the source cloud identity", async () => {
    await expect(
      forks.requestCloudToLocal({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        targetLocalWorkspaceId: fixture.workspaceId,
        accountUserId: fixture.userId,
        idempotencyKey: `copy-${randomUUID()}`,
        includeChats: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const valid = await forks.requestCloudToLocal({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      targetLocalWorkspaceId: randomUUID(),
      accountUserId: fixture.userId,
      idempotencyKey: `copy-${randomUUID()}`,
      includeChats: false,
    });
    await expect(
      pool.query(
        `UPDATE workspace_fork_intents
         SET target_local_workspace_id = source_cloud_workspace_id
         WHERE id = $1`,
        [valid.forkIntentId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("reauthorizes an idempotent cloud-to-local request after scope revocation", async () => {
    const idempotencyKey = `copy-${randomUUID()}`;
    const input = {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      targetLocalWorkspaceId: randomUUID(),
      accountUserId: fixture.userId,
      idempotencyKey,
      includeChats: false,
    };
    await expect(forks.requestCloudToLocal(input)).resolves.toMatchObject({
      replayed: false,
    });
    await pool.query(
      `DELETE FROM team_members WHERE org_id = $1 AND user_id = $2`,
      [fixture.organizationId, fixture.userId],
    );

    await expect(forks.requestCloudToLocal(input)).rejects.toMatchObject({
      code: "cloud_workspace_scope_not_found",
    });
  });

  it.each(["owner", "guest", "owner-team", "owner-team-legacy"] as const)("lets the %s export a durable checkpoint while preserving current actor authority", async (kind) => {
    const file = Buffer.from("portable after cancellation\n", "utf8");
    const fileBlob = await blobs.put({ ...engine(), bytes: file });
    const appended = await content.append({
      ...engine(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "d".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "portable.txt",
          entryType: "file",
          mode: 33188,
          blobId: fileBlob.id,
          contentSha256: fileBlob.plaintextSha256,
          sizeBytes: file.length,
        },
      ],
    });
    const manifestBytes = Buffer.from('{"kind":"portable"}', "utf8");
    const manifestBlob = await blobs.put({ ...engine(), bytes: manifestBytes });
    const checkpoint = await content.commitCheckpoint({
      ...engine(),
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "manual",
      manifestBlobId: manifestBlob.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: file.length,
      integritySha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
    await pool.query(
      `UPDATE organization_entitlements
       SET status = 'cancelled', cloud_workspaces_allowed = false,
           revision = revision + 1
       WHERE org_id = $1`,
      [fixture.organizationId],
    );
    await pool.query(
      `UPDATE cloud_workspaces
       SET status = 'stopped', desired_state = 'stopped',
           authority_epoch = authority_epoch + 1
       WHERE id = $1`,
      [fixture.workspaceId],
    );

    let guestGrantId: string | undefined;
    if (kind === "guest") {
      const guest = await seedReadyCloudWorkspace(pool);
      await pool.query("UPDATE cloud_workspaces SET single_member_mode=false,sharing_mode='organization' WHERE id=$1", [fixture.workspaceId]);
      guestGrantId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,expires_at)
        VALUES ($1,$2,$3,$4,'viewer',now()+interval '1 day')`, [guestGrantId,fixture.workspaceId,fixture.organizationId,guest.userId]);
      fixture = {...fixture,userId:guest.userId};
    }

    const targetLocalWorkspaceId = randomUUID();
    const requested = await forks.requestCloudToLocal({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      targetLocalWorkspaceId,
      accountUserId: fixture.userId,
      idempotencyKey: `portable-${randomUUID()}`,
      includeChats: false,
    });
    const request = (
      await pool.query(
        `SELECT state, checkpoint_id FROM workspace_checkpoint_requests
         WHERE id = $1`,
        [requested.checkpointRequestId],
      )
    ).rows[0];
    expect(request).toEqual({
      state: "succeeded",
      checkpoint_id: checkpoint.checkpointId,
    });

    const worker = new CloudWorkspaceForkWorker(pool, blobs, {
      workerId: "portable-export-test",
    });
    expect(await worker.runOnce()).toBe(true);
    const device = await registerDevice();
    const grantPayload = {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      forkIntentId: requested.forkIntentId,
    };
    const grant = await forks.issueExportGrant({
      ...grantPayload,
      accountUserId: fixture.userId,
      proof: proof(device, "fork.export.grant", grantPayload),
    });
    await expect(
      forks.readExportManifest({
        ...grantPayload,
        accountUserId: fixture.userId,
        grantToken: grant.grantToken,
        afterPath: null,
        proof: proof(device, "fork.export.manifest.read", {
          ...grantPayload,
          afterPath: null,
          limit: 500,
        }),
      }),
    ).resolves.toMatchObject({
      targetLocalWorkspaceId,
      checkpointId: checkpoint.checkpointId,
      entries: [{ path: "portable.txt", blobId: fileBlob.id }],
    });
    if (kind === "owner-team" || kind === "owner-team-legacy") {
      if (kind === "owner-team-legacy") await pool.query(
        "UPDATE workspace_export_grants SET actor_fingerprint=NULL WHERE fork_intent_id=$1", [requested.forkIntentId]);
      // Recreate within one transaction: timestamps alone cannot fence this
      // membership incarnation because now() is transaction-stable.
      await withSystemTx(pool, async tx => {
        await tx.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [fixture.teamId,fixture.userId]);
        await tx.query("INSERT INTO team_members(team_id,org_id,user_id) VALUES ($1,$2,$3)", [fixture.teamId,fixture.organizationId,fixture.userId]);
      });
      const read = (token:string) => forks.readExportManifest({...grantPayload,accountUserId:fixture.userId,
        grantToken:token,afterPath:null,proof:proof(device,"fork.export.manifest.read",{...grantPayload,afterPath:null,limit:500})});
      await expect(read(grant.grantToken)).rejects.toMatchObject({code:"grant_rejected"});
      const fresh = await forks.issueExportGrant({...grantPayload,accountUserId:fixture.userId,
        proof:proof(device,"fork.export.grant",grantPayload)});
      await expect(read(fresh.grantToken)).resolves.toMatchObject({checkpointId:checkpoint.checkpointId});
    }
    if (kind === "owner") {
      let started!:()=>void,resume!:()=>void;
      const downloading=new Promise<void>(resolve=>{started=resolve;});
      const released=new Promise<void>(resolve=>{resume=resolve;});
      const get=objectStore.get.bind(objectStore);
      objectStore.get=async key=>{started();await released;return get(key);};
      const payload={...grantPayload,blobId:fileBlob.id};
      const reading=forks.readExportBlob({...payload,accountUserId:fixture.userId,grantToken:grant.grantToken,
        proof:proof(device,'fork.export.blob.read',payload)});
      const settled=Promise.allSettled([reading]);
      try { await downloading; await replicas.revokeDevice({accountUserId:fixture.userId,deviceId:device.deviceId}); }
      finally { resume();await settled;objectStore.get=get; }
      await expect(reading).rejects.toMatchObject({name: 'WorkspaceForkError',code:'device_proof_rejected'});
    }
    if (guestGrantId) {
      await pool.query('UPDATE cloud_workspace_guest_grants SET revoked_at=now(),revision=revision+1 WHERE id=$1',[guestGrantId]);
      await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,expires_at)
        VALUES ($1,$2,$3,$4,'viewer',now()+interval '1 day')`, [randomUUID(),fixture.workspaceId,fixture.organizationId,fixture.userId]);
      await expect(forks.readExportManifest({...grantPayload,accountUserId:fixture.userId,grantToken:grant.grantToken,
        afterPath:null,proof:proof(device,'fork.export.manifest.read',{...grantPayload,afterPath:null,limit:500})}))
        .rejects.toMatchObject({code:'grant_rejected'});
    }

  });
});
