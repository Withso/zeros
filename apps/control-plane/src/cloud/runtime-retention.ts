// Keeps a worker runtime store from growing with every publish. Archives are
// content-addressed and can be rebuilt from the commit their source index
// records, so only the runtimes a deployment may still install need to stay.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { RuntimeSourceRecord } from "./runtime-source.js";

export const RUNTIME_RETENTION = { newest: 2, graceMs: 24 * 60 * 60_000 } as const;

const PREFIX = "cloud-v2/runtime/";
const ARCHIVE = /^cloud-v2\/runtime\/([0-9a-f]{64})\.tar\.gz$/;
const INDEX = /^cloud-v2\/runtime\/sources\/[0-9a-f]{64}\.json$/;
const CAPABILITIES = /^cloud-v2\/runtime\/capabilities\/([0-9a-f]{64})\.json$/;
const SHA = /^[0-9a-f]{64}$/;
// A store holding release records is pruned only by its release workflow (scripts/release/runtime-archive-retention.ts),
// which also keeps the channel's previous pin, live database references and in-flight promotions.
const RELEASE_MANAGED = /^cloud-v2\/runtime\/releases\//;

export type StoredObject = { key: string; lastModified: Date; size: number };
export type RetentionOptions = { protect: readonly string[]; newest?: number; graceMs?: number };

/** Which runtime objects can go. Kept: the protected runtimes (the live pin
 * and the one just published), the `newest` archives, and anything younger
 * than `graceMs`, which also covers a publish racing this one. Removed: older
 * archives, and their source indices and digest-bound capabilities.
 * Objects it does not recognise, and indices it could not read, always stay. */
export function planRuntimeRetention(objects: readonly StoredObject[], targets: ReadonlyMap<string, string | null>,
  options: RetentionOptions & { now: number }) {
  if (objects.some(object => RELEASE_MANAGED.test(object.key)))
    return { managed: true, kept: [] as string[], indices: [] as string[], archives: [] as string[], bytes: 0 };
  const newest = options.newest ?? RUNTIME_RETENTION.newest;
  const cutoff = options.now - (options.graceMs ?? RUNTIME_RETENTION.graceMs);
  const protect = new Set(options.protect.filter(sha => SHA.test(sha)));
  // A runtime a Dev checkout marked in the last week is in use there.
  for (const object of objects) {
    const used = object.key.match(USE)?.[1];
    if (used && object.lastModified.getTime() >= options.now - DEV_RUNTIME_RETENTION.unusedMs) protect.add(used);
  }
  const archives = objects.flatMap(object => {
    const match = object.key.match(ARCHIVE);
    return match ? [{ ...object, sha256: match[1]! }] : [];
  }).sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const kept = new Set(archives.filter((archive, rank) => protect.has(archive.sha256) || rank < newest ||
    archive.lastModified.getTime() >= cutoff).map(archive => archive.sha256));
  const removed = archives.filter(archive => !kept.has(archive.sha256));
  // An index whose archive is not kept either names a removed archive or one already gone.
  const indices = objects.filter(object => (INDEX.test(object.key) || CAPABILITIES.test(object.key)) && object.lastModified.getTime() < cutoff).filter(object => {
    const target = object.key.match(CAPABILITIES)?.[1] ?? targets.get(object.key);
    return typeof target === "string" && !kept.has(target) && !protect.has(target);
  });
  return {
    managed: false,
    kept: [...kept],
    indices: indices.map(object => object.key),
    archives: removed.map(archive => archive.key),
    bytes: [...indices, ...removed].reduce((sum, object) => sum + object.size, 0),
  };
}

/** Applies `planRuntimeRetention` to a store. Indices go first, so no index
 * ever names an archive that is already gone. */
export async function pruneRuntimes(client: Pick<S3Client, "send">, bucket: string, options: RetentionOptions & { now?: number }) {
  const objects = await listRuntimeObjects(client, bucket);
  const targets = new Map<string, string | null>();
  for (const object of objects) if (INDEX.test(object.key)) targets.set(object.key, await indexTarget(client, bucket, object.key));
  const plan = planRuntimeRetention(objects, targets, { ...options, now: options.now ?? Date.now() });
  for (const keys of [plan.indices, plan.archives]) await deleteKeys(client, bucket, keys);
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

// Headless Dev (`pnpm electron:cloud`): many checkouts share one bucket and select runtimes by source, so no pin says
// what is still needed. Each launcher marks the runtime it runs, on start and daily while running; a runtime no
// checkout has marked for a week is removed on a launcher start, never the starting checkout's own. Removal begins a
// week after the first marker, so a checkout that started before markers existed has marked its runtime by then.
export const DEV_RUNTIME_RETENTION = { unusedMs: 7 * 24 * 60 * 60_000 } as const;
const USES = `${PREFIX}uses/`;
const USES_SINCE = `${USES}since.json`;
const USE = /^cloud-v2\/runtime\/uses\/([0-9a-f]{64})\/([0-9a-f-]{36})\.json$/;
const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DevRetentionMode = "dry-run" | "apply";
export type DevRuntimeRetentionPlan = {
  version: 1; mode: DevRetentionMode; status: "planned" | "waiting" | "deleted" | "managed"; at: string; current: string;
  usesSince: string | null; deletesFrom: string | null;
  kept: Array<{ sha256: string; reason: "current" | "used" | "recent" }>;
  remove: Array<{ sha256: string; bytes: number; lastModified: string }>;
  keys: { indices: string[]; archives: string[]; uses: string[] };
  bytes: number;
};

/** Only exactly "apply" deletes. */
export const devRuntimeRetentionMode = (value: string | undefined): DevRetentionMode => value === "apply" ? "apply" : "dry-run";

/** Marks `sha256` as used now by this checkout, and starts the marker clock once per bucket. */
export async function recordRuntimeUse(client: Pick<S3Client, "send">, bucket: string, sha256: string, instance: string, now = Date.now()) {
  if (!SHA.test(sha256) || !INSTANCE.test(instance)) throw new Error("Invalid runtime use");
  const at = new Date(now).toISOString();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${USES}${sha256}/${instance}.json`,
    Body: JSON.stringify({ version: 1, sha256, at }), ContentType: "application/json", CacheControl: "no-cache" }));
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: USES_SINCE, Body: JSON.stringify({ version: 1, at }),
      ContentType: "application/json", IfNoneMatch: "*" }));
  } catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error; }
}

export function planDevRuntimeRetention(objects: readonly StoredObject[], targets: ReadonlyMap<string, string | null>,
  options: { current: string; now: number; mode: DevRetentionMode }): DevRuntimeRetentionPlan {
  if (!SHA.test(options.current)) throw new Error("Invalid current runtime");
  const since = objects.find(object => object.key === USES_SINCE)?.lastModified ?? null;
  const plan: DevRuntimeRetentionPlan = { version: 1, mode: options.mode, status: "planned", at: new Date(options.now).toISOString(), current: options.current,
    usesSince: since?.toISOString() ?? null, deletesFrom: since ? new Date(since.getTime() + DEV_RUNTIME_RETENTION.unusedMs).toISOString() : null,
    kept: [], remove: [], keys: { indices: [], archives: [], uses: [] }, bytes: 0 };
  if (objects.some(object => RELEASE_MANAGED.test(object.key))) return { ...plan, status: "managed" };
  const cutoff = options.now - DEV_RUNTIME_RETENTION.unusedMs, used = new Map<string, number>();
  for (const object of objects) {
    const sha256 = object.key.match(USE)?.[1];
    if (sha256) used.set(sha256, Math.max(used.get(sha256) ?? 0, object.lastModified.getTime()));
  }
  const removed = new Set<string>();
  for (const object of objects) {
    const sha256 = object.key.match(ARCHIVE)?.[1];
    if (!sha256) continue;
    const reason = sha256 === options.current ? "current" : (used.get(sha256) ?? 0) >= cutoff ? "used" : object.lastModified.getTime() >= cutoff ? "recent" : null;
    if (reason) { plan.kept.push({ sha256, reason }); continue; }
    removed.add(sha256);
    plan.remove.push({ sha256, bytes: object.size, lastModified: object.lastModified.toISOString() });
    plan.keys.archives.push(object.key); plan.bytes += object.size;
  }
  for (const object of objects) {
    const target = object.key.match(CAPABILITIES)?.[1] ?? (INDEX.test(object.key) ? targets.get(object.key) : undefined);
    if (typeof target === "string" && removed.has(target)) plan.keys.indices.push(object.key);
    const use = object.key.match(USE)?.[1];
    if (use && removed.has(use)) plan.keys.uses.push(object.key);
  }
  if (!since || since.getTime() > cutoff) plan.status = "waiting";
  return plan;
}

async function listRuntimeObjects(client: Pick<S3Client, "send">, bucket: string, prefix = PREFIX) {
  const objects: StoredObject[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const object of page.Contents ?? [])
      if (object.Key && object.LastModified) objects.push({ key: object.Key, lastModified: object.LastModified, size: object.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function deleteKeys(client: Pick<S3Client, "send">, bucket: string, keys: readonly string[]) {
  for (let start = 0; start < keys.length; start += 1000) {
    const reply = await client.send(new DeleteObjectsCommand({ Bucket: bucket,
      Delete: { Objects: keys.slice(start, start + 1000).map(Key => ({ Key })), Quiet: true } }));
    if (reply.Errors?.length) throw new Error("Runtime retention could not delete every object");
  }
}

/** Plans Dev cleanup and, in apply mode once markers have existed for a week, removes indices first, then archives,
 * then their markers: no index ever names an archive that is already gone. */
export async function retainDevRuntimes(client: Pick<S3Client, "send">, bucket: string, options: { current: string; mode: DevRetentionMode; now?: number }) {
  const objects = await listRuntimeObjects(client, bucket), targets = new Map<string, string | null>();
  for (const object of objects) if (INDEX.test(object.key)) targets.set(object.key, await indexTarget(client, bucket, object.key));
  const plan = planDevRuntimeRetention(objects, targets, { ...options, now: options.now ?? Date.now() });
  if (plan.status !== "planned" || options.mode !== "apply" || !plan.remove.length) return plan;
  for (const keys of [plan.keys.indices, plan.keys.archives, plan.keys.uses]) await deleteKeys(client, bucket, keys);
  return { ...plan, status: "deleted" as const };
}

/** `electron:cloud --reset`: this checkout no longer uses any runtime. */
export async function removeRuntimeUses(client: Pick<S3Client, "send">, bucket: string, instance: string) {
  if (!INSTANCE.test(instance)) throw new Error("Invalid runtime use");
  const keys = (await listRuntimeObjects(client, bucket, USES)).map(object => object.key).filter(key => key.match(USE)?.[2] === instance);
  await deleteKeys(client, bucket, keys);
  return keys.length;
}
