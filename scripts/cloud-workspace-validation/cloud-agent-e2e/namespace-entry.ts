// Root supervisor for a private SOURCE fixture or an installed test VM. The
// installed path requires original /host custody and keeps runtime/base bytes.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, rmdirSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertInstalledHarnessRuntimeCurrent, assertPrivateNamespace, assertPrivateRoot, FIXTURE_MUTABLE_LAYOUT,
  fixtureBaseOwnership, fixtureFacade, fixtureMountPlan, fixtureMutableOwnership, hostActiveFileOptions, installedHarnessPaths,
  preparePrivateProcView, readHarnessEntryConfiguration, readInstalledHarnessRuntime, readRootHarnessFile, requireInstalledCommonIdentity, retireInstalledHarnessTree,
  type InstalledCgroupIdentity, type InstalledHarnessHandover } from "./runtime-contract";
import { CpuPrivatePidFixtureScope, assertPrivatePidNamespace } from "./fixture-scope";
import { freshNativeArtifacts, readFixtureNativeFile } from "./artifacts";
import { copyRuntimeFixture, initializeFixtureCheckout, requireFixtureEngineIdentity, snapshotSystemExecutable } from "./projection";
import { cloudPreflightDiagnostic, zsrAdmissionDiagnostic } from "./diagnostics";
import { observedInstalledCgroupIdentity, observedInstalledRootIdentity, observedInstalledRuntimeEngineIdentity,
  observedRuntimeEngineIdentity, type RuntimeEngineIdentity } from "./identity";
import { readInstalledFixtureMirrorProof, readPrivateFixtureMirrorProof } from "./namespace-mirror-proof";
import { HarnessFailure } from "./assertions";
import type { NamespaceOutcome } from "./retirement";

type Config = { outerMountNamespace: string; outerPidNamespace: string; scope: "strict" | "cpu-private-pid-fixture"; stage: string; ca: string; scratch: string;
  mode?: "source";
  sourceFixtureLinux?: "host" | "ubuntu-24.04";
  descriptor: { active: { root: string; runtimeId: string; cgroupRoot: string }; marker: unknown };
  source: Record<string, string>; mcp: string };
async function runSourceFixture(config: Config) {
assertPrivateNamespace({ outer: config.outerMountNamespace, current: readlinkSync("/proc/self/ns/mnt"), uid: process.getuid!() });
assertPrivatePidNamespace(config.outerPidNamespace, readlinkSync("/proc/self/ns/pid"), process.pid);
assertPrivateRoot(statfsSync("/").type);
process.umask(0o022);
const emit = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`);
const mkdir = (directory: string, mode = 0o755, uid = 0, gid = uid) => { mkdirSync(directory, { recursive: true, mode }); chownSync(directory, uid, gid); chmodSync(directory, mode); };
const mount = (...args: string[]) => execFileSync("/usr/bin/mount", args, { stdio: "pipe" });
const publicFiles = Object.fromEntries(["nsswitch.conf", "hosts", "resolv.conf", "ld.so.cache"].map(name => [name, readFileSync(`/etc/${name}`)]));
const ubuntuWhich = config.sourceFixtureLinux === "ubuntu-24.04" ? snapshotSystemExecutable("/usr/bin/which") : undefined;
const ca = readFileSync(config.ca);
// Public certificates only, never host /etc/pki/private or provider homes.
const publicRoots = readFileSync(config.sourceFixtureLinux === "ubuntu-24.04"
  ? "/etc/ssl/certs/ca-certificates.crt" : "/etc/pki/tls/certs/ca-bundle.crt");
let engine: ChildProcess | undefined;
let originalEngineIdentity: RuntimeEngineIdentity | undefined;
function observeEngine() {
  if (!engine?.pid) throw new Error("engine_identity_missing");
  const observed = observedRuntimeEngineIdentity(config.descriptor.active.root, config.outerPidNamespace, engine.pid, originalEngineIdentity);
  originalEngineIdentity ??= observed;
  return observed;
}
let logs = "";
let status: "starting" | "running" | "exited" = "starting";
let launcher: Promise<number> | undefined;
let cgroupParent: string | undefined;
let addedControllers: string[] = [];
let cleanupConfirmed = true;
let step = "mounts";
let stopping: Promise<void> | undefined;
const progress = (value: string) => { step = value; emit({ type: "progress", step }); };
const diagnoses = [
  ["runtime_descriptor", /Cloud runtime descriptor or installation is invalid/],
  ["root_ancestry", /root-controlled|immutable root|root admission|path ancestry|not immutable|not root-controlled|Unsafe cloud/],
  ["namespace_map", /identity map|namespace evidence|UID map|uid_map|cloud engine namespace admission failed/],
  ["engine_startup", /Failed to start engine|engine startup never completed/],
  ["engine_shutdown", /Shutting down/],
  ["engine_ready", /Engine ready on port/],
  ["worker_config", /cloud-worker configuration|cloud-worker profile|cloud-worker toolchain/],
  ["runtime_binding", /cloud engine runtime binding|runtime material is invalid|engine image attestation/],
  ["native_loader", /ERR_DLOPEN_FAILED|GLIBC_|invalid ELF|undefined symbol/],
  ["require_async", /ERR_REQUIRE_ASYNC_MODULE|ERR_REQUIRE_ESM/],
  ["reference_error", /ReferenceError/],
  ["type_error", /TypeError/],
  ["syntax_error", /SyntaxError/],
  ["cgroup_admission", /cgroup|resource limit/],
  ["account_binding", /account binding|account JWT|account.*configured|OWNER_SUB/],
  ["module_missing", /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND/],
  ...["ws", "tinyglobby", "chokidar", "postcss", "node-pty", "better-sqlite3", "@anthropic-ai/claude-agent-sdk", "@xterm/headless", "@xterm/addon-serialize", "isomorphic-git", "diff", "parse5", "smol-toml", "zod", "@cursor/sdk"].map((name, index) => [
    `module_${index}`, new RegExp(`Cannot find module ['"]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`),
  ] as const),
  ["sqlite_binding", /better_sqlite3|NODE_MODULE_VERSION|bindings file/],
  ["registration", /registration.*fail|registration.*reject|runtime registration/i],
  ["durable_record", /record projection|record append|record.*sync.*fail/i],
  ["worker_canary", /canary|Cloud native|worker process domain/],
  ["permission", /EACCES|Operation not permitted|Permission denied/],
  ["file_missing", /ENOENT|No such file or directory/],
  ["mount_failure", /mount:|failed to mount|unknown filesystem/i],
  ["copy_failure", /ERR_FS_CP|Invalid src or dest|EEXIST|ENOSPC/],
  ["launch_source", /Unsafe cloud launch source/],
  ["launch_state", /Unsafe cloud launch state directory/],
] as const;
function diagnostics() { return diagnoses.filter(([, pattern]) => pattern.test(logs)).map(([label]) => label); }
function capture(value: Buffer) { logs = (logs + value.toString("utf8")).slice(-256 * 1024); }
function inspect() {
  const files: Record<string, unknown> = {};
  for (const name of ["tool-input.txt", "tool-output.txt", "shell-uid.txt", "stop-started.txt", "stop-finished.txt",
    "excluded-mcp.marker", "project-mcp.marker", "plugin-mcp.marker"]) {
    try { files[name] = readFixtureNativeFile(`/srv/zeros/files/workspace/${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files[name] = null; }
  }
  return { status, files, diagnostics: diagnostics(), preflight: cloudPreflightDiagnostic(logs), nativeAdmission: zsrAdmissionDiagnostic(logs) };
}
function stop(): Promise<void> {
  if (status === "exited") return Promise.resolve();
  if (!stopping) stopping = (async () => {
    // Reconfirm the original engine birth, allowing the real CLI shutdown
    // handler to return zero. Killing bwrap first abandons it via PDEATHSIG.
    try { process.kill(observeEngine().pid, "SIGTERM"); }
    catch { engine?.kill("SIGTERM"); }
    if (launcher) await launcher;
  })();
  return stopping;
}
try {
  progress("proc");
  const procView = preparePrivateProcView({ mountNamespace: config.outerMountNamespace, pidNamespace: config.outerPidNamespace }, {
    observe: () => ({ uid: process.getuid!(), mountNamespace: readlinkSync("/proc/self/ns/mnt"),
      pidNamespace: readlinkSync("/proc/self/ns/pid"), pid: process.pid, rootType: statfsSync("/").type,
      procType: statfsSync("/proc").type, initNamespace: readlinkSync("/proc/1/ns/pid") }),
    mountProc: () => { mount("-t", "proc", "-o", "nosuid,nodev,noexec", "proc", "/proc"); },
  });
  emit({ type: "proc", ...procView });
  progress("mounts");
  for (const step of fixtureMountPlan()) {
    if (step.kind === "mkdir") mkdir(step.target);
    else mount("-t", "tmpfs", "-o", "mode=0755", "zeros-source-fixture", step.target);
  }
  progress("system_view");
  // /usr/bin/rg may be absent on Amazon Linux. A private overlay preserves all
  // system binaries while adding the pinned product-owned ripgrep payload.
  mkdir("/run/zeros/bin-lower"); mkdir("/run/zeros/bin-upper"); mkdir("/run/zeros/bin-work");
  mount("--bind", "/usr/bin", "/run/zeros/bin-lower");
  mount("-t", "overlay", "overlay", "-o", "lowerdir=/run/zeros/bin-lower,upperdir=/run/zeros/bin-upper,workdir=/run/zeros/bin-work", "/usr/bin");
  cpSync(`${config.stage}/worker/binaries/rg`, "/usr/bin/rg");
  // cp preserves the source UID. This new private-overlay inode must
  // satisfy the real launcher's root-ancestry check before launch.
  chownSync("/usr/bin/rg", 0, 0); chmodSync("/usr/bin/rg", 0o555);
  if (ubuntuWhich) {
    // Ubuntu's which→/etc/alternatives alias is absent in this private etc.
    // Use the actual installed executable in the new private bin inode.
    rmSync("/usr/bin/which"); writeFileSync("/usr/bin/which", ubuntuWhich, { mode: 0o555 }); chownSync("/usr/bin/which", 0, 0);
  }
  for (const [name, bytes] of Object.entries(publicFiles)) writeFileSync(`/etc/${name}`, bytes, { mode: 0o644 });
  writeFileSync("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nzeros-agent:x:10001:10001:fixture worker:/srv/zeros/home/agent:/bin/bash\nzeros-capture:x:10002:10002:fixture capture:/srv/zeros/home/capture:/bin/bash\nzeros-engine:x:10003:10003:fixture engine:/nonexistent:/usr/sbin/nologin\nzeros-runtime:x:10004:10004:fixture supervisor:/nonexistent:/usr/sbin/nologin\n");
  writeFileSync("/etc/group", "root:x:0:\nzeros-agent:x:10001:\nzeros-capture:x:10002:\nzeros-engine:x:10003:\nzeros-runtime:x:10004:\n");
  mkdir("/etc/ssl/certs"); writeFileSync("/etc/ssl/cert.pem", publicRoots); writeFileSync("/etc/ssl/certs/ca-bundle.crt", publicRoots);
  mkdir("/etc/alternatives"); mkdir("/etc/containers");
  writeFileSync("/etc/containers/policy.json", JSON.stringify({ default: [{ type: "insecureAcceptAnything" }] }));
  writeFileSync("/etc/containers/registries.conf", "unqualified-search-registries = []\n");
  progress("runtime_copy");
  mkdir(path.dirname(config.descriptor.active.root));
  copyRuntimeFixture(config.stage, config.descriptor.active.root);
  // cp creates namespace-private inodes; root owns the entire runtime. Never
  // chown the shared source tree or dependency store.
  execFileSync("/usr/bin/chown", ["-R", "0:0", config.descriptor.active.root]);
  mkdir(`${config.descriptor.active.root}/fixture`); writeFileSync(`${config.descriptor.active.root}/fixture/ca.pem`, ca, { mode: 0o444 });
  writeFileSync("/etc/zeros/cloud-worker.json", JSON.stringify(config.descriptor.marker), { mode: 0o444 });
  writeFileSync("/run/zeros/active-runtime.json", JSON.stringify(config.descriptor.active), hostActiveFileOptions());
  writeFileSync("/opt/zeros/disk-epoch", "0\n", { mode: 0o444 });
  for (const [name, target] of Object.entries(fixtureFacade(config.descriptor.active.runtimeId))) symlinkSync(target, name);
  progress("checkout");
  for (const directory of ["/srv/zeros/files", "/srv/zeros/files/home", "/srv/zeros/files/home/agent", "/srv/zeros/files/home/capture",
    "/srv/zeros/files/state", "/srv/zeros/files/managed-settings", "/srv/zeros/home", "/srv/zeros/log", "/srv/zeros/setup"]) mkdir(directory);
  for (const directory of fixtureBaseOwnership()) mkdir(directory.target, directory.mode, directory.uid, directory.gid);
  for (const directory of fixtureMutableOwnership()) mkdir(directory.target, directory.mode, directory.uid, directory.gid);
  writeFileSync("/srv/zeros/managed-settings/settings.managed.toml", "# SOURCE-MODE fixture managed settings\n", { mode: 0o640 });
  chownSync("/srv/zeros/managed-settings/settings.managed.toml", 0, 10001);
  writeFileSync("/srv/zeros/log/engine.log", "", { mode: 0o640 }); chownSync("/srv/zeros/log/engine.log", 0, 10001);
  writeFileSync("/srv/zeros/files/workspace/tool-input.txt", "fixture native read 73491\n");
  writeFileSync("/srv/zeros/files/workspace/.mcp.json", config.mcp);
  for (const name of ["tool-input.txt", ".mcp.json"]) chownSync(`/srv/zeros/files/workspace/${name}`, 10003, 10003);
  initializeFixtureCheckout("/srv/zeros/files/workspace", args => { execFileSync("/usr/bin/setpriv", ["--reuid=10003", "--regid=10003", "--clear-groups", "/usr/bin/git", ...args],
    { stdio: "pipe", env: { PATH: "/usr/bin:/bin", HOME: FIXTURE_MUTABLE_LAYOUT.agentHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); });
  progress("cgroup");
  // All real controller writes happen after the mount guard. Only this
  // disposable child scope receives processes; shared processes never move.
  const controllers = config.scope === "strict" ? ["cpu", "memory", "pids"] : ["cpu"];
  const enabled = readFileSync("/sys/fs/cgroup/cgroup.subtree_control", "utf8").trim().split(/\s+/);
  const requested = controllers.filter(name => !enabled.includes(name));
  if (requested.length) writeFileSync("/sys/fs/cgroup/cgroup.subtree_control", requested.map(name => `+${name}`).join(" "));
  addedControllers = requested;
  cgroupParent = path.dirname(config.descriptor.active.cgroupRoot);
  mkdir(cgroupParent);
  if (config.scope !== "strict") writeFileSync(`${cgroupParent}/cgroup.type`, "threaded");
  writeFileSync(`${cgroupParent}/cgroup.subtree_control`, controllers.map(name => `+${name}`).join(" "));
  mkdir(config.descriptor.active.cgroupRoot);
  if (config.scope !== "strict") writeFileSync(`${config.descriptor.active.cgroupRoot}/cgroup.type`, "threaded");
  writeFileSync(`${config.descriptor.active.cgroupRoot}/cgroup.subtree_control`, controllers.map(name => `+${name}`).join(" "));
  progress("resolver");
  const { resolveCloudRuntime } = await import(pathToFileURL(`${config.descriptor.active.root}/lib/zeros/cloud-runtime-root.mjs`).href);
  const { launchCloudEngine } = await import(pathToFileURL(`${config.descriptor.active.root}/lib/zeros/cloud-engine-launcher.mjs`).href);
  const runtime = resolveCloudRuntime();
  const scope = config.scope === "strict" ? undefined : new CpuPrivatePidFixtureScope(runtime.cgroupRoot,
    JSON.parse(Buffer.from(config.source.ZEROS_CLOUD_RUNTIME_B64, "base64url").toString("utf8")).engine.instanceId, config.outerPidNamespace);
  emit({ type: "namespace", status: "observed", runtimeId: runtime.runtimeId });
  progress("launcher");
  launcher = launchCloudEngine({ source: config.source, runtime, ...(scope ? { scope } : {}), spawnProcess: (command: string, args: string[], options: Record<string, unknown>) => {
    // Test-only public trust + static asymmetric verification key. Every
    // production authority/owner/runtime variable goes through real launcher.
    engine = spawn(command, args, { ...options, env: { ...(options.env as object),
      NODE_EXTRA_CA_CERTS: `${runtime.root}/fixture/ca.pem`, ZEROS_ACCOUNT_JWT_PUBLIC_KEY: config.source.ZEROS_ACCOUNT_JWT_PUBLIC_KEY },
      stdio: ["ignore", "pipe", "pipe", "pipe"] });
    engine.stdout!.on("data", capture); engine.stderr!.on("data", capture);
    status = "running";
    return engine;
  } });
  const reader = createInterface({ input: process.stdin });
  reader.on("line", line => {
    try { const command = JSON.parse(line);
      if (command.op === "inspect") emit({ type: "inspection", id: command.id, ...inspect() });
      else if (command.op === "mirror-proof") {
        const proof = readPrivateFixtureMirrorProof({ outerMountNamespace: config.outerMountNamespace, outerPidNamespace: config.outerPidNamespace,
          scope: command.scope, commandId: command.commandId, conversationId: command.conversationId });
        emit({ type: "inspection", id: command.id, proof });
      }
      else if (command.op === "identity") {
        emit({ type: "inspection", id: command.id, ...requireFixtureEngineIdentity(observeEngine()) });
      }
      else if (command.op === "prepare-native" && typeof command.nonce === "string" && /^[a-f0-9-]{36}$/.test(command.nonce)) {
        for (const name of ["tool-output.txt", "shell-uid.txt", "stop-started.txt", "stop-finished.txt"]) rmSync(`/srv/zeros/files/workspace/${name}`, { force: true });
        const artifacts = freshNativeArtifacts(command.nonce);
        writeFileSync("/srv/zeros/files/workspace/tool-input.txt", artifacts.input);
        chownSync("/srv/zeros/files/workspace/tool-input.txt", 10003, 10003);
        emit({ type: "inspection", id: command.id, nonce: artifacts.nonce, outputHash: artifacts.outputHash,
          startHash: artifacts.startHash, shellHash: artifacts.shellHash, ...inspect() });
      }
      else if (command.op === "shutdown") void stop();
    } catch { emit({ type: "failure", code: "fixture_inspection_failed" }); }
  });
  reader.once("close", () => void stop());
  const code = await launcher;
  status = "exited"; reader.close();
  emit({ type: "exit", code, diagnostics: diagnostics(), capturedBytes: Buffer.byteLength(logs),
    preflight: cloudPreflightDiagnostic(logs), nativeAdmission: zsrAdmissionDiagnostic(logs),
    engineStackLines: [...logs.matchAll(/\/dist-engine\/cli\.js:(\d+):\d+/g)].slice(0, 8).map(match => Number(match[1])) });
  process.exitCode = code;
} catch (error) {
  logs += error instanceof Error ? error.message : "";
  if ((error as { stderr?: Buffer }).stderr) capture((error as { stderr: Buffer }).stderr);
  const rootChecks: { identity: string; uid: number; mode: number; links: number }[] = [];
  for (const [identity, filename] of Object.entries({ root: "/", usr: "/usr", bin: "/usr/bin", bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv", rg: "/usr/bin/rg",
    etc: "/etc", opt: "/opt", facade: "/opt/zeros", runtime: config.descriptor.active.root, worker: `${config.descriptor.active.root}/worker`,
    node: `${config.descriptor.active.root}/bin/node`, namespaceHelper: `${config.descriptor.active.root}/bin/cloud-engine-namespace`,
    srv: "/srv", zeros: "/srv/zeros", files: "/srv/zeros/files", managed: "/srv/zeros/managed-settings", run: "/run", runZeros: "/run/zeros" })) {
    try { const metadata = lstatSync(filename); if (metadata.uid !== 0 || metadata.mode & 0o022 || metadata.isSymbolicLink() || metadata.isFile() && metadata.nlink !== 1)
      rootChecks.push({ identity, uid: metadata.uid, mode: metadata.mode & 0o7777, links: metadata.nlink }); }
    catch { /* A missing required file is already a closed file_missing code. */ }
  }
  emit({ type: "failure", code: "namespace_launch_failed", diagnostics: diagnostics(), step,
    ...(rootChecks.length ? { rootChecks } : {}),
    ...(["ENOENT", "EACCES", "EPERM", "EROFS", "EINVAL", "ENOTSUP", "EBUSY", "ENOSPC"].includes((error as NodeJS.ErrnoException).code ?? "") ? { errno: (error as NodeJS.ErrnoException).code } : {}) });
  process.exitCode = 1;
} finally {
  if (cgroupParent) {
    try { rmdirSync(config.descriptor.active.cgroupRoot); rmdirSync(cgroupParent); }
    catch { cleanupConfirmed = false; emit({ type: "failure", code: "cleanup_unconfirmed" }); process.exitCode = 1; }
  }
  // Remove only controllers enabled by this fixture, after its scope retires.
  if (addedControllers.length) {
    try { writeFileSync("/sys/fs/cgroup/cgroup.subtree_control", addedControllers.map(name => `-${name}`).join(" ")); }
    catch { cleanupConfirmed = false; emit({ type: "failure", code: "cleanup_unconfirmed" }); process.exitCode = 1; }
  }
  if (cleanupConfirmed && launcher && process.exitCode === 0) emit({ type: "retired", engineScopeEmpty: true, namespacePrivate: true,
    ...(config.scope === "strict" ? { cgroupRemoved: true, scopeKind: "strict" } : { cgroupRemoved: false,
      scopeKind: "cpu-private-pid-fixture", pidNamespaceProcessesEmpty: true, ownCpuCgroupRemoved: true }) });
}
}

type InstalledConfig = { mode: "installed"; handover: InstalledHarnessHandover; ca: string; source: Record<string, string> };
async function runInstalledFixture(config: InstalledConfig) {
  const emit = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const installed = await readInstalledHarnessRuntime(config.handover), { runtime, active } = installed;
  const paths = installedHarnessPaths(active), originalRoot = observedInstalledRootIdentity(active);
  const assertOutside = () => {
    assertInstalledHarnessRuntimeCurrent(config.handover, installed.activeRecordSha256);
    observedInstalledRootIdentity(active, originalRoot);
  };
  const exists = (directory: string) => {
    try { lstatSync(directory); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const assertCommonAbsent = () => {
    assertOutside();
    if (exists(paths.common)) throw new HarnessFailure("cleanup_unconfirmed");
  };
  assertOutside();
  assertCommonAbsent();
  const launcherModule = await import(pathToFileURL(runtime.helpers.launcher).href);
  const cgroups = await import(pathToFileURL(`${runtime.libRoot}/cloud-engine-cgroup.mjs`).href);
  const layoutModule = await import(pathToFileURL(`${runtime.libRoot}/prepare-cloud-image-files.mjs`).href);
  const stagingParent = layoutModule.CLOUD_ENGINE_MUTABLE_LAYOUT.stagingParent as string;
  const staging = lstatSync(stagingParent);
  if (stagingParent !== FIXTURE_MUTABLE_LAYOUT.stagingParent || !staging.isDirectory() || staging.isSymbolicLink() ||
    staging.uid !== 0 || staging.gid !== 10003 || (staging.mode & 0o7777) !== 0o710)
    throw new HarnessFailure("fixture_contract_invalid");
  const ca = "/etc/zeros/fixture-ca.pem";
  let originalCommon: InstalledCgroupIdentity | undefined;
  let engine: ChildProcess | undefined, engineClosed: Promise<NamespaceOutcome> | undefined;
  let originalEngine: RuntimeEngineIdentity | undefined;
  let launcher: Promise<number> | undefined, stopping: Promise<void> | undefined;
  let reader: ReturnType<typeof createInterface> | undefined;
  let logs = "", status = "starting", code = 1;
  const capture = (bytes: Buffer) => { logs = (logs + bytes.toString("utf8")).slice(-256 * 1024); };
  const engineInstanceId = JSON.parse(Buffer.from(config.source.ZEROS_CLOUD_RUNTIME_B64, "base64url").toString("utf8")).engine.instanceId;
  const scope = new cgroups.CloudEngineCgroup({ runtime, instanceId: engineInstanceId });
  const prepareScope = scope.prepare.bind(scope);
  scope.prepare = () => {
    assertOutside();
    prepareScope();
    originalCommon = requireInstalledCommonIdentity(observedInstalledCgroupIdentity(paths.common));
    emit({ type: "prepared", common: originalCommon });
  };
  const observeEngine = () => {
    assertOutside();
    if (!engine?.pid || engine.exitCode !== null || engine.signalCode !== null) throw new HarnessFailure("engine_identity_missing");
    const observed = observedInstalledRuntimeEngineIdentity(active, originalRoot, engine.pid, scope.directory, originalEngine);
    originalEngine ??= observed;
    return observed;
  };
  const stop = () => {
    stopping ??= (async () => {
      assertOutside();
      if (engine?.exitCode === null && engine.signalCode === null) {
        process.kill(observeEngine().pid, "SIGTERM");
      }
      if (launcher) await launcher;
    })();
    return stopping;
  };
  const stopFromInput = () => { void stop().catch(() => { emit({ type: "failure", code: "cleanup_unconfirmed" }); process.exitCode = 1; }); };
  try {
    emit({ type: "installed-root", root: originalRoot });
    emit({ type: "namespace", status: "observed", runtimeId: runtime.runtimeId });
    launcher = launcherModule.launchCloudEngine({ runtime, source: config.source, scope,
      prepare: (...args: unknown[]) => {
        assertOutside();
        const custody = args[3] as { common: InstalledCgroupIdentity };
        const common = requireInstalledCommonIdentity(custody.common);
        if (!originalCommon || JSON.stringify(common) !== JSON.stringify(originalCommon)) throw new HarnessFailure("fixture_contract_invalid");
        const profile = launcherModule.prepareCloudEngineView(...args);
        try {
          assertOutside();
          // The actual view masks both setup stores. Publish only the public
          // CA into its existing readonly /etc/zeros projection before exec.
          const publicCa = `${profile.viewDirectory}/etc/fixture-ca.pem`;
          writeFileSync(publicCa, readRootHarnessFile(config.ca, 64 * 1024, undefined),
            { mode: 0o444, flag: "wx" });
          chmodSync(publicCa, 0o444);
          return profile;
        } catch (error) { profile.releaseView?.(); throw error; }
      },
      spawnProcess: (file: string, args: string[], options: Record<string, unknown>) => {
        assertOutside();
        engine = spawn(file, args, { ...options, env: { ...(options.env as object),
          NODE_EXTRA_CA_CERTS: ca, ZEROS_ACCOUNT_JWT_PUBLIC_KEY: config.source.ZEROS_ACCOUNT_JWT_PUBLIC_KEY },
          stdio: ["ignore", "pipe", "pipe", "pipe"] });
        // A spawn/stream error is not stdio retirement. Only the actual close
        // event releases this gate, after common-tree retirement below.
        engineClosed = new Promise(resolve => { engine!.once("error", () => {});
          engine!.once("close", (code, signal) => resolve({ code, signal })); });
        engine.stdout!.on("data", capture); engine.stderr!.on("data", capture); status = "running";
        return engine;
      },
    });
    reader = createInterface({ input: process.stdin });
    reader.on("line", line => {
      try {
        const command = JSON.parse(line); assertOutside();
        if (command.op === "identity") {
          const observed = observeEngine();
          emit({ type: "inspection", id: command.id, ...requireFixtureEngineIdentity(observed),
            pid: observed.pid, startTimeTicks: observed.startTimeTicks });
        } else if (command.op === "mirror-proof") {
          const proof = readInstalledFixtureMirrorProof({ active, originalRoot, handover: config.handover,
            activeRecordSha256: installed.activeRecordSha256, scope: command.scope, commandId: command.commandId,
            conversationId: command.conversationId });
          emit({ type: "inspection", id: command.id, proof });
        } else if (command.op === "inspect") {
          emit({ type: "inspection", id: command.id, status, preflight: cloudPreflightDiagnostic(logs), nativeAdmission: zsrAdmissionDiagnostic(logs) });
        } else if (command.op === "shutdown") stopFromInput();
        else throw new HarnessFailure("fixture_inspection_failed");
      } catch { emit({ type: "failure", code: "fixture_inspection_failed" }); }
    });
    reader.once("close", stopFromInput);
    if (!launcher) throw new HarnessFailure("namespace_launch_failed");
    code = await launcher;
    status = "exited";
    emit({ type: "exit", code, preflight: cloudPreflightDiagnostic(logs), nativeAdmission: zsrAdmissionDiagnostic(logs),
      capturedBytes: Buffer.byteLength(logs) });
    process.exitCode = code;
  } catch {
    emit({ type: "failure", code: "namespace_launch_failed" }); process.exitCode = 1;
  } finally {
    reader?.removeAllListeners("close"); reader?.close();
    try {
      if (originalCommon) {
        const completion: Promise<NamespaceOutcome> = launcher
          ? launcher.then(code => ({ code, signal: null }), () => ({ code: null, signal: null }))
          : Promise.resolve({ code, signal: null });
        const retired = await retireInstalledHarnessTree(originalCommon, completion, {
          assertOutside, identity: observedInstalledCgroupIdentity,
          exists,
          retire: () => new cgroups.CloudRuntimeCgroup({ runtime }).retire(),
          drain: async () => { if (engineClosed) await engineClosed; },
          assertPreserved: () => { observedInstalledRootIdentity(active, originalRoot); },
        });
        // Verify the same installed payload/receipt again after every target is
        // gone. A changed descriptor or image cannot supply successful cleanup.
        await readInstalledHarnessRuntime(config.handover);
        emit({ type: "retired", installed: retired, root: observedInstalledRootIdentity(active, originalRoot) });
      } else assertCommonAbsent();
    } catch { emit({ type: "failure", code: "cleanup_unconfirmed" }); process.exitCode = 1; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = readHarnessEntryConfiguration(process.argv.slice(2));
    if (input.mode === "installed") await runInstalledFixture(input.config as InstalledConfig);
    else await runSourceFixture(input.config as Config);
  } catch {
    process.stdout.write(`${JSON.stringify({ type: "failure", code: "fixture_contract_invalid" })}\n`); process.exitCode = 1;
  }
}
