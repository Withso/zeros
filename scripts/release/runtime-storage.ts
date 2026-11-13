import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { inspectRuntimeArchive } from "../../apps/control-plane/src/cloud/runtime-artifact";
import { ensureRuntimeCapabilities } from "../../apps/control-plane/src/cloud/runtime-capabilities";
import { runtimeStorageClient, runtimeObjectMissing } from "../../apps/control-plane/src/cloud/runtime-source";
import type { CloudV2RuntimeStore } from "../../apps/control-plane/src/cloud/runtime";
import { PromotionError, requireCheck } from "./contracts";
import { RuntimeManifest, RuntimeQualification, type RuntimePin } from "./runtime-contracts";
import { runtimeJson } from "./runtime-proof";
import type { RuntimeReleaseReceipt } from "./runtime-release";
import { RuntimeEventSchema, type RuntimeEvent } from "./runtime-journal";

const sdk = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("@aws-sdk/client-s3") as {
  GetObjectCommand: new (input: unknown) => unknown;
  PutObjectCommand: new (input: unknown) => unknown;
};
type ObjectBody = AsyncIterable<Uint8Array>;
type Client = { send(command: unknown): Promise<{ Body?: ObjectBody; ContentLength?: number }>; destroy(): void };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const archiveKey = (sha256: string) => `cloud-v2/runtime/${digest.parse(sha256)}.tar.gz`;
const retainedKey = (sha256: string) => `cloud-v2/runtime/releases/archives/${digest.parse(sha256)}.tar.gz`;
const manifestKey = (sha256: string) => `cloud-v2/runtime/releases/manifests/${digest.parse(sha256)}.json`;
export const qualificationKey = (sha256: string, runId: string, attempt: number) => {
  requireCheck(/^[1-9][0-9]{0,19}$/.test(runId) && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 10_000, "Invalid qualification run identity");
  return `cloud-v2/runtime/releases/qualifications/${digest.parse(sha256)}/${runId}/${attempt}.json`;
};

export function runtimeStoreConfig(env: NodeJS.ProcessEnv, prefix = "CLOUD_V2_RUNTIME_STORE_"): CloudV2RuntimeStore {
  const checked = z.object({ endpoint: z.string().url(), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).safeParse({
    endpoint: env[`${prefix}ENDPOINT`], bucket: env[`${prefix}BUCKET`], accessKeyId: env[`${prefix}ACCESS_KEY_ID`], secretAccessKey: env[`${prefix}SECRET_ACCESS_KEY`],
  });
  requireCheck(checked.success, "Runtime storage configuration is invalid");
  const url = new URL(checked.data.endpoint);
  requireCheck(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Runtime storage requires a credential-free HTTPS origin");
  return { ...checked.data, endpoint: url.origin };
}

async function readObject(client: Client, bucket: string, key: string, limit: number): Promise<Buffer> {
  const value = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
  requireCheck(value.Body && (value.ContentLength ?? 0) <= limit, "Runtime object is unavailable or exceeds its bound");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of value.Body) {
    bytes += chunk.length; requireCheck(bytes <= limit, "Runtime object exceeds its bound"); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type RuntimeReleaseStore = {
  storage: { endpoint: string; bucket: string };
  close(): void;
  publish(path: string, sourceSha: string, sourceSha256: string): Promise<RuntimeManifest>;
  copy(sha256: string, source?: RuntimeReleaseStore): Promise<RuntimeManifest>;
  download(sha256: string, path: string): Promise<void>;
  retain(pin: RuntimePin): Promise<void>;
  qualification(sha256: string, runId: string, attempt: number): Promise<RuntimeQualification>;
  saveQualification(record: RuntimeQualification): Promise<void>;
  saveReceipt(receipt: RuntimeReleaseReceipt): Promise<void>;
  saveEvent(event: RuntimeEvent): Promise<void>;
};
export function runtimeReleaseStore(storage: CloudV2RuntimeStore, repository: string, options: {
  client?: Client; inspect?: typeof inspectRuntimeArchive;
} = {}): RuntimeReleaseStore {
  const client = options.client ?? runtimeStorageClient(storage) as unknown as Client, inspect = options.inspect ?? inspectRuntimeArchive;
  const getJson = async (key: string) => JSON.parse((await readObject(client, storage.bucket, key, 32 * 1024)).toString("utf8"));
  async function immutableJson(key: string, value: unknown) {
    const bytes = Buffer.from(runtimeJson(value));
    try { await client.send(new sdk.PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes,
      ContentLength: bytes.length, ContentType: "application/json", CacheControl: "public,max-age=31536000,immutable", IfNoneMatch: "*" })); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
      requireCheck((await readObject(client, storage.bucket, key, 32 * 1024)).equals(bytes), "Immutable runtime release object already contains different bytes");
    }
  }
  async function download(key: string, destination: string, expected: string): Promise<void> {
    const value = await client.send(new sdk.GetObjectCommand({ Bucket: storage.bucket, Key: key }));
    requireCheck(value.Body && (value.ContentLength ?? 0) > 0 && value.ContentLength! <= 1024 ** 3, "Runtime archive is unavailable or exceeds its bound");
    const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let length = 0; const hash = createHash("sha256");
    try {
      for await (const chunk of value.Body) {
        length += chunk.length; requireCheck(length <= 1024 ** 3, "Runtime archive exceeds its bound"); hash.update(chunk);
        await file.writeFile(chunk);
      }
      requireCheck(length === value.ContentLength && hash.digest("hex") === expected, "Runtime archive does not match its digest");
    } finally { await file.close(); }
  }
  async function immutableArchive(key: string, path: string, manifest: RuntimeManifest) {
    const stream = createReadStream(path);
    try {
      await client.send(new sdk.PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: stream, ContentLength: manifest.bytes,
        ContentType: "application/gzip", CacheControl: "public,max-age=31536000,immutable", IfNoneMatch: "*" }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
      const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-verify-"));
      try { await download(key, join(directory, "archive.tar.gz"), manifest.sha256); }
      finally { await rm(directory, { recursive: true, force: true }); }
    } finally { stream.destroy(); }
  }
  async function checkedArchive(path: string, capabilitiesRequired = true) {
    const read = await inspect(path);
    requireCheck(!capabilitiesRequired || read.features, "Runtime archive must declare its capabilities");
    return { manifest: RuntimeManifest.parse({ version: 1, repository, sha256: read.sha256, sourceSha: read.commit, sourceSha256: read.sourceSha256, bytes: read.bytes }),
      features: read.features };
  }
  async function retainArchive(path: string, manifest: RuntimeManifest, features?: string[]) {
    // The ordinary publisher prunes only its archive namespace; release retention must survive that sweep.
    await immutableArchive(retainedKey(manifest.sha256), path, manifest);
    await immutableArchive(archiveKey(manifest.sha256), path, manifest);
    if (features) {
      try { await ensureRuntimeCapabilities({ sha256: manifest.sha256, sourceSha256: manifest.sourceSha256, commit: manifest.sourceSha, features }, storage, client); }
      catch { throw new PromotionError("Runtime capabilities could not be verified"); }
    }
    await immutableJson(manifestKey(manifest.sha256), manifest);
  }
  async function copyArchive(sha256: string, source?: RuntimeReleaseStore, capabilitiesRequired = true): Promise<RuntimeManifest> {
    const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-copy-")), copy = join(directory, "archive.tar.gz");
    try {
      if (source) await source.download(sha256, copy);
      else {
        try { await download(retainedKey(sha256), copy, sha256); }
        catch (error) { if (!runtimeObjectMissing(error)) throw error; await download(archiveKey(sha256), copy, sha256); }
      }
      const { manifest, features } = await checkedArchive(copy, capabilitiesRequired);
      requireCheck(manifest.sha256 === sha256, "Runtime archive digest changed while copying");
      await retainArchive(copy, manifest, features); return manifest;
    } catch (error) { throw new PromotionError(error instanceof PromotionError ? error.message : "Runtime archive copy failed; details withheld"); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return {
    storage: { endpoint: storage.endpoint, bucket: storage.bucket },
    close() { if (!options.client) client.destroy(); },
    async publish(path: string, sourceSha: string, sourceSha256: string): Promise<RuntimeManifest> {
      const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-release-")), copy = join(directory, "archive.tar.gz");
      try {
        const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await source.stat(); requireCheck(stat.isFile() && stat.size > 0 && stat.size <= 1024 ** 3, "Runtime archive must be a bounded regular file");
          const target = await open(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          try {
            let bytes = 0;
            for await (const chunk of source.createReadStream({ autoClose: false })) { bytes += chunk.length; requireCheck(bytes <= 1024 ** 3, "Runtime archive exceeds its bound"); await target.writeFile(chunk); }
            requireCheck(bytes === stat.size, "Runtime archive changed during the checked copy");
          } finally { await target.close(); }
        } finally { await source.close(); }
        const { manifest, features } = await checkedArchive(copy);
        requireCheck(manifest.sourceSha === sourceSha && manifest.sourceSha256 === sourceSha256, "Runtime archive source changed before publication");
        await retainArchive(copy, manifest, features); return manifest;
      } catch (error) { throw new PromotionError(error instanceof PromotionError ? error.message : "Runtime archive publication failed; details withheld"); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
    copy: copyArchive,
    async download(sha256: string, path: string) { await download(retainedKey(sha256), path, sha256); },
    async retain(pin: RuntimePin) { await copyArchive(pin.sha256, undefined, false); },
    async qualification(sha256: string, runId: string, attempt: number) { return RuntimeQualification.parse(await getJson(qualificationKey(sha256, runId, attempt))); },
    async saveQualification(record: RuntimeQualification) { await immutableJson(qualificationKey(record.manifest.sha256, record.receipt.runId, record.receipt.runAttempt), record); },
    async saveReceipt(receipt: RuntimeReleaseReceipt) {
      requireCheck(["alpha", "beta", "production"].includes(receipt.channel) && /^[1-9][0-9]{0,19}$/.test(receipt.runId) &&
        Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt > 0 && receipt.runAttempt <= 10_000, "Runtime receipt identity is invalid");
      await immutableJson(`cloud-v2/runtime/releases/${receipt.channel}/${receipt.runId}/${receipt.runAttempt}.json`, receipt);
    },
    async saveEvent(value: RuntimeEvent) {
      const event = RuntimeEventSchema.safeParse(value);
      requireCheck(event.success && event.data.source.repository === repository, "Runtime recovery record is invalid; details withheld");
      const { channel, runId, runAttempt } = event.data.source;
      await immutableJson(`cloud-v2/runtime/releases/intents/${channel}/${runId}/${runAttempt}/${event.data.cleanup ? "cleanup/" : ""}${String(event.data.sequence).padStart(4, "0")}.json`, event.data);
    },
  };
}
