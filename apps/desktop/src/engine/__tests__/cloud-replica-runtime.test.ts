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
import {
  parseCloudReplicaDeviceRegistered,
  parseCloudReplicaHostSessionMessage,
  parseCloudReplicaProofRequest,
  parseCloudReplicaProofResponse,
} from "../cloud-replica-host-control";
import {
  cloudReplicaDetachmentCode,
  CloudReplicaRuntime,
  preserveCloudReplicaDivergences,
  selectFairCloudReplicaBatch,
  validateCloudReplicaDestination,
} from "../cloud-replica-runtime";
import { CloudReplicaClientError } from "../cloud-replica-client";
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

describe("desktop cloud replica runtime", () => {
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
