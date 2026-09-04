import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CloudReplicaClientError,
  HttpCloudReplicaApi,
  type CloudReplicaProofSigner,
} from "../cloud-replica-client";

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "content-type": "application/json",
    },
  });
}

function proofSigner(deviceId: string) {
  const proof = vi.fn<CloudReplicaProofSigner["proof"]>(async () => ({
    deviceId,
    keyVersion: 1,
    timestampMs: 1_700_000_000_000,
    nonce: "nonce-0000000000000001",
    signature: "signature",
  }));
  return { deviceId, proof } satisfies CloudReplicaProofSigner;
}

describe("cloud workspace fork HTTP client", () => {
  it("imports an immutable local snapshot with exact bodies and no device proof", async () => {
    const organizationId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const lifecycleIntentId = randomUUID();
    const forkIntentId = randomUUID();
    const githubInstallationId = randomUUID();
    const checkpointId = randomUUID();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const signer = proofSigner(randomUUID());
    let call = 0;
    const requestFetch = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer current-workos-token");
      expect(headers.get("x-zeros-device-id")).toBeNull();
      expect(headers.get("x-zeros-device-signature")).toBeNull();
      call += 1;
      if (call === 1) {
        expect(url).toBe(
          `https://api.zeros.build/v1/organizations/${organizationId}/cloud-workspaces`,
        );
        expect(init?.method).toBe("POST");
        const body = String(init?.body);
        expect(headers.get("content-length")).toBe(
          String(Buffer.byteLength(body, "utf8")),
        );
        expect(JSON.parse(body)).toMatchObject({
          forkFromLocal: {
            sourceWorkspaceId,
            targetWorkspaceId,
            sourceSnapshotSha256: "a".repeat(64),
          },
        });
        return jsonResponse(
          {
            workspace: { id: targetWorkspaceId, organizationId },
            intent: { id: lifecycleIntentId },
            fork: {
              id: forkIntentId,
              operation: "local_to_cloud",
              sourceLocalWorkspaceId: sourceWorkspaceId,
              targetCloudWorkspaceId: targetWorkspaceId,
            },
            replayed: false,
          },
          202,
        );
      }
      if (call === 2) {
        expect(url).toContain(`/forks/${forkIntentId}/import/blobs`);
        expect(init?.method).toBe("POST");
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("content-length")).toBe(String(bytes.byteLength));
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from(bytes));
        return jsonResponse(
          {
            blob: {
              id: randomUUID(),
              plaintextSha256: sha256,
              plaintextBytes: bytes.byteLength,
              reused: false,
            },
          },
          201,
        );
      }
      if (call === 3) {
        expect(init?.method).toBe("PUT");
        expect(url).toContain(`/forks/${forkIntentId}/import/entries`);
        return jsonResponse({ accepted: 1 });
      }
      if (call === 4) {
        expect(init?.method).toBe("PUT");
        expect(url).toContain(`/forks/${forkIntentId}/import/records`);
        return jsonResponse({ accepted: 1 });
      }
      expect(init?.method).toBe("POST");
      expect(url).toContain(`/forks/${forkIntentId}/import/finalize`);
      expect(headers.get("idempotency-key")).toBe("fork-finalize-0001");
      return jsonResponse({ checkpointId, replayed: false }, 201);
    });
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "current-workos-token",
      signer,
      fetch: requestFetch,
    });
    const created = await client.createCloudFromLocal({
      organizationId,
      repository: {
        forge: "github.com",
        owner: "zeros-labs",
        name: "zeros",
        revision: "1".repeat(40),
        githubInstallationId,
      },
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceRevision: 4,
      sourceSnapshotSha256: "a".repeat(64),
      sourceGitHeadRef: "refs/heads/main",
      includeChats: true,
      includeSettings: true,
      idempotencyKey: "fork-create-0001",
    });
    const uploaded = await client.uploadForkBlob({
      organizationId,
      workspaceId: created.workspaceId,
      forkIntentId: created.forkIntentId,
      bytes,
    });
    await client.stageForkEntries({
      organizationId,
      workspaceId: targetWorkspaceId,
      forkIntentId,
      entries: [
        {
          operation: "upsert",
          path: "src/index.ts",
          entryType: "file",
          mode: 33188,
          blobId: uploaded.id,
          contentSha256: sha256,
          sizeBytes: bytes.byteLength,
        },
      ],
    });
    await client.stageForkRecords({
      organizationId,
      workspaceId: targetWorkspaceId,
      forkIntentId,
      records: [
        {
          ordinal: 0,
          entityKind: "chat",
          entityId: "chat_f_0123456789012345678901234567890123456789",
          operation: "upsert",
          schemaVersion: 1,
          document: { version: 1 },
          occurredAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });
    await expect(
      client.finalizeForkImport({
        organizationId,
        workspaceId: targetWorkspaceId,
        forkIntentId,
        idempotencyKey: "fork-finalize-0001",
      }),
    ).resolves.toEqual({ checkpointId, replayed: false });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(signer.proof).not.toHaveBeenCalled();
    expect(requestFetch).toHaveBeenCalledTimes(5);
  });

  it("binds every export read to a device proof and short-lived export grant", async () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const targetLocalWorkspaceId = randomUUID();
    const forkIntentId = randomUUID();
    const checkpointId = randomUUID();
    const blobId = randomUUID();
    const bytes = new Uint8Array([9, 8, 7]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const grantToken = `zwe_${Buffer.alloc(32, 7).toString("base64url")}`;
    const signer = proofSigner(randomUUID());
    let call = 0;
    const requestFetch = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-zeros-device-id")).toBe(signer.deviceId);
      call += 1;
      if (call === 1) {
        expect(url).toContain(`/forks/${forkIntentId}/export/grant`);
        expect(headers.get("x-zeros-export-grant")).toBeNull();
        return jsonResponse(
          {
            grantToken,
            deviceId: signer.deviceId,
            deviceKeyVersion: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          201,
        );
      }
      expect(headers.get("x-zeros-export-grant")).toBe(grantToken);
      if (call === 2) {
        return jsonResponse({
          sourceCloudWorkspaceId: workspaceId,
          targetLocalWorkspaceId,
          checkpointId,
          contentRevision: 4,
          recordRevision: 1,
          includeChats: true,
          fileCount: 1,
          totalBytes: bytes.byteLength,
          gitBaseCommit: "2".repeat(40),
          gitHeadRef: "refs/heads/main",
          repository: {
            forge: "github.com",
            owner: "zeros-labs",
            name: "zeros",
            revision: "main",
          },
          entries: [
            {
              operation: "upsert",
              path: "src/index.ts",
              entryType: "file",
              mode: 33188,
              blobId,
              contentSha256: sha256,
              sizeBytes: bytes.byteLength,
            },
          ],
          nextAfterPath: null,
        });
      }
      if (call === 3) {
        return jsonResponse({
          recordRevision: 1,
          events: [
            {
              revision: 1,
              entityKind: "chat",
              entityId: "chat-1",
              operation: "upsert",
              schemaVersion: 1,
              document: { version: 1 },
              occurredAt: "2026-08-30T00:00:00.000Z",
            },
          ],
          hasMore: false,
        });
      }
      expect(url).toContain(`/export/blobs/${blobId}`);
      return new Response(bytes, {
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "application/octet-stream",
        },
      });
    });
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "current-workos-token",
      signer,
      fetch: requestFetch,
    });
    await client.issueExportGrant({ organizationId, workspaceId, forkIntentId });
    await client.readForkManifest({
      organizationId,
      workspaceId,
      forkIntentId,
      grantToken,
      afterPath: null,
      limit: 100,
    });
    await client.readForkRecords({
      organizationId,
      workspaceId,
      forkIntentId,
      grantToken,
      afterRevision: 0,
      limit: 20,
    });
    await expect(
      client.readForkBlob({
        organizationId,
        workspaceId,
        forkIntentId,
        grantToken,
        blobId,
        expectedSizeBytes: bytes.byteLength,
        expectedSha256: sha256,
      }),
    ).resolves.toEqual(bytes);
    expect(signer.proof.mock.calls.map(([action, payload]) => [action, payload])).toEqual([
      [
        "fork.export.grant",
        { organizationId, workspaceId, forkIntentId },
      ],
      [
        "fork.export.manifest.read",
        { organizationId, workspaceId, forkIntentId, afterPath: null, limit: 100 },
      ],
      [
        "fork.export.records.read",
        { organizationId, workspaceId, forkIntentId, afterRevision: 0, limit: 20 },
      ],
      [
        "fork.export.blob.read",
        { organizationId, workspaceId, forkIntentId, blobId },
      ],
    ]);
  });

  it("rejects unsafe manifest paths and mismatched blob integrity", async () => {
    const ids = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      forkIntentId: randomUUID(),
    };
    const targetLocalWorkspaceId = randomUUID();
    const checkpointId = randomUUID();
    const blobId = randomUUID();
    const grantToken = `zwe_${Buffer.alloc(32, 8).toString("base64url")}`;
    const signer = proofSigner(randomUUID());
    const requestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          sourceCloudWorkspaceId: ids.workspaceId,
          targetLocalWorkspaceId,
          checkpointId,
          contentRevision: 1,
          recordRevision: 0,
          includeChats: false,
          fileCount: 0,
          totalBytes: 0,
          gitBaseCommit: "3".repeat(40),
          gitHeadRef: null,
          repository: {
            forge: "github.com",
            owner: "zeros-labs",
            name: "zeros",
            revision: "main",
          },
          entries: [
            {
              operation: "delete",
              path: "../outside",
              entryType: null,
              mode: null,
              blobId: null,
              contentSha256: null,
              sizeBytes: null,
            },
          ],
          nextAfterPath: null,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
        }),
      );
    const client = new HttpCloudReplicaApi({
      baseUrl: "https://api.zeros.build",
      getAccessToken: async () => "current-workos-token",
      signer,
      fetch: requestFetch,
    });
    await expect(
      client.readForkManifest({ ...ids, grantToken, afterPath: null, limit: 10 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.readForkBlob({
        ...ids,
        grantToken,
        blobId,
        expectedSizeBytes: 3,
        expectedSha256: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(CloudReplicaClientError);
  });
});
