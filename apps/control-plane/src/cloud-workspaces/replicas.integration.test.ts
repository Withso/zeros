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

import { runMigrations } from "../migrate.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
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

function newKeyPair(): Omit<DeviceSigner, "deviceId" | "keyVersion"> {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("missing Ed25519 public key");
  return { privateKey: pair.privateKey, publicKey: jwk.x };
}

d("cloud workspace receive-only replicas", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let blobs: DatabaseCloudWorkspaceBlobService;
  let content: DatabaseCloudWorkspaceContentService;
  let replicas: DatabaseCloudWorkspaceReplicaService;
  let firstBlobId: string;
  let firstBytes: Buffer;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    blobs = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    content = new DatabaseCloudWorkspaceContentService({
      pool,
      workosEnabled: false,
    });
    replicas = new DatabaseCloudWorkspaceReplicaService(pool, blobs, false);

    firstBytes = Buffer.from("checkpoint state\n", "utf8");
    const firstBlob = await blobs.put({
      ...engine(),
      bytes: firstBytes,
    });
    firstBlobId = firstBlob.id;
    const appended = await content.append({
      ...engine(),
      expectedRevision: 0,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "src/checkpoint.ts",
          entryType: "file",
          mode: 33188,
          blobId: firstBlob.id,
          contentSha256: firstBlob.plaintextSha256,
          sizeBytes: firstBytes.length,
        },
      ],
    });
    const manifestBytes = Buffer.from('{"kind":"replica-bootstrap"}', "utf8");
    const manifest = await blobs.put({ ...engine(), bytes: manifestBytes });
    await content.commitCheckpoint({
      ...engine(),
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: appended.revision,
      reason: "manual",
      manifestBlobId: manifest.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: firstBytes.length,
      integritySha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
  });

  function engine() {
    return {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
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

  async function register(label: string): Promise<DeviceSigner> {
    const key = newKeyPair();
    const registered = await replicas.registerDevice({
      accountUserId: fixture.userId,
      label,
      platform: "macos",
      publicKey: key.publicKey,
      idempotencyKey: `device-${randomUUID()}`,
    });
    return {
      ...key,
      deviceId: registered.device.id,
      keyVersion: registered.device.keyVersion,
    };
  }

  async function createReplica(signer: DeviceSigner, idempotencyKey: string) {
    const payload = {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      pathLabel: "Zeros replica",
      ignorePolicySha256: "b".repeat(64),
      idempotencyKey,
    };
    return replicas.createReplica({
      ...payload,
      accountUserId: fixture.userId,
      proof: proof(signer, "replica.create", payload),
    });
  }

  it("bootstraps, catches up, and pauses one device without affecting another", async () => {
    const deviceA = await register("Mac A");
    const deviceB = await register("Mac B");
    const idempotencyKey = `replica-${randomUUID()}`;
    const createdA = await createReplica(deviceA, idempotencyKey);
    expect(createdA.replica).toMatchObject({
      workspaceId: fixture.workspaceId,
      deviceId: deviceA.deviceId,
      mode: "receive_only",
      desiredState: "active",
      observedState: "bootstrapping",
      eventCursor: 0,
      manifestRevision: 1,
    });
    expect(createdA.grant?.token).toMatch(/^zwr_/);
    const nonceRetention = await pool.query<{ retained_ms: string | number }>(
      `SELECT extract(epoch FROM (max(expires_at) - now())) * 1000 AS retained_ms
       FROM device_request_nonces
       WHERE device_id = $1`,
      [deviceA.deviceId],
    );
    expect(Number(nonceRetention.rows[0]!.retained_ms)).toBeLessThanOrEqual(
      12 * 60_000,
    );
    const replayedA = await createReplica(deviceA, idempotencyKey);
    expect(replayedA).toMatchObject({
      replica: { id: createdA.replica.id },
      replayed: true,
    });
    const grantA = replayedA.grant!;
    const createdB = await createReplica(deviceB, `replica-${randomUUID()}`);

    const bootstrapPayload = { afterPath: null, limit: 100 };
    const bootstrap = await replicas.readBootstrap({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: createdA.replica.id,
      accountUserId: fixture.userId,
      grantToken: grantA.token,
      afterPath: null,
      limit: 100,
      proof: proof(deviceA, "replica.bootstrap.read", bootstrapPayload),
    });
    expect(bootstrap).toMatchObject({
      manifestRevision: 1,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      entries: [
        {
          path: "src/checkpoint.ts",
          operation: "upsert",
          blobId: firstBlobId,
        },
      ],
      nextAfterPath: null,
    });
    const blobPayload = { blobId: firstBlobId };
    await expect(
      replicas.readBlob({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        blobId: firstBlobId,
        proof: proof(deviceA, "replica.blob.read", blobPayload),
      }),
    ).resolves.toEqual(firstBytes);

    // Bootstrap advertises this immutable checkpoint projection. It must be
    // readable through the same grant capability as an entry blob; otherwise
    // desktop cannot verify the advertised integrity before publication.
    const manifestBlobPayload = { blobId: bootstrap.manifestBlobId };
    await expect(
      replicas.readBlob({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        blobId: bootstrap.manifestBlobId,
        proof: proof(deviceA, "replica.blob.read", manifestBlobPayload),
      }),
    ).resolves.toEqual(Buffer.from('{"kind":"replica-bootstrap"}', "utf8"));

    const bootstrapReceipt = {
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: "c".repeat(64),
      outcome: "applied" as const,
      errorCode: null,
      idempotencyKey: `receipt-${randomUUID()}`,
    };
    await expect(
      replicas.recordReceipt({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        ...bootstrapReceipt,
        proof: proof(deviceA, "replica.receipt", bootstrapReceipt),
      }),
    ).resolves.toMatchObject({
      replica: { eventCursor: 1, observedState: "in_sync" },
      replayed: false,
    });
    await expect(
      replicas.recordReceipt({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        ...bootstrapReceipt,
        proof: proof(deviceA, "replica.receipt", bootstrapReceipt),
      }),
    ).resolves.toMatchObject({
      replica: { eventCursor: 1, observedState: "in_sync" },
      replayed: true,
    });

    const secondBytes = Buffer.from("next cloud revision\n", "utf8");
    const secondBlob = await blobs.put({ ...engine(), bytes: secondBytes });
    await content.append({
      ...engine(),
      expectedRevision: 1,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [
        {
          operation: "upsert",
          path: "src/next.ts",
          entryType: "file",
          mode: 33188,
          blobId: secondBlob.id,
          contentSha256: secondBlob.plaintextSha256,
          sizeBytes: secondBytes.length,
        },
      ],
    });
    const eventPayload = { afterRevision: 1, limit: 100 };
    await expect(
      replicas.readEvents({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        afterRevision: 1,
        limit: 100,
        proof: proof(deviceA, "replica.events.read", eventPayload),
      }),
    ).resolves.toMatchObject({
      fromRevision: 1,
      toRevision: 2,
      currentRevision: 2,
      events: [{ revision: 2, path: "src/next.ts" }],
      hasMore: false,
    });

    const pauseIdempotencyKey = `command-${randomUUID()}`;
    const pausePayload = {
      operation: "pause",
      replaceDiverged: false,
      idempotencyKey: pauseIdempotencyKey,
    };
    const pauseProof = proof(deviceA, "replica.pause", pausePayload);
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        operation: "pause",
        idempotencyKey: pauseIdempotencyKey,
        proof: pauseProof,
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "paused", observedState: "paused" },
      grant: null,
    });
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        operation: "pause",
        idempotencyKey: pauseIdempotencyKey,
        proof: proof(deviceA, "replica.pause", pausePayload),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "paused" },
      replayed: true,
    });
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        operation: "pause",
        idempotencyKey: pauseIdempotencyKey,
        proof: pauseProof,
      }),
    ).rejects.toMatchObject({ code: "device_proof_replayed" });

    const state = await pool.query(
      `SELECT id, desired_state FROM workspace_replicas ORDER BY id`,
    );
    expect(state.rows).toEqual(
      expect.arrayContaining([
        { id: createdA.replica.id, desired_state: "paused" },
        { id: createdB.replica.id, desired_state: "active" },
      ]),
    );
    const bBootstrapPayload = { afterPath: null, limit: 10 };
    await expect(
      replicas.readBootstrap({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdB.replica.id,
        accountUserId: fixture.userId,
        grantToken: createdB.grant!.token,
        afterPath: null,
        limit: 10,
        proof: proof(deviceB, "replica.bootstrap.read", bBootstrapPayload),
      }),
    ).resolves.toMatchObject({ manifestRevision: 1 });

    const resumeIdempotencyKey = `command-${randomUUID()}`;
    const resumePayload = {
      operation: "resume",
      replaceDiverged: false,
      idempotencyKey: resumeIdempotencyKey,
    };
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        operation: "resume",
        idempotencyKey: resumeIdempotencyKey,
        proof: proof(deviceA, "replica.resume", resumePayload),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "active", observedState: "syncing" },
      replayed: false,
    });
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        operation: "pause",
        idempotencyKey: pauseIdempotencyKey,
        proof: proof(deviceA, "replica.pause", pausePayload),
      }),
    ).rejects.toMatchObject({ code: "cursor_conflict" });
    await expect(
      replicas.recordReceipt({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: createdA.replica.id,
        accountUserId: fixture.userId,
        grantToken: grantA.token,
        ...bootstrapReceipt,
        proof: proof(deviceA, "replica.receipt", bootstrapReceipt),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "active", observedState: "syncing" },
      replayed: true,
    });
    expect(
      (
        await pool.query(
          `SELECT desired_state, observed_state
           FROM workspace_replicas WHERE id = $1`,
          [createdA.replica.id],
        )
      ).rows[0],
    ).toEqual({ desired_state: "active", observed_state: "syncing" });
  });

  it("allows an owner to pause or remove a replica after paid cloud cancellation", async () => {
    const device = await register("Cancelled plan Mac");
    const created = await createReplica(device, `replica-${randomUUID()}`);
    await pool.query(
      `UPDATE organization_entitlements
       SET status = 'cancelled', cloud_workspaces_allowed = false,
           revision = revision + 1
       WHERE org_id = $1`,
      [fixture.organizationId],
    );

    const pauseKey = `command-${randomUUID()}`;
    const pausePayload = {
      operation: "pause" as const,
      replaceDiverged: false,
      idempotencyKey: pauseKey,
    };
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "pause",
        idempotencyKey: pauseKey,
        proof: proof(device, "replica.pause", pausePayload),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "paused", observedState: "paused" },
      grant: null,
    });

    const resumeKey = `command-${randomUUID()}`;
    const resumePayload = {
      operation: "resume" as const,
      replaceDiverged: false,
      idempotencyKey: resumeKey,
    };
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "resume",
        idempotencyKey: resumeKey,
        proof: proof(device, "replica.resume", resumePayload),
      }),
    ).rejects.toMatchObject({
      code: "cloud_organization_entitlement_required",
    });

    const removeKey = `command-${randomUUID()}`;
    const removePayload = {
      operation: "remove" as const,
      replaceDiverged: false,
      idempotencyKey: removeKey,
    };
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "remove",
        idempotencyKey: removeKey,
        proof: proof(device, "replica.remove", removePayload),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "removed", observedState: "removed" },
      grant: null,
    });
  });

  it("revokes a stale device key and requires explicit divergence replacement", async () => {
    const device = await register("Rotating Mac");
    const created = await createReplica(device, `replica-${randomUUID()}`);
    const applied = {
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: "a".repeat(64),
      outcome: "applied" as const,
      errorCode: null,
      idempotencyKey: `receipt-${randomUUID()}`,
    };
    await replicas.recordReceipt({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      grantToken: created.grant!.token,
      ...applied,
      proof: proof(device, "replica.receipt", applied),
    });
    const divergent = {
      fromRevision: 1,
      toRevision: 1,
      manifestSha256: "d".repeat(64),
      outcome: "diverged" as const,
      errorCode: "local_content_changed",
      idempotencyKey: `receipt-${randomUUID()}`,
    };
    await replicas.recordReceipt({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      grantToken: created.grant!.token,
      ...divergent,
      proof: proof(device, "replica.receipt", divergent),
    });
    // The original receipt revoked its grant, but an uncertain-response retry
    // remains safe because it is authenticated by the same registered device
    // and exact idempotency request.
    await expect(
      replicas.recordReceipt({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        grantToken: created.grant!.token,
        ...divergent,
        proof: proof(device, "replica.receipt", divergent),
      }),
    ).resolves.toMatchObject({ replayed: true });
    const resumeIdempotencyKey = `command-${randomUUID()}`;
    const resumePayload = {
      operation: "resume",
      replaceDiverged: false,
      idempotencyKey: resumeIdempotencyKey,
    };
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "resume",
        idempotencyKey: resumeIdempotencyKey,
        proof: proof(device, "replica.resume", resumePayload),
      }),
    ).rejects.toMatchObject({ code: "divergence_resolution_required" });

    const replacementIdempotencyKey = `command-${randomUUID()}`;
    const replacementPayload = {
      operation: "resume",
      replaceDiverged: true,
      idempotencyKey: replacementIdempotencyKey,
    };
    const replacement = await replicas.changeReplicaState({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      operation: "resume",
      replaceDiverged: true,
      idempotencyKey: replacementIdempotencyKey,
      proof: proof(device, "replica.resume", replacementPayload),
    });
    expect(replacement).toMatchObject({
      replica: {
        observedState: "bootstrapping",
        eventCursor: 0,
        manifestRevision: 1,
      },
      grant: { token: expect.stringMatching(/^zwr_/) },
    });
    const replacementReceipt = {
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: "e".repeat(64),
      outcome: "applied" as const,
      errorCode: null,
      idempotencyKey: `receipt-${randomUUID()}`,
    };
    await replicas.recordReceipt({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      grantToken: replacement.grant!.token,
      ...replacementReceipt,
      proof: proof(device, "replica.receipt", replacementReceipt),
    });
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "resume",
        replaceDiverged: true,
        idempotencyKey: replacementIdempotencyKey,
        proof: proof(device, "replica.resume", replacementPayload),
      }),
    ).resolves.toMatchObject({
      replica: { desiredState: "active", observedState: "in_sync" },
      grant: { token: expect.stringMatching(/^zwr_/) },
      replayed: true,
    });

    const afterReplacementPauseKey = `command-${randomUUID()}`;
    const afterReplacementPause = {
      operation: "pause" as const,
      replaceDiverged: false,
      idempotencyKey: afterReplacementPauseKey,
    };
    await replicas.changeReplicaState({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      operation: "pause",
      idempotencyKey: afterReplacementPauseKey,
      proof: proof(device, "replica.pause", afterReplacementPause),
    });
    const afterReplacementResumeKey = `command-${randomUUID()}`;
    const afterReplacementResume = {
      operation: "resume" as const,
      replaceDiverged: false,
      idempotencyKey: afterReplacementResumeKey,
    };
    await replicas.changeReplicaState({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      operation: "resume",
      idempotencyKey: afterReplacementResumeKey,
      proof: proof(device, "replica.resume", afterReplacementResume),
    });
    await expect(
      replicas.changeReplicaState({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        operation: "resume",
        replaceDiverged: true,
        idempotencyKey: replacementIdempotencyKey,
        proof: proof(device, "replica.resume", replacementPayload),
      }),
    ).rejects.toMatchObject({ code: "cursor_conflict" });

    const nextKey = newKeyPair();
    const rotationIdempotencyKey = `rotate-${randomUUID()}`;
    const rotatePayload = {
      newPublicKey: nextKey.publicKey,
      idempotencyKey: rotationIdempotencyKey,
    };
    const rotated = await replicas.rotateDeviceKey({
      accountUserId: fixture.userId,
      newPublicKey: nextKey.publicKey,
      idempotencyKey: rotationIdempotencyKey,
      proof: proof(device, "device.rotate", rotatePayload),
    });
    expect(rotated.device.keyVersion).toBe(2);
    const rotatedSigner: DeviceSigner = {
      ...nextKey,
      deviceId: device.deviceId,
      keyVersion: 2,
    };
    await expect(
      replicas.rotateDeviceKey({
        accountUserId: fixture.userId,
        newPublicKey: nextKey.publicKey,
        idempotencyKey: rotationIdempotencyKey,
        proof: proof(rotatedSigner, "device.rotate", rotatePayload),
      }),
    ).resolves.toMatchObject({
      device: { id: device.deviceId, keyVersion: 2 },
      replayed: true,
    });
    const oldGrant = await pool.query(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::integer AS live
       FROM workspace_replica_grants WHERE replica_id = $1`,
      [created.replica.id],
    );
    expect(oldGrant.rows[0]).toEqual({ live: 0 });
  });

  it("advances empty content revisions and refreshes a retention-gapped snapshot", async () => {
    const device = await register("Snapshot Mac");
    const created = await createReplica(device, `replica-${randomUUID()}`);
    const bootstrapReceipt = {
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: "7".repeat(64),
      outcome: "applied" as const,
      errorCode: null,
      idempotencyKey: `receipt-${randomUUID()}`,
    };
    await replicas.recordReceipt({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      grantToken: created.grant!.token,
      ...bootstrapReceipt,
      proof: proof(device, "replica.receipt", bootstrapReceipt),
    });

    await content.append({
      ...engine(),
      expectedRevision: 1,
      idempotencyKey: `content-${randomUUID()}`,
      gitBaseCommit: "a".repeat(40),
      gitHeadRef: "refs/heads/main",
      mutations: [],
    });
    const eventPayload = { afterRevision: 1, limit: 100 };
    await expect(
      replicas.readEvents({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        grantToken: created.grant!.token,
        afterRevision: 1,
        limit: 100,
        proof: proof(device, "replica.events.read", eventPayload),
      }),
    ).resolves.toMatchObject({
      currentRevision: 2,
      fromRevision: 1,
      toRevision: 2,
      events: [],
      hasMore: false,
    });

    const manifestBytes = Buffer.from('{"kind":"new-snapshot"}', "utf8");
    const manifest = await blobs.put({ ...engine(), bytes: manifestBytes });
    const checkpoint = await content.commitCheckpoint({
      ...engine(),
      idempotencyKey: `checkpoint-${randomUUID()}`,
      contentRevision: 2,
      reason: "manual",
      manifestBlobId: manifest.id,
      artifactBlobId: null,
      inclusionPolicy: { ignored: "excluded", secrets: "excluded" },
      fileCount: 1,
      totalBytes: firstBytes.length,
      integritySha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
    const snapshotPayload = { replicaId: created.replica.id };
    const refreshed = await replicas.refreshSnapshot({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      replicaId: created.replica.id,
      accountUserId: fixture.userId,
      proof: proof(device, "replica.snapshot", snapshotPayload),
    });
    expect(refreshed).toMatchObject({
      replica: {
        checkpointId: checkpoint.checkpointId,
        manifestRevision: 2,
        eventCursor: 0,
        observedState: "bootstrapping",
      },
      grant: { token: expect.stringMatching(/^zwr_/) },
    });
    const stalePayload = { afterPath: null, limit: 10 };
    await expect(
      replicas.readBootstrap({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        replicaId: created.replica.id,
        accountUserId: fixture.userId,
        grantToken: created.grant!.token,
        afterPath: null,
        limit: 10,
        proof: proof(device, "replica.bootstrap.read", stalePayload),
      }),
    ).rejects.toMatchObject({ code: "grant_rejected" });
  });
});
