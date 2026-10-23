import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { cloudV2RuntimeKey, type CloudV2RuntimeStore } from "./runtime.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeSourceRecord = z.object({ version: z.literal(1), sourceSha256: sha, sha256: sha,
  commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export const cloudV2RuntimeSourceKey = (sourceSha256: string) => `cloud-v2/runtime/sources/${sha.parse(sourceSha256)}.json`;
export const runtimeObjectMissing = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

export function runtimeStorageClient(store: CloudV2RuntimeStore): S3Client {
  return new S3Client({ region: "auto", endpoint: store.endpoint, forcePathStyle: true, maxAttempts: 2,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
}

/** Only a confirmed absence permits a build. Corrupt metadata and storage
 * failures stay errors; they cannot silently spend time/egress publishing. */
export async function lookupRuntimeSource(sourceSha256: string, store: CloudV2RuntimeStore, provided?: S3Client, signal?: AbortSignal) {
  const client = provided ?? runtimeStorageClient(store);
  const request = signal ? { abortSignal: signal } : {};
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: store.bucket, Key: cloudV2RuntimeSourceKey(sourceSha256) }), request);
    if (!object.Body || (object.ContentLength ?? 0) > 4096) throw new Error();
    const parts: Buffer[] = []; let bytes = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      bytes += chunk.length; if (bytes > 4096) throw new Error(); parts.push(Buffer.from(chunk));
    }
    const record = RuntimeSourceRecord.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    if (record.sourceSha256 !== sourceSha256) throw new Error();
    const archive = await client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: cloudV2RuntimeKey(record.sha256) }), request);
    if (!archive.ContentLength || archive.ContentLength > 1024 ** 3) throw new Error();
    return record;
  } catch (error) {
    if (runtimeObjectMissing(error)) return null;
    throw new Error("Worker runtime lookup failed; check the source index and runtime storage configuration");
  } finally { if (!provided) client.destroy(); }
}
