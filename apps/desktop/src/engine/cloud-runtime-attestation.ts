import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { hasCloudEngineUserNamespace, isCloudDeploymentOwner } from "./agents/containment/cloud-deployment-authority.mjs";
import type { CloudWorkerConfiguration } from "./agents/containment/cloud-worker-config";

export type CloudAgentRuntimeAttestation = Readonly<{
  profile: "zeros-cloud-worker-v3";
  contractSha256: string;
}>;
const CONTRACT_FILES = ["package.json", "pnpm-lock.yaml", "scripts/zsr-qualification/pin.json",
  "scripts/cloud-workspace-validation/sandbox/cloud-worker.json", "scripts/cloud-workspace-validation/sandbox/runtime-layout.json"];
const ARTIFACTS = ["dist-engine/cli.js", "dist-engine/design-capture-worker.js", "binaries/zsr-supervisor.mjs"];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const invalid = () => new Error("Cloud engine image attestation is invalid");

function readImmutable(file: string, maximum: number): Buffer {
  if (realpathSync(file) !== file) throw invalid();
  for (let current = file; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !isCloudDeploymentOwner(current, stat.uid) || (stat.mode & 0o022) ||
        (current === file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw invalid();
    if (current === "/") break;
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor), current = lstatSync(file);
    if (!stat.isFile() || stat.dev !== current.dev || stat.ino !== current.ino || stat.size < 1 || stat.size > maximum) throw invalid();
    const bytes = readFileSync(descriptor);
    if (bytes.length !== stat.size) throw invalid();
    return bytes;
  } finally { closeSync(descriptor); }
}

/** The host broker verifies the complete pinned source tree before admitting
 * the engine. Its immutable metadata binds this contract to that source. The
 * engine independently checks the baked profile, source contract and compiled
 * artifacts before publishing any registration or accepting personal secrets. */
export function verifyCloudAgentRuntimeAttestation(build: unknown, read: (relative: string) => Buffer): CloudAgentRuntimeAttestation {
  if (!build || typeof build !== "object" || Array.isArray(build)) throw invalid();
  const value = build as Record<string, unknown>;
  const source = value.source as Record<string, unknown> | undefined;
  const artifacts = value.artifacts as Record<string, unknown> | undefined;
  if (value.version !== 2 || value.profile !== "zeros-cloud-worker-v3" ||
      typeof value.imageContractSha256 !== "string" || !digest.test(value.imageContractSha256) ||
      !source || typeof source.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit) ||
      !artifacts || Object.keys(artifacts).sort().join("\0") !== [...ARTIFACTS].sort().join("\0")) throw invalid();
  const contract = sha(CONTRACT_FILES.map(file => `${file}\0${read(file)}\0`).join(""));
  if (source.contractSha256 !== contract || ARTIFACTS.some(file => artifacts[file] !== sha(read(file)))) throw invalid();
  return Object.freeze({ profile: "zeros-cloud-worker-v3", contractSha256: value.imageContractSha256 });
}

export function readCloudAgentRuntimeAttestation(worker: CloudWorkerConfiguration | null): CloudAgentRuntimeAttestation {
  if (worker?.version !== 3 || worker.profile !== "zeros-cloud-worker-v3" || !hasCloudEngineUserNamespace(3)) throw invalid();
  let build: unknown;
  try { build = JSON.parse(readImmutable("/etc/zeros/image-build.json", 64 * 1024).toString("utf8")); }
  catch { throw invalid(); }
  return verifyCloudAgentRuntimeAttestation(build, file => readImmutable(path.join("/opt/zeros", file), 64 * 1024 * 1024));
}
