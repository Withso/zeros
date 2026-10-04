import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeArtifactStore,
  runtimeArtifactObjectKey,
  S3RuntimeArtifactStore,
} from "./runtime-artifact-store.js";

const runtimeId = `r1-${"a".repeat(64)}`;
const archiveSha256 = "b".repeat(64);
const key = runtimeArtifactObjectKey(runtimeId, archiveSha256);
const clients: S3Client[] = [];

function fixture() {
  // Signing is local; these fixture credentials never reach a provider.
  const client = new S3Client({
    endpoint: "https://objects.example.test",
    region: "auto",
    credentials: {
      accessKeyId: "synthetic-runtime-access",
      secretAccessKey: "synthetic-runtime-secret",
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  clients.push(client);
  return {
    client,
    store: new S3RuntimeArtifactStore(client, "runtime-artifacts"),
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

describe("runtime artifacts", () => {
  it("returns null when S3 is not configured", () => {
    expect(createRuntimeArtifactStore({ s3: null })).toBeNull();
  });

  it("creates the adapter from the control plane's S3 configuration", async () => {
    const store = createRuntimeArtifactStore({
      s3: {
        endpoint: "https://objects.example.test",
        region: "auto",
        bucket: "runtime-artifacts",
        accessKeyId: "synthetic-runtime-access",
        secretAccessKey: "synthetic-runtime-secret",
      },
    });
    expect(store).not.toBeNull();
    const upload = await store!.presignCreatePut(key, 123);
    const signed = new URL(upload.url);
    expect(signed.origin).toBe("https://objects.example.test");
    expect(signed.pathname).toBe(`/runtime-artifacts/${key}`);
    expect(signed.searchParams.get("X-Amz-SignedHeaders")!.split(";")).toEqual(
      expect.arrayContaining(["content-length", "if-none-match"]),
    );
  });

  it("constructs only the isolated, digest-addressed archive key", () => {
    expect(key).toBe(`runtime/v1/${runtimeId}/${archiveSha256}.tar.gz`);
    for (const id of [
      "../workspace",
      runtimeId.toUpperCase(),
      `${runtimeId}/x`,
    ]) {
      expect(() => runtimeArtifactObjectKey(id, archiveSha256)).toThrow(
        "runtime artifact key is invalid",
      );
    }
    expect(() => runtimeArtifactObjectKey(runtimeId, "../archive")).toThrow(
      "runtime artifact key is invalid",
    );
  });

  it("signs create-only PUT and its exact byte length", async () => {
    const { store } = fixture();
    const started = Date.now();
    const upload = await store.presignCreatePut(key, 123);
    const signed = new URL(upload.url);
    const headers = signed.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(headers).toEqual(
      expect.arrayContaining(["content-length", "if-none-match"]),
    );
    expect(upload.headers).toMatchObject({
      "If-None-Match": "*",
      "Content-Length": "123",
    });
    expect(signed.pathname).toBe(`/runtime-artifacts/${key}`);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(Date.parse(upload.expiresAt) - started).toBeGreaterThanOrEqual(
      899_000,
    );
    expect(Date.parse(upload.expiresAt) - Date.now()).toBeLessThanOrEqual(
      900_000,
    );
  });

  it("bounds GET capabilities to fifteen minutes", async () => {
    const { store } = fixture();
    const download = await store.presignGet(key, 60);
    const signed = new URL(download.url);
    expect(signed.pathname).toBe(`/runtime-artifacts/${key}`);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");
    for (const ttl of [0, -1, 901, 1.5, NaN]) {
      await expect(store.presignGet(key, ttl)).rejects.toThrow(
        "runtime artifact TTL is invalid",
      );
    }
  });

  it("reads existence and a validated content length", async () => {
    const { client, store } = fixture();
    const send = vi.spyOn(client, "send");
    send.mockResolvedValueOnce({ ContentLength: 123 } as never);
    expect(await store.head(key)).toEqual({ exists: true, bytes: 123 });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0]![0] as HeadObjectCommand).input).toEqual({
      Bucket: "runtime-artifacts",
      Key: key,
    });
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    expect(await store.head(key)).toEqual({ exists: false, bytes: null });
    send.mockResolvedValueOnce({ ContentLength: 0 } as never);
    expect(await store.head(key)).toEqual({ exists: true, bytes: 0 });
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid HEAD length (%s)",
    async (bytes) => {
      const { client, store } = fixture();
      vi.spyOn(client, "send").mockResolvedValueOnce({
        ContentLength: bytes,
      } as never);
      await expect(store.head(key)).rejects.toThrow(
        /^runtime artifact state unavailable$/,
      );
    },
  );

  it("rejects untrusted keys and PUT lengths before signing or storage I/O", async () => {
    const { client, store } = fixture();
    const send = vi.spyOn(client, "send");
    for (const objectKey of [
      "workspace/v2/other",
      `${key}/../other`,
      `dev/test/${key}`,
      `${key}?private`,
    ]) {
      await expect(store.head(objectKey)).rejects.toThrow(
        "runtime artifact key is invalid",
      );
      await expect(store.presignGet(objectKey, 60)).rejects.toThrow(
        "runtime artifact key is invalid",
      );
      await expect(store.presignCreatePut(objectKey, 123)).rejects.toThrow(
        "runtime artifact key is invalid",
      );
    }
    for (const bytes of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.presignCreatePut(key, bytes)).rejects.toThrow(
        "runtime artifact length is invalid",
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps URL-bearing SDK errors out of errors and logs", async () => {
    const { client, store } = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(client, "send").mockRejectedValue(
      new Error(
        "https://objects.example.test/private?signature=private-sentinel",
      ),
    );
    await expect(store.head(key)).rejects.toThrow(
      /^runtime artifact state unavailable$/,
    );
    client.config.credentials = async () => {
      throw new Error(
        "https://objects.example.test/private?signature=private-sentinel",
      );
    };
    await expect(store.presignGet(key, 60)).rejects.toThrow(
      /^runtime artifact signing failed$/,
    );
    await expect(store.presignCreatePut(key, 123)).rejects.toThrow(
      /^runtime artifact signing failed$/,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
