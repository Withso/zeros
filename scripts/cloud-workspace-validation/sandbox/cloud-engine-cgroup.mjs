import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const CLOUD_ENGINE_CGROUP = "/sys/fs/cgroup/zeros-cloud-engine";
export const CLOUD_SETUP_CGROUP = "/sys/fs/cgroup/zeros-cloud-setup";
export const CLOUD_ENGINE_LIMITS = Object.freeze({
  "cpu.max": "400000 100000",
  "memory.max": String(7 * 1024 * 1024 * 1024),
  "pids.max": "4096",
  "memory.oom.group": "1",
});
const CONTROL_NAMES = new Set([
  ...Object.keys(CLOUD_ENGINE_LIMITS),
  "cgroup.procs",
  "cgroup.events",
  "cgroup.kill",
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
    directory = CLOUD_ENGINE_CGROUP,
    io = nativeIo,
    now = () => performance.now(),
    pause = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (
      !/^\/sys\/fs\/cgroup\/zeros-cloud-(?:engine(?:-[a-f0-9-]{36})?|setup)$/.test(
        directory,
      )
    )
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
