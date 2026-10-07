import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { validateCloudRuntimeMarker, resolveCloudRuntime } from "./cloud-runtime-root.mjs";

/** Host seccomp is not evidence of the isolated engine's admission. Worker v4
 * must prove its own filter and no-new-privileges bit. */
export function cloudRuntimeProcessSecurityQualified(version, _hostSeccomp, identity) {
  return version === 4 && identity?.secure === true &&
    identity.noNewPrivs === 1 && identity.seccompMode === 2;
}

export function cloudHostRuntimeProfile(marker) {
  validateCloudRuntimeMarker(marker);
  return Object.freeze({
    version: 4,
    profile: "zeros-cloud-worker-v4",
    engineUid: 10003,
    engineGid: 10003,
    runtimeDirectory: "/run/zeros/engine",
    setupDirectory: "/srv/zeros/setup",
    managedSettingsDirectory: "/srv/zeros/managed-settings",
  });
}

export function ensureCloudHostRuntimeDirectory(profile) {
  const accepted = cloudHostRuntimeProfile({
    version: profile.version,
    profile: profile.profile,
    backend: "cloud-worker",
    uid: 10001,
    gid: 10001,
  });
  if (process.getuid?.() !== 0 || process.platform !== "linux")
    throw new Error("Cloud runtime admission requires VM root");
  const parent = path.dirname(accepted.runtimeDirectory);
  for (let current = parent; ; current = path.dirname(current)) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      metadata.mode & 0o022 ||
      realpathSync(current) !== current
    )
      throw new Error("Cloud runtime ancestry is unsafe");
    if (current === "/") break;
  }
  let created = false;
  try {
    mkdirSync(accepted.runtimeDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const descriptor = openSync(
    accepted.runtimeDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== (created ? 0 : accepted.engineUid) ||
      (metadata.mode & 0o777) !== 0o700
    )
      throw new Error("Cloud runtime directory is unsafe");
    if (created) {
      fchownSync(descriptor, accepted.engineUid, accepted.engineGid);
      fchmodSync(descriptor, 0o700);
    }
  } finally {
    closeSync(descriptor);
  }
  return accepted;
}

/** Host broker only: it validates physical ownership before the engine's user
 * namespace deliberately makes VM root unmapped. No environment flag selects
 * another identity or credential directory. */
export function readCloudHostRuntimeProfile(
  file = "/etc/zeros/cloud-worker.json",
) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    !path.isAbsolute(file) ||
    realpathSync(file) !== file
  )
    throw new Error("Cloud host profile requires immutable root admission");
  for (let current = file; ; current = path.dirname(current)) {
    const metadata = lstatSync(current);
    if (
      metadata.uid !== 0 ||
      metadata.mode & 0o022 ||
      metadata.isSymbolicLink() ||
      (current === file
        ? !metadata.isFile() || metadata.nlink !== 1
        : !metadata.isDirectory())
    )
      throw new Error("Cloud host profile is not root-controlled");
    if (current === "/") break;
  }
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      metadata.nlink !== 1 ||
      metadata.size < 2 ||
      metadata.size > 4096
    )
      throw new Error("Cloud host profile is invalid");
    const buffer = Buffer.alloc(4097);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes !== metadata.size) throw new Error("Cloud host profile changed");
    const marker = JSON.parse(buffer.toString("utf8", 0, bytes));
    const profile = cloudHostRuntimeProfile(marker);
    resolveCloudRuntime();
    return profile;
  } finally {
    closeSync(descriptor);
  }
}
