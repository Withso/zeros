// Keeps a worker runtime store from growing with every publish. Archives are
// content-addressed and can be rebuilt from the commit their source index
// records, so only the runtimes a deployment may still install need to stay.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { RuntimeSourceRecord } from "./runtime-source.js";

export const RUNTIME_RETENTION = { newest: 2, graceMs: 24 * 60 * 60_000 } as const;

const PREFIX = "cloud-v2/runtime/";
const ARCHIVE = /^cloud-v2\/runtime\/([0-9a-f]{64})\.tar\.gz$/;
const INDEX = /^cloud-v2\/runtime\/sources\/[0-9a-f]{64}\.json$/;
const SHA = /^[0-9a-f]{64}$/;

export type StoredObject = { key: string; lastModified: Date; size: number };
export type RetentionOptions = { protect: readonly string[]; newest?: number; graceMs?: number };

/** Which runtime objects can go. Kept: the protected runtimes (the live pin
 * and the one just published), the `newest` archives, and anything younger
 * than `graceMs`, which also covers a publish racing this one. Removed: older
 * archives, and the source indices naming them or an archive that is gone.
 * Objects it does not recognise, and indices it could not read, always stay. */
export function planRuntimeRetention(objects: readonly StoredObject[], targets: ReadonlyMap<string, string | null>,
  options: RetentionOptions & { now: number }) {
  const newest = options.newest ?? RUNTIME_RETENTION.newest;
  const cutoff = options.now - (options.graceMs ?? RUNTIME_RETENTION.graceMs);
  const protect = new Set(options.protect.filter(sha => SHA.test(sha)));
  const archives = objects.flatMap(object => {
    const match = object.key.match(ARCHIVE);
    return match ? [{ ...object, sha256: match[1]! }] : [];
  }).sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const kept = new Set(archives.filter((archive, rank) => protect.has(archive.sha256) || rank < newest ||
    archive.lastModified.getTime() >= cutoff).map(archive => archive.sha256));
  const removed = archives.filter(archive => !kept.has(archive.sha256));
  // An index whose archive is not kept either names a removed archive or one already gone.
  const indices = objects.filter(object => INDEX.test(object.key) && object.lastModified.getTime() < cutoff).filter(object => {
    const target = targets.get(object.key);
    return typeof target === "string" && !kept.has(target) && !protect.has(target);
  });
  return {
    kept: [...kept],
    indices: indices.map(object => object.key),
    archives: removed.map(archive => archive.key),
    bytes: [...indices, ...removed].reduce((sum, object) => sum + object.size, 0),
  };
}

/** Applies `planRuntimeRetention` to a store. Indices go first, so no index
 * ever names an archive that is already gone. */
export async function pruneRuntimes(client: Pick<S3Client, "send">, bucket: string, options: RetentionOptions & { now?: number }) {
  const objects: StoredObject[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ...(token ? { ContinuationToken: token } : {}) }));
    for (const object of page.Contents ?? [])
      if (object.Key && object.LastModified) objects.push({ key: object.Key, lastModified: object.LastModified, size: object.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const targets = new Map<string, string | null>();
  for (const object of objects) if (INDEX.test(object.key)) targets.set(object.key, await indexTarget(client, bucket, object.key));
  const plan = planRuntimeRetention(objects, targets, { ...options, now: options.now ?? Date.now() });
  for (const keys of [plan.indices, plan.archives]) {
    for (let start = 0; start < keys.length; start += 1000) {
      const reply = await client.send(new DeleteObjectsCommand({ Bucket: bucket,
        Delete: { Objects: keys.slice(start, start + 1000).map(Key => ({ Key })), Quiet: true } }));
      if (reply.Errors?.length) throw new Error("Runtime retention could not delete every object");
    }
  }
  return plan;
}

/** The archive a source index names, or null when it cannot be read. */
async function indexTarget(client: Pick<S3Client, "send">, bucket: string, key: string): Promise<string | null> {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!object.Body || (object.ContentLength ?? 0) > 4096) return null;
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > 4096) return null;
      parts.push(Buffer.from(chunk));
    }
    const record = RuntimeSourceRecord.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    return key === `${PREFIX}sources/${record.sourceSha256}.json` ? record.sha256 : null;
  } catch {
    return null;
  }
}
