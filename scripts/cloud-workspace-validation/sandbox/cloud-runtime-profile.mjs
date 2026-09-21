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

/** A VM broker need not inherit a provider container's seccomp filter. Version
 * 2 must prove the actual isolated engine's filter and no-new-privileges bit;
 * host-only evidence cannot satisfy this boundary. Legacy admission is kept. */
export function cloudRuntimeProcessSecurityQualified(
  version,
  hostSeccomp,
  identity,
) {
  return (version === 2 || version === 3)
    ? identity?.secure === true &&
        identity.noNewPrivs === 1 &&
        identity.seccompMode === 2
    : version === 1 && hostSeccomp === "2";
}

export function cloudHostRuntimeProfile(marker) {
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.backend !== "cloud-worker" ||
    marker.uid !== 10001 ||
    marker.gid !== 10001 ||
    !(
      (marker.version === 1 && marker.profile === "zeros-cloud-worker-v1") ||
      (marker.version === 2 && marker.profile === "zeros-cloud-worker-v2") ||
      (marker.version === 3 && marker.profile === "zeros-cloud-worker-v3")
    )
  )
    throw new Error("Unsupported cloud host runtime profile");
  const isolated = marker.version >= 2;
  return Object.freeze({
    version: marker.version,
    profile: marker.profile,
    engineUid: isolated ? 10003 : 0,
    engineGid: isolated ? 10003 : 0,
    runtimeDirectory: isolated ? "/run/zeros/engine" : "/run/zeros",
    setupDirectory: isolated ? "/srv/zeros/setup" : "/srv/zeros/state/setup",
    managedSettingsDirectory: isolated
      ? "/srv/zeros/managed-settings"
      : "/srv/zeros/state/user-settings",
  });
}

export function ensureCloudHostRuntimeDirectory(profile) {
  const accepted = cloudHostRuntimeProfile({
    ...profile,
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
    return cloudHostRuntimeProfile(
      JSON.parse(buffer.toString("utf8", 0, bytes)),
    );
  } finally {
    closeSync(descriptor);
  }
}
