import {
  chmodSync,
  fchmodSync,
  fchownSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveCloudRuntime, isCloudRuntimeCgroupRoot } from "./cloud-runtime-root.mjs";
import { validCloudResourceContract } from "./cloud-resource-admission.mjs";
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";

export const CLOUD_ENGINE_CGROUP = "/sys/fs/cgroup/zeros-cloud-engine";
export const CLOUD_SETUP_CGROUP = "/sys/fs/cgroup/zeros-cloud-setup";
// Existing main budget is retained on the new common ancestor. The engine
// leaf itself has CPU-only controls and is uncapped inside that budget.
export const CLOUD_RUNTIME_LIMITS = Object.freeze({
  "cpu.max": "400000 100000",
  "memory.max": String(7 * 1024 * 1024 * 1024),
  "pids.max": "4096",
  "memory.oom.group": "1",
});
export const CLOUD_ENGINE_LIMITS = Object.freeze({
  "cpu.max": "max 100000",
  "cpu.weight": "100",
});
export const CLOUD_HOST_LIMITS = Object.freeze({
  "cpu.max": "100000 100000",
  "memory.max": String(256 * 1024 * 1024),
  "pids.max": "256",
  "memory.oom.group": "1",
});
const INSTANCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// The protected v4 base's final stop verifier admits engine-* leaf names.
// Retain that namespace without changing base bytes or its compatibility ID.
const WORKLOAD_PREFIX = "engine-workload-";
const RUNTIME_TREE = "engine-runtime";
const MIGRATION_CONTROLS = ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"];
const workloadLeaf = name => name.startsWith(WORKLOAD_PREFIX) && INSTANCE.test(name.slice(WORKLOAD_PREFIX.length));
const CONTROL_NAMES = new Set([
  ...Object.keys(CLOUD_RUNTIME_LIMITS),
  ...Object.keys(CLOUD_ENGINE_LIMITS),
  "cgroup.procs",
  "cgroup.events",
  "cgroup.kill",
  "cgroup.controllers",
  "cgroup.subtree_control",
  "cgroup.threads",
  "cpuset.cpus.effective",
]);

const skippedCap = diagnostic => ({ kind: "skipped", cpuMax: "max 100000", diagnostic });
export const CLOUD_RESOURCE_CONTRACT = "/run/zeros/cloud-resource-contract.json";

/** Root-only admitted SKU, kept outside the shared engine projection. Missing
 * metadata is explicit fallback, never a nominal allocation inferred from RAM. */
export function readCloudRuntimeResourceContract() {
  let descriptor;
  try {
    for (let current = path.dirname(CLOUD_RESOURCE_CONTRACT); ; current = path.dirname(current)) {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.mode & 0o022 || realpathSync(current) !== current)
        throw new Error("Cloud resource contract ancestry is unsafe");
      if (current === "/") break;
    }
    descriptor = openSync(CLOUD_RESOURCE_CONTRACT, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.gid !== 0 || metadata.nlink !== 1 ||
        (metadata.mode & 0o7777) !== 0o600 || metadata.size < 2 || metadata.size > 2048) throw new Error("Cloud resource contract is unsafe");
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!value || Object.keys(value).sort().join(",") !== "resources,version" || value.version !== 1 || !validCloudResourceContract(value.resources))
      throw new Error("Cloud resource contract is invalid");
    return Object.freeze({ ...value.resources });
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
const MAX_CPU = 65535;
function cpuCount(source) {
  if (typeof source !== "string" || source.length > 65536) return null;
  const value = source.trim();
  if (!/^(?:0|[1-9][0-9]{0,4})(?:-(?:0|[1-9][0-9]{0,4}))?(?:,(?:0|[1-9][0-9]{0,4})(?:-(?:0|[1-9][0-9]{0,4}))?)*$/.test(value)) return null;
  let previous = -1, count = 0;
  for (const range of value.split(",")) {
    const [first, last = first] = range.split("-").map(Number);
    if (first <= previous || last < first || last > MAX_CPU) return null;
    count += last - first + 1;
    previous = last;
  }
  return count;
}

/** Only the exact engine ancestry supplies the CPU set. CPU-only leaves
 * legitimately lack this file; an unreadable existing file is not bypassed. */
export function cloudWorkloadCpuCap(directory, read = file => readFileSync(file, "utf8"), parentCpuMax = "max 100000") {
  if (typeof directory !== "string" || !directory.startsWith("/sys/fs/cgroup/") ||
      directory.includes("\0") || path.posix.normalize(directory) !== directory || directory.split("/").length > 128)
    return skippedCap("cpuset_invalid");
  let source;
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    try { source = read(`${cursor}/cpuset.cpus.effective`); break; }
    catch (error) {
      if (error?.code !== "ENOENT" || cursor === "/sys/fs/cgroup") return skippedCap("cpuset_unavailable");
    }
  }
  const count = cpuCount(source);
  if (count === null) return skippedCap("cpuset_invalid");
  const parent = /^(max|[1-9][0-9]{0,18}) ([1-9][0-9]{0,18})$/.exec(parentCpuMax);
  if (!parent || BigInt(parent[2]) > 9223372036854775807n ||
      parent[1] !== "max" && BigInt(parent[1]) > 9223372036854775807n)
    throw new Error("Invalid cloud CPU ancestor limit");
  const period = BigInt(parent[2]);
  const quota = parent[1] === "max" ? BigInt(count) * period :
    (BigInt(count) * period < BigInt(parent[1]) ? BigInt(count) * period : BigInt(parent[1]));
  const maximum = (quota * 75000n + period / 2n) / period;
  if (maximum < 1n) throw new Error("Invalid cloud CPU ancestor limit");
  return { kind: "applied", effectiveCpus: count, cpuMax: `${maximum} 100000` };
}

/** Same MemTotal source as allocation/SKU admission. If either measurement
 * fails, preserve both exact main bounds and skip only the optional cap. */
export function cloudRuntimeBudget(directory, read = file => readFileSync(file, "utf8"), measuredMemoryBytes,
  nominalMemoryBytes, hostMemoryMax = Number(CLOUD_HOST_LIMITS["memory.max"]), nominalCpuMillicores) {
  const cap = cloudWorkloadCpuCap(directory, read);
  let memory = measuredMemoryBytes;
  let diagnostic;
  if (memory === undefined) {
    let source;
    try { source = read("/proc/meminfo"); }
    catch { diagnostic = "memory_unavailable"; }
    const lines = typeof source === "string" && source.length <= 65536 ? source.split("\n").filter(line => line.startsWith("MemTotal:")) : [];
    const match = lines.length === 1 && /^MemTotal:\s+([1-9][0-9]{0,15}) kB$/.exec(lines[0]);
    memory = match ? Number(match[1]) * 1024 : NaN;
  }
  const measured = Number.isSafeInteger(memory) && memory > 0 ? memory : null;
  const nominal = Number.isSafeInteger(nominalMemoryBytes) && nominalMemoryBytes > 1024 ** 3 ? nominalMemoryBytes : null;
  if (!Number.isSafeInteger(hostMemoryMax) || hostMemoryMax <= 0) throw new Error("Invalid cloud host memory reserve");
  if (measured === null || measured <= hostMemoryMax) diagnostic ??= "memory_invalid";
  if (nominal === null) diagnostic ??= "memory_unavailable";
  if (!Number.isSafeInteger(nominalCpuMillicores) || nominalCpuMillicores < 1 || nominalCpuMillicores > 2147483647)
    diagnostic ??= "cpuset_unavailable";
  const current = cap.kind === "applied" && diagnostic === undefined;
  const requested = current ? nominal - 1024 ** 3 : Number(CLOUD_RUNTIME_LIMITS["memory.max"]);
  // Fallback reproduces main byte-for-byte, even if some raw observations
  // remain available. Only the nominal policy applies the host ceiling.
  const ceiling = current ? measured - hostMemoryMax : requested;
  const applied = Math.min(requested, ceiling);
  const memoryBudget = Object.freeze({ nominalMemoryBytes: nominal === null ? null : String(nominal),
    measuredMemoryBytes: measured === null ? null : String(measured), hostMemoryMax: String(hostMemoryMax),
    source: current ? "nominal" : "fallback", capped: applied < requested });
  const limits = Object.freeze({ ...CLOUD_RUNTIME_LIMITS,
    ...(current ? { "cpu.max": `${nominalCpuMillicores * 100} 100000` } : {}), "memory.max": String(applied) });
  return { limits,
    cap: cap.kind === "skipped" ? cap : current ? cloudWorkloadCpuCap(directory, read, limits["cpu.max"]) : skippedCap(diagnostic), memoryBudget };
}

function delegatedDirectory(directory) {
  const index = directory.indexOf(`/${RUNTIME_TREE}`);
  return index !== -1 && isCloudRuntimeCgroupRoot(directory.slice(0, index)) &&
    (directory.length === index + RUNTIME_TREE.length + 1 || directory[index + RUNTIME_TREE.length + 1] === "/");
}

function assertDirectory(directory) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    realpathSync(directory) !== directory ||
    statfsSync(directory).type !== 0x63677270
  )
    throw new Error("Cloud engine requires an admitted cgroup v2 scope");
  for (let current = directory; ; current = path.dirname(current)) {
    const metadata = lstatSync(current);
    // A provider user namespace can leave kernel-owned sysfs ancestors
    // unmapped. Only these two actual sysfs directories get this exception;
    // the delegated cgroup and every writable control remain root-owned.
    const kernelAncestor = ["/sys", "/sys/fs"].includes(current) &&
      metadata.uid === 65534 && statfsSync(current).type === 0x62656572;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.uid !== 0 && !(delegatedDirectory(current) && metadata.uid === 10003) && !kernelAncestor) ||
      metadata.mode & 0o022
    )
      throw new Error("Cloud engine cgroup ancestry is unsafe");
    if (current === "/") break;
  }
}

function openControl(directory, name, writing) {
  if (!CONTROL_NAMES.has(name)) throw new Error("Invalid cgroup control");
  const descriptor = openSync(
    path.join(directory, name),
    constants.O_NOFOLLOW | (writing ? constants.O_WRONLY : constants.O_RDONLY),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (metadata.uid !== 0 && !(delegatedDirectory(directory) && metadata.uid === 10003 && metadata.gid === 10003 &&
        (MIGRATION_CONTROLS.includes(name) || !writing && name === "cgroup.events"))) ||
      metadata.mode & 0o022 ||
      statfsSync(`/proc/self/fd/${descriptor}`).type !== 0x63677270
    )
      throw new Error("Cloud engine cgroup control is unsafe");
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

const nativeIo = {
  children(directory) {
    assertDirectory(directory);
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  },
  exists(directory) {
    try {
      assertDirectory(directory);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  },
  create(directory) {
    assertDirectory(path.dirname(directory));
    mkdirSync(directory, { mode: 0o700 });
    assertDirectory(directory);
    // The namespace engine needs read-only resource evidence. The host keeps
    // every controller root-owned; this grants no write or delegation rights.
    chmodSync(directory, 0o755);
  },
  read(directory, name) {
    const descriptor = openControl(directory, name, false);
    try {
      const buffer = Buffer.alloc(65537);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!count) break;
        size += count;
      }
      if (size > 65536)
        throw new Error("Cloud engine cgroup evidence is too large");
      return buffer.toString("utf8", 0, size).trim();
    } finally {
      closeSync(descriptor);
    }
  },
  readAbsolute(file) {
    if (file !== "/proc/meminfo") return this.read(path.dirname(file), path.basename(file));
    const descriptor = openSync(file, constants.O_NOFOLLOW | constants.O_RDONLY);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || ![0, 65534].includes(metadata.uid) || metadata.mode & 0o022 ||
          statfsSync(`/proc/self/fd/${descriptor}`).type !== 0x9fa0)
        throw new Error("Cloud memory allocation evidence is unsafe");
      const value = readFileSync(descriptor, "utf8");
      if (value.length > 65536) throw new Error("Cloud memory allocation evidence is too large");
      return value;
    } finally { closeSync(descriptor); }
  },
  delegate(directory, controls) {
    if (!delegatedDirectory(directory) || controls.join("\0") !== MIGRATION_CONTROLS.join("\0"))
      throw new Error("Invalid cloud cgroup delegation");
    assertDirectory(directory);
    // These descriptors are used only to change ownership and are closed
    // here. No root-open migration descriptor is delivered to engine code.
    for (const name of controls) {
      const descriptor = openControl(directory, name, false);
      try { fchownSync(descriptor, 10003, 10003); fchmodSync(descriptor, 0o644); }
      finally { closeSync(descriptor); }
    }
    const descriptor = openSync(directory, constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_RDONLY);
    try { fchownSync(descriptor, 10003, 10003); fchmodSync(descriptor, 0o755); }
    finally { closeSync(descriptor); }
  },
  processIdentity(pid) {
    const source = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(source);
    const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(source);
    return uid && gid && uid.slice(1).every(value => value === uid[1]) && gid.slice(1).every(value => value === gid[1]) ?
      { uid: Number(uid[1]), gid: Number(gid[1]) } : null;
  },
  identity(directory) {
    assertDirectory(directory);
    const metadata = lstatSync(directory, { bigint: true });
    // Delegated scopes belong to the current engine. Only the original direct
    // legacy resident namespace retains VM-root ownership; /host is excluded.
    const owner = delegatedDirectory(directory) ? 10003n :
      isCloudRuntimeCgroupRoot(path.dirname(directory)) && workloadLeaf(path.basename(directory)) ? 0n : null;
    if (owner === null || metadata.uid !== owner || metadata.gid !== owner || metadata.ino <= 0n)
      throw new Error("Cloud delegated scope identity is unsafe");
    return Object.freeze({ directory, dev: String(metadata.dev), ino: String(metadata.ino) });
  },
  write(directory, name, value) {
    const descriptor = openControl(directory, name, true);
    try {
      if (writeSync(descriptor, value) !== Buffer.byteLength(value))
        throw new Error("Cloud engine cgroup write was not confirmed");
    } finally {
      closeSync(descriptor);
    }
  },
  remove(directory) {
    assertDirectory(directory);
    rmdirSync(directory);
  },
};

function populated(source) {
  const values = source
    .split("\n")
    .filter((line) => line.startsWith("populated "));
  if (values.length !== 1 || !/^populated [01]$/.test(values[0]))
    throw new Error("Invalid cgroup population evidence");
  return values[0] === "populated 1";
}

function confirmControls(io, directory, controls) {
  for (const [name, value] of Object.entries(controls)) {
    io.write(directory, name, value);
    if (io.read(directory, name) !== value) throw new Error("Cloud engine resource limit was not confirmed");
  }
}
function ensureEmptyDirectory(io, directory) {
  if (!io.exists(directory)) io.create(directory);
  if (io.read(directory, "cgroup.procs") !== "") throw new Error("Cloud resource parent must be empty");
}
function enableCpu(io, directory) {
  io.write(directory, "cgroup.subtree_control", "+cpu");
  if (io.read(directory, "cgroup.subtree_control") !== "cpu") throw new Error("Cloud CPU delegation was not confirmed");
}
function removeKernelTree(io, directory, budget = { remaining: 8192 }, depth = 0) {
  if (--budget.remaining < 0 || depth > 128) throw new Error("Cloud cgroup cleanup exceeds its bound");
  const children = io.children(directory);
  if (children.some(name => !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") || name.length > 255))
    throw new Error("Invalid cloud cgroup child");
  for (const name of children) removeKernelTree(io, `${directory}/${name}`, budget, depth + 1);
  if (populated(io.read(directory, "cgroup.events"))) throw new Error("Cloud engine retirement is unconfirmed");
  io.remove(directory);
}

/** The protected dispatcher and every root helper remain OUTSIDE this
 * delegated tree. Root limit files protect the whole workspace; migration
 * rights use the engine user's own opener credentials, never a root FD. */
export class CloudRuntimeCgroup {
  /** @param {{runtime?: any, io?: any, resourceContract?: any,
   * now?: () => number, pause?: (milliseconds: number) => Promise<void>}} options */
  constructor({ runtime = resolveCloudRuntime(), io = nativeIo, resourceContract,
    now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    if (runtime.profile !== "v4" || !isCloudRuntimeCgroupRoot(runtime.cgroupRoot)) throw new Error("Invalid cloud engine scope identity");
    this.runtime = runtime; this.io = io; this.now = now; this.pause = pause;
    this.resourceContract = resourceContract;
    this.directory = `${runtime.cgroupRoot}/${RUNTIME_TREE}`;
    this.workloadDirectory = `${this.directory}/engine-workload-shared/workload`;
  }
  prepare() {
    const engine = `${this.directory}/engine-00000000-0000-4000-8000-000000000000`;
    const read = file => this.io.readAbsolute(file);
    const optional = file => { try { return read(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } };
    let contract = this.resourceContract;
    try { contract ??= readCloudRuntimeResourceContract(); } catch { contract = null; }
    const nominal = validCloudResourceContract(contract) ? contract.memoryMiB * 1024 ** 2 : undefined;
    let hostMemoryMax = Number(CLOUD_HOST_LIMITS["memory.max"]);
    try {
      const value = this.io.read(`${this.runtime.cgroupRoot}/host`, "memory.max");
      if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error();
      hostMemoryMax = Number(value);
    } catch { /* Boot keeps the fixed protected-host reserve; qualification rechecks actual controls. */ }
    let budget = cloudRuntimeBudget(engine, read, undefined, nominal, hostMemoryMax, contract?.cpuMillicores);
    ensureEmptyDirectory(this.io, this.directory);
    confirmControls(this.io, this.directory, budget.limits);
    enableCpu(this.io, this.directory);
    const container = path.dirname(this.workloadDirectory);
    ensureEmptyDirectory(this.io, container);
    enableCpu(this.io, container);
    if (!this.io.exists(this.workloadDirectory)) this.io.create(this.workloadDirectory);
    const cap = budget.cap.kind === "applied" ? cloudWorkloadCpuCap(engine, read,
      effectiveCloudResourceLimits(`0::${engine.slice("/sys/fs/cgroup".length)}\n`, optional).cpuMax ?? "max 100000") : budget.cap;
    confirmControls(this.io, this.workloadDirectory, { "cpu.max": cap.cpuMax, "cpu.weight": "100" });
    for (const directory of [this.directory, container, this.workloadDirectory]) this.io.delegate(directory, MIGRATION_CONTROLS);
    this.cpuSplit = Object.freeze({ engine: Object.freeze({ cpuMax: "max 100000", cpuWeight: 100 }),
      workload: Object.freeze({ controllers: Object.freeze(["cpu"]), cpuWeight: 100, cap: Object.freeze(cap) }) });
    this.memoryBudget = budget.memoryBudget;
    this.resourceProjection = Object.freeze({ version: 1,
      resources: validCloudResourceContract(contract) ? Object.freeze({ ...contract }) : null, memoryBudget: this.memoryBudget });
    return this.cpuSplit;
  }
  async retire(timeoutMs = 5000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid cloud engine retirement deadline");
    if (!this.io.exists(this.directory)) return null;
    const original = this.io.identity(this.directory);
    // This kills the engine too. Only the outside root dispatcher can call it
    // after the engine's checkpoint/seal completion and retain the receipt.
    this.io.write(this.directory, "cgroup.kill", "1");
    const deadline = this.now() + timeoutMs;
    while (populated(this.io.read(this.directory, "cgroup.events"))) {
      if (this.now() >= deadline) throw new Error("Cloud engine retirement is unconfirmed");
      await this.pause(Math.min(25, Math.max(1, deadline - this.now())));
    }
    // New siblings created by the shared user are part of the same kernel
    // custody. Prune the complete empty tree before the frozen base verifier.
    removeKernelTree(this.io, this.directory);
    return Object.freeze({ ...original, populated: 0, pruned: true });
  }
}

/** The control leaf contains only the exact non-root controller. Actual work
 * enters the shared pool through its original Host entry. VM-wide retirement
 * belongs to the outside root owner of the common tree. */
export class CloudEngineCgroup {
  /** @param {{directory?: string, runtime?: any, kind?: string, instanceId?: string,
   * resourceContract?: any, io?: any, now?: () => number,
   * pause?: (milliseconds: number) => Promise<void>}} options */
  constructor({
    directory,
    runtime = resolveCloudRuntime(),
    kind = "engine",
    instanceId,
    resourceContract,
    io = nativeIo,
    now = () => performance.now(),
    pause = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    directory ??= cloudCgroupDirectory(runtime, kind, instanceId);
    const leaf = directory.slice(runtime.cgroupRoot.length + 1);
    const nestedLeaf = leaf.startsWith(`${RUNTIME_TREE}/`) ? leaf.slice(RUNTIME_TREE.length + 1) : null;
    const valid = runtime.profile === "v4" &&
      isCloudRuntimeCgroupRoot(runtime.cgroupRoot) &&
      (path.dirname(directory) === runtime.cgroupRoot && (leaf === "setup" || leaf.startsWith("engine-") && INSTANCE.test(leaf.slice(7)) || workloadLeaf(leaf)) ||
       path.dirname(directory) === `${runtime.cgroupRoot}/${RUNTIME_TREE}` && nestedLeaf !== null &&
       (nestedLeaf.startsWith("engine-") && INSTANCE.test(nestedLeaf.slice(7)) || workloadLeaf(nestedLeaf)));
    if (!valid)
      throw new Error("Invalid cloud engine scope identity");
    this.directory = directory;
    this.io = io;
    this.now = now;
    this.pause = pause;
    this.nested = nestedLeaf !== null;
    this.runtime = runtime;
    this.resourceContract = resourceContract;
  }

  prepare() {
    if (this.nested) {
      const parent = new CloudRuntimeCgroup({ runtime: this.runtime, io: this.io, resourceContract: this.resourceContract });
      this.cpuSplit = parent.prepare(); this.memoryBudget = parent.memoryBudget; this.resourceProjection = parent.resourceProjection;
    }
    const created = !this.io.exists(this.directory);
    if (created) this.io.create(this.directory);
    try {
      if (populated(this.io.read(this.directory, "cgroup.events")))
        throw new Error("Previous cloud engine scope has not retired");
      confirmControls(this.io, this.directory, this.nested ? CLOUD_ENGINE_LIMITS : CLOUD_RUNTIME_LIMITS);
      if (this.nested) {
        this.io.delegate(this.directory, MIGRATION_CONTROLS);
        this.original = Object.freeze({ control: this.io.identity(this.directory),
          common: this.io.identity(`${this.runtime.cgroupRoot}/${RUNTIME_TREE}`),
          workload: this.io.identity(`${this.runtime.cgroupRoot}/${RUNTIME_TREE}/engine-workload-shared/workload`) });
      }
    } catch (error) {
      // Only undo a new, affirmatively empty scope. Never kill or adopt an
      // unexpected workload when admission has not succeeded.
      if (created && !populated(this.io.read(this.directory, "cgroup.events")))
        this.io.remove(this.directory);
      throw error;
    }
  }

  custodySeed(infrastructure = []) {
    if (!this.nested || !this.original || !this.cpuSplit || !Array.isArray(infrastructure) || infrastructure.length > 15)
      throw new Error("Cloud original scope identity is unavailable");
    for (const identity of Object.values(this.original)) {
      const actual = this.io.identity(identity.directory);
      if (actual.directory !== identity.directory || actual.dev !== identity.dev || actual.ino !== identity.ino)
        throw new Error("Cloud original scope identity changed");
    }
    // Only the root caller supplies already verified original controller
    // births; the pinned publisher adds its own blocked direct child.
    return { version: 1, common: { ...this.original.common }, workload: { ...this.original.workload },
      infrastructure: globalThis.structuredClone(infrastructure), cpuSplit: this.cpuSplit };
  }

  get placement() {
    this.custodySeed();
    const identity = this.original.control;
    return `${identity.directory}@${identity.dev}:${identity.ino}`;
  }

  get currentIdentity() {
    if (!this.nested) throw new Error("Cloud original scope identity is unavailable");
    return this.io.identity(this.directory);
  }

  attach(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647)
      throw new Error("Invalid cloud engine process identity");
    if (this.nested) {
      const identity = this.io.processIdentity(pid);
      if (identity?.uid !== 10003 || identity.gid !== 10003) throw new Error("Invalid cloud engine process identity");
    }
    this.io.write(this.directory, "cgroup.procs", String(pid));
    const members = this.io.read(this.directory, "cgroup.procs").split("\n");
    if (!members.includes(String(pid)))
      throw new Error("Cloud engine process placement was not confirmed");
  }

  async retire(timeoutMs = 5000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new Error("Invalid cloud engine retirement deadline");
    if (!this.io.exists(this.directory)) return;
    // cgroup.kill addresses the complete kernel-owned descendant set, not a
    // numeric process group that a workload can leave or the kernel can reuse.
    this.io.write(this.directory, "cgroup.kill", "1");
    const deadline = this.now() + timeoutMs;
    while (populated(this.io.read(this.directory, "cgroup.events"))) {
      if (this.now() >= deadline)
        throw new Error("Cloud engine retirement is unconfirmed");
      await this.pause(Math.min(25, Math.max(1, deadline - this.now())));
    }
    // The shared user may create child groups. The root owner removes the
    // exact empty kernel subtree after a positive original kill receipt.
    if (this.nested) removeKernelTree(this.io, this.directory);
    else this.io.remove(this.directory);
  }
}

export function cloudCgroupDirectory(runtime, kind, instanceId) {
  if (runtime.profile !== "v4" || !["setup", "engine", "workload"].includes(kind))
    throw new Error("Invalid cloud engine scope identity");
  if (!isCloudRuntimeCgroupRoot(runtime.cgroupRoot) || kind !== "setup" && !INSTANCE.test(instanceId ?? ""))
    throw new Error("Invalid cloud engine scope identity");
  return `${runtime.cgroupRoot}/${kind === "setup" ? "setup" : `${RUNTIME_TREE}/${kind === "workload" ? WORKLOAD_PREFIX : "engine-"}${instanceId}`}`;
}

/** The systemd dispatcher stays in protected DelegateSubgroup=host. Only VM
 * root writes limits; UID10003 receives migration rights within engine-runtime. */
export class CloudDelegatedCgroups {
  constructor({ runtime = resolveCloudRuntime(), io = nativeIo,
    readMembership = () => readFileSync("/proc/self/cgroup", "utf8") } = {}) {
    if (runtime.profile !== "v4" || !isCloudRuntimeCgroupRoot(runtime.cgroupRoot))
      throw new Error("Invalid delegated cloud cgroup root");
    this.runtime = runtime;
    this.io = io;
    this.readMembership = readMembership;
  }
  leaves() {
    const root = this.runtime.cgroupRoot;
    if (!this.io.exists(root)) throw new Error("Cloud delegated parent is missing");
    const children = this.io.children(root);
    if (children.length > 1024 || children.some(name => name !== "host" && name !== "setup" && name !== RUNTIME_TREE &&
      !(name.startsWith("engine-") && INSTANCE.test(name.slice(7))) && !workloadLeaf(name)))
      throw new Error("Unexpected cloud delegated cgroup child");
    return children;
  }
  assertRetired() {
    for (const name of this.leaves().filter(name => name !== "host")) {
      if (populated(this.io.read(`${this.runtime.cgroupRoot}/${name}`, "cgroup.events")))
        throw new Error("Previous cloud engine scope has not retired");
    }
  }
  prepareHost() {
    const root = this.runtime.cgroupRoot;
    if (this.readMembership().trim() !== `0::${root.slice("/sys/fs/cgroup".length)}/host`)
      throw new Error("Cloud host cgroup membership is invalid");
    if (!this.leaves().includes("host") || this.io.read(root, "cgroup.procs") !== "")
      throw new Error("Cloud delegated parent must be empty");
    const controllers = ["cpu", "memory", "pids"];
    const available = this.io.read(root, "cgroup.controllers").split(/\s+/);
    if (controllers.some(name => !available.includes(name))) throw new Error("Cloud cgroup controllers are unavailable");
    this.io.write(root, "cgroup.subtree_control", controllers.map(name => `+${name}`).join(" "));
    const enabled = this.io.read(root, "cgroup.subtree_control").split(/\s+/);
    if (controllers.some(name => !enabled.includes(name))) throw new Error("Cloud cgroup delegation was not confirmed");
    const host = `${root}/host`;
    if (!this.io.exists(host) || this.io.children(host).length) throw new Error("Unexpected cloud host cgroup child");
    for (const [name, value] of Object.entries(CLOUD_HOST_LIMITS)) {
      this.io.write(host, name, value);
      if (this.io.read(host, name) !== value) throw new Error("Cloud host limit was not confirmed");
    }
  }
  async retire({ preserveWorkload } = {}) {
    const leaves = this.leaves();
    const tree = `${this.runtime.cgroupRoot}/${RUNTIME_TREE}`;
    const treeChildren = leaves.includes(RUNTIME_TREE) ? this.io.children(tree) : [];
    // A caller may preserve only its currently witnessed resident host. Missing
    // or malformed witnesses fail before any engine is disturbed. Ordinary
    // stop/recovery still retires every workload, including detached descendants.
    if (preserveWorkload !== undefined && (!INSTANCE.test(preserveWorkload) ||
      !leaves.includes(`${WORKLOAD_PREFIX}${preserveWorkload}`) && !treeChildren.includes(`${WORKLOAD_PREFIX}${preserveWorkload}`)))
      throw new Error("Invalid resident workload preservation witness");
    // Keep the service process in host alive to prove every workload leaf
    // empty. systemd's KillMode=control-group owns the final host-leaf exit.
    if (leaves.includes(RUNTIME_TREE)) {
      if (preserveWorkload === undefined) await new CloudRuntimeCgroup({ runtime: this.runtime, io: this.io }).retire();
      else for (const name of treeChildren.filter(name => name.startsWith("engine-") && INSTANCE.test(name.slice(7))))
        await new CloudEngineCgroup({ runtime: this.runtime, directory: `${tree}/${name}`, io: this.io }).retire();
    }
    for (const name of leaves.filter(name => name !== "host" && name !== RUNTIME_TREE && name !== `${WORKLOAD_PREFIX}${preserveWorkload}`))
      await new CloudEngineCgroup({ runtime: this.runtime, directory: `${this.runtime.cgroupRoot}/${name}`, io: this.io }).retire();
  }
}
