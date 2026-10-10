#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { parseSetupTimings, setupTimingClock } from "./cloud-setup-timings.mjs";
import * as filesystem from "node:fs";
import { cloudComputerHostRepository } from "./cloud-computer-checkout.mjs";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  createCloudRuntimeResolver,
  parseCloudActiveRuntime,
  validateCloudRuntimeMarker,
} from "./cloud-runtime-root.mjs";
import { cloudAllocationCapacity, cloudResourcesMeetContract, cloudRuntimeResourcesQualified, validCloudResourceBudgetProjection } from "./cloud-resource-admission.mjs";
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";

const MARKER = "/etc/zeros/cloud-worker.json";
const MAX_OUTPUT = 8 * 1024 * 1024;
const ADMISSION_DIRECTORY = "/run/zeros";
const ADMISSION_PROOF = path.join(
  ADMISSION_DIRECTORY,
  "cloud-worker-admission.json",
);
const ENGINE_LOCK = path.join(ADMISSION_DIRECTORY, "engine.lock");
const LOCKED_ARGUMENT = "--engine-lock-held";

function readOptional(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function rootControlled(file, executable = false, directory = false) {
  try {
    if (!path.isAbsolute(file) || realpathSync(file) !== file) return false;
    let cursor = file;
    for (;;) {
      const stat = lstatSync(cursor);
      const leaf = cursor === file;
      if (
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (leaf
          ? directory
            ? !stat.isDirectory()
            : !stat.isFile()
          : !stat.isDirectory())
      ) {
        return false;
      }
      if (leaf && executable && (stat.mode & 0o111) === 0) return false;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return true;
  } catch {
    return false;
  }
}

function namespace(name) {
  try {
    return readlinkSync(`/proc/self/ns/${name}`);
  } catch {
    return null;
  }
}

function containerInitStartTicks() {
  try {
    const source = readFileSync("/proc/1/stat", "utf8");
    const commandEnd = source.lastIndexOf(")");
    const fields = source
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

// Component-local vocabulary. Arbitrary child output and exception messages
// never enter this vocabulary.
const V4_CHECKS = new Set([
  "active_descriptor", "host_marker", "installer_receipt", "receipt_digest",
  "manifest_digest", "manifest_schema", "base_compatibility", "root_ownership",
  "file_mode", "file_inventory", "hard_link", "symlink_escape", "boot_identity",
  "namespace_binding", "uid_map", "apparmor", "cgroup_controllers",
  "finite_resources", "engine_lifecycle", "containment_smoke", "seccomp", "setup_exit", "input_schema",
  "lock_busy", "launch_proof", "pointer_publish", "timeout", "process_signal", "diagnostic_missing",
]);
const V4_STAGES = new Set([
  "validate_input", "lock", "verify_tree", "qualify_engine", "run_setup", "publish_proof", "consume_proof", "done",
]);
export const CLOUD_V4_IDENTITY_FIELDS = Object.freeze([
  "runtimeId", "manifestSha256", "baseCompatibilityId", "installerReceiptSha256", "bootId", "supervisorSessionId",
]);
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const hexDigest = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
function receiptTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible days and 24:00. The installer's RFC3339
  // receipt contract does not, so reject those spellings before parsing.
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour < 24 && minute < 60 && second < 60 && Number.isFinite(Date.parse(value));
}
class V4Failure extends Error {
  constructor(check) { super("Cloud v4 attestation failed"); this.check = check; }
}
export function requireCloudV4Check(pass, check) {
  if (!pass) throw new V4Failure(V4_CHECKS.has(check) ? check : "diagnostic_missing");
}
function attemptV4(check, operation) {
  try { return operation(); }
  catch (error) { if (error instanceof V4Failure) throw error; throw new V4Failure(check); }
}
export function cloudV4Diagnostic(error, stage) {
  const check = error instanceof V4Failure && V4_CHECKS.has(error.check) ? error.check : "diagnostic_missing";
  return { schema: "zeros.diagnostic/v1", component: "attester", stage: V4_STAGES.has(stage) ? stage : "validate_input",
    ok: error === null, exitCode: error === null ? 0 : 1, timedOut: error !== null && check === "timeout",
    failedChecks: error === null ? [] : [check] };
}

/** Root-owned authority files are pinned, bounded and read without following
 * links. Tests inject node:fs using the same logical-root fixture as B2. */
export function readCloudV4File(file, maximum, check, mode) {
  attemptV4(check, () => lstatSync(file));
  requireCloudV4Check(rootControlled(file), "root_ownership");
  return attemptV4(check, () => {
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd), current = lstatSync(file);
      requireCloudV4Check(stat.isFile() && stat.uid === 0 && stat.dev === current.dev && stat.ino === current.ino &&
        !current.isSymbolicLink(), "root_ownership");
      requireCloudV4Check(stat.nlink === 1, "hard_link");
      requireCloudV4Check((stat.mode & 0o7022) === 0 && (mode === undefined || (stat.mode & 0o777) === mode), "file_mode");
      requireCloudV4Check(stat.size >= 2 && stat.size <= maximum, check);
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      requireCloudV4Check(size === stat.size, check);
      return bytes.subarray(0, size);
    } finally { closeSync(fd); }
  });
}

export function parseCloudV4Document(bytes, check) {
  return attemptV4(check, () => {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const objects = [];
    // JSON.parse silently discards duplicate keys, including escaped aliases.
    for (let index = 0; index < source.length; index++) {
      if (source[index] === "{") objects.push(new Set());
      else if (source[index] === "}") objects.pop();
      else if (source[index] === '"') {
        const start = index++;
        for (; index < source.length; index++) {
          if (source[index] === "\\") index++;
          else if (source[index] === '"') break;
        }
        let next = index + 1;
        while (next < source.length && /\s/.test(source[next])) next++;
        if (source[next] === ":") {
          const key = JSON.parse(source.slice(start, index + 1)), keys = objects.at(-1);
          requireCloudV4Check(keys && /^[\x20-\x7e]+$/.test(key) && !keys.has(key), check);
          keys.add(key);
        }
      }
    }
    return JSON.parse(source);
  });
}

/** The installer authenticates the inventory. Attestation independently binds
 * its raw manifest/receipt/base bytes and the host resolver's physical root.
 * A fresh resolver on each call also detects a supervisor restart mid-probe. */
export function verifyCloudV4Installation() {
  requireCloudV4Check(process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0, "root_ownership");
  requireCloudV4Check(process.arch === "x64", "base_compatibility");
  const marker = parseCloudV4Document(readCloudV4File(MARKER, 4096, "host_marker"), "host_marker");
  attemptV4("host_marker", () => validateCloudRuntimeMarker(marker));
  const descriptor = attemptV4("active_descriptor", () => parseCloudActiveRuntime(parseCloudV4Document(
    readCloudV4File("/run/zeros/active-runtime.json", 16384, "active_descriptor", 0o600), "active_descriptor")));
  const resolver = createCloudRuntimeResolver({ filesystem, isOwner: (_file, uid) => uid === 0,
    isEngine: () => false, isReadOnly: () => false, executable: () => process.execPath });
  const runtime = attemptV4("root_ownership", () => resolver.resolve());
  requireCloudV4Check(runtime.profile === "v4" && Object.keys(descriptor).every(key => runtime[key] === descriptor[key]), "active_descriptor");
  const manifestRaw = readCloudV4File(`${runtime.root}/manifest.json`, 64 * 1024 * 1024, "manifest_digest", 0o444);
  requireCloudV4Check(createHash("sha256").update(manifestRaw).digest("hex") === runtime.manifestSha256, "manifest_digest");
  const manifest = parseCloudV4Document(manifestRaw, "manifest_schema");
  requireCloudV4Check(manifest?.schema === "zeros.runtime-manifest/v1" && Array.isArray(manifest.files) &&
    manifest.files.length > 0 && manifest.files.length <= 250_000, "manifest_schema");
  let expandedBytes = 0, fileCount = 0;
  for (const file of manifest.files) {
    requireCloudV4Check(file && ["file", "dir", "symlink"].includes(file.type), "manifest_schema");
    if (file.type === "file") {
      requireCloudV4Check(Number.isSafeInteger(file.size) && file.size >= 0, "manifest_schema");
      expandedBytes += file.size; fileCount++;
    }
  }
  requireCloudV4Check(fileCount > 0 && expandedBytes > 0 && expandedBytes <= 4 * 1024 ** 3, "manifest_schema");
  const compatibility = readCloudV4File("/opt/zeros-bootstrap/compatibility.json", 256 * 1024, "base_compatibility", 0o444);
  requireCloudV4Check(`bc1-${createHash("sha256").update(compatibility).digest("hex")}` === runtime.baseCompatibilityId, "base_compatibility");
  const receiptRaw = readCloudV4File(`/srv/zeros/runtime-installs/${runtime.runtimeId}.json`, 4096, "installer_receipt", 0o600);
  requireCloudV4Check(createHash("sha256").update(receiptRaw).digest("hex") === runtime.installerReceiptSha256, "receipt_digest");
  const receipt = parseCloudV4Document(receiptRaw, "installer_receipt");
  requireCloudV4Check(exactKeys(receipt, ["archiveSha256", "baseCompatibilityId", "bootstrapVersion", "expandedBytes", "fileCount",
    "installedAt", "manifestSha256", "runtimeId", "schema"]) && receipt.schema === "zeros.runtime-install-receipt/v1" &&
    receipt.runtimeId === runtime.runtimeId && receipt.manifestSha256 === runtime.manifestSha256 &&
    receipt.baseCompatibilityId === runtime.baseCompatibilityId && receipt.bootstrapVersion === 1 &&
    hexDigest(receipt.archiveSha256) && receipt.expandedBytes === expandedBytes && receipt.fileCount === fileCount &&
    receiptTimestamp(receipt.installedAt), "installer_receipt");
  try { lstatSync(`${runtime.root}.incomplete`); throw new V4Failure("file_inventory"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  requireCloudV4Check(runtime.bootId === readOptional("/proc/sys/kernel/random/boot_id"), "boot_identity");
  return runtime;
}

export function cloudV4Identity(runtime) {
  return Object.fromEntries(CLOUD_V4_IDENTITY_FIELDS.map(key => [key, runtime[key]]));
}
export function cloudV4LaunchBinding() {
  const namespaces = Object.fromEntries(["mnt", "pid", "cgroup"].map(name => [name, namespace(name)]));
  const ticks = containerInitStartTicks();
  requireCloudV4Check(typeof ticks === "string" && /^[0-9]{1,32}$/.test(ticks) &&
    ["mnt", "pid", "net", "ipc", "uts", "cgroup", "user"].every(name =>
      new RegExp(`^${name}:\\[[0-9]{1,20}\\]$`).test(namespace(name) ?? "")), "namespace_binding");
  return { containerInitStartTicks: ticks, namespaces };
}
export function requireCloudV4AdmissionDirectory() {
  requireCloudV4Check(rootControlled(ADMISSION_DIRECTORY, false, true) &&
    (lstatSync(ADMISSION_DIRECTORY).mode & 0o7077) === 0, "root_ownership");
}

function verifyV4Link(root, file) {
  // Follow raw components before '..', just like the resolver. A final
  // realpath check alone would accept a link that leaves R and reenters it.
  let current = root, pending = file.slice(root.length + 1).split("/"), links = 0;
  while (pending.length) {
    requireCloudV4Check(pending.length <= 4096, "symlink_escape");
    const component = pending.shift();
    if (!component || component === ".") continue;
    if (component === "..") {
      requireCloudV4Check(current !== root, "symlink_escape");
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(current);
      requireCloudV4Check(target.length > 0 && Buffer.byteLength(target) <= 4096 &&
        !path.isAbsolute(target) && !/[\\\0\r\n]/.test(target) && ++links <= 64, "symlink_escape");
      pending = [...target.split("/"), ...pending];
      current = path.dirname(current);
    } else requireCloudV4Check(pending.length ? stat.isDirectory() : stat.isFile() || stat.isDirectory(), "symlink_escape");
  }
}

function verifyV4Tree(root) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const file = pending.pop(), stat = lstatSync(file);
    requireCloudV4Check(++visited <= 250_002, "file_inventory");
    requireCloudV4Check(stat.uid === 0, "root_ownership");
    if (stat.isSymbolicLink()) {
      attemptV4("symlink_escape", () => verifyV4Link(root, file));
    } else {
      requireCloudV4Check((stat.mode & 0o7022) === 0, "file_mode");
      if (stat.isDirectory()) for (const entry of readdirSync(file)) pending.push(path.join(file, entry));
      else {
        requireCloudV4Check(stat.isFile(), "file_inventory");
        requireCloudV4Check(stat.nlink === 1, "hard_link");
      }
    }
  }
}

function verifyV4Helpers(runtime) {
  const trusted = { node: rootControlled(runtime.node, true) };
  requireCloudV4Check(trusted.node, "root_ownership");
  const deploymentTrusted = {};
  for (const [name, relative, executable] of [
    ["runtimeProfile", "cloud-runtime-profile.mjs"], ["engineLauncher", "cloud-engine-launcher.mjs"],
    ["engineView", "cloud-engine-view.mjs"], ["engineCgroup", "cloud-engine-cgroup.mjs"],
    ["runtimeLayout", "runtime-layout.json"], ["resourceInspector", "cgroup-resources.mjs"],
    ["resourceAdmission", "cloud-resource-admission.mjs"], ["setupProcess", "cloud-setup-process.mjs"],
    ["admissionConsumer", "consume-cloud-admission.mjs", true], ["previewLinkInstaller", "install-cloud-preview-links.mjs", true],
    ["githubCredentialInstaller", "install-cloud-github-credential.mjs", true], ["githubRefreshRequestHelper", "cloud-github-refresh-request.mjs", true],
    ["gitAskpass", "cloud-git-askpass.mjs", true],
    ["setupHelper", "setup-cloud-workspace.mjs", true], ["attester", "attest-cloud-worker.mjs", true],
  ]) deploymentTrusted[name] = rootControlled(`${runtime.libRoot}/${relative}`, executable);
  deploymentTrusted.hostProcessSupervisor = rootControlled(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`);
  requireCloudV4Check(rootControlled(runtime.helpers.supervisor, true), "root_ownership");
  deploymentTrusted.engineNamespace = rootControlled(runtime.engineNamespace, true);
  deploymentTrusted.launcher = rootControlled(runtime.startEngine, true);
  deploymentTrusted.engineQualification = rootControlled(`${runtime.workerRoot}/scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs`);
  requireCloudV4Check(Object.values(deploymentTrusted).every(Boolean), "root_ownership");
  requireCloudV4Check(rootControlled("/etc/apparmor.d/zeros-cloud-engine"), "apparmor");
  deploymentTrusted.engineAppArmor = true;
  attemptV4("root_ownership", () => verifyV4Tree(runtime.root));
  deploymentTrusted.runtimeTree = true;
  deploymentTrusted.admissionDirectory = true;
  return { trusted, deploymentTrusted };
}

function runV4Probe(runtime, helper, timeout, check) {
  const result = spawnSync(runtime.node, [helper, "--qualify"], { encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT,
    env: { PATH: `${runtime.binRoot}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: "/root" } });
  requireCloudV4Check(result.error?.code !== "ETIMEDOUT", "timeout");
  requireCloudV4Check(!result.signal, "process_signal");
  requireCloudV4Check(!result.error && result.status === 0, check);
  return parseCloudV4Document(Buffer.from(result.stdout ?? ""), "diagnostic_missing");
}

function v4DelegatedResources(runtime, qualification) {
  const root = runtime.cgroupRoot;
  requireCloudV4Check(statfsSync(root).type === 0x63677270, "cgroup_controllers");
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor);
    const kernelAncestor = ["/sys", "/sys/fs"].includes(cursor) && stat.uid === 65534 && statfsSync(cursor).type === 0x62656572;
    requireCloudV4Check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === 0 || kernelAncestor) &&
      !(stat.mode & 0o022), "cgroup_controllers");
    if (cursor === "/") break;
  }
  for (const control of ["cgroup.controllers", "cgroup.subtree_control", "cgroup.procs"]) {
    const stat = lstatSync(`${root}/${control}`);
    requireCloudV4Check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022), "cgroup_controllers");
  }
  requireCloudV4Check(readOptional(`${root}/cgroup.procs`) === "" &&
    ["cgroup.controllers", "cgroup.subtree_control"].every(name =>
      ["cpu", "memory", "pids"].every(controller => readOptional(`${root}/${name}`)?.split(/\s+/).includes(controller))), "cgroup_controllers");
  const resources = qualification?.identity?.resources;
  const relative = root.slice("/sys/fs/cgroup".length), leaf = resources?.hierarchy?.[0]?.path;
  const prefix = `${relative}/engine-runtime/engine-`;
  requireCloudV4Check(typeof leaf === "string" && leaf.startsWith(prefix) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf.slice(prefix.length)), "cgroup_controllers");
  requireCloudV4Check(cloudRuntimeResourcesQualified(resources), "finite_resources");
  const contractPath = "/run/zeros/cloud-resource-contract.json";
  let contract = null;
  try { lstatSync(contractPath); contract = parseCloudV4Document(readCloudV4File(contractPath, 4096, "finite_resources", 0o600), "finite_resources"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  requireCloudV4Check(contract === null || exactKeys(contract, ["version", "resources"]) && contract.version === 1, "finite_resources");
  requireCloudV4Check(validCloudResourceBudgetProjection({ version: 1, resources: contract?.resources ?? null,
    memoryBudget: resources.memoryBudget }), "finite_resources");
  const hostLimit = `${root}/host/memory.max`;
  requireCloudV4Check(rootControlled(hostLimit) && readOptional(hostLimit) === resources.memoryBudget.hostMemoryMax, "finite_resources");
  const meminfo = readOptional("/proc/meminfo");
  const memoryLines = typeof meminfo === "string" && meminfo.length <= 65536 ? meminfo.split("\n").filter(line => line.startsWith("MemTotal:")) : [];
  const rawMemory = memoryLines.length === 1 && /^MemTotal:\s+([1-9][0-9]{0,15}) kB$/.exec(memoryLines[0]);
  const memoryBytes = rawMemory ? BigInt(rawMemory[1]) * 1024n : null;
  requireCloudV4Check((resources.memoryBudget.measuredMemoryBytes === null || memoryBytes === BigInt(resources.memoryBudget.measuredMemoryBytes)) &&
    (resources.memoryBudget.source === "fallback" || memoryBytes === null ||
      BigInt(resources.memoryMax) <= memoryBytes - BigInt(resources.memoryBudget.hostMemoryMax)), "finite_resources");
  // The root launcher has already retired this exact common tree. Validate the
  // fixed probe's pre-retirement ancestry rather than statting a removed leaf
  // or borrowing the unrelated host-service limits.
  const hierarchy = resources.hierarchy;
  requireCloudV4Check(Array.isArray(hierarchy) && hierarchy.length > 1 && hierarchy.length <= 128, "cgroup_controllers");
  let expected = leaf;
  const controls = new Map();
  for (const entry of hierarchy) {
    requireCloudV4Check(exactKeys(entry, ["path", "cpuMax", "memoryMax", "pidsMax"]) && entry.path === expected &&
      !controls.has(entry.path), "cgroup_controllers");
    controls.set(entry.path, entry);
    expected = path.posix.dirname(expected);
  }
  requireCloudV4Check(hierarchy.at(-1).path === "/" && controls.has(`${relative}/engine-runtime`) &&
    /^[1-9][0-9]{0,18}$/.test(controls.get(`${relative}/engine-runtime`).memoryMax ?? "") &&
    /^[1-9][0-9]{0,18}$/.test(controls.get(`${relative}/engine-runtime`).pidsMax ?? ""), "finite_resources");
  const observed = attemptV4("finite_resources", () => effectiveCloudResourceLimits(`0::${leaf}\n`, file => {
    const directory = path.posix.dirname(file).slice("/sys/fs/cgroup".length) || "/";
    return controls.get(directory)?.[({ "cpu.max": "cpuMax", "memory.max": "memoryMax", "pids.max": "pidsMax" })[path.basename(file)]] ?? null;
  }));
  requireCloudV4Check(["finite", "cpuMax", "memoryMax", "pidsMax"].every(name => resources[name] === observed[name]), "finite_resources");
  const storage = statfsSync(cloudComputerHostRepository(runtime), { bigint: true });
  const allocation = cloudAllocationCapacity({ isolated: false, membership: `0::${relative}\n`, read: readOptional,
    architecture: process.arch, availableCPUs: availableParallelism(), storageBytes: Number(storage.blocks * storage.bsize) });
  requireCloudV4Check([allocation.cpuMillicores, allocation.memoryBytes, allocation.storageBytes].every(value => Number.isSafeInteger(value) && value > 0), "finite_resources");
  const result = { finite: resources.finite, cpuMax: resources.cpuMax, memoryMax: resources.memoryMax, pidsMax: resources.pidsMax,
    allocation, cpuSplit: resources.cpuSplit, memoryBudget: resources.memoryBudget };
  requireCloudV4Check(contract === null || cloudResourcesMeetContract(contract.resources, result), "finite_resources");
  return result;
}

export function validV4Diagnostic(value) {
  return exactKeys(value, ["schema", "component", "stage", "ok", "exitCode", "timedOut", "failedChecks", ...(value?.timings === undefined ? [] : ["timings"])]) &&
    (value.timings === undefined || parseSetupTimings(value.timings) !== undefined) &&
    value.schema === "zeros.diagnostic/v1" && value.component === "attester" && V4_STAGES.has(value.stage) &&
    typeof value.ok === "boolean" && value.exitCode === (value.ok ? 0 : 1) && typeof value.timedOut === "boolean" &&
    Array.isArray(value.failedChecks) && value.failedChecks.length <= 32 && new Set(value.failedChecks).size === value.failedChecks.length &&
    value.failedChecks.every(check => V4_CHECKS.has(check)) && (value.ok ? value.failedChecks.length === 0 : value.failedChecks.length > 0) &&
    value.timedOut === value.failedChecks.includes("timeout");
}

function attestV4CloudWorker() {
  let stage = "validate_input";
  const timings = setupTimingClock("attester_preflight");
  let finished;
  const next = value => { finished?.(); finished = timings.start(value); };
  try {
    requireCloudV4Check(process.platform === "linux" && process.geteuid?.() === 0, "root_ownership");
    stage = "lock";
    next(stage);
    requireCloudV4AdmissionDirectory();
    if (process.argv[2] !== LOCKED_ARGUMENT) {
      requireCloudV4Check(process.argv.length === 2, "input_schema");
      const token = path.join(ADMISSION_DIRECTORY, `.attest-lock-${process.pid}-${randomBytes(8).toString("hex")}`);
      let child;
      try {
        writeFileSync(token, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
        child = spawnSync("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "75", ENGINE_LOCK,
          process.execPath, realpathSync(fileURLToPath(import.meta.url)), LOCKED_ARGUMENT, token],
        { encoding: "utf8", timeout: 300_000, maxBuffer: MAX_OUTPUT, env: { PATH: "/usr/bin:/bin", HOME: "/root" } });
      } finally { rmSync(token, { force: true }); }
      requireCloudV4Check(child.error?.code !== "ETIMEDOUT", "timeout");
      requireCloudV4Check(!child.signal, "process_signal");
      requireCloudV4Check(child.status !== 75, "lock_busy");
      requireCloudV4Check(!child.error, "diagnostic_missing");
      const lines = (child.stdout ?? "").trim().split("\n");
      const diagnostic = attemptV4("diagnostic_missing", () => JSON.parse(lines.at(-1)));
      requireCloudV4Check(validV4Diagnostic(diagnostic) && child.status === diagnostic.exitCode, "diagnostic_missing");
      if (diagnostic.ok) {
        requireCloudV4Check(lines.length === 2, "diagnostic_missing");
        const report = attemptV4("diagnostic_missing", () => JSON.parse(lines[0]));
        requireCloudV4Check(report?.version === 2 && report.boundary === "workspace-vm" && report.profile === "zeros-cloud-worker-v4" && report.qualified === true, "diagnostic_missing");
        process.stdout.write(`${JSON.stringify(report)}\n`);
      }
      process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
      process.exitCode = diagnostic.exitCode;
      return;
    }
    requireCloudV4Check(process.argv.length === 4 && typeof process.argv[3] === "string" &&
      path.dirname(process.argv[3]) === ADMISSION_DIRECTORY, "input_schema");
    const token = readCloudV4File(process.argv[3], 65, "input_schema", 0o600);
    requireCloudV4Check(hexDigest(token.toString("utf8").trim()), "input_schema");
    unlinkSync(process.argv[3]);
    // Hold the engine lock before invalidating any prior unconsumed authority.
    rmSync(ADMISSION_PROOF, { force: true });
    stage = "verify_tree";
    next(stage);
    const runtime = verifyCloudV4Installation(), binding = cloudV4LaunchBinding();
    const helpers = verifyV4Helpers(runtime);
    stage = "qualify_engine";
    next(stage);
    const qualification = runV4Probe(runtime, runtime.helpers.launcher, 180_000, "engine_lifecycle");
    requireCloudV4Check(qualification?.identity?.hostUid === 10003 && qualification?.identity?.namespaceUid === 10003, "uid_map");
    requireCloudV4Check(qualification?.identity?.qualified === true && qualification.identity.noNewPrivs === 1 &&
      qualification.identity.seccompMode === 2 && exactKeys(qualification.identity.capabilities, ["effective", "permitted", "inheritable", "bounding", "ambient"]) &&
      Object.values(qualification.identity.capabilities).every(value => value === 0), "seccomp");
    requireCloudV4Check(qualification?.version === 2 && qualification.boundary === "workspace-vm" && qualification.qualified === true &&
      qualification.engineChecksPassed === undefined &&
      ["sameEngineIdentity", "noSandbox", "ownedProcessGroups", "originalProcessGroupsRetired", "timeoutRetired", "workloadCgroup", "vmWorkloadDrain"].every(name => qualification.execution?.[name] === true) &&
      ["capture", "humanServices", "actorTools"].every(name => qualification[name]?.sameEngineIdentity === true) &&
      qualification.capture.chromiumSandbox === true && qualification.humanServices.noSandbox === true && qualification.actorTools.noSandbox === true, "engine_lifecycle");
    const resources = attemptV4("cgroup_controllers", () => v4DelegatedResources(runtime, qualification));
    stage = "run_setup";
    next(stage);
    const setup = runV4Probe(runtime, runtime.helpers.setupProcess, 30_000, "setup_exit");
    requireCloudV4Check(setup?.hostUid === 10003 && setup.hostGid === 10003 &&
      ["detachedDescendantsRetired", "timeoutRetired"].every(name => setup?.[name] === true), "setup_exit");
    stage = "publish_proof";
    next(stage);
    const current = verifyCloudV4Installation();
    requireCloudV4Check([...CLOUD_V4_IDENTITY_FIELDS, "cgroupRoot"].every(key => current[key] === runtime[key]), "active_descriptor");
    requireCloudV4Check(JSON.stringify(cloudV4LaunchBinding()) === JSON.stringify(binding), "namespace_binding");
    // Project only fixed fields. Probe stdout/stderr may include workload data.
    const report = { version: 2, boundary: "workspace-vm", profile: "zeros-cloud-worker-v4", qualified: true,
      runtime: cloudV4Identity(runtime), helpers, resources,
      qualification: { identity: { hostUid: 10003, namespaceUid: 10003, noNewPrivs: 1, seccompMode: 2,
        capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } },
        execution: { sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true, originalProcessGroupsRetired: true,
          timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true },
        capture: { sameEngineIdentity: true, chromiumSandbox: true }, humanServices: { sameEngineIdentity: true, noSandbox: true },
        actorTools: { sameEngineIdentity: true, noSandbox: true } },
      setupQualification: { hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: true, timeoutRetired: true } };
    const serialized = `${JSON.stringify(report)}\n`;
    const proof = { version: 2, profile: report.profile, qualifiedAtMs: Date.now(), reportSha256: createHash("sha256").update(serialized).digest("hex"),
      ...report.runtime, ...binding };
    const temporary = `${ADMISSION_PROOF}.${process.pid}.tmp`;
    attemptV4("pointer_publish", () => {
      try {
        writeFileSync(temporary, `${JSON.stringify(proof)}\n`, { flag: "wx", mode: 0o400 });
        chmodSync(temporary, 0o400);
        renameSync(temporary, ADMISSION_PROOF);
      } finally { rmSync(temporary, { force: true }); }
    });
    process.stdout.write(serialized);
    finished?.();
    process.stdout.write(`${JSON.stringify({ ...cloudV4Diagnostic(null, "done"), timings: timings.snapshot() })}\n`);
  } catch (error) {
    finished?.("failed");
    process.stdout.write(`${JSON.stringify({ ...cloudV4Diagnostic(error ?? {}, stage), timings: timings.snapshot() })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  attestV4CloudWorker();
}
