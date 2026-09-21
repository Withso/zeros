#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  statfsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudEngineCgroup } from "./cloud-engine-cgroup.mjs";
import {
  cloudEngineViewArguments,
  cloudEngineViewEnvironment,
} from "./cloud-engine-view.mjs";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";

function rootPath(file, directory = false) {
  if (realpathSync(file) !== file)
    throw new Error("Noncanonical cloud launch source");
  for (let current = file; ; current = path.dirname(current)) {
    const metadata = lstatSync(current);
    if (
      metadata.uid !== 0 ||
      metadata.mode & 0o022 ||
      metadata.isSymbolicLink() ||
      (current === file && !directory
        ? !metadata.isFile() || metadata.nlink !== 1
        : !metadata.isDirectory())
    )
      throw new Error("Unsafe cloud launch source");
    if (current === "/") break;
  }
}

function privateDirectory(directory, uid, gid, mode) {
  rootPath(path.dirname(directory), true);
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(directory, { mode: 0o700 });
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fchownSync(descriptor, uid, gid);
      fchmodSync(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
    metadata = lstatSync(directory);
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o777) !== mode
  )
    throw new Error("Unsafe cloud launch state directory");
}

function readPhysical(file, maximum, owner = 0) {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(descriptor);
    const filesystem = owner === null ? statfsSync(`/proc/self/fd/${descriptor}`).type : null;
    const kernelFile = filesystem === 0x9fa0 ||
      (file.startsWith("/proc/sys/kernel/") && filesystem === 0x65735546 &&
        metadata.uid === 0 && (metadata.mode & 0o022) === 0);
    if (
      !metadata.isFile() ||
      (owner === null ? !kernelFile : metadata.uid !== owner) ||
      metadata.nlink !== 1 ||
      (owner !== null && metadata.size > maximum) ||
      metadata.size < 0
    )
      throw new Error("Unsafe cloud launch document");
    const buffer = Buffer.alloc(maximum + 1);
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
    if (size > maximum) throw new Error("Cloud launch document is too large");
    return buffer.subarray(0, size);
  } finally {
    closeSync(descriptor);
  }
}

/** Kernel virtual files can report synthetic sizes and overflow ownership.
 * Process identity requires procfs. Fixed sysctls also permit a root-owned,
 * non-writable provider FUSE projection; actual bytes remain strictly bounded. */
export function readCloudEngineKernelParameter(file, maximum) {
  if (!["/proc/self/uid_map", "/proc/sys/kernel/overflowuid", "/proc/sys/kernel/overflowgid",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"].includes(file))
    throw new Error("Unsupported cloud kernel parameter");
  return readPhysical(file, maximum, null);
}

function publishViewFile(file, source, uid, gid, mode) {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, source);
    fchownSync(descriptor, uid, gid);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** Ubuntu's optional restriction requires an explicit application profile.
 * Never disable the global sysctl: only this root-owned launcher may grant
 * nested namespaces to its already confined engine and descendants. */
export function prepareCloudEngineAppArmor({
  read = readCloudEngineKernelParameter,
  verify = rootPath,
  execute = spawnSync,
} = {}) {
  let restriction;
  try {
    restriction = read(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      32,
    )
      .toString("utf8")
      .trim();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (restriction === "0") return;
  if (restriction !== "1")
    throw new Error("Unsupported cloud user namespace restriction");
  const lines = read("/proc/self/uid_map", 4096).toString("utf8").trim().split("\n");
  const mappings = lines.map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)?.slice(1).map(Number));
  if (mappings.length !== 1 || !mappings[0] || mappings[0].length !== 3 ||
    mappings[0].some(n => !Number.isSafeInteger(n) || n < 0 || n > 4294967295) ||
    mappings[0][0] !== 0 || mappings[0][2] < 10004)
    throw new Error("Unsupported cloud kernel identity map");
  if (mappings[0][1] !== 0 || mappings[0][2] !== 4294967295) {
    // The provider owns outer namespace policy; a container cannot replace
    // that host policy. The full engine/worker/capture admission below must
    // still demonstrate the nested namespaces and all containment checks.
    return;
  }
  const parser = "/usr/sbin/apparmor_parser";
  const profile = "/opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor";
  verify(parser);
  verify(profile);
  const result = execute(parser, ["--replace", "--skip-cache", profile], {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    cwd: "/",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (result.status !== 0 || result.signal || result.error)
    throw new Error(
      "Cloud user namespace application profile could not be loaded",
    );
}

export function prepareCloudEngineView() {
  const profile = readCloudHostRuntimeProfile();
  if (profile.version !== 2 && profile.version !== 3)
    throw new Error("Isolated cloud engine profile required");
  for (const file of [
    "/usr/bin/bwrap",
    "/usr/bin/setpriv",
    "/usr/bin/rg",
    "/opt/zeros-runtime/bin/node",
    "/opt/zeros-runtime/cloud-engine-namespace",
    "/opt/zeros/dist-engine/cli.js",
  ])
    rootPath(file);
  // The attester verifies the complete installation against the image digest.
  // Recheck immutable path ancestry at the final launch boundary as well.
  rootPath("/opt/zeros", true);
  rootPath("/opt/zeros-runtime", true);
  prepareCloudEngineAppArmor();
  privateDirectory("/run/zeros/view", 0, 0, 0o700);
  privateDirectory("/run/zeros/view/settings", 10003, 10001, 0o750);
  privateDirectory(profile.runtimeDirectory, 10003, 10003, 0o700);
  privateDirectory("/srv/zeros/state", 10003, 10003, 0o700);
  for (const kind of ["uid", "gid"]) {
    const value = readCloudEngineKernelParameter(`/proc/sys/kernel/overflow${kind}`, 32).toString(
      "utf8",
    );
    if (value.trim() !== "65534")
      throw new Error("Unsupported kernel overflow identity");
  }
  rootPath(profile.managedSettingsDirectory, true);
  const managed = readPhysical(
    path.join(profile.managedSettingsDirectory, "settings.managed.toml"),
    512 * 1024,
  );
  try {
    publishViewFile(
      "/run/zeros/view/settings/settings.managed.toml",
      managed,
      10003,
      10001,
      0o640,
    );
  } finally {
    managed.fill(0);
  }
  return profile;
}

/** The child cannot enter the general engine until the host has positively
 * placed it in its finite cgroup. Closing a failed barrier is never used to
 * cancel launch: the child is killed first and the complete scope is drained. */
export async function launchCloudEngine({
  operation = "serve",
  source = process.env,
  scope = new CloudEngineCgroup(),
  prepare = prepareCloudEngineView,
  spawnProcess = spawn,
  signals = process,
} = {}) {
  const profile=prepare();
  const args = cloudEngineViewArguments(operation,profile?.version??2);
  const environment = cloudEngineViewEnvironment(source, operation);
  scope.prepare();
  let child;
  let admitted = false;
  let exit;
  let stopping = false;
  let stopTimer;
  let settleCancellation;
  const cancelled = new Promise((resolve) => {
    settleCancellation = resolve;
  });
  const forward = (signal) => {
    try {
      child?.kill(signal);
    } catch {
      /* scope retirement follows */
    }
  };
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    forward(signal);
    stopTimer = setTimeout(() => {
      forward("SIGKILL");
      settleCancellation({ code: 125, failed: true });
    }, 10000);
  };
  const term = () => stop("SIGTERM");
  const interrupt = () => stop("SIGINT");
  signals.once("SIGTERM", term);
  signals.once("SIGINT", interrupt);
  try {
    child = spawnProcess(
      "/opt/zeros-runtime/cloud-engine-namespace",
      ["--await-scope", ...args],
      {
        cwd: "/",
        env: environment,
        stdio: ["ignore", "inherit", "inherit", "pipe"],
      },
    );
    exit = new Promise((resolve) => {
      child.on("error", () => resolve({ code: null, failed: true }));
      child.once("exit", (code) => resolve({ code, failed: false }));
    });
    await new Promise((resolve, reject) => {
      const onError = () => {
        child.off("spawn", onSpawn);
        reject(new Error("Cloud engine child could not start"));
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    if (stopping || child.exitCode !== null || child.signalCode !== null)
      throw new Error("Cloud engine launch was cancelled");
    scope.attach(child.pid);
    const barrier = child.stdio[3];
    if (!barrier) throw new Error("Cloud engine launch barrier is unavailable");
    await new Promise((resolve, reject) => {
      const onError = () =>
        reject(new Error("Cloud engine launch barrier failed"));
      // Keep an error observer through stream destruction: a late EPIPE must
      // not crash the root broker after the write callback already completed.
      barrier.on("error", onError);
      barrier.end("1", (error) => {
        if (error) onError();
        else resolve();
      });
    });
    admitted = true;
    const outcome = await Promise.race([exit, cancelled]);
    if (outcome.failed || !Number.isInteger(outcome.code)) return 125;
    return outcome.code;
  } finally {
    signals.off("SIGTERM", term);
    signals.off("SIGINT", interrupt);
    clearTimeout(stopTimer);
    if (!admitted) forward("SIGKILL");
    try {
      await scope.retire();
    } finally {
      child?.stdio[3]?.destroy();
      child?.unref();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const operation =
    args.length === 0
      ? "serve"
      : args.length === 1 && args[0] === "--qualify"
        ? "qualify"
        : null;
  if (!operation) process.exitCode = 125;
  else
    launchCloudEngine({ operation }).then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        process.stderr.write(
          "cloud engine launch or retirement was not confirmed\n",
        );
        process.exitCode = 125;
      },
    );
}
