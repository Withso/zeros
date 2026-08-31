import {
  createPublicKey,
  randomUUID,
  verify,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CloudReplicaClientError,
  HttpCloudReplicaApi,
} from "../cloud-replica-client";
import {
  cloudReplicaDeviceProofMessage,
  cloudReplicaDeviceSecretAccount,
  CloudReplicaDeviceSigner,
  createCloudReplicaDeviceCredential,
  parseCloudReplicaDeviceCredential,
} from "../cloud-replica-device";

function registeredCredential() {
  return {
    ...createCloudReplicaDeviceCredential(randomUUID()),
    deviceId: randomUUID(),
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cloud replica device possession", () => {
  it("round-trips a strict Ed25519 key and signs the coordinator proof contract", () => {
    const credential = registeredCredential();
    expect(cloudReplicaDeviceSecretAccount(credential.accountUserId)).toBe(
      `cloud_replica_device:${credential.accountUserId}`,
    );
    const parsed = parseCloudReplicaDeviceCredential(credential);
    const signer = new CloudReplicaDeviceSigner(parsed);
    const payload = { afterRevision: 3, limit: 100 };
    const proof = signer.proof("replica.events.read", payload, 1_700_000_000_000);
    expect(
      verify(
        null,
        cloudReplicaDeviceProofMessage({
          accountUserId: credential.accountUserId,
          deviceId: credential.deviceId,
          keyVersion: 1,
          action: "replica.events.read",
          timestampMs: proof.timestampMs,
          nonce: proof.nonce,
          payload,
        }),
        createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey },
          format: "jwk",
        }),
        Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(true);

    expect(() =>
      parseCloudReplicaDeviceCredential({
        ...credential,
        privateKey: createCloudReplicaDeviceCredential(randomUUID()).privateKey,
      }),
    ).toThrow(/does not match/);
  });
});

describe("cloud replica bounded HTTP client", () => {
  it.each([
    { entryType: "symlink", mode: 33188, sizeBytes: 1 },
    { entryType: "symlink", mode: 40960, sizeBytes: 4_097 },
  ])("rejects an unsafe remote entry descriptor: %o", async (descriptor) => {
    const credential = registeredCredential();
    const ids = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      replicaId: randomUUID(),
    };
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "workos-access-token",
      signer: new CloudReplicaDeviceSigner(credential),
      fetch: vi.fn<typeof fetch>(async () =>
        responseJson({
          currentRevision: 1,
          minimumRetainedRevision: 0,
          snapshotRequired: false,
          fromRevision: 0,
          toRevision: 1,
          events: [
            {
              revision: 1,
              sequence: 1,
              path: "unsafe-link",
              operation: "upsert",
              ...descriptor,
              blobId: randomUUID(),
              contentSha256: "a".repeat(64),
            },
          ],
          hasMore: false,
        }),
      ),
    });
    await expect(
      client.readEvents({
        ...ids,
        grantToken: `zwr_${Buffer.alloc(32, 4).toString("base64url")}`,
        afterRevision: 0,
        limit: 100,
      }),
    ).rejects.toThrow("Cloud replica mutation is invalid");
  });

  it("accepts a legal bootstrap page larger than the old 2 MiB ceiling", async () => {
    const credential = registeredCredential();
    const ids = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      replicaId: randomUUID(),
    };
    const checkpointId = randomUUID();
    const manifestBlobId = randomUUID();
    const entries = Array.from({ length: 700 }, (_, index) => ({
      path: `large/${String(index).padStart(4, "0")}-${"p".repeat(3_500)}`,
      operation: "delete",
      entryType: null,
      mode: null,
      blobId: null,
      contentSha256: null,
      sizeBytes: null,
    }));
    const response = JSON.stringify({
      checkpointId,
      manifestRevision: 1,
      manifestBlobId,
      integritySha256: "a".repeat(64),
      fileCount: 0,
      totalBytes: 0,
      entries,
      nextAfterPath: null,
    });
    expect(Buffer.byteLength(response)).toBeGreaterThan(2 * 1024 * 1024);
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "workos-access-token",
      signer: new CloudReplicaDeviceSigner(credential),
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(response, {
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(response)),
          },
        }),
      ),
    });

    await expect(
      client.readBootstrap({
        ...ids,
        grantToken: `zwr_${Buffer.alloc(32, 3).toString("base64url")}`,
        afterPath: null,
        limit: 700,
      }),
    ).resolves.toMatchObject({ checkpointId, entries: { length: 700 } });
  });

  it("binds every data read to WorkOS bearer, device proof, replica grant, and cursor", async () => {
    const credential = registeredCredential();
    const signer = new CloudReplicaDeviceSigner(credential);
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const replicaId = randomUUID();
    const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer workos-access-token");
      expect(headers.get("x-zeros-replica-grant")).toMatch(/^zwr_/);
      expect(headers.get("x-zeros-device-id")).toBe(credential.deviceId);
      const payload = { afterRevision: 4, limit: 100 };
      const valid = verify(
        null,
        cloudReplicaDeviceProofMessage({
          accountUserId: credential.accountUserId,
          deviceId: credential.deviceId!,
          keyVersion: 1,
          action: "replica.events.read",
          timestampMs: Number(headers.get("x-zeros-device-timestamp")),
          nonce: headers.get("x-zeros-device-nonce")!,
          payload,
        }),
        createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey },
          format: "jwk",
        }),
        Buffer.from(headers.get("x-zeros-device-signature")!, "base64url"),
      );
      expect(valid).toBe(true);
      return responseJson({
        currentRevision: 4,
        minimumRetainedRevision: 0,
        snapshotRequired: false,
        fromRevision: 4,
        toRevision: 4,
        events: [],
        hasMore: false,
      });
    });
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "workos-access-token",
      signer,
      fetch: requestFetch,
    });
    await expect(
      client.readEvents({
        organizationId,
        workspaceId,
        replicaId,
        grantToken: `zwr_${Buffer.alloc(32, 7).toString("base64url")}`,
        afterRevision: 4,
        limit: 100,
      }),
    ).resolves.toMatchObject({ fromRevision: 4, events: [] });
    expect(String(requestFetch.mock.calls[0]![0])).toBe(
      `https://api.zeros.build/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}/replicas/${replicaId}/events?afterRevision=4&limit=100`,
    );
  });

  it("signs the receipt idempotency identity and refuses an unbounded blob", async () => {
    const credential = registeredCredential();
    const signer = new CloudReplicaDeviceSigner(credential);
    const ids = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      replicaId: randomUUID(),
    };
    const remote = {
      id: ids.replicaId,
      workspaceId: ids.workspaceId,
      organizationId: ids.organizationId,
      deviceId: credential.deviceId,
      mode: "receive_only",
      desiredState: "active",
      observedState: "in_sync",
      workspaceAuthorityEpoch: 1,
      grantEpoch: 1,
      checkpointId: randomUUID(),
      manifestRevision: 1,
      eventCursor: 1,
      ignorePolicySha256: "a".repeat(64),
      clientManifestSha256: "b".repeat(64),
      lastErrorCode: null,
    };
    const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const payload = { ...body, idempotencyKey: "receipt-test-0001" };
      expect(
        verify(
          null,
          cloudReplicaDeviceProofMessage({
            accountUserId: credential.accountUserId,
            deviceId: credential.deviceId!,
            keyVersion: 1,
            action: "replica.receipt",
            timestampMs: Number(headers.get("x-zeros-device-timestamp")),
            nonce: headers.get("x-zeros-device-nonce")!,
            payload,
          }),
          createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey },
            format: "jwk",
          }),
          Buffer.from(headers.get("x-zeros-device-signature")!, "base64url"),
        ),
      ).toBe(true);
      return responseJson({ replica: remote, replayed: false });
    });
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "workos-access-token",
      signer,
      fetch: requestFetch,
    });
    await expect(
      client.recordReceipt({
        ...ids,
        grantToken: `zwr_${Buffer.alloc(32, 9).toString("base64url")}`,
        idempotencyKey: "receipt-test-0001",
        fromRevision: 0,
        toRevision: 1,
        manifestSha256: "b".repeat(64),
        outcome: "applied",
        errorCode: null,
      }),
    ).resolves.toMatchObject({ replica: { id: ids.replicaId } });

    await expect(
      client.readBlob({
        ...ids,
        grantToken: `zwr_${Buffer.alloc(32, 9).toString("base64url")}`,
        blobId: randomUUID(),
        expectedSizeBytes: 64 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(CloudReplicaClientError);
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });
});
