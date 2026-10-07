import {
  chmodSync,
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

export const CLOUD_ENGINE_CGROUP = "/sys/fs/cgroup/zeros-cloud-engine";
export const CLOUD_SETUP_CGROUP = "/sys/fs/cgroup/zeros-cloud-setup";
export const CLOUD_ENGINE_LIMITS = Object.freeze({
  "cpu.max": "400000 100000",
  "memory.max": String(7 * 1024 * 1024 * 1024),
  "pids.max": "4096",
  "memory.oom.group": "1",
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
const workloadLeaf = name => name.startsWith(WORKLOAD_PREFIX) && INSTANCE.test(name.slice(WORKLOAD_PREFIX.length));
const CONTROL_NAMES = new Set([
  ...Object.keys(CLOUD_ENGINE_LIMITS),
  "cgroup.procs",
  "cgroup.events",
  "cgroup.kill",
  "cgroup.controllers",
  "cgroup.subtree_control",
]);

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
      (metadata.uid !== 0 && !kernelAncestor) ||
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
      metadata.uid !== 0 ||
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

/** One engine and ALL of its descendants, including setsid/double-forked
 * processes, share this VM-local scope. No controller is delegated to the
 * engine. Provider ancestor limits remain in force when they are smaller.
 * A caller holds the engine's existing exclusive launch lock throughout. */
export class CloudEngineCgroup {
  constructor({
    directory,
    runtime = resolveCloudRuntime(),
    kind = "engine",
    instanceId,
    io = nativeIo,
    now = () => performance.now(),
    pause = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    directory ??= cloudCgroupDirectory(runtime, kind, instanceId);
    const leaf = directory.slice(runtime.cgroupRoot.length + 1);
    const valid = runtime.profile === "v4" &&
      isCloudRuntimeCgroupRoot(runtime.cgroupRoot) && path.dirname(directory) === runtime.cgroupRoot &&
      (leaf === "setup" || leaf.startsWith("engine-") && INSTANCE.test(leaf.slice(7)) || workloadLeaf(leaf));
    if (!valid)
      throw new Error("Invalid cloud engine scope identity");
    this.directory = directory;
    this.io = io;
    this.now = now;
    this.pause = pause;
  }

  prepare() {
    const created = !this.io.exists(this.directory);
    if (created) this.io.create(this.directory);
    try {
      if (populated(this.io.read(this.directory, "cgroup.events")))
        throw new Error("Previous cloud engine scope has not retired");
      for (const [name, value] of Object.entries(CLOUD_ENGINE_LIMITS)) {
        this.io.write(this.directory, name, value);
        if (this.io.read(this.directory, name) !== value)
          throw new Error("Cloud engine resource limit was not confirmed");
      }
    } catch (error) {
      // Only undo a new, affirmatively empty scope. Never kill or adopt an
      // unexpected workload when admission has not succeeded.
      if (created && !populated(this.io.read(this.directory, "cgroup.events")))
        this.io.remove(this.directory);
      throw error;
    }
  }

  attach(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647)
      throw new Error("Invalid cloud engine process identity");
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
    // Nested cgroups are never delegated. An unexpected child group makes
    // rmdir fail rather than authorizing a recursive deletion or a new engine.
    this.io.remove(this.directory);
  }
}

export function cloudCgroupDirectory(runtime, kind, instanceId) {
  if (runtime.profile !== "v4" || !["setup", "engine", "workload"].includes(kind))
    throw new Error("Invalid cloud engine scope identity");
  if (!isCloudRuntimeCgroupRoot(runtime.cgroupRoot) || kind !== "setup" && !INSTANCE.test(instanceId ?? ""))
    throw new Error("Invalid cloud engine scope identity");
  return `${runtime.cgroupRoot}/${kind === "setup" ? "setup" : `${kind === "workload" ? WORKLOAD_PREFIX : "engine-"}${instanceId}`}`;
}

/** The systemd dispatcher already occupies DelegateSubgroup=host. Only VM
 * root writes controllers; workload UIDs receive no delegated control files. */
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
    if (children.length > 1024 || children.some(name => name !== "host" && name !== "setup" &&
      !(name.startsWith("engine-") && INSTANCE.test(name.slice(7))) && !workloadLeaf(name)))
      throw new Error("Unexpected cloud delegated cgroup child");
    return children;
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
    // A caller may preserve only its currently witnessed resident host. Missing
    // or malformed witnesses fail before any engine is disturbed. Ordinary
    // stop/recovery still retires every workload, including detached descendants.
    if (preserveWorkload !== undefined && (!INSTANCE.test(preserveWorkload) ||
      !leaves.includes(`${WORKLOAD_PREFIX}${preserveWorkload}`)))
      throw new Error("Invalid resident workload preservation witness");
    // Keep the service process in host alive to prove every workload leaf
    // empty. systemd's KillMode=control-group owns the final host-leaf exit.
    for (const name of leaves.filter(name => name !== "host" && name !== `${WORKLOAD_PREFIX}${preserveWorkload}`))
      await new CloudEngineCgroup({ runtime: this.runtime, directory: `${this.runtime.cgroupRoot}/${name}`, io: this.io }).retire();
  }
}
