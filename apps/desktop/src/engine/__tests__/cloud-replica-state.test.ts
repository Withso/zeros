import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CloudReplicaApplyEngine } from "../cloud-replica-apply";
import {
  cloudReplicaIgnorePolicySha256,
  CloudReplicaStateError,
  DatabaseCloudReplicaState,
} from "../cloud-replica-state";
import { runMigrations } from "../db/migrations";

const databases: Database.Database[] = [];
const directories: string[] = [];

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  databases.push(db);
  return db;
}

function publicKey(): string {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("missing test public key");
  return jwk.x;
}

async function tempRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "zeros-replica-state-"));
  directories.push(parent);
  return path.join(parent, "workspace");
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("device-private cloud replica SQLite state", () => {
  it("binds one public device identity per account without storing credentials", () => {
    const db = database();
    const state = new DatabaseCloudReplicaState(db);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    const key = publicKey();
    expect(
      state.recordRegistration({
        accountUserId,
        deviceId,
        keyVersion: 1,
        publicKey: key,
      }),
    ).toMatchObject({ accountUserId, deviceId, keyVersion: 1 });
    const rotated = publicKey();
    expect(
      state.recordRegistration({
        accountUserId,
        deviceId,
        keyVersion: 2,
        publicKey: rotated,
      }),
    ).toMatchObject({ deviceId, keyVersion: 2, publicKey: rotated });
    expect(() =>
      state.recordRegistration({
        accountUserId,
        deviceId: randomUUID(),
        keyVersion: 1,
        publicKey: publicKey(),
      }),
    ).toThrowError(CloudReplicaStateError);

    const columns = db
      .prepare("PRAGMA table_info(cloud_device_registrations)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["private_key", "grant", "access_token"]),
    );
  });

  it("persists an exact projection and advances its cursor only by CAS receipt", async () => {
    const db = database();
    const state = new DatabaseCloudReplicaState(db);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    state.recordRegistration({
      accountUserId,
      deviceId,
      keyVersion: 1,
      publicKey: publicKey(),
    });
    const replicaId = randomUUID();
    const rootPath = await tempRoot();
    const ignorePolicy = { version: 1, defaults: [".git", ".zeros"] };
    state.createReplica({
      replicaId,
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      accountUserId,
      deviceId,
      rootPath,
      checkpointId: randomUUID(),
      manifestRevision: 1,
      workspaceAuthorityEpoch: 3,
      grantEpoch: 1,
      ignorePolicy,
    });
    expect(state.replica(replicaId)).toMatchObject({
      rootPath,
      eventCursor: 0,
      ignorePolicySha256: cloudReplicaIgnorePolicySha256(ignorePolicy),
    });

    const bytes = Buffer.from("durable cloud content\n", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const applied = await new CloudReplicaApplyEngine(
      state.projection(replicaId),
      async () => bytes,
    ).apply({
      replicaId,
      rootPath,
      fromRevision: 0,
      toRevision: 1,
      mutations: [
        {
          revision: 1,
          sequence: 1,
          path: "src/index.ts",
          operation: "upsert",
          entryType: "file",
          mode: 33188,
          blobId: randomUUID(),
          contentSha256: digest,
          sizeBytes: bytes.length,
        },
      ],
    });
    expect(await readFile(path.join(rootPath, "src/index.ts"), "utf8")).toBe(
      "durable cloud content\n",
    );
    expect(state.replica(replicaId)?.eventCursor).toBe(0);
    expect(
      state.advanceReceipt({
        replicaId,
        fromRevision: 0,
        toRevision: 1,
        manifestSha256: applied.manifestSha256,
        observedState: "in_sync",
      }),
    ).toMatchObject({ eventCursor: 1, observedState: "in_sync" });
    expect(() =>
      state.advanceReceipt({
        replicaId,
        fromRevision: 0,
        toRevision: 1,
        manifestSha256: applied.manifestSha256,
        observedState: "in_sync",
      }),
    ).toThrowError(expect.objectContaining({ code: "cursor_conflict" }));
    expect(state.markDetached(replicaId, "workspace_deleted")).toMatchObject({
      desiredState: "paused",
      observedState: "detached",
      lastErrorCode: "workspace_deleted",
      eventCursor: 1,
    });
    expect(await readFile(path.join(rootPath, "src/index.ts"), "utf8")).toBe(
      "durable cloud content\n",
    );
  });

  it("rejects remote state whose authority or grant epoch moved backwards", async () => {
    const db = database();
    const state = new DatabaseCloudReplicaState(db);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    state.recordRegistration({
      accountUserId,
      deviceId,
      keyVersion: 1,
      publicKey: publicKey(),
    });
    const replicaId = randomUUID();
    state.createReplica({
      replicaId,
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      accountUserId,
      deviceId,
      rootPath: await tempRoot(),
      checkpointId: randomUUID(),
      manifestRevision: 1,
      workspaceAuthorityEpoch: 4,
      grantEpoch: 7,
      ignorePolicy: { version: 1 },
    });

    expect(() =>
      state.updateRemoteState({
        replicaId,
        desiredState: "paused",
        observedState: "paused",
        workspaceAuthorityEpoch: 3,
        grantEpoch: 8,
      }),
    ).toThrowError(expect.objectContaining({ code: "cursor_conflict" }));
    expect(() =>
      state.updateRemoteState({
        replicaId,
        desiredState: "paused",
        observedState: "paused",
        workspaceAuthorityEpoch: 4,
        grantEpoch: 6,
      }),
    ).toThrowError(expect.objectContaining({ code: "cursor_conflict" }));
    expect(() =>
      state.updateRemoteState({
        replicaId,
        desiredState: "removed",
        observedState: "removed",
        workspaceAuthorityEpoch: 4,
        grantEpoch: 7,
      }),
    ).toThrowError(expect.objectContaining({ code: "cursor_conflict" }));
    expect(() =>
      state.resetForSnapshot({
        replicaId,
        checkpointId: randomUUID(),
        manifestRevision: 2,
        workspaceAuthorityEpoch: 3,
        grantEpoch: 8,
      }),
    ).toThrowError(expect.objectContaining({ code: "cursor_conflict" }));
    expect(state.replica(replicaId)).toMatchObject({
      desiredState: "active",
      workspaceAuthorityEpoch: 4,
      grantEpoch: 7,
    });
  });

  it("keeps each replica path unique and records divergence transactionally", async () => {
    const db = database();
    const state = new DatabaseCloudReplicaState(db);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    state.recordRegistration({
      accountUserId,
      deviceId,
      keyVersion: 1,
      publicKey: publicKey(),
    });
    const rootPath = await tempRoot();
    const base = {
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      accountUserId,
      deviceId,
      rootPath,
      checkpointId: randomUUID(),
      manifestRevision: 1,
      workspaceAuthorityEpoch: 1,
      grantEpoch: 1,
      ignorePolicy: { version: 1 },
    };
    const replicaId = randomUUID();
    state.createReplica({ ...base, replicaId });
    expect(() =>
      state.createReplica({ ...base, replicaId: randomUUID() }),
    ).toThrowError(expect.objectContaining({ code: "identity_conflict" }));
    state.projection(replicaId).divergence({
      path: "edited.ts",
      expectedSha256: "a".repeat(64),
      observedSha256: "b".repeat(64),
      cloudSha256: "c".repeat(64),
    });
    expect(state.replica(replicaId)).toMatchObject({
      observedState: "diverged",
      lastErrorCode: "local_content_changed",
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM cloud_replica_divergences WHERE replica_id = ?",
        )
        .get(replicaId),
    ).toEqual({ count: 1 });
  });
});
