import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ZSR_RESOURCE_LIMITS } from "./zsr-resource-limits.mjs";

const SCOPE_PREFIX = "zsr-agent-";
const REQUIRED_FILES = [
  "cgroup.events",
  "cgroup.kill",
  "cgroup.procs",
  "cpu.max",
  "memory.max",
  "memory.oom.group",
  "pids.max",
];

function physicalDirectory(directory, label) {
  if (!path.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error(`${label} must be absolute`);
  }
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(directory) !== directory
  ) {
    throw new Error(`${label} must be a physical directory`);
  }
}

function writeControl(scope, name, value) {
  const control = path.join(scope, name);
  const metadata = lstatSync(control);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`cgroup controller ${name} is unavailable`);
  }
  writeFileSync(control, `${value}\n`);
  const actual = readFileSync(control, "utf8").trim();
  if (actual !== String(value)) {
    throw new Error(`cgroup controller ${name} rejected its exact limit`);
  }
}

function scopeName(generation) {
  return `${SCOPE_PREFIX}${createHash("sha256")
    .update(String(generation))
    .digest("hex")
    .slice(0, 24)}`;
}

/** Create a cgroup-v2 domain before untrusted bytes start. The parent is a
 * deployment capability: a qualified cloud orchestrator must delegate cpu,
 * memory, and pids controllers there. */
export function createZsrCgroupScope(options) {
  if (process.platform !== "linux") {
    throw new Error("cgroup scopes require Linux");
  }
  physicalDirectory(options.parent, "cgroup parent");
  const scope = path.join(options.parent, scopeName(options.generation));
  mkdirSync(scope, { mode: 0o755 });
  try {
    options.onDirectoryCreatedForTesting?.(scope);
    for (const name of REQUIRED_FILES) {
      if (!existsSync(path.join(scope, name))) {
        throw new Error(
          `cloud cgroup delegation is missing required controller ${name}`,
        );
      }
    }
    const limits = options.limits ?? ZSR_RESOURCE_LIMITS;
    writeControl(scope, "memory.max", limits.memoryBytes);
    writeControl(scope, "memory.oom.group", 1);
    writeControl(
      scope,
      "cpu.max",
      `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`,
    );
    writeControl(scope, "pids.max", limits.processes);
    if (existsSync(path.join(scope, "memory.swap.max"))) {
      writeControl(scope, "memory.swap.max", 0);
    }
    return Object.freeze({
      path: scope,
      limits: Object.freeze({ ...limits }),
    });
  } catch (error) {
    try {
      rmdirSync(scope);
    } catch {
      // A failed deployment contract remains a hard admission failure. The
      // root-owned stale-scope recovery pass handles non-empty cgroupfs nodes.
    }
    throw error;
  }
}

/** Attach the trusted outer wrapper before it execs bwrap/sandbox-runtime.
 * Every descendant then inherits the scope, including setsid/double-forks. */
export function wrapWithZsrCgroup(scope, argv) {
  if (!scope?.path || !Array.isArray(argv) || argv.length === 0) {
    throw new Error("invalid cgroup launch request");
  }
  return [
    "/bin/sh",
    "-c",
    'zsr_scope="$1"; shift; printf "%s\\n" "$$" > "$zsr_scope/cgroup.procs" || exit 125; exec "$@"',
    "zsr-cgroup",
    scope.path,
    ...argv,
  ];
}

function populated(scope) {
  const events = readFileSync(path.join(scope, "cgroup.events"), "utf8");
  const value = /^populated\s+([01])$/m.exec(events)?.[1];
  if (value === undefined) throw new Error("cgroup.events is malformed");
  return value === "1";
}

export async function killAndRemoveZsrCgroup(scope, timeoutMs = 5_000) {
  if (!scope?.path) return;
  if (!existsSync(scope.path)) return;
  writeFileSync(path.join(scope.path, "cgroup.kill"), "1\n");
  const deadline = Date.now() + timeoutMs;
  while (populated(scope.path) && Date.now() < deadline) {
    await delay(20);
  }
  if (populated(scope.path)) {
    throw new Error("ZSR cgroup remained populated after cgroup.kill");
  }
  rmdirSync(scope.path);
}

/** Engine-boot recovery. It is called before any new authority is published,
 * so every remaining ZSR scope belongs to a crashed prior coordinator. */
export async function recoverZsrCgroupScopes(parent) {
  if (!parent) return { discovered: 0, recovered: 0, active: 0, preserved: 0 };
  physicalDirectory(parent, "cgroup parent");
  const scopes = readdirSync(parent, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(SCOPE_PREFIX),
  );
  let recovered = 0;
  for (const entry of scopes) {
    await killAndRemoveZsrCgroup({ path: path.join(parent, entry.name) });
    recovered += 1;
  }
  return {
    discovered: scopes.length,
    recovered,
    active: 0,
    preserved: 0,
  };
}
