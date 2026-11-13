import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { runtimeObjectMissing, runtimeStorageClient } from "./runtime-source.js";
import { cloudV2RuntimeKey, type CloudV2RuntimeStore } from "./runtime.js";
import { RuntimeReleaseSchema, type RuntimeRelease } from "./runtime-release.js";
import type { RuntimeCanaryAdmission } from "./runtime-canary.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WorkerCapabilitiesSchema = z.object({
  version: z.literal(1),
  features: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(128)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value)),
}).strict();
export const RuntimeCapabilitiesSchema = WorkerCapabilitiesSchema.extend({
  sha256: digest, sourceSha256: digest, commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export const runtimeCapabilitiesKey = (sha256: string) => `cloud-v2/runtime/capabilities/${digest.parse(sha256)}.json`;
export type RuntimeCapabilitiesClient = {
  send(command: GetObjectCommand | HeadObjectCommand | PutObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
};
type RuntimeObject = { Body?: AsyncIterable<Uint8Array>; ContentLength?: number };

export async function readRuntimeCapabilities(sha256: string, store: CloudV2RuntimeStore, provided?: RuntimeCapabilitiesClient,
  signal?: AbortSignal): Promise<RuntimeCapabilities | null> {
  const owned = provided ? undefined : runtimeStorageClient(store), client = provided ?? owned!;
  const request = signal ? { abortSignal: signal } : undefined;
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: store.bucket, Key: runtimeCapabilitiesKey(sha256) }), request) as RuntimeObject;
    if (!object.Body || (object.ContentLength ?? 0) > 16_384) throw new Error();
    const parts: Buffer[] = []; let bytes = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      bytes += chunk.length; if (bytes > 16_384) throw new Error(); parts.push(Buffer.from(chunk));
    }
    const record = RuntimeCapabilitiesSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    if (record.sha256 !== sha256) throw new Error();
    const archive = await client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: cloudV2RuntimeKey(sha256) }), request) as RuntimeObject;
    if (!archive.ContentLength || archive.ContentLength > 1024 ** 3) throw new Error();
    return record;
  } catch (error) {
    if (runtimeObjectMissing(error)) return null;
    throw new HttpError(503, "worker_runtime_unavailable", "Worker capabilities could not be verified");
  } finally { owned?.destroy(); }
}

/** A stored archive can predate its capability index. Ensure the index on every
 * publication, then verify what admission will read before advertising it. */
export async function ensureRuntimeCapabilities(artifact: Omit<RuntimeCapabilities, "version">, store: CloudV2RuntimeStore,
  client: RuntimeCapabilitiesClient, signal?: AbortSignal): Promise<RuntimeCapabilities> {
  const { sha256, sourceSha256, commit, features } = RuntimeCapabilitiesSchema.parse({ version: 1, ...artifact });
  const bytes = Buffer.from(JSON.stringify({ version: 1, sha256, sourceSha256, commit, features }));
  try {
    await client.send(new PutObjectCommand({ Bucket: store.bucket, Key: runtimeCapabilitiesKey(sha256), Body: bytes,
      ContentLength: bytes.length, ContentType: "application/json", CacheControl: "public,max-age=31536000,immutable", IfNoneMatch: "*" }),
    signal ? { abortSignal: signal } : undefined);
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
  }
  const record = await readRuntimeCapabilities(sha256, store, client, signal);
  if (!record || record.sourceSha256 !== sourceSha256 || record.commit !== commit || JSON.stringify(record.features) !== JSON.stringify(features))
    throw new Error("Runtime capabilities do not match the checked archive");
  return record;
}

const unavailable = () => new HttpError(409, "worker_update_required", "Update the qualified worker before creating shared workspaces");

/** A signed release canary substitutes only for its not-yet-earned release
 * receipt. Its create scope and one-use grant are checked by the create path. */
export function activeRuntimeQualification(channel: string | undefined,
  runtime: { sha256: string; release?: RuntimeRelease; store: CloudV2RuntimeStore }) {
  const records = new Map<string, Promise<RuntimeCapabilities | null>>();
  return async (canary?: RuntimeCanaryAdmission, developmentSha256?: string): Promise<RuntimeCapabilities> => {
    if (developmentSha256 !== undefined && channel !== "development") throw unavailable();
    const sha256 = canary?.runtimeSha256 ?? developmentSha256 ?? runtime.sha256;
    let pending = records.get(sha256);
    if (!pending) {
      pending = readRuntimeCapabilities(sha256, runtime.store);
      if (records.size >= 16) records.delete(records.keys().next().value!);
      records.set(sha256, pending);
    }
    let record: RuntimeCapabilities | null;
    try { record = await pending; } catch (error) { records.delete(sha256); throw error; }
    if (!record) { records.delete(sha256); throw unavailable(); }
    if (!record.features.includes("acting-user-v1") || !record.features.includes("sync-context-v1")) throw unavailable();
    if (canary) {
      if (channel !== "alpha" || canary.runtimeSha256 !== record.sha256 || canary.sourceSha !== record.commit || canary.exp * 1000 <= Date.now())
        throw unavailable();
    } else if (channel !== "development") {
      const release = RuntimeReleaseSchema.safeParse(runtime.release);
      if (!release.success || release.data.sha256 !== record.sha256 || release.data.sourceSha !== record.commit || release.data.sourceSha256 !== record.sourceSha256)
        throw unavailable();
    }
    return record;
  };
}
