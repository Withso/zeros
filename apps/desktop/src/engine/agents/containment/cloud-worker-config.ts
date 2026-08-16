import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type {
  CloudWorkerResourceLimits,
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
    "containerWorker",
    "networkBridge",
    "node",
    "setpriv",
    "socat",
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
    networkBridge: String(record.networkBridge),
    containerWorker: String(record.containerWorker),
    bwrap: String(record.bwrap),
    socat: String(record.socat),
    setpriv: String(record.setpriv),
  };
}

function parseResources(value: unknown): CloudWorkerResourceLimits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "cpuPeriodMicros",
    "cpuQuotaMicros",
    "memoryBytes",
    "processes",
  ];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) {
    return null;
  }
  const integerInRange = (name: string, minimum: number, maximum: number) =>
    Number.isSafeInteger(record[name]) &&
    Number(record[name]) >= minimum &&
    Number(record[name]) <= maximum;
  if (
    !integerInRange("memoryBytes", 256 * 1024 * 1024, 1024 ** 4) ||
    !integerInRange("cpuQuotaMicros", 1_000, 100_000_000) ||
    !integerInRange("cpuPeriodMicros", 1_000, 1_000_000) ||
    !integerInRange("processes", 64, 1_000_000)
  ) {
    return null;
  }
  return {
    memoryBytes: Number(record.memoryBytes),
    cpuQuotaMicros: Number(record.cpuQuotaMicros),
    cpuPeriodMicros: Number(record.cpuPeriodMicros),
    processes: Number(record.processes),
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
    "cgroupParent",
    "gid",
    "profile",
    "resources",
    "toolchain",
    "uid",
    "version",
  ];
  const toolchain = parseToolchain(value.toolchain);
  const resources = parseResources(value.resources);
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
    typeof value.cgroupParent !== "string" ||
    !path.isAbsolute(value.cgroupParent) ||
    value.cgroupParent.includes("\0") ||
    !resources ||
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
    cgroupParent: path.normalize(value.cgroupParent),
    resources,
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
  if (!existsSync(file)) return null;
  if (
    process.platform !== "linux" ||
    typeof process.geteuid !== "function" ||
    process.geteuid() !== 0
  ) {
    throw new Error("cloud-worker configuration requires a root Linux engine");
  }
  assertRootControlledPath(file);
  const stat = lstatSync(file);
  if (stat.size < 2 || stat.size > MAX_CONFIG_BYTES) {
    throw new Error("cloud-worker configuration has an invalid size");
  }
  const configuration = parseCloudWorkerConfiguration(
    readFileSync(file, "utf8"),
  );
  const cgroupRoot = realpathSync("/sys/fs/cgroup");
  const relativeCgroup = path.relative(cgroupRoot, configuration.cgroupParent);
  if (
    relativeCgroup === "" ||
    relativeCgroup === ".." ||
    relativeCgroup.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCgroup)
  ) {
    throw new Error("cloud-worker cgroup parent is outside cgroup v2");
  }
  assertRootControlledPath(configuration.cgroupParent, "directory");
  for (const candidate of Object.values(configuration.toolchain)) {
    assertRootControlledPath(candidate);
  }
  for (const candidate of [
    configuration.toolchain.node,
    configuration.toolchain.bwrap,
    configuration.toolchain.socat,
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
