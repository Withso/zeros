// Builds the cloud worker runtime, packs it and stores it under its sha256,
// then prints the CLOUD_V2_RUNTIME_SHA256 the control plane should run.
//
//   pnpm --dir apps/control-plane cloud-v2:publish-runtime
//
// Runs on Linux x64, the platform of Boat VMs, from a clean checkout. The
// store comes from CLOUD_V2_RUNTIME_STORE_{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { cloudV2RuntimeKey } from "./runtime.js";

const root = resolve(import.meta.dirname, "../../../..");
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Publish the runtime on Linux x64, the platform Boat VMs run");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", "apps/cloud-worker", "packages/protocol") && !process.argv.includes("--allow-dirty"))
    throw new Error("The worker or protocol has uncommitted changes; commit them or pass --allow-dirty");
  execFileSync("pnpm", ["--filter", "@zeros/cloud-worker", "build"], { cwd: root, stdio: "inherit" });
  const dist = join(root, "apps/cloud-worker/dist");
  writeFileSync(join(dist, "BUILD.json"), `${JSON.stringify({ commit: git("rev-parse", "HEAD"), builtAt: new Date().toISOString() })}\n`);

  const work = mkdtempSync(join(tmpdir(), "zeros-runtime-"));
  try {
    const archive = join(work, "runtime.tar.gz");
    execFileSync("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", dist, "."]);
    const hash = createHash("sha256");
    await pipeline(createReadStream(archive), hash);
    const sha256 = hash.digest("hex");
    const client = new S3Client({
      region: "auto", endpoint: required("CLOUD_V2_RUNTIME_STORE_ENDPOINT"), forcePathStyle: true,
      credentials: { accessKeyId: required("CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID"), secretAccessKey: required("CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY") },
    });
    const target = { Bucket: required("CLOUD_V2_RUNTIME_STORE_BUCKET"), Key: cloudV2RuntimeKey(sha256) };
    const stored = await client.send(new HeadObjectCommand(target)).then(() => true, () => false);
    if (!stored) await client.send(new PutObjectCommand({
      ...target, Body: createReadStream(archive), ContentLength: statSync(archive).size, ContentType: "application/gzip",
    }));
    console.log(`${stored ? "already stored" : "stored"} ${(statSync(archive).size / 1e6).toFixed(0)} MB`);
    console.log(`CLOUD_V2_RUNTIME_SHA256=${sha256}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
