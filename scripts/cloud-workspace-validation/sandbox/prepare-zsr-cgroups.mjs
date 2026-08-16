#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "/etc/zeros/cloud-worker.json";
const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP2_SUPER_MAGIC = 0x63677270;
const REQUIRED_CONTROLLERS = ["cpu", "memory", "pids"];
const SCOPE_PREFIX = "zsr-agent-";

function fail(message) {
  throw new Error(`cloud cgroup preparation failed: ${message}`);
}

function physicalDirectory(directory, label) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== directory
  ) {
    fail(`${label} is not a canonical physical directory`);
  }
}

function readTokens(file) {
  return new Set(
    readFileSync(file, "utf8").trim().split(/\s+/).filter(Boolean),
  );
}

function writeExact(file, value) {
  writeFileSync(file, `${value}\n`);
  if (readFileSync(file, "utf8").trim() !== String(value)) {
    fail(`${path.basename(file)} rejected its exact value`);
  }
}

function enableControllers(directory) {
  const available = readTokens(path.join(directory, "cgroup.controllers"));
  const missing = REQUIRED_CONTROLLERS.filter((name) => !available.has(name));
  if (missing.length > 0) {
    fail(`controllers are not delegated: ${missing.join(", ")}`);
  }
  writeFileSync(
    path.join(directory, "cgroup.subtree_control"),
    `${REQUIRED_CONTROLLERS.map((name) => `+${name}`).join(" ")}\n`,
  );
  const enabled = readTokens(path.join(directory, "cgroup.subtree_control"));
  const disabled = REQUIRED_CONTROLLERS.filter((name) => !enabled.has(name));
  if (disabled.length > 0) {
    fail(`controllers could not be enabled: ${disabled.join(", ")}`);
  }
}

function moveRootProcesses(coordinator) {
  const source = path.join(CGROUP_ROOT, "cgroup.procs");
  const destination = path.join(coordinator, "cgroup.procs");
  for (let pass = 0; pass < 32; pass += 1) {
    const pids = readFileSync(source, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (pids.length === 0) return;
    for (const pid of pids) {
      if (!/^[1-9][0-9]*$/.test(pid)) fail("cgroup.procs is malformed");
      try {
        writeFileSync(destination, `${pid}\n`);
      } catch (error) {
        // A process can exit between enumeration and migration. Every other
        // error is a missing delegation and must fail image admission.
        if (error?.code !== "ESRCH" && error?.code !== "ENOENT") throw error;
      }
    }
  }
  if (readFileSync(source, "utf8").trim()) {
    fail("root cgroup remained populated during controller delegation");
  }
}

function recoverStaleScopes(parent) {
  let recovered = 0;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCOPE_PREFIX)) continue;
    const scope = path.join(parent, entry.name);
    writeFileSync(path.join(scope, "cgroup.kill"), "1\n");
    const deadline = Date.now() + 5_000;
    while (
      /^populated\s+1$/m.test(
        readFileSync(path.join(scope, "cgroup.events"), "utf8"),
      ) &&
      Date.now() < deadline
    ) {
      // This trusted boot-time helper runs before admission. Atomics.wait is a
      // bounded synchronous sleep which cannot leave an async operation alive.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (
      /^populated\s+1$/m.test(
        readFileSync(path.join(scope, "cgroup.events"), "utf8"),
      )
    ) {
      fail(`stale scope ${entry.name} remained populated`);
    }
    rmdirSync(scope);
    recovered += 1;
  }
  return recovered;
}

export function prepareZsrCgroupHierarchy(markerPath = MARKER) {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) {
    fail("a root Linux coordinator is required");
  }
  physicalDirectory(CGROUP_ROOT, "cgroup root");
  const filesystem = statfsSync(CGROUP_ROOT);
  if (Number(filesystem.type) !== CGROUP2_SUPER_MAGIC) {
    fail("/sys/fs/cgroup is not cgroup v2");
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const parent = path.normalize(String(marker.cgroupParent ?? ""));
  if (
    parent !== path.join(CGROUP_ROOT, "zeros-agents") ||
    path.dirname(parent) !== CGROUP_ROOT
  ) {
    fail("marker cgroup parent is outside the fixed hierarchy");
  }
  const resources = marker.resources;
  if (
    !resources ||
    !Number.isSafeInteger(resources.memoryBytes) ||
    !Number.isSafeInteger(resources.cpuQuotaMicros) ||
    !Number.isSafeInteger(resources.cpuPeriodMicros) ||
    !Number.isSafeInteger(resources.processes)
  ) {
    fail("marker resource contract is invalid");
  }
  const outerResources = {
    memoryMax: readFileSync(
      path.join(CGROUP_ROOT, "memory.max"),
      "utf8",
    ).trim(),
    cpuMax: readFileSync(path.join(CGROUP_ROOT, "cpu.max"), "utf8").trim(),
    pidsMax: readFileSync(path.join(CGROUP_ROOT, "pids.max"), "utf8").trim(),
    swapMax: existsSync(path.join(CGROUP_ROOT, "memory.swap.max"))
      ? readFileSync(path.join(CGROUP_ROOT, "memory.swap.max"), "utf8").trim()
      : null,
  };

  const coordinator = path.join(CGROUP_ROOT, "zeros-coordinator");
  for (const directory of [coordinator, parent]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: false, mode: 0o755 });
    }
    physicalDirectory(directory, path.basename(directory));
    chmodSync(directory, 0o755);
  }
  moveRootProcesses(coordinator);
  enableControllers(CGROUP_ROOT);

  // Preserve the platform's finite outer contract on the coordinator child.
  // A child cgroup otherwise reports "max" even though an ancestor is finite,
  // which weakens both observability and restart attestation.
  writeExact(path.join(coordinator, "memory.max"), outerResources.memoryMax);
  writeExact(path.join(coordinator, "cpu.max"), outerResources.cpuMax);
  writeExact(path.join(coordinator, "pids.max"), outerResources.pidsMax);
  writeExact(path.join(coordinator, "memory.oom.group"), 1);
  if (
    outerResources.swapMax !== null &&
    existsSync(path.join(coordinator, "memory.swap.max"))
  ) {
    writeExact(
      path.join(coordinator, "memory.swap.max"),
      outerResources.swapMax,
    );
  }

  for (const name of [
    "cpu.max",
    "memory.max",
    "memory.oom.group",
    "pids.max",
  ]) {
    if (!existsSync(path.join(parent, name))) {
      fail(`delegated parent is missing ${name}`);
    }
  }
  writeExact(
    path.join(parent, "cpu.max"),
    `${resources.cpuQuotaMicros} ${resources.cpuPeriodMicros}`,
  );
  writeExact(path.join(parent, "memory.max"), resources.memoryBytes);
  writeExact(path.join(parent, "memory.oom.group"), 1);
  writeExact(path.join(parent, "pids.max"), resources.processes);
  if (existsSync(path.join(parent, "memory.swap.max"))) {
    writeExact(path.join(parent, "memory.swap.max"), 0);
  }
  enableControllers(parent);
  const recovered = recoverStaleScopes(parent);

  return {
    version: 1,
    parent,
    coordinator,
    controllers: REQUIRED_CONTROLLERS,
    resources: {
      memoryMax: readFileSync(path.join(parent, "memory.max"), "utf8").trim(),
      cpuMax: readFileSync(path.join(parent, "cpu.max"), "utf8").trim(),
      pidsMax: readFileSync(path.join(parent, "pids.max"), "utf8").trim(),
      swapMax: existsSync(path.join(parent, "memory.swap.max"))
        ? readFileSync(path.join(parent, "memory.swap.max"), "utf8").trim()
        : null,
    },
    outerResources,
    recovered,
  };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.stdout.write(`${JSON.stringify(prepareZsrCgroupHierarchy())}\n`);
}
