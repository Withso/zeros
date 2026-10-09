import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  hasCloudEngineUserNamespace,
  isCloudDeploymentOwner,
} from "./cloud-deployment-authority.mjs";
import {resolveCloudRuntime, validateCloudRuntimeMarker} from "./cloud-runtime-root.mjs";

import type {
  CloudWorkerRuntimeConfiguration,
  CloudWorkerToolchain,
} from "./types";

export const CLOUD_WORKER_CONFIG_PATH = "/etc/zeros/cloud-worker.json";
const MAX_CONFIG_BYTES = 4 * 1024;
const originalConfigurations = new WeakSet<object>();
export function isCloudWorkerConfiguration(value: unknown): value is CloudWorkerConfiguration {
  return typeof value === "object" && value !== null && originalConfigurations.has(value);
}

export interface CloudWorkerConfiguration extends CloudWorkerRuntimeConfiguration {
  readonly version: 4;
  readonly backend: "cloud-worker";
  readonly profile: "zeros-cloud-worker-v4";
  readonly toolchain: CloudWorkerToolchain;
}

function parseToolchain(value: unknown, legacy: boolean): CloudWorkerToolchain | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = legacy ? ["bwrap", "node", "setpriv", "supervisor"] : ["node", "supervisor"];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) {
    return null;
  }
  if (
    expectedKeys.some(
      (name) =>
        typeof record[name] !== "string" ||
        !path.isAbsolute(String(record[name])) ||
        String(record[name]).includes("\0"),
    )
  ) {
    return null;
  }
  return {
    node: String(record.node),
    supervisor: String(record.supervisor),
    ...(legacy ? { bwrap: String(record.bwrap), setpriv: String(record.setpriv) } : {}),
  };
}

export function parseCloudWorkerConfiguration(
  source: string,
): CloudWorkerConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("cloud-worker configuration is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cloud-worker configuration is invalid");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    "backend",
    "gid",
    "profile",
    "toolchain",
    "uid",
    "version",
  ];
  const legacy = value.uid === 10001 && value.gid === 10001;
  const engine = value.uid === 10003 && value.gid === 10003 || value.uid === 0 && value.gid === 0;
  const toolchain = parseToolchain(value.toolchain, legacy);
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    (value.version !== 4 || value.profile !== "zeros-cloud-worker-v4") ||
    value.backend !== "cloud-worker" ||
    (!legacy && !engine) ||
    !Number.isInteger(value.uid) ||
    Number(value.uid) < 0 ||
    Number(value.uid) > 2_147_483_647 ||
    !Number.isInteger(value.gid) ||
    Number(value.gid) < 0 ||
    Number(value.gid) > 2_147_483_647 ||
    !toolchain
  ) {
    throw new Error("cloud-worker configuration has an unsupported contract");
  }
  return {
    version: 4,
    backend: "cloud-worker",
    profile: "zeros-cloud-worker-v4",
    uid: Number(value.uid),
    gid: Number(value.gid),
    toolchain,
  };
}

export function assertRootControlledPath(
  file: string,
  leafKind: "file" | "directory" = "file",
): void {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) {
    throw new Error("cloud-worker configuration path is not canonical");
  }
  let cursor = file;
  for (;;) {
    const stat = lstatSync(cursor);
    const isLeaf = cursor === file;
    if (
      stat.isSymbolicLink() ||
      !isCloudDeploymentOwner(cursor, stat.uid) ||
      (stat.mode & 0o022) !== 0 ||
      (isLeaf
        ? leafKind === "directory"
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    ) {
      throw new Error("cloud-worker configuration is not root-controlled");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

/** Load the immutable deployment marker projected by the root launcher.
 * Merely setting ZEROS_CLOUD_PORT (or any child-visible variable) cannot
 * activate cloud placement. Archived markers parse for compatibility, but
 * only the current non-root identity and pinned Host assets can activate. */
export function loadCloudWorkerConfiguration(
  file = CLOUD_WORKER_CONFIG_PATH,
): CloudWorkerConfiguration | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let configuration: CloudWorkerConfiguration;
  try {
    if (
      process.platform !== "linux" ||
      typeof process.geteuid !== "function" ||
      process.geteuid() !== 10003
    ) {
      throw new Error(
        "cloud-worker configuration requires the non-root cloud engine",
      );
    }
    assertRootControlledPath(file);
    const stat = fstatSync(descriptor);
    const current = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino
    ) {
      throw new Error("cloud-worker configuration is not root-controlled");
    }
    if (stat.size < 2 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("cloud-worker configuration has an invalid size");
    }
    configuration = parseCloudWorkerConfiguration(
      readFileSync(descriptor, "utf8"),
    );
    if (!hasCloudEngineUserNamespace(4)) {
      throw new Error(
        "cloud-worker profile does not match its engine namespace",
      );
    }
  } finally {
    closeSync(descriptor);
  }
  if (configuration.uid !== 10003 || configuration.gid !== 10003 ||
      configuration.uid !== process.geteuid?.() || configuration.gid !== process.getegid?.() ||
      configuration.toolchain.bwrap || configuration.toolchain.setpriv)
    throw new Error("cloud execution requires the same-user runtime upgrade");
  for (const candidate of Object.values(configuration.toolchain)) {
    assertRootControlledPath(candidate);
  }
  validateCloudRuntimeMarker(configuration, true);
  const runtime = resolveCloudRuntime();
  if (runtime.profile !== "v4" || configuration.toolchain.node !== runtime.node ||
      configuration.toolchain.supervisor !== `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`)
    throw new Error("cloud-worker toolchain does not match the active runtime");
  for (const candidate of [
    configuration.toolchain.node,
  ]) {
    if ((lstatSync(candidate).mode & 0o111) === 0) {
      throw new Error(
        "cloud-worker toolchain contains a non-executable helper",
      );
    }
  }
  Object.freeze(configuration.toolchain);
  Object.freeze(configuration);
  originalConfigurations.add(configuration);
  return configuration;
}
