// Publishes a Linux x64 worker archive under its sha256. Without --artifact,
// builds first (native Linux Node 24, or an isolated Docker build on a Mac).
//
//   pnpm --dir apps/control-plane cloud-v2:publish-runtime
//
// Store comes from CLOUD_V2_RUNTIME_STORE_* or the private local profile with --local.
import { createReadStream, copyFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { cloudV2RuntimeKey, type CloudV2RuntimeStore } from "./runtime.js";
import { inspectRuntimeArchive } from "./runtime-artifact.js";
import { cloudV2RuntimeSourceKey, runtimeObjectMissing, runtimeStorageClient } from "./runtime-source.js";

const root = resolve(import.meta.dirname, "../../../..");
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function runtimeStore(local: boolean) {
  if (local) {
    const { loadProfile } = await import(pathToFileURL(join(root, "scripts/dev-environment/profile.mjs")).href);
    // Use the launcher's private-file checks and profile selection. An invalid
    // local profile must not silently select an ambient hosted store instead.
    return z.object({
      endpoint: z.string().trim().min(1), bucket: z.string().trim().min(1),
      accessKeyId: z.string().trim().min(1), secretAccessKey: z.string().trim().min(1),
    }).parse(loadProfile(undefined, { root }).storage);
  }
  return {
    endpoint: required("CLOUD_V2_RUNTIME_STORE_ENDPOINT"), bucket: required("CLOUD_V2_RUNTIME_STORE_BUCKET"),
    accessKeyId: required("CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID"), secretAccessKey: required("CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY"),
  };
}

/** Upload the immutable archive before publishing its source index. The local
 * launcher supplies cancellable process supervision and a clean build env. */
export async function publishRuntime({ storage, artifact, docker, allowDirty, repository = root, expectedSourceSha256, env, execute, signal }: {
  storage: CloudV2RuntimeStore; artifact?: string; docker?: boolean; allowDirty?: boolean; repository?: string;
  expectedSourceSha256?: string; env?: NodeJS.ProcessEnv;
  execute?: (command: string, args: string[], options: { cwd?: string; timeout?: number }) => unknown;
  signal?: AbortSignal;
}) {
  const bucket = storage.bucket;
  const request = signal ? { abortSignal: signal } : {};
  const work = mkdtempSync(join(tmpdir(), "zeros-runtime-"));
  let client: S3Client | undefined;
  try {
    const archive = join(work, "runtime.tar.gz");
    if (artifact) {
      const source = lstatSync(artifact);
      if (!source.isFile() || source.isSymbolicLink()) throw new Error("Runtime archive must be a regular file");
      // Hash and upload the same private copy even if the caller replaces
      // their original archive while storage is being contacted.
      copyFileSync(artifact, archive);
    } else {
      const { packageRuntime } = await import(pathToFileURL(join(repository, "apps/cloud-worker/scripts/package-runtime.mjs")).href);
      await packageRuntime({ repository, output: archive, docker, allowDirty, env, execute });
    }
    const { sha256, bytes, sourceSha256, commit } = await inspectRuntimeArchive(archive);
    if (expectedSourceSha256 && sourceSha256 !== expectedSourceSha256) throw new Error("Worker sources changed before publication; retry the build");
    client = runtimeStorageClient(storage);
    const target = { Bucket: bucket, Key: cloudV2RuntimeKey(sha256) };
    const stored = await client.send(new HeadObjectCommand(target), request).then(() => true, error => {
      if (runtimeObjectMissing(error)) return false;
      throw new Error("Runtime storage lookup failed");
    });
    if (!stored) await client.send(new PutObjectCommand({
      ...target, Body: createReadStream(archive), ContentLength: bytes, ContentType: "application/gzip",
    }), request);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: cloudV2RuntimeSourceKey(sourceSha256),
      Body: JSON.stringify({ version: 1, sourceSha256, sha256, commit }), ContentType: "application/json", CacheControl: "no-cache" }), request);
    return { sha256, sourceSha256, commit, bytes, stored };
  } finally {
    client?.destroy();
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { local: { type: "boolean" }, artifact: { type: "string" }, docker: { type: "boolean" }, "allow-dirty": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("cloud-v2:publish-runtime [--local] [--artifact <Linux archive.tar.gz> | --docker] [--allow-dirty]\nMac builds require Docker. --artifact validates and uploads an existing archive without building. --local reads the electron:cloud profile's storage section; otherwise uses CLOUD_V2_RUNTIME_STORE_*. Publishes the SHA-pinned archive and a source-hash index for automatic startup.");
    return;
  }
  if (values.artifact && (values.docker || values["allow-dirty"])) throw new Error("Choose either an existing artifact or build options");
  const { systemEnvironment } = await import(pathToFileURL(join(root, "scripts/dev-environment/state.mjs")).href);
  const result = await publishRuntime({ storage: await runtimeStore(values.local === true), ...(values.artifact ? { artifact: values.artifact } : {}),
    docker: values.docker ?? false, allowDirty: values["allow-dirty"] ?? false, env: systemEnvironment() });
  console.log(`${result.stored ? "already stored" : "stored"} ${(result.bytes / 1e6).toFixed(0)} MB`);
  console.log(`CLOUD_V2_RUNTIME_SHA256=${result.sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Runtime publication failed; check the Linux archive/build and runtime storage configuration (the private profile with --local, otherwise CLOUD_V2_RUNTIME_STORE_*). No new pin was emitted."); process.exitCode = 1; });
}
