#!/usr/bin/env node
// Credential-free v4 smoke. Only this file's closed result reaches the caller;
// native tools, dependency loaders and owned-process probes use captured output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adoptCloudEngineState } from "./prepare-cloud-image-files.mjs";
import { adoptCloudComputerBuildRepositories } from "./cloud-computer-checkout.mjs";
import { CLOUD_HOST_LIMITS, CloudDelegatedCgroups } from "./cloud-engine-cgroup.mjs";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };

export const RUNTIME_SELF_TEST_CHECKS = Object.freeze([
  "node_abi", "sqlite_query", "pty_load", "claude_version", "codex_version",
  "cursor_load", "engine_load", "supervisor_idle", "engine_lifecycle",
]);
const MAX_OUTPUT = 64 * 1024;
const SCRIPT = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export function selfTestDiagnostic(results, timedOut = false) {
  const failedChecks = RUNTIME_SELF_TEST_CHECKS.filter(name => results[name] !== true);
  return { schema: "zeros.diagnostic/v1", component: "qualification", stage: "self_test",
    ok: failedChecks.length === 0 && !timedOut, exitCode: failedChecks.length || timedOut ? 1 : 0,
    timedOut, failedChecks: timedOut && failedChecks.length === 0 ? [...RUNTIME_SELF_TEST_CHECKS] : failedChecks };
}

export function parseSelfTestDiagnostic(output, exitCode) {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) > MAX_OUTPUT) return null;
    const result = JSON.parse(output.replace(/\r?\n$/, "").split("\n").at(-1));
    if (!exactKeys(result, ["schema", "component", "stage", "ok", "exitCode", "timedOut", "failedChecks"]) ||
        result.schema !== "zeros.diagnostic/v1" || result.component !== "qualification" || result.stage !== "self_test" ||
        typeof result.ok !== "boolean" || typeof result.timedOut !== "boolean" || result.exitCode !== exitCode ||
        ![0, 1].includes(exitCode) || !Array.isArray(result.failedChecks) ||
        new Set(result.failedChecks).size !== result.failedChecks.length ||
        result.failedChecks.some(name => !RUNTIME_SELF_TEST_CHECKS.includes(name) && name !== "containment_smoke") ||
        (result.ok ? result.timedOut || exitCode !== 0 || result.failedChecks.length !== 0 : result.failedChecks.length === 0 || exitCode !== 1)) return null;
    return result;
  } catch { return null; }
}

export function supervisorIsIdle(status, runtime) {
  return exactKeys(status, ["schema", "baseCompatibilityId", "bootId", "currentRuntimeId", "hostState"]) &&
    status.schema === "zeros.base-status/v1" && status.hostState === "idle" && status.currentRuntimeId === runtime.runtimeId &&
    status.baseCompatibilityId === runtime.baseCompatibilityId && status.bootId === runtime.bootId;
}

/** The resolver validates root ownership/paths. Hash exact bytes, never a
 * reserialized document, and bind this smoke to the boot's installed receipt. */
export function verifySelfTestIdentity(runtime, manifestBytes, receiptBytes, executable) {
  assert.equal(runtime.profile, "v4");
  assert.match(runtime.runtimeId, /^r1-[a-f0-9]{64}$/);
  assert.equal(runtime.root, `/opt/zeros-infra/${runtime.runtimeId}`);
  assert.equal(executable, `${runtime.root}/bin/node`);
  assert.equal(runtime.node, executable);
  assert.equal(runtime.runtimeId, `r1-${runtime.manifestSha256}`);
  assert.equal(sha256(manifestBytes), runtime.manifestSha256);
  assert.equal(sha256(receiptBytes), runtime.installerReceiptSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(manifest.schema, "zeros.runtime-manifest/v1");
  assert.equal(manifest.entrypoints.selfTest, "lib/zeros/runtime-self-test.mjs");
  assert.equal(receipt.schema, "zeros.runtime-install-receipt/v1");
  assert.equal(receipt.runtimeId, runtime.runtimeId);
  assert.equal(receipt.manifestSha256, runtime.manifestSha256);
  assert.equal(receipt.baseCompatibilityId, runtime.baseCompatibilityId);
  return manifest;
}

export function versionMatches(output, version, provider) {
  if (typeof output !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) return false;
  const value = output.trim();
  return provider === "codex" ? value === `codex-cli ${version}` :
    provider === "claude" && (value === version || value === `${version} (Claude Code)`);
}

export function containmentSmokePassed(output) {
  // Read archived v1 qualification only; new checks never emit this posture.
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) > 8 * 1024 * 1024) return false;
    const report = JSON.parse(output);
    return report.version === 1 && report.secure === true &&
      ["identity", "workload", "capture", "humanServices", "actorTools"].every(name => report[name]?.secure === true);
  } catch { return false; }
}

export function engineLifecyclePassed(output) {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) > 8 * 1024 * 1024) return false;
    const report = JSON.parse(output);
    return report.version === 2 && report.boundary === "workspace-vm" && report.qualified === true &&
      !Object.hasOwn(report, "engineChecksPassed") &&
      report.identity?.qualified === true && report.identity?.noNewPrivs === 1 && report.identity?.seccompMode === 2 &&
      report.identity?.hostUid === 10003 && report.identity?.namespaceUid === 10003 &&
      exactKeys(report.identity?.capabilities, ["effective", "permitted", "inheritable", "bounding", "ambient"]) &&
      Object.values(report.identity.capabilities).every(value => value === 0) &&
      ["sameEngineIdentity", "noSandbox", "ownedProcessGroups", "originalProcessGroupsRetired", "timeoutRetired", "workloadCgroup", "vmWorkloadDrain"].every(name => report.execution?.[name] === true) &&
      !Object.hasOwn(report.execution, "detachedDescendantsRetired") &&
      report.capture?.sameEngineIdentity === true && report.capture?.chromiumSandbox === true &&
      ["humanServices", "actorTools"].every(name => report[name]?.sameEngineIdentity === true && report[name]?.noSandbox === true);
  } catch { return false; }
}

export async function runSelfTestChecks(checks) {
  const results = {};
  for (const name of RUNTIME_SELF_TEST_CHECKS) {
    try { results[name] = await checks[name]() === true; }
    catch { results[name] = false; }
  }
  return selfTestDiagnostic(results);
}

function command(executable, args, environment, timeout = 20_000, maxBuffer = MAX_OUTPUT, lock) {
  const child = spawnSync(executable, args, { cwd: "/", env: environment, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", ...(lock === undefined ? [] : [lock])], timeout, maxBuffer, killSignal: "SIGKILL" });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  return child.stdout;
}

const SETUP_LOCK = "/run/zeros/setup.lock";
const sameEntry = (left, right) => left.dev === right.dev && left.ino === right.ino &&
  left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink;

function setupLockStat(fd) {
  for (let directory = path.dirname(SETUP_LOCK); ; directory = path.dirname(directory)) {
    const stat = lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
    assert.equal(realpathSync(directory), directory);
    if (directory === "/") break;
  }
  const stat = fstatSync(fd);
  // The original installer flock may precede umask077. Reuse safe original
  // modes without changing the lock's bytes, inode, owner or mode.
  assert(stat.isFile() && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1 && stat.size === 0 &&
    [0o600, 0o640, 0o644].includes(stat.mode & 0o7777));
  assert(sameEntry(stat, lstatSync(SETUP_LOCK)));
  assert.equal(realpathSync(SETUP_LOCK), SETUP_LOCK);
  return stat;
}

function lockCommand(fd) {
  const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe", fd],
    timeout: 5000, maxBuffer: 4096,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  return result.status;
}

/** The original root setup lock outlives every offline probe and root wrapper.
 * No lock descriptor is delivered to a non-root engine child. */
export function acquireSelfTestSetupLock() {
  const fd = openSync(SETUP_LOCK, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const original = setupLockStat(fd);
    assert.equal(lockCommand(fd), 0);
    assert(sameEntry(original, setupLockStat(fd)));
    assertSelfTestSetupLock(fd);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function assertSelfTestSetupLock(fd) {
  const original = setupLockStat(fd);
  const assertHeld = () => {
    // fdinfo describes this open file description, so a different process's
    // lock on the same inode cannot stand in for the inherited original lock.
    const file = `/proc/self/fdinfo/${fd}`;
    assert.equal(statfsSync(file).type, 0x9fa0);
    const source = readFileSync(file, "utf8");
    assert(source.length <= 4096);
    const locks = source.split("\n").filter(line => line.startsWith("lock:"));
    assert.equal(locks.length, 1);
    const lock = /^lock:\s+[0-9]+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?[0-9]+\s+[a-f0-9]+:[a-f0-9]+:([0-9]+)\s+0\s+EOF$/.exec(locks[0]);
    assert(lock && lock[1] === String(original.ino));
  };
  assertHeld();
  const probe = openSync(SETUP_LOCK, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(sameEntry(original, setupLockStat(probe)));
    assert.equal(lockCommand(probe), 73);
    assert(sameEntry(original, setupLockStat(fd)));
    assertHeld();
  } finally { closeSync(probe); }
}

/** Only the small fixed root launch wrapper joins the original protected host.
 * Keep the importing self-test orchestrator outside its 256 MiB budget. */
export function enterSelfTestHost(runtime) {
  assert(process.platform === "linux" && [process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()]
    .every(id => id === 0));
  assert.equal(runtime.cgroupRoot, "/sys/fs/cgroup/system.slice/zeros-host.service");
  const delegated = new CloudDelegatedCgroups({ runtime });
  const host = `${runtime.cgroupRoot}/host`;
  const expected = `0::${host.slice("/sys/fs/cgroup".length)}`;
  const membership = delegated.readMembership().trim();
  assert(/^0::\/[^\n\r\0]*$/.test(membership) && membership.length <= 8192);
  assert(!membership.startsWith(`0::${runtime.cgroupRoot.slice("/sys/fs/cgroup".length)}/`) || membership === expected);
  delegated.assertRetired();
  assert(delegated.leaves().includes("host") && delegated.io.children(host).length === 0);
  assert.equal(delegated.io.read(runtime.cgroupRoot, "cgroup.procs"), "");
  const controllers = delegated.io.read(runtime.cgroupRoot, "cgroup.subtree_control").split(/\s+/);
  assert(["cpu", "memory", "pids"].every(controller => controllers.includes(controller)));
  for (const [name, value] of Object.entries(CLOUD_HOST_LIMITS)) assert.equal(delegated.io.read(host, name), value);
  const original = [runtime.cgroupRoot, host].map(directory => {
    const stat = lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
    return stat;
  });
  const verifyDirectories = () => [runtime.cgroupRoot, host].forEach((directory, index) => {
    assert.equal(realpathSync(directory), directory);
    assert(sameEntry(original[index], lstatSync(directory)));
  });
  const control = `${host}/cgroup.procs`;
  const fd = openSync(control, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1 && !(stat.mode & 0o022));
    assert.equal(statfsSync(`/proc/self/fd/${fd}`).type, 0x63677270);
    assert(sameEntry(stat, lstatSync(control)));
    verifyDirectories();
    // Zero identifies this exact calling process, with no numeric PID adoption.
    assert.equal(writeSync(fd, "0"), 1);
    assert.equal(delegated.readMembership().trim(), expected);
    verifyDirectories();
    assert(sameEntry(stat, fstatSync(fd)) && sameEntry(stat, lstatSync(control)));
  } finally { closeSync(fd); }
}

function selfTestLauncher(runtime, operation, environment, timeout = 30_000, maxBuffer = MAX_OUTPUT) {
  return command(runtime.node, [`${runtime.root}/lib/zeros/runtime-self-test.mjs`, `--host-${operation}`],
    environment, timeout, maxBuffer, 3);
}

/** Importability does not prove the platform payload survived bundling. Run
 * its actual ELF entry points as the non-root agent, with no provider key. */
export function probeCursorPlatformPayload(root) {
  assert(process.getuid?.() === 10003 && process.geteuid?.() === 10003 &&
    process.getgid?.() === 10003 && process.getegid?.() === 10003, "Cursor payload requires non-root engine identity");
  assert.equal(path.resolve(root), root);
  const fromWorker = createRequire(`${root}/worker/package.json`);
  const internal = filename => {
    const actual = realpathSync(filename);
    assert(actual.startsWith(`${root}/`));
    return actual;
  };
  const sdk = internal(fromWorker.resolve("@cursor/sdk"));
  assert(Object.keys(fromWorker("@cursor/sdk")).length > 0);
  const platform = internal(createRequire(sdk).resolve("@cursor/sdk-linux-x64/package.json"));
  const binary = name => internal(path.join(path.dirname(platform), "bin", name));
  const environment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME, TMPDIR: process.env.HOME };
  assert.match(command(binary("rg"), ["--version"], environment), /^ripgrep /);
  // This payload exists on the pinned Linux x64 runtime. --help exercises its
  // loader/ABI without attempting another sandbox or a provider operation.
  assert.match(command(binary("cursorsandbox"), ["--help"], environment), /Usage: cursorsandbox/);
  return true;
}

function prepareSelfTestLayout(runtime) {
  adoptCloudEngineState(runtime);
  // A Cloud Computer template build reaches this after the base clone step,
  // which leaves legacy-owned repositories the launcher refuses.
  adoptCloudComputerBuildRepositories();
  // B4 sanitizes files to an empty root-owned parent; qualification installation
  // deliberately skips workspace setup. Never import/move a legacy workspace.
  for (let directory = runtimeLayout.engineFilesRoot; ; directory = path.dirname(directory)) {
    const metadata = lstatSync(directory);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === 0 && !(metadata.mode & 0o022));
    assert.equal(realpathSync(directory), directory);
    if (directory === "/") break;
  }
  try { lstatSync(path.join(runtimeLayout.root, "workspace")); assert.fail(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Create missing workspace and mount points at their final paths. These
  // logical paths may be binds from /home/user/.zeros-persist (contracts §22–23).
  // These are the established image-layout owners/modes; the real launcher
  // revalidates the projection before entering the engine view.
  const prepareDirectory = (directory, uid) => {
    try {
      mkdirSync(directory, { mode: 0o700 });
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchownSync(fd, uid, uid); fchmodSync(fd, 0o755); }
      finally { closeSync(fd); }
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    const metadata = lstatSync(directory);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === uid && metadata.gid === uid);
    assert.equal(metadata.mode & 0o777, 0o755);
    assert.equal(realpathSync(directory), directory);
  };
  const emptyMountPoint = (directory, allowed = []) => {
    prepareDirectory(directory, 0);
    assert(readdirSync(directory).every(name => allowed.includes(name)));
  };
  emptyMountPoint(path.join(runtimeLayout.engineFilesRoot, "home"), ["agent", "capture"]);
  for (const name of ["state", "managed-settings", "home/agent", "home/capture"])
    emptyMountPoint(path.join(runtimeLayout.engineFilesRoot, name));
  // Build recipes may populate the workspace; leave their contents intact.
  prepareDirectory(runtimeLayout.repository, 10003);
}

export function runtimeEngineLifecycleSmoke(runtime, environment) {
  prepareSelfTestLayout(runtime);
  // Keep only loopback usable in this otherwise disconnected namespace so
  // the existing local gateway/service probes can exercise their sockets.
  command("/usr/bin/python3", ["-I", "-c",
    "import socket,fcntl,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); fcntl.ioctl(s,0x8914,struct.pack('16sH14x',b'lo',1)); s.close()"], environment);
  // The fixed launcher runs W/scripts/.../qualify-cloud-engine.mjs inside
  // the v4 engine view, including direct non-root owned-process/service probes.
  // Manifest/receipt identity is checked separately; this neither consumes
  // workspace admission nor starts a model session.
  const stdout = selfTestLauncher(runtime, "qualify", environment, 330_000, 8 * 1024 * 1024);
  return engineLifecyclePassed(stdout);
}

async function installedRuntime() {
  // B2's single selector reads only the base-owned active descriptor. No argv,
  // cwd, facade, environment or source-checkout fallback can select a runtime.
  const resolver = await import("./cloud-runtime-root.mjs");
  const runtime = resolver.resolveCloudRuntime();
  const manifestFile = `${runtime.root}/manifest.json`;
  const receiptFile = `/srv/zeros/runtime-installs/${runtime.runtimeId}.json`;
  resolver.assertCloudRuntimePath(manifestFile);
  resolver.assertCloudRuntimePath(receiptFile);
  const manifest = verifySelfTestIdentity(runtime, readFileSync(manifestFile), readFileSync(receiptFile), process.execPath);
  assert.equal(SCRIPT, `${runtime.root}/lib/zeros/runtime-self-test.mjs`);
  return { runtime, manifest, resolver };
}

async function offlineChecks(environment) {
  const { runtime, manifest, resolver } = await installedRuntime();
  const worker = `${runtime.root}/worker`;
  const fromWorker = createRequire(`${worker}/package.json`);
  const internal = file => resolver.resolveCloudRuntimePackagePath(file);
  const version = (file, args) => command(file, args, environment);
  return runSelfTestChecks({
    node_abi() {
      assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
      assert.equal(process.versions.node, manifest.platform.node);
      assert.equal(Number(process.versions.modules), manifest.platform.nodeModulesAbi);
      assert.equal(manifest.platform.os, "linux"); assert.equal(manifest.platform.arch, "x64");
      assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
      return true;
    },
    sqlite_query() {
      internal(fromWorker.resolve("better-sqlite3"));
      const database = fromWorker("better-sqlite3")();
      try { assert.equal(database.prepare("SELECT 127 AS abi").get().abi, 127); }
      finally { database.close(); }
      return true;
    },
    pty_load() {
      internal(fromWorker.resolve("node-pty"));
      assert.equal(typeof fromWorker("node-pty").spawn, "function");
      assert(Object.keys(fromWorker.cache).some(file => file.endsWith("/pty.node") && file.startsWith(`${worker}/`)));
      return true;
    },
    claude_version() {
      const sdk = internal(fromWorker.resolve("@anthropic-ai/claude-agent-sdk"));
      const binary = internal(createRequire(sdk).resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"));
      return versionMatches(version(binary, ["--version"]), manifest.agents.claude.cli, "claude");
    },
    codex_version() {
      const wrapper = internal(fromWorker.resolve("@openai/codex/package.json"));
      const native = internal(createRequire(wrapper).resolve("@openai/codex-linux-x64/package.json"));
      const binary = internal(path.join(path.dirname(native), "vendor/x86_64-unknown-linux-musl/bin/codex"));
      return versionMatches(version(binary, ["--version"]), manifest.agents.codex.package, "codex");
    },
    cursor_load() {
      const sdk = internal(fromWorker.resolve("@cursor/sdk"));
      internal(createRequire(sdk).resolve("@cursor/sdk-linux-x64/package.json"));
      assert(Object.keys(fromWorker("@cursor/sdk")).length > 0);
      prepareSelfTestLayout(runtime);
      const output = selfTestLauncher(runtime, "probe-cursor", environment);
      assert.equal(output, "cursor_payload_ok");
      return true;
    },
    engine_load() {
      internal(fromWorker.resolve("tsx/cjs")); fromWorker("tsx/cjs");
      const engine = internal(`${worker}/apps/desktop/src/engine/zeros-engine.ts`);
      assert.equal(typeof fromWorker(engine).ZerosEngine, "function");
      assert(version(runtime.node, [`${worker}/dist-engine/cli.js`, "--help"]).includes("Usage:"));
      return true;
    },
    supervisor_idle() {
      const stdout = command("/usr/bin/python3", ["-I", "/opt/zeros-bootstrap/bootstrap.py", "status"], environment, 30_000);
      return supervisorIsIdle(JSON.parse(stdout), runtime);
    },
    engine_lifecycle: () => runtimeEngineLifecycleSmoke(runtime, environment),
  });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--engine-cursor-probe") {
    const { resolveCloudRuntime } = await import("./cloud-runtime-root.mjs");
    const runtime = resolveCloudRuntime();
    const authority = await import(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-deployment-authority.mjs`);
    assert(authority.hasCloudEngineUserNamespace(4));
    assert.equal(process.execPath, runtime.node);
    if (probeCursorPlatformPayload(runtime.root)) process.stdout.write("cursor_payload_ok");
    return;
  }
  if (process.argv.length === 3 && ["--host-probe-cursor", "--host-qualify"].includes(process.argv[2])) {
    try {
      const { runtime } = await installedRuntime();
      assertSelfTestSetupLock(3);
      enterSelfTestHost(runtime);
      assertSelfTestSetupLock(3);
      const { launchCloudEngine } = await import("./cloud-engine-launcher.mjs");
      process.exitCode = await launchCloudEngine({ runtime, operation: process.argv[2].slice("--host-".length) });
    } catch {
      process.stderr.write("cloud self-test launch or retirement was not confirmed\n");
      process.exitCode = 125;
    }
    return;
  }
  let result = selfTestDiagnostic({});
  let directory;
  let lock;
  try {
    assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0);
    assert.equal(process.geteuid?.(), 0);
    if (process.argv.length === 3 && process.argv[2] === "--offline-probes") {
      // The parent supplies an empty private HOME, never the VM root's HOME.
      // Its network namespace has no external interfaces/routes.
      assertSelfTestSetupLock(3);
      result = await offlineChecks({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME, TMPDIR: process.env.HOME });
    } else {
      assert.equal(process.argv.length, 2);
      const { runtime } = await installedRuntime();
      lock = acquireSelfTestSetupLock();
      assert(supervisorIsIdle(JSON.parse(command("/usr/bin/python3", ["-I", "/opt/zeros-bootstrap/bootstrap.py", "status"],
        { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, 30_000)), runtime));
      new CloudDelegatedCgroups({ runtime }).assertRetired();
      directory = mkdtempSync("/run/zeros/runtime-smoke-");
      const child = spawnSync("/usr/bin/unshare", ["--net", "--", runtime.node, SCRIPT, "--offline-probes"], {
        cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory, TMPDIR: directory },
        stdio: ["ignore", "pipe", "pipe", lock], encoding: "utf8", timeout: 540_000, maxBuffer: MAX_OUTPUT, killSignal: "SIGKILL",
      });
      assertSelfTestSetupLock(lock);
      if (!child.error && child.signal === null) result = parseSelfTestDiagnostic(child.stdout, child.status) ?? result;
      else result = selfTestDiagnostic({}, child.error?.code === "ETIMEDOUT");
    }
  } catch { /* No exception text, output, paths or environment reaches stdout. */ }
  finally {
    if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch { result = selfTestDiagnostic({}); }
    if (lock !== undefined) closeSync(lock);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // Dependency imports may leave timers behind. This is a one-shot probe.
  process.exit(result.exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) await main();
