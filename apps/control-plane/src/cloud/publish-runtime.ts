// Publishes a Linux x64 worker archive under its sha256. Without --artifact,
// builds first (native Linux Node 24, or an isolated Docker build on a Mac).
//
//   pnpm --dir apps/control-plane cloud-v2:publish-runtime
//
// store comes from CLOUD_V2_RUNTIME_STORE_{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}.
import { createReadStream, copyFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { cloudV2RuntimeKey } from "./runtime.js";
import { inspectRuntimeArchive } from "./runtime-artifact.js";

const root = resolve(import.meta.dirname, "../../../..");
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main() {
  const { values } = parseArgs({ options: { artifact: { type: "string" }, docker: { type: "boolean" }, "allow-dirty": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("cloud-v2:publish-runtime [--artifact <Linux archive.tar.gz> | --docker] [--allow-dirty]\nMac builds require Docker. --artifact validates and uploads an existing archive without building. Uses CLOUD_V2_RUNTIME_STORE_*; the SHA pin and immutable runtime key are unchanged.");
    return;
  }
  if (values.artifact && (values.docker || values["allow-dirty"])) throw new Error("Choose either an existing artifact or build options");
  const store = { region: "auto", endpoint: required("CLOUD_V2_RUNTIME_STORE_ENDPOINT"), forcePathStyle: true,
    credentials: { accessKeyId: required("CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID"), secretAccessKey: required("CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY") } };
  const bucket = required("CLOUD_V2_RUNTIME_STORE_BUCKET");
  const work = mkdtempSync(join(tmpdir(), "zeros-runtime-"));
  let client: S3Client | undefined;
  try {
    const archive = join(work, "runtime.tar.gz");
    if (values.artifact) {
      const source = lstatSync(values.artifact);
      if (!source.isFile() || source.isSymbolicLink()) throw new Error("Runtime archive must be a regular file");
      // Hash and upload the same private copy even if the caller replaces
      // their original archive while storage is being contacted.
      copyFileSync(values.artifact, archive);
    } else {
      const { packageRuntime } = await import(pathToFileURL(join(root, "apps/cloud-worker/scripts/package-runtime.mjs")).href);
      await packageRuntime({ repository: root, output: archive, docker: values.docker, allowDirty: values["allow-dirty"] });
    }
    const { sha256, bytes } = await inspectRuntimeArchive(archive);
    client = new S3Client(store);
    const target = { Bucket: bucket, Key: cloudV2RuntimeKey(sha256) };
    const stored = await client.send(new HeadObjectCommand(target)).then(() => true, () => false);
    if (!stored) await client.send(new PutObjectCommand({
      ...target, Body: createReadStream(archive), ContentLength: bytes, ContentType: "application/gzip",
    }));
    console.log(`${stored ? "already stored" : "stored"} ${(bytes / 1e6).toFixed(0)} MB`);
    console.log(`CLOUD_V2_RUNTIME_SHA256=${sha256}`);
  } finally {
    client?.destroy();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Runtime publication failed; check the Linux archive/build and CLOUD_V2_RUNTIME_STORE_* configuration. No new pin was emitted."); process.exitCode = 1; });
}
