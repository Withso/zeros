import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CloudReplicaDeviceSigner,
  createCloudReplicaDeviceCredential,
} from "../cloud-replica-device";
import { CloudReplicaSyncBroker } from "../cloud-replica-broker";
import {
  parseCloudReplicaDeviceRegistered,
  parseCloudReplicaHostSessionMessage,
  parseCloudReplicaProofRequest,
  parseCloudReplicaProofResponse,
  type CloudReplicaHostSession,
} from "../cloud-replica-host-control";
import {
  cloudReplicaDetachmentCode,
  CloudReplicaRuntime,
  preserveCloudReplicaDivergences,
  selectFairCloudReplicaBatch,
  validateCloudReplicaDestination,
  type CloudReplicaRuntimeDependencies,
} from "../cloud-replica-runtime";
import {
  CloudReplicaClientError,
  type CloudWorkspaceDesktopApi,
} from "../cloud-replica-client";
import {
  DatabaseCloudReplicaState,
  type CloudReplicaLocalState,
} from "../cloud-replica-state";
import { runMigrations } from "../db/migrations";

const databases: Database.Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

async function activeRuntimeFixture(
  manifestRevision = 0,
  dependencies: Partial<CloudReplicaRuntimeDependencies> = {},
) {
  const db = new Database(":memory:");
  databases.push(db);
  runMigrations(db);
  const root = await mkdtemp(
    path.join(tmpdir(), "zeros-cloud-replica-runtime-"),
  );
  roots.push(root);
  const accountUserId = randomUUID();
  const deviceId = randomUUID();
  const replicaId = randomUUID();
  const workspaceId = randomUUID();
  const organizationId = randomUUID();
  const checkpointId = randomUUID();
  const credential = createCloudReplicaDeviceCredential(accountUserId);
  const state = new DatabaseCloudReplicaState(db);
  state.recordRegistration({
    accountUserId,
    deviceId,
    keyVersion: 1,
    publicKey: credential.publicKey,
  });
  state.createReplica({
    replicaId,
    workspaceId,
    organizationId,
    accountUserId,
    deviceId,
    rootPath: root,
    checkpointId,
    manifestRevision,
    workspaceAuthorityEpoch: 1,
    grantEpoch: 1,
    ignorePolicy: { version: 1 },
  });
  const session: CloudReplicaHostSession = {
    version: 1,
    accountUserId,
    accessToken: "header.payload.signature",
    expiresAtMs: 60_000,
    baseUrl: "http://127.0.0.1:9999",
    allowInsecureLoopback: true,
    device: {
      deviceId,
      keyVersion: 1,
      publicKey: credential.publicKey,
    },
  };
  const runtime = new CloudReplicaRuntime(db, {
    emitHostControl: () => undefined,
    syncIntervalMs: 300_000,
    now: () => 1_000,
    ...dependencies,
  });
  return {
    runtime,
    state,
    session,
    root,
    accountUserId,
    deviceId,
    replicaId,
    workspaceId,
    organizationId,
    checkpointId,
  };
}

describe("desktop cloud replica runtime", () => {
  it("retries a transient unreadable projection without recording a local edit", async () => {
    const transient = Object.assign(new Error("temporarily unreadable"), {
      code: "EACCES",
    });
    const fixture = await activeRuntimeFixture(1, {
      inspectEntry: async () => {
        throw transient;
      },
    });
    const relativePath = "blocked/entry.txt";
    const bytes = Buffer.from("projected contents\n");
    fixture.state.projection(fixture.replicaId).commitEntry({
      path: relativePath,
      portablePathKey: relativePath,
      revision: 1,
      entryType: "file",
      mode: 33188,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    });
    try {
      const local = fixture.state.replica(fixture.replicaId)!;
      await expect(
        (
          fixture.runtime as unknown as {
            scanLocalProjection(value: CloudReplicaLocalState): Promise<void>;
          }
        ).scanLocalProjection(local),
      ).rejects.toBe(transient);
      expect(fixture.state.openDivergences(fixture.replicaId)).toEqual([]);
    } finally {
      await fixture.runtime.dispose();
    }
  });

  it("round-robins more than four due replicas instead of starving the fifth", () => {
    const replicas = ["a", "b", "c", "d", "e", "f"].map((replicaId) => ({
      replicaId,
    }));
    const first = selectFairCloudReplicaBatch(replicas, null, 4);
    expect(first.replicas.map((replica) => replica.replicaId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    const second = selectFairCloudReplicaBatch(replicas, first.cursor, 4);
    expect(second.replicas.map((replica) => replica.replicaId)).toEqual([
      "e",
      "f",
      "a",
      "b",
    ]);
  });

  it("classifies permanent remote authority loss as local detachment", () => {
    expect(
      cloudReplicaDetachmentCode(
        new CloudReplicaClientError(404, "workspace_replica_not_found", "gone"),
      ),
    ).toBe("workspace_deleted");
    expect(
      cloudReplicaDetachmentCode(
        new CloudReplicaClientError(
          403,
          "cloud_organization_entitlement_required",
          "cancelled",
        ),
      ),
    ).toBe("cloud_entitlement_inactive");
    expect(
      cloudReplicaDetachmentCode(
        new CloudReplicaClientError(503, "request_failed", "retry"),
      ),
    ).toBeNull();
  });

  it("requires an empty real directory for a new receive-only replica", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-replica-root-"),
    );
    roots.push(root);
    await expect(
      validateCloudReplicaDestination(root, { allowPopulated: false }),
    ).resolves.toBe(root);
    await writeFile(path.join(root, "local.txt"), "do not overwrite\n");
    await expect(
      validateCloudReplicaDestination(root, { allowPopulated: false }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      validateCloudReplicaDestination(root, { allowPopulated: true }),
    ).resolves.toBe(root);
  });

  it("never follows a nested recovery-directory symlink while preserving divergence", async () => {
    const sandbox = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-replica-preserve-"),
    );
    roots.push(sandbox);
    const root = path.join(sandbox, "workspace");
    const external = path.join(sandbox, "outside");
    const replicaId = randomUUID();
    const detectedAt = 1234;
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(external);
    await writeFile(path.join(root, "src", "changed.txt"), "local change\n");
    const backupRoot = `${root}.zeros-local-changes`;
    await mkdir(path.join(backupRoot, replicaId), { recursive: true });
    await symlink(
      external,
      path.join(backupRoot, replicaId, String(detectedAt)),
    );

    await expect(
      preserveCloudReplicaDivergences({
        rootPath: root,
        replicaId,
        divergences: [
          {
            path: "src/changed.txt",
            detectedAt,
            observedSha256: "a".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow("unsafe");

    await expect(
      readFile(path.join(root, "src", "changed.txt"), "utf8"),
    ).resolves.toBe("local change\n");
    await expect(
      lstat(path.join(external, "src", "changed.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enrolls deterministically and delegates signatures without exporting the private key", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    runMigrations(db);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    const credential = createCloudReplicaDeviceCredential(accountUserId);
    const fingerprint = createHash("sha256")
      .update(Buffer.from(credential.publicKey, "base64url"))
      .digest("hex");
    const emitted: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = new CloudReplicaRuntime(db, {
      emitHostControl: (line) => emitted.push(line),
      syncIntervalMs: 300_000,
      now: () => 1_000,
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return jsonResponse({
          device: {
            id: deviceId,
            label: "Test Mac",
            platform: "macos",
            keyAlgorithm: "ed25519",
            keyFingerprint: fingerprint,
            keyVersion: 1,
            trustState: "trusted",
          },
          replayed: false,
        });
      },
      deviceLabel: "Test Mac",
      platform: "macos",
    });
    const unbound = {
      version: 1 as const,
      accountUserId,
      accessToken: "header.payload.signature",
      expiresAtMs: 60_000,
      baseUrl: "http://127.0.0.1:9999",
      allowInsecureLoopback: true,
      device: {
        deviceId: null,
        keyVersion: 1,
        publicKey: credential.publicKey,
      },
    };
    await runtime.updateSession(unbound);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:9999/v1/devices");
    expect(requests[0]!.init?.headers).toMatchObject({
      authorization: "Bearer header.payload.signature",
    });
    const registration = parseCloudReplicaDeviceRegistered(
      JSON.parse(emitted.shift()!.trim()),
    );
    expect(registration).toMatchObject({
      accountUserId,
      deviceId,
      publicKey: credential.publicKey,
      keyFingerprint: fingerprint,
    });
    expect(JSON.stringify(registration)).not.toContain(credential.privateKey);

    await runtime.updateSession({
      ...unbound,
      device: { ...unbound.device, deviceId },
    });
    const proofPromise = runtime.requestHostProof({
      accountUserId,
      deviceId,
      keyVersion: 1,
      action: "replica.grant",
      payload: { replicaId: randomUUID() },
    });
    const request = parseCloudReplicaProofRequest(
      JSON.parse(emitted.shift()!.trim()),
    );
    expect(request).not.toBeNull();
    expect(JSON.stringify(request)).not.toContain(credential.privateKey);
    const proof = new CloudReplicaDeviceSigner({
      ...credential,
      deviceId,
    }).proof(request!.action, request!.payload, 1_000);
    expect(
      runtime.handleProofResponse({
        type: "host.cloudReplicaProofResponse",
        requestId: request!.requestId,
        proof,
        errorCode: null,
      }),
    ).toBe(true);
    await expect(proofPromise).resolves.toMatchObject({
      deviceId,
      keyVersion: 1,
    });
    await runtime.dispose();
  });

  it("drains an active sync before pausing its remote replica", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    runMigrations(db);
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-replica-pause-race-"),
    );
    roots.push(root);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    const replicaId = randomUUID();
    const workspaceId = randomUUID();
    const organizationId = randomUUID();
    const checkpointId = randomUUID();
    const credential = createCloudReplicaDeviceCredential(accountUserId);
    const state = new DatabaseCloudReplicaState(db);
    state.recordRegistration({
      accountUserId,
      deviceId,
      keyVersion: 1,
      publicKey: credential.publicKey,
    });
    state.createReplica({
      replicaId,
      workspaceId,
      organizationId,
      accountUserId,
      deviceId,
      rootPath: root,
      checkpointId,
      manifestRevision: 1,
      workspaceAuthorityEpoch: 1,
      grantEpoch: 1,
      ignorePolicy: { version: 1 },
    });
    const session: CloudReplicaHostSession = {
      version: 1,
      accountUserId,
      accessToken: "header.payload.signature",
      expiresAtMs: 60_000,
      baseUrl: "http://127.0.0.1:9999",
      allowInsecureLoopback: true,
      device: {
        deviceId,
        keyVersion: 1,
        publicKey: credential.publicKey,
      },
    };
    let stateChangeCalls = 0;
    const api = {
      changeReplicaState: async (input: {
        operation: "pause" | "resume" | "remove";
      }) => {
        stateChangeCalls += 1;
        const desiredState =
          input.operation === "remove"
            ? ("removed" as const)
            : input.operation === "pause"
              ? ("paused" as const)
              : ("active" as const);
        return {
          replica: {
            id: replicaId,
            workspaceId,
            organizationId,
            deviceId,
            mode: "receive_only" as const,
            desiredState,
            observedState: desiredState,
            workspaceAuthorityEpoch: input.operation === "remove" ? 3 : 2,
            grantEpoch: input.operation === "remove" ? 3 : 2,
            checkpointId,
            manifestRevision: 1,
            eventCursor: 0,
            ignorePolicySha256: null,
            clientManifestSha256: null,
            lastErrorCode: null,
          },
          grant: null,
          replayed: stateChangeCalls > 2,
        };
      },
    } as unknown as CloudWorkspaceDesktopApi;
    const broker = new CloudReplicaSyncBroker(api, state, () => 1_000);
    let drainStarted!: () => void;
    let releaseDrain!: () => void;
    const started = new Promise<void>((resolve) => {
      drainStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    broker.cancelAndDrain = async () => {
      broker.cancel();
      drainStarted();
      await release;
    };
    const runtime = new CloudReplicaRuntime(db, {
      emitHostControl: () => undefined,
      syncIntervalMs: 300_000,
      now: () => 1_000,
    });
    const internals = runtime as unknown as {
      session: CloudReplicaHostSession | null;
      api: CloudWorkspaceDesktopApi | null;
      broker: CloudReplicaSyncBroker | null;
    };
    internals.session = session;
    internals.api = api;
    internals.broker = broker;

    const pause = runtime.pause(replicaId, "pause-race-test");
    await started;
    const remove = runtime.remove(replicaId, "remove-after-pause-test");
    await Promise.resolve();
    expect(stateChangeCalls).toBe(0);
    releaseDrain();
    await expect(pause).resolves.toMatchObject({
      replicaId,
      desiredState: "paused",
    });
    await expect(remove).resolves.toMatchObject({
      replicaId,
      desiredState: "removed",
    });
    expect(stateChangeCalls).toBe(2);
    await expect(
      runtime.pause(replicaId, "pause-race-test"),
    ).rejects.toMatchObject({ code: "cursor_conflict" });
    expect(state.replica(replicaId)).toMatchObject({
      desiredState: "removed",
      workspaceAuthorityEpoch: 3,
      grantEpoch: 3,
    });
    await runtime.dispose();
  });

  it("waits for a scheduler scan that started before broker in-flight registration", async () => {
    const fixture = await activeRuntimeFixture();
    let remoteCalls = 0;
    const api = {
      changeReplicaState: async () => {
        remoteCalls += 1;
        return {
          replica: {
            id: fixture.replicaId,
            workspaceId: fixture.workspaceId,
            organizationId: fixture.organizationId,
            deviceId: fixture.deviceId,
            mode: "receive_only" as const,
            desiredState: "paused" as const,
            observedState: "paused",
            workspaceAuthorityEpoch: 2,
            grantEpoch: 2,
            checkpointId: fixture.checkpointId,
            manifestRevision: 0,
            eventCursor: 0,
            ignorePolicySha256: null,
            clientManifestSha256: null,
            lastErrorCode: null,
          },
          grant: null,
          replayed: false,
        };
      },
    } as unknown as CloudWorkspaceDesktopApi;
    const broker = new CloudReplicaSyncBroker(api, fixture.state, () => 1_000);
    let syncCalls = 0;
    const originalSync = broker.sync.bind(broker);
    broker.sync = (replicaId) => {
      syncCalls += 1;
      return originalSync(replicaId);
    };
    let scanStarted!: () => void;
    let releaseScan!: () => void;
    const started = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let drainStarted!: () => void;
    const draining = new Promise<void>((resolve) => {
      drainStarted = resolve;
    });
    const originalDrain = broker.cancelAndDrain.bind(broker);
    broker.cancelAndDrain = async () => {
      drainStarted();
      await originalDrain();
    };
    const internals = fixture.runtime as unknown as {
      session: CloudReplicaHostSession | null;
      api: CloudWorkspaceDesktopApi | null;
      broker: CloudReplicaSyncBroker | null;
      runTick(): Promise<void>;
      scanLocalProjection(local: CloudReplicaLocalState): Promise<void>;
    };
    internals.session = fixture.session;
    internals.api = api;
    internals.broker = broker;
    internals.scanLocalProjection = async () => {
      scanStarted();
      await scanGate;
    };

    const tick = internals.runTick();
    await started;
    const pause = fixture.runtime.pause(
      fixture.replicaId,
      "pause-during-scheduler-scan",
    );
    await draining;
    expect(remoteCalls).toBe(0);
    expect(syncCalls).toBe(0);
    expect(internals.broker).toBeNull();

    releaseScan();
    await tick;
    await expect(pause).resolves.toMatchObject({
      replicaId: fixture.replicaId,
      desiredState: "paused",
    });
    expect(remoteCalls).toBe(1);
    expect(syncCalls).toBe(0);
    await fixture.runtime.dispose();
  });

  it("orders pause and remove after a real manually requested sync", async () => {
    const fixture = await activeRuntimeFixture();
    let readStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const lifecycleCalls: Array<"pause" | "resume" | "remove"> = [];
    const api = {
      readEvents: async (input: { afterRevision: number }) => {
        readStarted();
        await readGate;
        return {
          currentRevision: input.afterRevision,
          minimumRetainedRevision: 0,
          snapshotRequired: false,
          fromRevision: input.afterRevision,
          toRevision: input.afterRevision,
          events: [],
          hasMore: false,
        };
      },
      changeReplicaState: async (input: {
        operation: "pause" | "resume" | "remove";
      }) => {
        lifecycleCalls.push(input.operation);
        const removed = input.operation === "remove";
        return {
          replica: {
            id: fixture.replicaId,
            workspaceId: fixture.workspaceId,
            organizationId: fixture.organizationId,
            deviceId: fixture.deviceId,
            mode: "receive_only" as const,
            desiredState: removed ? ("removed" as const) : ("paused" as const),
            observedState: removed ? "removed" : "paused",
            workspaceAuthorityEpoch: removed ? 3 : 2,
            grantEpoch: removed ? 3 : 2,
            checkpointId: fixture.checkpointId,
            manifestRevision: 0,
            eventCursor: 0,
            ignorePolicySha256: null,
            clientManifestSha256: null,
            lastErrorCode: null,
          },
          grant: null,
          replayed: false,
        };
      },
    } as unknown as CloudWorkspaceDesktopApi;
    const broker = new CloudReplicaSyncBroker(api, fixture.state, () => 1_000);
    broker.seedGrant(fixture.replicaId, {
      token: `zwr_${"s".repeat(43)}`,
      expiresAt: new Date(901_000).toISOString(),
    });
    const internals = fixture.runtime as unknown as {
      session: CloudReplicaHostSession | null;
      api: CloudWorkspaceDesktopApi | null;
      broker: CloudReplicaSyncBroker | null;
    };
    internals.session = fixture.session;
    internals.api = api;
    internals.broker = broker;

    const sync = fixture.runtime.syncNow(fixture.replicaId);
    await started;
    const pause = fixture.runtime.pause(
      fixture.replicaId,
      "pause-after-manual-sync",
    );
    const remove = fixture.runtime.remove(
      fixture.replicaId,
      "remove-after-manual-sync",
    );
    await Promise.resolve();
    expect(lifecycleCalls).toEqual([]);

    releaseRead();
    await expect(sync).resolves.toMatchObject({
      replicaId: fixture.replicaId,
      eventCursor: 0,
    });
    await expect(pause).resolves.toMatchObject({ desiredState: "paused" });
    await expect(remove).resolves.toMatchObject({ desiredState: "removed" });
    expect(lifecycleCalls).toEqual(["pause", "remove"]);
    expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
      desiredState: "removed",
      workspaceAuthorityEpoch: 3,
      grantEpoch: 3,
    });
    await fixture.runtime.dispose();
  });

  it.each(["sign-out", "account replacement"] as const)(
    "waits for a held lifecycle response during %s without applying it",
    async (transitionKind) => {
      const fixture = await activeRuntimeFixture();
      let responseStarted!: () => void;
      let releaseResponse!: () => void;
      const started = new Promise<void>((resolve) => {
        responseStarted = resolve;
      });
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const api = {
        changeReplicaState: async () => {
          responseStarted();
          await responseGate;
          return {
            replica: {
              id: fixture.replicaId,
              workspaceId: fixture.workspaceId,
              organizationId: fixture.organizationId,
              deviceId: fixture.deviceId,
              mode: "receive_only" as const,
              desiredState: "paused" as const,
              observedState: "paused",
              workspaceAuthorityEpoch: 2,
              grantEpoch: 2,
              checkpointId: fixture.checkpointId,
              manifestRevision: 0,
              eventCursor: 0,
              ignorePolicySha256: null,
              clientManifestSha256: null,
              lastErrorCode: null,
            },
            grant: null,
            replayed: false,
          };
        },
      } as unknown as CloudWorkspaceDesktopApi;
      const oldBroker = new CloudReplicaSyncBroker(
        api,
        fixture.state,
        () => 1_000,
      );
      const internals = fixture.runtime as unknown as {
        session: CloudReplicaHostSession | null;
        api: CloudWorkspaceDesktopApi | null;
        broker: CloudReplicaSyncBroker | null;
      };
      internals.session = fixture.session;
      internals.api = api;
      internals.broker = oldBroker;

      const pause = fixture.runtime.pause(
        fixture.replicaId,
        transitionKind === "sign-out"
          ? "pause-before-sign-out"
          : "pause-before-account-replacement",
      );
      void pause.catch(() => undefined);
      await started;
      const replacementAccountUserId = randomUUID();
      const replacementDeviceId = randomUUID();
      const replacementCredential = createCloudReplicaDeviceCredential(
        replacementAccountUserId,
      );
      const nextSession: CloudReplicaHostSession | null =
        transitionKind === "sign-out"
          ? null
          : {
              ...fixture.session,
              accountUserId: replacementAccountUserId,
              device: {
                deviceId: replacementDeviceId,
                keyVersion: 1,
                publicKey: replacementCredential.publicKey,
              },
            };
      let transitioned = false;
      const transition = fixture.runtime.updateSession(nextSession).then(() => {
        transitioned = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(transitioned).toBe(false);
      expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
        desiredState: "active",
        workspaceAuthorityEpoch: 1,
        grantEpoch: 1,
      });

      releaseResponse();
      await expect(pause).rejects.toMatchObject({ code: "signed_out" });
      await transition;
      expect(fixture.state.replica(fixture.replicaId)).toMatchObject({
        desiredState: "active",
        observedState: "bootstrapping",
        workspaceAuthorityEpoch: 1,
        grantEpoch: 1,
      });
      expect(internals.broker).not.toBe(oldBroker);
      if (nextSession === null) {
        expect(internals.session).toBeNull();
        expect(internals.broker).toBeNull();
      } else {
        expect(internals.session).toBe(nextSession);
        expect(internals.broker).not.toBeNull();
        expect(fixture.runtime.list()).toEqual([]);
      }
      await fixture.runtime.dispose();
    },
  );

  it("does not reset a completed replacement when its command is replayed", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    runMigrations(db);
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-replica-replace-replay-"),
    );
    roots.push(root);
    const accountUserId = randomUUID();
    const deviceId = randomUUID();
    const replicaId = randomUUID();
    const workspaceId = randomUUID();
    const organizationId = randomUUID();
    const checkpointId = randomUUID();
    const credential = createCloudReplicaDeviceCredential(accountUserId);
    const state = new DatabaseCloudReplicaState(db);
    state.recordRegistration({
      accountUserId,
      deviceId,
      keyVersion: 1,
      publicKey: credential.publicKey,
    });
    state.createReplica({
      replicaId,
      workspaceId,
      organizationId,
      accountUserId,
      deviceId,
      rootPath: root,
      checkpointId,
      manifestRevision: 1,
      workspaceAuthorityEpoch: 2,
      grantEpoch: 2,
      ignorePolicy: { version: 1 },
    });
    const projectedBytes = Buffer.from("cloud projection\n", "utf8");
    const projectedSha256 = createHash("sha256")
      .update(projectedBytes)
      .digest("hex");
    await writeFile(path.join(root, "local-edit.txt"), projectedBytes);
    state.projection(replicaId).commitEntry({
      path: "local-edit.txt",
      portablePathKey: "local-edit.txt",
      revision: 1,
      entryType: "file",
      mode: 33188,
      contentSha256: projectedSha256,
      sizeBytes: projectedBytes.length,
    });
    state.advanceReceipt({
      replicaId,
      fromRevision: 0,
      toRevision: 1,
      manifestSha256: state.projection(replicaId).manifestSha256(),
      observedState: "in_sync",
    });
    await writeFile(path.join(root, "local-edit.txt"), "keep my local edit\n");
    const session: CloudReplicaHostSession = {
      version: 1,
      accountUserId,
      accessToken: "header.payload.signature",
      expiresAtMs: 60_000,
      baseUrl: "http://127.0.0.1:9999",
      allowInsecureLoopback: true,
      device: {
        deviceId,
        keyVersion: 1,
        publicKey: credential.publicKey,
      },
    };
    let eventReads = 0;
    const api = {
      changeReplicaState: async () => ({
        replica: {
          id: replicaId,
          workspaceId,
          organizationId,
          deviceId,
          mode: "receive_only" as const,
          desiredState: "active" as const,
          observedState: "in_sync",
          workspaceAuthorityEpoch: 2,
          grantEpoch: 2,
          checkpointId,
          manifestRevision: 1,
          eventCursor: 1,
          ignorePolicySha256: null,
          clientManifestSha256: state.projection(replicaId).manifestSha256(),
          lastErrorCode: null,
        },
        grant: {
          token: `zwr_${"g".repeat(43)}`,
          expiresAt: new Date(15 * 60_000).toISOString(),
        },
        replayed: true,
      }),
      readEvents: async (input: { afterRevision: number }) => {
        eventReads += 1;
        return {
          currentRevision: input.afterRevision,
          minimumRetainedRevision: 0,
          snapshotRequired: false,
          fromRevision: input.afterRevision,
          toRevision: input.afterRevision,
          events: [],
          hasMore: false,
        };
      },
    } as unknown as CloudWorkspaceDesktopApi;
    const runtime = new CloudReplicaRuntime(db, {
      emitHostControl: () => undefined,
      syncIntervalMs: 300_000,
      now: () => 1_000,
    });
    const internals = runtime as unknown as {
      session: CloudReplicaHostSession | null;
      api: CloudWorkspaceDesktopApi | null;
      broker: CloudReplicaSyncBroker | null;
    };
    internals.session = session;
    internals.api = api;
    internals.broker = new CloudReplicaSyncBroker(api, state, () => 1_000);

    await expect(
      runtime.resume(replicaId, "replace-replay-test", true),
    ).resolves.toMatchObject({
      replicaId,
      observedState: "in_sync",
      eventCursor: 1,
    });
    expect(eventReads).toBe(1);
    await expect(
      readFile(path.join(root, "local-edit.txt"), "utf8"),
    ).resolves.toBe("keep my local edit\n");
    expect(state.replica(replicaId)).toMatchObject({
      eventCursor: 1,
      clientManifestSha256: state.projection(replicaId).manifestSha256(),
    });
    await runtime.dispose();
  });

  it("strictly parses session/proof control messages", () => {
    expect(
      parseCloudReplicaHostSessionMessage({
        type: "host.cloudReplicaSession",
        session: null,
      }),
    ).toBeNull();
    expect(
      parseCloudReplicaHostSessionMessage({
        type: "host.cloudReplicaSession",
        session: null,
        injected: true,
      }),
    ).toBeUndefined();
    expect(
      parseCloudReplicaProofResponse({
        type: "host.cloudReplicaProofResponse",
        requestId: "crp_AAAAAAAAAAAAAAAAAAAAAA",
        proof: null,
        errorCode: null,
      }),
    ).toBeNull();
  });
});
