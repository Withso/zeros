import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudReplicaMutation } from "../cloud-replica-apply";
import {
  CloudReplicaBrokerError,
  CloudReplicaSyncBroker,
  parseBootstrapManifest,
} from "../cloud-replica-broker";
import type {
  CloudReplicaApi,
  CloudReplicaBootstrapPage,
  CloudReplicaEventPage,
  CloudReplicaGrant,
  CloudReplicaRemoteState,
} from "../cloud-replica-client";
import { DatabaseCloudReplicaState } from "../cloud-replica-state";
import { runMigrations } from "../db/migrations";

const databases: Database.Database[] = [];
const directories: string[] = [];

function publicKey(): string {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  if (typeof jwk.x !== "string") throw new Error("missing public key");
  return jwk.x;
}

async function localFixture(
  manifestRevision = 1,
  ignorePolicy: unknown = { version: 1 },
) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  databases.push(db);
  const parent = await mkdtemp(path.join(os.tmpdir(), "zeros-replica-broker-"));
  directories.push(parent);
  const rootPath = path.join(parent, "workspace");
  const state = new DatabaseCloudReplicaState(db);
  const accountUserId = randomUUID();
  const deviceId = randomUUID();
  state.recordRegistration({
    accountUserId,
    deviceId,
    keyVersion: 1,
    publicKey: publicKey(),
  });
  const ids = {
    replicaId: randomUUID(),
    workspaceId: randomUUID(),
    organizationId: randomUUID(),
    checkpointId: randomUUID(),
  };
  state.createReplica({
    ...ids,
    accountUserId,
    deviceId,
    rootPath,
    manifestRevision,
    workspaceAuthorityEpoch: 1,
    grantEpoch: 1,
    ignorePolicy,
  });
  return { db, state, rootPath, accountUserId, deviceId, ...ids };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function descriptor(
  pathValue: string,
  bytes: Buffer,
  blobId = randomUUID(),
): Omit<CloudReplicaMutation, "revision" | "sequence"> {
  return {
    path: pathValue,
    operation: "upsert",
    entryType: "file",
    mode: 33188,
    blobId,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

function bootstrapManifestInput(
  document: unknown,
  page: Partial<{
    fileCount: number;
    totalBytes: number;
    gitBaseCommit: string | null;
    gitHeadRef: string | null;
  }> = {},
) {
  const serialized = JSON.stringify(document);
  if (typeof serialized !== "string") {
    throw new Error("bootstrap manifest test document must serialize");
  }
  const bytes = Buffer.from(serialized, "utf8");
  return {
    bytes,
    page: {
      integritySha256: createHash("sha256").update(bytes).digest("hex"),
      fileCount: 1,
      totalBytes: 1,
      gitBaseCommit: null,
      gitHeadRef: null,
      ...page,
    },
  };
}

function checkpointManifestEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path: "entry.txt",
    entryType: "file",
    mode: 33188,
    contentSha256: "a".repeat(64),
    sizeBytes: 1,
    ...overrides,
  };
}

function checkpointManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
    gitBaseCommit: null,
    gitHeadRef: null,
    entries: [checkpointManifestEntry()],
    deletions: [],
    ...overrides,
  };
}

class FakeReplicaApi implements CloudReplicaApi {
  readonly blobs = new Map<string, Uint8Array>();
  bootstrapPage!: CloudReplicaBootstrapPage;
  /** A test can replace this with a signed-but-wrong projection descriptor. */
  bootstrapManifestBytes: Uint8Array | null = null;
  eventPages: CloudReplicaEventPage[] = [];
  receiptCalls = 0;
  loseNextReceiptResponse = false;
  refreshedPage: CloudReplicaBootstrapPage | null = null;

  constructor(public remote: CloudReplicaRemoteState) {}

  private grant(): CloudReplicaGrant {
    return {
      token: `zwr_${Buffer.alloc(32, this.remote.grantEpoch).toString("base64url")}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async renewGrant() {
    return { replica: { ...this.remote }, grant: this.grant() };
  }

  async refreshSnapshot() {
    if (!this.refreshedPage) throw new Error("no refreshed checkpoint");
    this.remote = {
      ...this.remote,
      checkpointId: this.refreshedPage.checkpointId,
      manifestRevision: this.refreshedPage.manifestRevision,
      eventCursor: 0,
      grantEpoch: this.remote.grantEpoch + 1,
      observedState: "bootstrapping",
      clientManifestSha256: null,
    };
    this.bootstrapPage = this.refreshedPage;
    return { replica: { ...this.remote }, grant: this.grant() };
  }

  async readBootstrap() {
    const page = this.bootstrapPage;
    const manifest =
      this.bootstrapManifestBytes ??
      Buffer.from(
        JSON.stringify({
          version: 1,
          audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
          gitBaseCommit: page.gitBaseCommit ?? null,
          gitHeadRef: page.gitHeadRef ?? null,
          entries: page.entries
            .filter((entry) => entry.operation === "upsert")
            .map((entry) => ({
              path: entry.path,
              entryType: entry.entryType,
              mode: entry.mode,
              contentSha256: entry.contentSha256,
              sizeBytes: entry.sizeBytes,
            })),
          deletions: page.entries
            .filter((entry) => entry.operation === "delete")
            .map((entry) => entry.path),
        }),
        "utf8",
      );
    this.blobs.set(page.manifestBlobId, manifest);
    return {
      ...page,
      integritySha256: createHash("sha256").update(manifest).digest("hex"),
    };
  }

  async readEvents(input: Parameters<CloudReplicaApi["readEvents"]>[0]) {
    const next = this.eventPages.shift();
    if (next) return next;
    return {
      currentRevision: this.remote.eventCursor,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: input.afterRevision,
      toRevision: input.afterRevision,
      events: [],
      hasMore: false,
    };
  }

  async readBlob(input: Parameters<CloudReplicaApi["readBlob"]>[0]) {
    const bytes = this.blobs.get(input.blobId);
    if (
      !bytes ||
      (input.expectedSizeBytes !== undefined &&
        bytes.byteLength !== input.expectedSizeBytes)
    ) {
      throw new Error("missing fake blob");
    }
    return bytes;
  }

  async recordReceipt(input: Parameters<CloudReplicaApi["recordReceipt"]>[0]) {
    this.receiptCalls += 1;
    if (input.outcome === "applied") {
      this.remote = {
        ...this.remote,
        eventCursor: input.toRevision,
        clientManifestSha256: input.manifestSha256,
        observedState: "in_sync",
        lastErrorCode: null,
      };
    } else {
      this.remote = {
        ...this.remote,
        observedState: input.outcome === "diverged" ? "diverged" : "failed",
        lastErrorCode: input.errorCode,
        grantEpoch:
          input.outcome === "diverged"
            ? this.remote.grantEpoch + 1
            : this.remote.grantEpoch,
      };
    }
    if (this.loseNextReceiptResponse) {
      this.loseNextReceiptResponse = false;
      throw new Error("response lost after commit");
    }
    return { replica: { ...this.remote }, replayed: false };
  }
}

function remoteFor(
  fixture: Awaited<ReturnType<typeof localFixture>>,
): CloudReplicaRemoteState {
  return {
    id: fixture.replicaId,
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    deviceId: fixture.deviceId,
    mode: "receive_only",
    desiredState: "active",
    observedState: "bootstrapping",
    workspaceAuthorityEpoch: 1,
    grantEpoch: 1,
    checkpointId: fixture.checkpointId,
    manifestRevision: 1,
    eventCursor: 0,
    ignorePolicySha256: "a".repeat(64),
    clientManifestSha256: null,
    lastErrorCode: null,
  };
}

describe("cloud replica receive-only broker", () => {
  it("keeps the documented local-to-cloud legacy descriptor compatible", () => {
    expect(
      parseBootstrapManifest(
        bootstrapManifestInput({
          audience: "zeros-local-to-cloud-fork-v1",
          forkIntentId: randomUUID(),
          sourceLocalWorkspaceId: randomUUID(),
          sourceRevision: 1,
          sourceSnapshotSha256: "a".repeat(64),
          gitBaseCommit: "b".repeat(40),
          gitHeadRef: "refs/heads/main",
          targetCloudWorkspaceId: randomUUID(),
          entryCount: 1,
          fileCount: 1,
          totalBytes: 1,
          recordCount: 0,
        }),
      ),
    ).toEqual({ kind: "legacy" });
  });

  it.each([
    ["a missing audience", undefined],
    ["an unknown audience", "zeros-unrecognized-checkpoint-v1"],
  ])(
    "rejects %s instead of treating it as a legacy descriptor",
    (_, audience) => {
      const document = checkpointManifest();
      if (audience === undefined) delete document.audience;
      else document.audience = audience;

      expect(() =>
        parseBootstrapManifest(bootstrapManifestInput(document)),
      ).toThrowError(
        expect.objectContaining({ code: "remote_protocol_error" }),
      );
    },
  );

  it.each([
    ["gitBaseCommit", {}],
    ["gitBaseCommit", []],
    ["gitHeadRef", {}],
    ["gitHeadRef", []],
    ["entryType", {}],
    ["entryType", []],
    ["mode", {}],
    ["mode", []],
  ])("fails closed for an object or array %s value", (field, value) => {
    const document = checkpointManifest(
      field === "gitBaseCommit" || field === "gitHeadRef"
        ? { [field]: value }
        : { entries: [checkpointManifestEntry({ [field]: value })] },
    );

    expect(() =>
      parseBootstrapManifest(bootstrapManifestInput(document)),
    ).toThrowError(expect.objectContaining({ code: "remote_protocol_error" }));
  });

  it("bootstraps an exact checkpoint then consumes ordered event pages", async () => {
    const fixture = await localFixture();
    const initial = Buffer.from("checkpoint\n", "utf8");
    const next = Buffer.from("event\n", "utf8");
    const first = descriptor("src/value.ts", initial);
    const second = descriptor("src/value.ts", next);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(first.blobId!, initial);
    api.blobs.set(second.blobId!, next);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "b".repeat(64),
      fileCount: 1,
      totalBytes: initial.length,
      entries: [first],
      nextAfterPath: null,
    };
    api.eventPages.push({
      currentRevision: 2,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: 1,
      toRevision: 2,
      events: [{ ...second, revision: 2, sequence: 1 }],
      hasMore: false,
    });
    const result = await new CloudReplicaSyncBroker(api, fixture.state).sync(
      fixture.replicaId,
    );
    expect(result).toMatchObject({ eventCursor: 2, observedState: "in_sync" });
    expect(
      await readFile(path.join(fixture.rootPath, "src/value.ts"), "utf8"),
    ).toBe("event\n");
    expect(api.receiptCalls).toBe(2);
  });

  it("recovers a receipt response lost after the server committed", async () => {
    const fixture = await localFixture();
    const bytes = Buffer.from("already applied\n", "utf8");
    const entry = descriptor("value.txt", bytes);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(entry.blobId!, bytes);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "c".repeat(64),
      fileCount: 1,
      totalBytes: bytes.length,
      entries: [entry],
      nextAfterPath: null,
    };
    api.loseNextReceiptResponse = true;
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    await expect(broker.sync(fixture.replicaId)).rejects.toThrow(
      "response lost after commit",
    );
    expect(fixture.state.replica(fixture.replicaId)?.eventCursor).toBe(0);
    await expect(broker.sync(fixture.replicaId)).resolves.toMatchObject({
      eventCursor: 1,
      observedState: "in_sync",
    });
    expect(
      await readFile(path.join(fixture.rootPath, "value.txt"), "utf8"),
    ).toBe("already applied\n");
  });

  it("keeps a local divergence visible while adopting a response-lost cursor", async () => {
    const fixture = await localFixture(0);
    fixture.state.projection(fixture.replicaId).divergence({
      path: "edited.ts",
      expectedSha256: "a".repeat(64),
      observedSha256: "b".repeat(64),
      cloudSha256: "c".repeat(64),
    });
    const projectionHash = fixture.state
      .projection(fixture.replicaId)
      .manifestSha256();
    const api = new FakeReplicaApi({
      ...remoteFor(fixture),
      observedState: "in_sync",
      manifestRevision: 0,
      eventCursor: 1,
      clientManifestSha256: projectionHash,
    });

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).resolves.toMatchObject({
      eventCursor: 1,
      observedState: "diverged",
      lastErrorCode: "local_content_changed",
    });
  });

  it("rejects a stale renewal before adopting its cursor or caching its grant", async () => {
    const fixture = await localFixture(0);
    fixture.state.updateRemoteState({
      replicaId: fixture.replicaId,
      desiredState: "active",
      observedState: "in_sync",
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      checkpointId: fixture.checkpointId,
      manifestRevision: 0,
    });
    const api = new FakeReplicaApi({
      ...remoteFor(fixture),
      observedState: "in_sync",
      manifestRevision: 0,
      eventCursor: 1,
      clientManifestSha256: fixture.state
        .projection(fixture.replicaId)
        .manifestSha256(),
    });
    let renewCalls = 0;
    const originalRenew = api.renewGrant.bind(api);
    api.renewGrant = async () => {
      renewCalls += 1;
      return originalRenew();
    };
    const broker = new CloudReplicaSyncBroker(api, fixture.state);

    await expect(broker.sync(fixture.replicaId)).rejects.toMatchObject({
      code: "cursor_conflict",
    });
    expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
      eventCursor: 0,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      clientManifestSha256: null,
    });

    api.remote = {
      ...remoteFor(fixture),
      observedState: "in_sync",
      manifestRevision: 0,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
    };
    await expect(broker.sync(fixture.replicaId)).resolves.toMatchObject({
      eventCursor: 0,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
    });
    expect(renewCalls).toBe(2);
  });

  it("rejects a stale receipt before advancing local receipt state", async () => {
    const fixture = await localFixture();
    fixture.state.updateRemoteState({
      replicaId: fixture.replicaId,
      desiredState: "active",
      observedState: "bootstrapping",
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
    });
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "0".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      nextAfterPath: null,
    };
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    broker.seedGrant(fixture.replicaId, {
      token: `zwr_${"r".repeat(43)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });

    await expect(broker.sync(fixture.replicaId)).rejects.toMatchObject({
      code: "cursor_conflict",
    });
    expect(api.receiptCalls).toBe(1);
    expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
      eventCursor: 0,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      clientManifestSha256: null,
    });
  });

  it("rejects a stale snapshot before resetting state or seeding its grant", async () => {
    const fixture = await localFixture();
    const existingBytes = Buffer.from("retained projection\n", "utf8");
    const existingSha256 = createHash("sha256")
      .update(existingBytes)
      .digest("hex");
    await mkdir(fixture.rootPath, { recursive: true });
    await writeFile(path.join(fixture.rootPath, "retained.txt"), existingBytes);
    fixture.state.projection(fixture.replicaId).commitEntry({
      path: "retained.txt",
      portablePathKey: "retained.txt",
      revision: 1,
      entryType: "file",
      mode: 33188,
      contentSha256: existingSha256,
      sizeBytes: existingBytes.length,
    });
    fixture.state.advanceReceipt({
      replicaId: fixture.replicaId,
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: fixture.state
        .projection(fixture.replicaId)
        .manifestSha256(),
      observedState: "in_sync",
    });
    fixture.state.updateRemoteState({
      replicaId: fixture.replicaId,
      desiredState: "active",
      observedState: "in_sync",
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
    });
    const api = new FakeReplicaApi({
      ...remoteFor(fixture),
      observedState: "in_sync",
      eventCursor: 1,
    });
    api.eventPages.push({
      currentRevision: 3,
      minimumRetainedRevision: 2,
      snapshotRequired: true,
      fromRevision: 1,
      toRevision: 1,
      events: [],
      hasMore: false,
    });
    const staleCheckpointId = randomUUID();
    api.refreshSnapshot = async () => ({
      replica: {
        ...remoteFor(fixture),
        checkpointId: staleCheckpointId,
        manifestRevision: 3,
        observedState: "bootstrapping",
      },
      grant: {
        token: `zwr_${"n".repeat(43)}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
    });
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    broker.seedGrant(fixture.replicaId, {
      token: `zwr_${"c".repeat(43)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const seedGrant = vi.spyOn(broker, "seedGrant");

    await expect(broker.sync(fixture.replicaId)).rejects.toMatchObject({
      code: "cursor_conflict",
    });
    expect(seedGrant).not.toHaveBeenCalled();
    expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      eventCursor: 1,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
    });
    expect(fixture.state.projectionEntries(fixture.replicaId)).toEqual([
      expect.objectContaining({ path: "retained.txt", revision: 1 }),
    ]);
    await expect(
      readFile(path.join(fixture.rootPath, "retained.txt"), "utf8"),
    ).resolves.toBe("retained projection\n");
  });

  it("advances across a durable content revision with no file mutations", async () => {
    const fixture = await localFixture();
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "9".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      nextAfterPath: null,
    };
    api.eventPages.push({
      currentRevision: 2,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: 1,
      toRevision: 2,
      events: [],
      hasMore: false,
    });

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).resolves.toMatchObject({ eventCursor: 2, observedState: "in_sync" });
    expect(api.receiptCalls).toBe(2);
  });

  it("refuses a malformed event sequence before it can advance the local cursor", async () => {
    const fixture = await localFixture();
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "9".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      nextAfterPath: null,
    };
    api.eventPages.push({
      currentRevision: 2,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: 1,
      toRevision: 2,
      events: [
        {
          ...descriptor("bad-sequence.txt", Buffer.from("bad")),
          revision: 2,
          sequence: 2,
        },
      ],
      hasMore: false,
    });

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).rejects.toMatchObject({ code: "remote_protocol_error" });
    expect(fixture.state.replica(fixture.replicaId)?.eventCursor).toBe(1);
  });

  it("refuses a signed bootstrap manifest whose path projection differs from the page", async () => {
    const fixture = await localFixture();
    const bytes = Buffer.from("checkpoint", "utf8");
    const entry = descriptor("src/real.ts", bytes);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(entry.blobId!, bytes);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "0".repeat(64),
      fileCount: 1,
      totalBytes: bytes.length,
      entries: [entry],
      nextAfterPath: null,
    };
    api.bootstrapManifestBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
        gitBaseCommit: null,
        gitHeadRef: null,
        entries: [
          {
            path: "src/substituted.ts",
            entryType: "file",
            mode: 33188,
            contentSha256: entry.contentSha256,
            sizeBytes: bytes.length,
          },
        ],
        deletions: [],
      }),
      "utf8",
    );

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).rejects.toMatchObject({ code: "remote_protocol_error" });
    expect(fixture.state.projectionEntries(fixture.replicaId)).toEqual([]);
    await expect(
      readFile(path.join(fixture.rootPath, "src/real.ts")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a signed bootstrap manifest whose mode differs with the same blob hash and totals", async () => {
    const fixture = await localFixture();
    const bytes = Buffer.from("checkpoint", "utf8");
    const entry = descriptor("src/executable.ts", bytes);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(entry.blobId!, bytes);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "0".repeat(64),
      fileCount: 1,
      totalBytes: bytes.length,
      entries: [entry],
      nextAfterPath: null,
    };
    api.bootstrapManifestBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
        gitBaseCommit: null,
        gitHeadRef: null,
        entries: [
          {
            path: entry.path,
            entryType: "file",
            mode: 33261,
            contentSha256: entry.contentSha256,
            sizeBytes: bytes.length,
          },
        ],
        deletions: [],
      }),
      "utf8",
    );

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).rejects.toMatchObject({ code: "remote_protocol_error" });
    expect(fixture.state.projectionEntries(fixture.replicaId)).toEqual([]);
  });

  it("refuses a signed bootstrap manifest whose deletion differs with unchanged counts", async () => {
    const fixture = await localFixture();
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "0".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries: [
        {
          path: "removed-by-page.ts",
          operation: "delete",
          entryType: null,
          mode: null,
          blobId: null,
          contentSha256: null,
          sizeBytes: null,
        },
      ],
      nextAfterPath: null,
    };
    api.bootstrapManifestBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
        gitBaseCommit: null,
        gitHeadRef: null,
        entries: [],
        deletions: ["other-deletion.ts"],
      }),
      "utf8",
    );

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).rejects.toMatchObject({ code: "remote_protocol_error" });
    expect(fixture.state.projectionEntries(fixture.replicaId)).toEqual([]);
  });

  it("cancels a stale bootstrap before it can publish a receipt or projection", async () => {
    const fixture = await localFixture();
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "0".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      nextAfterPath: null,
    };
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      const original = api.readBootstrap.bind(api);
      api.readBootstrap = async () => {
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
        return original();
      };
    });
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    const work = broker.sync(fixture.replicaId);
    await started;
    let drained = false;
    const drain = broker.cancelAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();

    await expect(work).rejects.toMatchObject({ code: "cancelled" });
    await drain;
    expect(drained).toBe(true);
    expect(api.receiptCalls).toBe(0);
    expect(fixture.state.projectionEntries(fixture.replicaId)).toEqual([]);
  });

  it("refreshes from a current durable snapshot after retention creates a gap", async () => {
    const fixture = await localFixture();
    const oldBytes = Buffer.from("old\n", "utf8");
    const oldEntry = descriptor("old.txt", oldBytes);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(oldEntry.blobId!, oldBytes);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "d".repeat(64),
      fileCount: 1,
      totalBytes: oldBytes.length,
      entries: [oldEntry],
      nextAfterPath: null,
    };
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    await broker.sync(fixture.replicaId);

    const replacement = Buffer.from("new snapshot\n", "utf8");
    const newEntry = descriptor("new.txt", replacement);
    api.blobs.set(newEntry.blobId!, replacement);
    const checkpointId = randomUUID();
    api.refreshedPage = {
      checkpointId,
      manifestRevision: 3,
      manifestBlobId: randomUUID(),
      integritySha256: "e".repeat(64),
      fileCount: 1,
      totalBytes: replacement.length,
      entries: [newEntry],
      nextAfterPath: null,
    };
    api.eventPages.push({
      currentRevision: 3,
      minimumRetainedRevision: 2,
      snapshotRequired: true,
      fromRevision: 1,
      toRevision: 1,
      events: [],
      hasMore: false,
    });
    await expect(broker.sync(fixture.replicaId)).resolves.toMatchObject({
      checkpointId,
      eventCursor: 3,
    });
    await expect(
      readFile(path.join(fixture.rootPath, "old.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(fixture.rootPath, "new.txt"), "utf8")).toBe(
      "new snapshot\n",
    );
  });

  it("preserves a local edit and reports divergence instead of overwriting", async () => {
    const fixture = await localFixture();
    const initial = Buffer.from("checkpoint\n", "utf8");
    const next = Buffer.from("cloud next\n", "utf8");
    const first = descriptor("value.txt", initial);
    const second = descriptor("value.txt", next);
    const api = new FakeReplicaApi(remoteFor(fixture));
    api.blobs.set(first.blobId!, initial);
    api.blobs.set(second.blobId!, next);
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "f".repeat(64),
      fileCount: 1,
      totalBytes: initial.length,
      entries: [first],
      nextAfterPath: null,
    };
    const broker = new CloudReplicaSyncBroker(api, fixture.state);
    await broker.sync(fixture.replicaId);
    await writeFile(path.join(fixture.rootPath, "value.txt"), "local edit\n");
    api.eventPages.push({
      currentRevision: 2,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: 1,
      toRevision: 2,
      events: [{ ...second, revision: 2, sequence: 1 }],
      hasMore: false,
    });
    await expect(broker.sync(fixture.replicaId)).rejects.toBeInstanceOf(
      CloudReplicaBrokerError,
    );
    expect(
      await readFile(path.join(fixture.rootPath, "value.txt"), "utf8"),
    ).toBe("local edit\n");
    expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
      observedState: "diverged",
      eventCursor: 1,
    });
  });

  it("acknowledges custom-excluded paths while applying a sparse final revision", async () => {
    const fixture = await localFixture(1, {
      version: 1,
      excludePrefixes: ["generated"],
    });
    const initial = Buffer.from("initial\n", "utf8");
    const ignoredInitial = Buffer.from("generated initial\n", "utf8");
    const next = Buffer.from("next\n", "utf8");
    const ignoredNext = Buffer.from("generated next\n", "utf8");
    const first = descriptor("src/value.ts", initial);
    const ignoredFirst = descriptor("generated/value.ts", ignoredInitial);
    const second = descriptor("src/value.ts", next);
    const ignoredSecond = descriptor("generated/value.ts", ignoredNext);
    const api = new FakeReplicaApi(remoteFor(fixture));
    for (const [entry, bytes] of [
      [first, initial],
      [ignoredFirst, ignoredInitial],
      [second, next],
      [ignoredSecond, ignoredNext],
    ] as const) {
      api.blobs.set(entry.blobId!, bytes);
    }
    api.bootstrapPage = {
      checkpointId: fixture.checkpointId,
      manifestRevision: 1,
      manifestBlobId: randomUUID(),
      integritySha256: "a".repeat(64),
      fileCount: 2,
      totalBytes: initial.length + ignoredInitial.length,
      entries: [ignoredFirst, first],
      nextAfterPath: null,
    };
    api.eventPages.push({
      currentRevision: 3,
      minimumRetainedRevision: 0,
      snapshotRequired: false,
      fromRevision: 1,
      toRevision: 3,
      events: [
        { ...second, revision: 2, sequence: 1 },
        { ...ignoredSecond, revision: 3, sequence: 1 },
      ],
      hasMore: false,
    });

    await expect(
      new CloudReplicaSyncBroker(api, fixture.state).sync(fixture.replicaId),
    ).resolves.toMatchObject({ eventCursor: 3, observedState: "in_sync" });
    expect(
      await readFile(path.join(fixture.rootPath, "src/value.ts"), "utf8"),
    ).toBe("next\n");
    await expect(
      readFile(path.join(fixture.rootPath, "generated/value.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
