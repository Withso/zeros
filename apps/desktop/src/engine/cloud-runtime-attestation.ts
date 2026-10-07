import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { hasCloudEngineUserNamespace, isCloudDeploymentOwner } from "./agents/containment/cloud-deployment-authority.mjs";
import type { CloudWorkerConfiguration } from "./agents/containment/cloud-worker-config";
import {resolveCloudRuntime, cloudActiveRuntimeDescriptor, parseCloudActiveRuntime, type CloudActiveRuntime} from "./agents/containment/cloud-runtime-root.mjs";

export type CloudAgentRuntimeAttestation = Readonly<{
  profile: "zeros-cloud-worker-v4";
  runtimeId: string;
  manifestSha256: string;
  baseCompatibilityId: string;
  installerReceiptSha256: string;
  bootId: string;
  supervisorSessionId: string;
}>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
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

/** The host broker owns full inventory/receipt verification. The engine binds
 * registration to the selected v4 manifest before accepting personal secrets. */
export function verifyCloudRuntimeV4Attestation(active: CloudActiveRuntime, read: (relative: string) => Buffer): CloudAgentRuntimeAttestation {
  const identity = parseCloudActiveRuntime(active);
  // The root broker owns full inventory/receipt verification. Independently
  // bind registration to the manifest bytes mounted at the selected R.
  if (sha(read("manifest.json")) !== identity.manifestSha256) throw invalid();
  return Object.freeze({profile:"zeros-cloud-worker-v4", runtimeId:identity.runtimeId, manifestSha256:identity.manifestSha256,
    baseCompatibilityId:identity.baseCompatibilityId, installerReceiptSha256:identity.installerReceiptSha256,
    bootId:identity.bootId, supervisorSessionId:identity.supervisorSessionId});
}

export function readCloudAgentRuntimeAttestation(worker: CloudWorkerConfiguration | null): CloudAgentRuntimeAttestation {
  if (worker?.version !== 4 || worker.profile !== "zeros-cloud-worker-v4" || !hasCloudEngineUserNamespace(4)) throw invalid();
  const runtime = resolveCloudRuntime();
  if (runtime.profile !== "v4" || worker.toolchain.node !== runtime.node) throw invalid();
  return verifyCloudRuntimeV4Attestation(cloudActiveRuntimeDescriptor(runtime), file => readImmutable(path.join(runtime.root, file), 64 * 1024 * 1024));
}
