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
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudEngineCgroup, CloudRuntimeCgroup } from "./cloud-engine-cgroup.mjs";
import {
  cloudEngineViewArguments,
  cloudEngineViewEnvironment,
  cloudEngineWorkspacePaths,
  cloudEngineWorkerProjection,
} from "./cloud-engine-view.mjs";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import { resolveCloudRuntime, cloudActiveRuntimeDescriptor } from "./cloud-runtime-root.mjs";
import { readCloudComputerWorkspaceAdmission } from "./cloud-computer-checkout.mjs";
import { validCloudResourceBudgetProjection } from "./cloud-resource-admission.mjs";
import { CLOUD_ROOT_CUSTODY_DIRECTORY, cloudRootProcessBirth, readCloudRootControllerRecord } from "./publish-cloud-workload-custody.mjs";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import { CLOUD_ENGINE_MUTABLE_LAYOUT } from "./prepare-cloud-image-files.mjs";

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

export function assertCloudEngineFilesProjection(runtime, {
  root = runtimeLayout.engineFilesRoot, rootPath: verifyRoot = rootPath,
} = {}) {
  if (runtime.profile !== "v4") throw new Error("Isolated cloud engine profile required");
  verifyRoot(root, true);
  const names = readdirSync(root);
  const allowed = ["workspace", "attachment-staging", "state", "home", "managed-settings",
    "repos", ".zeros-setup", ".zeros-engine-setup"];
  if (names.some(name => !allowed.includes(name)))
    throw new Error("Unexpected cloud engine file projection");
  if (names.includes("repos")) {
    const repos = path.join(root, "repos");
    verifyRoot(repos, true);
    const metadata = lstatSync(repos);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Unsafe cloud repository projection");
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

/** The original prepared root scope owns this budget. The readonly projection
 * contains only its admitted SKU and truthful observations, never credentials. */
export function publishCloudEngineResourceProjection(viewDirectory, document, {
  publish = publishViewFile, verify = rootPath,
} = {}) {
  if (!/^\/run\/zeros\/view\/runtime-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(viewDirectory) ||
      !validCloudResourceBudgetProjection(document)) throw new Error("Cloud root resource projection is invalid");
  verify(`${viewDirectory}/etc`, true);
  publish(`${viewDirectory}/etc/cloud-resource-contract.json`, JSON.stringify(document), 0, 0, 0o444);
}

/** Ubuntu's optional restriction requires an explicit application profile.
 * Never disable the global sysctl: only this root-owned launcher may grant
 * nested namespaces to its already confined engine and descendants. */
export function prepareCloudEngineAppArmor({
  read = readCloudEngineKernelParameter,
  verify = rootPath,
  execute = spawnSync,
  runtime = resolveCloudRuntime(),
} = {}) {
  if (runtime.profile !== "v4") throw new Error("Isolated cloud engine profile required");
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
    // that host policy. The engine admission below must still demonstrate its own deployment identity.
    return;
  }
  const parser = "/usr/sbin/apparmor_parser";
  const profile = "/etc/apparmor.d/zeros-cloud-engine";
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

function verifyComputerRepositoryProjection(directory) {
  const parent = (directory) => {
    rootPath(directory, true);
    const metadata = lstatSync(directory);
    if (metadata.gid !== 0 || (metadata.mode & 0o7777) !== 0o755)
      throw new Error("Unsafe cloud computer repository parent");
  };
  const repositoryName = /^[a-z0-9_.-]{1,100}$/;
  parent(directory);
  const owners = readdirSync(directory);
  if (owners.length > 20) throw new Error("Unexpected cloud computer repository projection");
  let count = 0;
  for (const owner of owners) {
    if (!repositoryName.test(owner)) throw new Error("Unexpected cloud computer repository projection");
    const ownerDirectory = path.join(directory, owner);
    parent(ownerDirectory);
    for (const name of readdirSync(ownerDirectory)) {
      if (!repositoryName.test(name) || ++count > 20)
        throw new Error("Unexpected cloud computer repository projection");
      const repository = path.join(ownerDirectory, name);
      const metadata = lstatSync(repository);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 10003 || metadata.gid !== 10003 ||
        realpathSync(repository) !== repository)
        throw new Error("Unsafe cloud computer repository projection");
    }
  }
}

export function prepareCloudEngineView(runtime = resolveCloudRuntime(), source = process.env, operation = "serve", custody, placement, resourceProjection) {
  const profile = readCloudHostRuntimeProfile();
  if (profile.version !== 4 || runtime.profile !== "v4")
    throw new Error("Isolated cloud engine profile required");
  let engineIdentity;
  if (["serve", "resident"].includes(operation)) {
    try {
      const encoded = source.ZEROS_CLOUD_RUNTIME_B64;
      if (typeof encoded !== "string" || encoded.length > 65536) throw new Error();
      engineIdentity = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch { throw new Error("Invalid cloud engine scope identity"); }
  }
  const computer = readCloudComputerWorkspaceAdmission(runtime, { engineIdentity });
  let residentHostId;
  if (operation === "resident") residentHostId = source.ZEROS_RESIDENT_HOST_ID;
  else if (operation === "serve" && source.ZEROS_RESIDENT_PTY_B64 !== undefined) {
    try {
      if (source.ZEROS_RESIDENT_PTY_B64.length > 4096) throw new Error();
      residentHostId = JSON.parse(Buffer.from(source.ZEROS_RESIDENT_PTY_B64, "base64url").toString("utf8")).hostId;
    } catch { throw new Error("Invalid resident service identity"); }
  }
  if (residentHostId !== undefined || operation === "resident") {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(residentHostId ?? ""))
      throw new Error("Invalid resident service identity");
    privateDirectory("/run/zeros/resident-workloads", 0, 0, 0o700);
    privateDirectory(`/run/zeros/resident-workloads/${residentHostId}`, 10003, 10003, 0o750);
    rootPath("/opt/zeros-infra", true);
  }
  for (const file of [
    "/usr/bin/bwrap",
    `${runtime.workerRoot}/binaries/rg`,
    `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`,
    runtime.node,
    runtime.engineNamespace,
    `${runtime.workerRoot}/dist-engine/cli.js`,
    ...(operation === "resident" ? [`${runtime.workerRoot}/dist-engine/resident-pty.js`] : []),
  ])
    rootPath(file);
  // The attester verifies the complete installation against the image digest.
  // Recheck immutable path ancestry at the final launch boundary as well.
  rootPath(runtime.workerRoot, true);
  rootPath(runtime.root, true);
  prepareCloudEngineAppArmor({runtime});
  privateDirectory("/run/zeros/view", 0, 0, 0o700);
  privateDirectory("/run/zeros/view/settings", 10003, 10003, 0o750);
  privateDirectory(profile.runtimeDirectory, 10003, 10003, 0o700);
  privateDirectory("/srv/zeros/state", 10003, 10003, 0o700);
  rootPath(runtimeLayout.engineFilesRoot, true);
  privateDirectory(runtimeLayout.attachmentTemporaryRoot, 10003, 10003, 0o700);
  privateDirectory(CLOUD_ENGINE_MUTABLE_LAYOUT.legacyStagingParent, 0, 10001, 0o710);
  privateDirectory(CLOUD_ENGINE_MUTABLE_LAYOUT.stagingParent, 0, 10003, 0o710);
  privateDirectory(CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, 10003, 10003, 0o755);
  privateDirectory(CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome, 10003, 10003, 0o700);
  assertCloudEngineFilesProjection(runtime);
  if (readdirSync(runtimeLayout.engineFilesRoot).includes("repos"))
    verifyComputerRepositoryProjection(path.join(runtimeLayout.engineFilesRoot, "repos"));
  for (const name of ["home", "state", "managed-settings", "home/agent", "home/capture"]) {
    const directory = path.join(runtimeLayout.engineFilesRoot, name);
    if (computer) privateDirectory(directory, 0, 0, 0o755);
    else rootPath(directory, true);
    if (name === "home" ? readdirSync(directory).some(child => !["agent", "capture"].includes(child))
      : readdirSync(directory).length > 0)
      throw new Error("Unexpected cloud engine mount contents");
  }
  if (computer) {
    // This is only an empty target directory. No host bind is installed here.
    const target = runtimeLayout.repository;
    try { mkdirSync(target, { mode: 0o755 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const metadata = lstatSync(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(target) !== target ||
      ![0, 10003].includes(metadata.uid) || readdirSync(target).length)
      throw new Error("Unsafe cloud primary mount target");
  }
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
      10003,
      0o640,
    );
  } finally {
    managed.fill(0);
  }
  const viewDirectory = `/run/zeros/view/runtime-${randomUUID()}`;
  let rootContextFile;
  let rootRecordFile;
  privateDirectory(viewDirectory, 0, 0, 0o700);
  try {
    privateDirectory(`${viewDirectory}/etc`, 0, 0, 0o755);
    privateDirectory(`${viewDirectory}/facade`, 0, 0, 0o755);
    privateDirectory(`${viewDirectory}/facade/sessions`, 0, 0, 0o700);
    const descriptor = cloudActiveRuntimeDescriptor(runtime);
    publishViewFile(`${viewDirectory}/active-runtime.json`, JSON.stringify(descriptor), 0, 0, 0o444);
    if (computer) publishViewFile(`${viewDirectory}/etc/cloud-workspace-paths.json`,
      JSON.stringify(cloudEngineWorkspacePaths(computer.repositoryDirectory)), 0, 0, 0o444);
    publishViewFile(`${viewDirectory}/etc/cloud-worker.json`, JSON.stringify(cloudEngineWorkerProjection(runtime)), 0, 0, 0o444);
    publishCloudEngineResourceProjection(viewDirectory, resourceProjection);
    if (custody) {
      if (custody.common?.directory !== `${runtime.cgroupRoot}/engine-runtime` || !placement?.startsWith(`${custody.common.directory}/`))
        throw new Error("Invalid original cloud workload custody");
      privateDirectory("/run/zeros/workload-custody", 0, 0, 0o700);
      publishViewFile(`${viewDirectory}/etc/cloud-workload-custody.json`, JSON.stringify(custody), 0, 0, 0o444);
      const original = cloudRootProcessBirth(process.pid, readPhysical(`/proc/${process.pid}/stat`, 8192, null).toString("utf8"));
      const [directory, encoded] = placement.split("@");
      const [dev, ino] = encoded.split(":");
      rootContextFile = `${CLOUD_ROOT_CUSTODY_DIRECTORY}/${path.basename(directory)}.launch.json`;
      rootRecordFile = `${CLOUD_ROOT_CUSTODY_DIRECTORY}/${path.basename(directory)}.json`;
      const context = { version: 1, episode: randomUUID(),
        runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
        scope: { directory, dev, ino }, owner: { pid: original.pid, startToken: original.startToken } };
      publishViewFile(rootContextFile, JSON.stringify(context), 0, 0, 0o444);
    }
    for (const [name, target] of Object.entries({ current: `../zeros-infra/${runtime.runtimeId}`, bin: "current/bin",
      worker: "current/worker", "manifest.json": "current/manifest.json", logs: "/srv/zeros/log", state: "/srv/zeros/state" }))
      symlinkSync(target, `${viewDirectory}/facade/${name}`);
    rootPath("/opt/zeros/disk-epoch");
    const epoch = readPhysical("/opt/zeros/disk-epoch", 64);
    if (!/^[0-9]+\n?$/.test(epoch.toString("utf8"))) throw new Error("Invalid cloud disk epoch");
    publishViewFile(`${viewDirectory}/facade/disk-epoch`, epoch, 0, 0, 0o444);
    return {...profile, runtime, viewDirectory, residentHostId,
      ...(computer ? { primaryRepository: computer.repositoryDirectory } : {}),
      releaseView: () => {
        rmSync(viewDirectory, {recursive:true,force:true});
        if (rootContextFile) rmSync(rootContextFile, {force:true});
        if (rootRecordFile) rmSync(rootRecordFile, {force:true});
      }};
  } catch (error) {
    rmSync(viewDirectory, {recursive:true,force:true});
    if (rootContextFile) rmSync(rootContextFile, {force:true});
    throw error;
  }
}

function assertCloudRootOutside(runtime) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.getgid?.() !== 0 ||
      readPhysical("/proc/self/cgroup", 8192, null).toString("utf8").trim() !== `0::${runtime.cgroupRoot.slice("/sys/fs/cgroup".length)}/host`)
    throw new Error("Cloud root monitor placement was refused");
}

/** @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {import('node:child_process').ChildProcess} */
function spawnCloudEngine(file, args, options) {
  return spawn(file, args, options);
}

/** @type {import('node:events').EventEmitter} */
const cloudEngineSignals = process;

/** The root wrapper remains outside delegation. Its fixed C transition
 * verifies and places only the unreaped, blocked, fully dropped direct child.
 * The outside root owner alone survives final whole-tree retirement.
 * @param {{operation?: string, source?: NodeJS.ProcessEnv, runtime?: any,
 * scope?: any, prepare?: typeof prepareCloudEngineView,
 * spawnProcess?: typeof spawnCloudEngine,
 * signals?: import('node:events').EventEmitter,
 * assertOutside?: typeof assertCloudRootOutside,
 * retireRuntime?: () => Promise<unknown>, publish?: (report: unknown) => void}} options */
export async function launchCloudEngine({
  operation = "serve",
  source = process.env,
  runtime = resolveCloudRuntime(),
  scope,
  prepare = prepareCloudEngineView,
  spawnProcess = spawnCloudEngine,
  signals = cloudEngineSignals,
  assertOutside = assertCloudRootOutside,
  retireRuntime = () => new CloudRuntimeCgroup({ runtime }).retire(),
  publish = report => process.stdout.write(JSON.stringify(report) + "\n"),
} = {}) {
  if (runtime.profile !== "v4") throw new Error("Isolated cloud engine profile required");
  assertOutside(runtime);
  let profile;
  let args, environment;
  let prepared = false;
  try {
    if (!scope) {
      let instanceId;
      {
        if (operation === "resident") instanceId = source.ZEROS_RESIDENT_HOST_ID;
        else if (operation === "serve") {
          try { instanceId = JSON.parse(Buffer.from(source.ZEROS_CLOUD_RUNTIME_B64 ?? "", "base64url").toString("utf8"))?.engine?.instanceId; }
          catch { throw new Error("Invalid cloud engine scope identity"); }
        } else instanceId = randomUUID();
      }
      scope = new CloudEngineCgroup({runtime, instanceId, kind: operation === "resident" ? "workload" : "engine"});
    }
    scope.prepare();
    prepared = true;
    let infrastructure = [];
    if (operation === "serve" && source.ZEROS_ROOT_RESIDENT_CUSTODY_B64 !== undefined) {
      let expected;
      try {
        const encoded = source.ZEROS_ROOT_RESIDENT_CUSTODY_B64;
        if (typeof encoded !== "string" || encoded.length > 32768) throw new Error();
        expected = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch { throw new Error("Resident original custody unavailable"); }
      const current = readCloudRootControllerRecord({ runtime: expected.runtime, scope: expected.scope, owner: expected.owner, episode: expected.episode });
      const seed = scope.custodySeed();
      if (JSON.stringify(expected) !== JSON.stringify(current) || current.birth.kind !== "resident" ||
          current.common.directory !== seed.common.directory || current.common.dev !== seed.common.dev || current.common.ino !== seed.common.ino ||
          current.workload.directory !== seed.workload.directory || current.workload.dev !== seed.workload.dev || current.workload.ino !== seed.workload.ino)
        throw new Error("Resident original custody changed");
      infrastructure = [current.birth];
    }
    const custody = scope.custodySeed(infrastructure);
    const placement = scope.placement;
    profile = prepare(runtime, source, operation, custody, placement, scope.resourceProjection);
    runtime = profile?.runtime ?? runtime;
    args = cloudEngineViewArguments(operation,profile?.version,runtime,profile?.viewDirectory,profile?.primaryRepository,profile?.residentHostId,placement);
    environment = cloudEngineViewEnvironment(source, operation,runtime);
  } catch (error) {
    try {
      // Only successful original admission grants cleanup custody. A refused
      // or unexpectedly populated scope belongs to no new launch.
      if (prepared) await scope.retire();
    } finally { profile?.releaseView?.(); }
    throw error;
  }
  let child;
  let admitted = false;
  let exit;
  let stopping = false;
  let stopTimer;
  let settleCancellation;
  let qualification = "";
  let qualificationInvalid = false;
  let qualificationDone;
  let wholeTreeRetired = false;
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
      runtime.engineNamespace,
      ["--await-launch", ...args],
      {
        cwd: "/",
        env: environment,
        // The resident entry receives only the supervisor's private control
        // pipe. Its lifetime never depends on an engine attachment socket.
        stdio: [operation === "resident" ? "inherit" : "ignore", operation === "qualify" ? "pipe" : "inherit", "inherit", "pipe"],
      },
    );
    exit = new Promise((resolve) => {
      child.on("error", () => resolve({ code: null, failed: true }));
      child.once("exit", (code) => resolve({ code, failed: false }));
    });
    if (operation === "qualify") {
      if (!child.stdout) throw new Error("Cloud qualification output is unavailable");
      child.stdout.setEncoding("utf8");
      qualificationDone = new Promise(resolve => {
        child.stdout.once("end", resolve); child.stdout.once("error", resolve); child.stdout.once("close", resolve);
      });
      child.stdout.on("error", () => { qualificationInvalid = true; });
      child.stdout.on("data", chunk => {
        if (qualificationInvalid) return;
        qualification += chunk;
        if (Buffer.byteLength(qualification) > 256 * 1024) { qualificationInvalid = true; qualification = ""; forward("SIGKILL"); }
      });
    }
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
    if (operation === "qualify") {
      const receipt = await retireRuntime();
      wholeTreeRetired = true;
      if (!receipt || receipt.populated !== 0 || receipt.pruned !== true)
        throw new Error("Cloud qualification whole-tree retirement was unconfirmed");
      let outputTimer;
      try { await Promise.race([qualificationDone, new Promise(resolve => { outputTimer = setTimeout(() => { qualificationInvalid = true; resolve(); }, 5000); })]); }
      finally { clearTimeout(outputTimer); }
      let inner;
      try {
        if (qualificationInvalid || !/^\{[^\n]*\}\n?$/.test(qualification)) throw new Error();
        inner = JSON.parse(qualification);
        if (outcome.failed || outcome.code !== 0 || inner?.version !== 2 || inner.boundary !== "workspace-vm" ||
            inner.qualified !== false || inner.engineChecksPassed !== true || inner.execution?.vmWorkloadDrain !== false) throw new Error();
      } catch { throw new Error("Cloud inner qualification was refused"); }
      const report = { ...inner };
      delete report.engineChecksPassed;
      publish({ ...report, qualified: true, execution: { ...report.execution, vmWorkloadDrain: true } });
      return 0;
    }
    if (outcome.failed || !Number.isInteger(outcome.code)) return 125;
    return outcome.code;
  } finally {
    signals.off("SIGTERM", term);
    signals.off("SIGINT", interrupt);
    clearTimeout(stopTimer);
    if (!admitted) forward("SIGKILL");
    try {
      if (operation === "qualify") { if (!wholeTreeRetired) await retireRuntime(); }
      else await scope.retire();
    } finally {
      profile?.releaseView?.();
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
        : args.length === 1 && args[0] === "--resident"
          ? "resident"
        : args.length === 1 && args[0] === "--probe-cursor"
          ? "probe-cursor"
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
