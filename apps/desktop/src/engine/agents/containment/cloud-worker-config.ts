import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import type {
  CloudWorkerRuntimeConfiguration,
  CloudWorkerToolchain,
} from "./types";

export const CLOUD_WORKER_CONFIG_PATH = "/etc/zeros/cloud-worker.json";
const MAX_CONFIG_BYTES = 4 * 1024;

export interface CloudWorkerConfiguration extends CloudWorkerRuntimeConfiguration {
  readonly version: 1;
  readonly backend: "cloud-worker";
  readonly profile: "zeros-cloud-worker-v1";
  readonly toolchain: CloudWorkerToolchain;
}

function parseToolchain(value: unknown): CloudWorkerToolchain | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "bwrap",
    "node",
    "setpriv",
    "supervisor",
  ];
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
    bwrap: String(record.bwrap),
    setpriv: String(record.setpriv),
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
  const toolchain = parseToolchain(value.toolchain);
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    value.version !== 1 ||
    value.backend !== "cloud-worker" ||
    value.profile !== "zeros-cloud-worker-v1" ||
    !Number.isInteger(value.uid) ||
    Number(value.uid) <= 0 ||
    Number(value.uid) > 2_147_483_647 ||
    !Number.isInteger(value.gid) ||
    Number(value.gid) <= 0 ||
    Number(value.gid) > 2_147_483_647 ||
    !toolchain
  ) {
    throw new Error("cloud-worker configuration has an unsupported contract");
  }
  return {
    version: 1,
    backend: "cloud-worker",
    profile: "zeros-cloud-worker-v1",
    uid: Number(value.uid),
    gid: Number(value.gid),
    toolchain,
  };
}

function assertRootControlledPath(
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
      stat.uid !== 0 ||
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

/** Load the immutable deployment marker that is baked by the cloud image.
 * Merely setting ZEROS_CLOUD_PORT (or any child-visible variable) cannot
 * activate a privileged backend. An invalid marker fails startup instead of
 * silently downgrading to weaker nested isolation. */
export function loadCloudWorkerConfiguration(
  file = CLOUD_WORKER_CONFIG_PATH,
): CloudWorkerConfiguration | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let configuration: CloudWorkerConfiguration;
  try {
    if (
      process.platform !== "linux" ||
      typeof process.geteuid !== "function" ||
      process.geteuid() !== 0
    ) {
      throw new Error("cloud-worker configuration requires a root Linux engine");
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
  } finally {
    closeSync(descriptor);
  }
  for (const candidate of Object.values(configuration.toolchain)) {
    assertRootControlledPath(candidate);
  }
  for (const candidate of [
    configuration.toolchain.node,
    configuration.toolchain.bwrap,
    configuration.toolchain.setpriv,
  ]) {
    if ((lstatSync(candidate).mode & 0o111) === 0) {
      throw new Error(
        "cloud-worker toolchain contains a non-executable helper",
      );
    }
  }
  return configuration;
}
