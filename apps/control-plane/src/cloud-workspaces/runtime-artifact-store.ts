import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Agent as HttpsAgent } from "node:https";

const MAX_TTL_SECONDS = 900;
const OPERATION_TIMEOUT_MS = 60_000;
const objectKeyPattern =
  /^runtime\/v1\/r1-[a-f0-9]{64}\/[a-f0-9]{64}\.tar\.gz$/;

export type RuntimeArtifactCapability = { url: string; expiresAt: string };
export type RuntimeArtifactUpload = RuntimeArtifactCapability & {
  headers: Record<string, string>;
};
export type RuntimeArtifactStore = {
  presignCreatePut(
    objectKey: string,
    bytes: number,
  ): Promise<RuntimeArtifactUpload>;
  head(objectKey: string): Promise<{ exists: boolean; bytes: number | null }>;
  presignGet(
    objectKey: string,
    ttlSeconds: number,
  ): Promise<RuntimeArtifactCapability>;
};

export type RuntimeArtifactStoreConfig = {
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
};

export function createRuntimeArtifactStore(
  config: RuntimeArtifactStoreConfig,
): RuntimeArtifactStore | null {
  const store = config.s3;
  if (!store) return null;
  return new S3RuntimeArtifactStore(
    new S3Client({
      endpoint: store.endpoint,
      region: store.region,
      credentials: {
        accessKeyId: store.accessKeyId,
        secretAccessKey: store.secretAccessKey,
      },
      forcePathStyle: true,
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: 60_000,
        httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 16 }),
      },
    }),
    store.bucket,
  );
}

export function runtimeArtifactObjectKey(
  runtimeId: string,
  archiveSha256: string,
): string {
  const key = `runtime/v1/${runtimeId}/${archiveSha256}.tar.gz`;
  assertObjectKey(key);
  return key;
}

function assertObjectKey(key: string): void {
  if (!objectKeyPattern.test(key))
    throw new Error("runtime artifact key is invalid");
}

/** A separate adapter: runtime archives never enter the workspace ciphertext
 * namespace, encryption, deletion fences, or configurable Dev prefix. URLs
 * are short-lived bearer material and must not be logged or persisted. */
export class S3RuntimeArtifactStore implements RuntimeArtifactStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("runtime artifact bucket is invalid");
    }
  }

  async presignCreatePut(
    objectKey: string,
    bytes: number,
  ): Promise<RuntimeArtifactUpload> {
    assertObjectKey(objectKey);
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error("runtime artifact length is invalid");
    const expiresAt = new Date(
      Date.now() + MAX_TTL_SECONDS * 1000,
    ).toISOString();
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ContentLength: bytes,
          ContentType: "application/gzip",
          CacheControl: "no-store",
          IfNoneMatch: "*",
        }),
        {
          expiresIn: MAX_TTL_SECONDS,
          // A caller cannot remove create-only protection or change the size.
          signableHeaders: new Set([
            "if-none-match",
            "content-length",
            "content-type",
          ]),
        },
      );
      return {
        url,
        expiresAt,
        headers: {
          "If-None-Match": "*",
          "Content-Length": String(bytes),
          "Content-Type": "application/gzip",
          "Cache-Control": "no-store",
        },
      };
    } catch {
      throw new Error("runtime artifact signing failed");
    }
  }

  async head(
    objectKey: string,
  ): Promise<{ exists: boolean; bytes: number | null }> {
    assertObjectKey(objectKey);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        {
          abortSignal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
        },
      );
      const bytes = response.ContentLength;
      if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("invalid length");
      return { exists: true, bytes };
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
          ?.httpStatusCode === 404
      ) {
        return { exists: false, bytes: null };
      }
      throw new Error("runtime artifact state unavailable");
    }
  }

  async presignGet(
    objectKey: string,
    ttlSeconds: number,
  ): Promise<RuntimeArtifactCapability> {
    assertObjectKey(objectKey);
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error("runtime artifact TTL is invalid");
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        { expiresIn: ttlSeconds },
      );
      return { url, expiresAt };
    } catch {
      throw new Error("runtime artifact signing failed");
    }
  }
}
