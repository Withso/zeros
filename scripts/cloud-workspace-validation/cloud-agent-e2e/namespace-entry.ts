// Root-only, private mount namespace supervisor. This entry is bundled into
// scratch before sudo; it never mounts or creates host paths before the guard.
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, rmdirSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { assertPrivateNamespace, assertPrivateRoot, fixtureFacade, fixtureMountPlan, hostActiveFileOptions, preparePrivateProcView } from "./runtime-contract";
import { CpuPrivatePidFixtureScope, assertPrivatePidNamespace } from "./fixture-scope";
import { freshNativeArtifacts } from "./artifacts";
import { copyRuntimeFixture, initializeFixtureCheckout, snapshotSystemExecutable } from "./projection";
import { cloudPreflightDiagnostic, zsrAdmissionDiagnostic } from "./diagnostics";
import { observedRuntimeEngine } from "./identity";
import { readPrivateFixtureMirrorProof } from "./namespace-mirror-proof";

type Config = { outerMountNamespace: string; outerPidNamespace: string; scope: "strict" | "cpu-private-pid-fixture"; stage: string; ca: string; scratch: string;
  sourceFixtureLinux?: "host" | "ubuntu-24.04";
  descriptor: { active: { root: string; runtimeId: string; cgroupRoot: string }; marker: unknown };
  source: Record<string, string>; mcp: string };
const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as Config;
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
  ...["ws", "tinyglobby", "chokidar", "postcss", "node-pty", "better-sqlite3", "@anthropic-ai/claude-agent-sdk", "@xterm/headless", "@xterm/addon-serialize", "isomorphic-git", "diff", "parse5", "smol-toml", "zod", "@cursor/sdk", "./cloud-native-view.mjs", "./cloud-coordinator-view.mjs"].map((name, index) => [
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
    try { const bytes = readFileSync(`/srv/zeros/files/workspace/${name}`); files[name] = { bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files[name] = null; }
  }
  return { status, files, diagnostics: diagnostics(), preflight: cloudPreflightDiagnostic(logs), nativeAdmission: zsrAdmissionDiagnostic(logs) };
}
function stop(): Promise<void> {
  if (status === "exited") return Promise.resolve();
  if (!stopping) stopping = (async () => {
    // Signal the uniquely observed own engine, allowing the real CLI shutdown
    // handler to return zero. Killing bwrap first abandons it via PDEATHSIG.
    try { process.kill(observedRuntimeEngine(config.descriptor.active.root, config.outerPidNamespace), "SIGTERM"); }
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
  // system binaries while adding the existing sandbox rg under its v4 name.
  mkdir("/run/zeros/bin-lower"); mkdir("/run/zeros/bin-upper"); mkdir("/run/zeros/bin-work");
  mount("--bind", "/usr/bin", "/run/zeros/bin-lower");
  mount("-t", "overlay", "overlay", "-o", "lowerdir=/run/zeros/bin-lower,upperdir=/run/zeros/bin-upper,workdir=/run/zeros/bin-work", "/usr/bin");
  cpSync(`${config.stage}/worker/binaries/zsr-rg`, "/usr/bin/rg");
  // cp preserves the sandbox source UID. This new private-overlay inode must
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
  mkdir("/srv/zeros/files/workspace", 0o755, 10001);
  mkdir("/srv/zeros/home/agent", 0o700, 10001); mkdir("/srv/zeros/home/capture", 0o700, 10002);
  mkdir("/srv/zeros/state", 0o700, 10003); mkdir("/srv/zeros/managed-settings", 0o755);
  writeFileSync("/srv/zeros/managed-settings/settings.managed.toml", "# SOURCE-MODE fixture managed settings\n", { mode: 0o644 });
  writeFileSync("/srv/zeros/files/workspace/tool-input.txt", "fixture native read 73491\n");
  writeFileSync("/srv/zeros/files/workspace/.mcp.json", config.mcp);
  for (const name of ["tool-input.txt", ".mcp.json"]) chownSync(`/srv/zeros/files/workspace/${name}`, 10001, 10001);
  initializeFixtureCheckout("/srv/zeros/files/workspace", args => { execFileSync("/usr/bin/setpriv", ["--reuid=10001", "--regid=10001", "--clear-groups", "/usr/bin/git", ...args],
    { stdio: "pipe", env: { PATH: "/usr/bin:/bin", HOME: "/srv/zeros/home/agent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); });
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
        observedRuntimeEngine(config.descriptor.active.root, config.outerPidNamespace);
        emit({ type: "inspection", id: command.id, engineUid: 10003, engineGid: 10003,
          uidMap: [[0, 10003, 1], [10001, 10001, 2], [10004, 10004, 1]],
          gidMap: [[0, 10003, 1], [10001, 10001, 2], [10004, 10004, 1]], identityObserved: true });
      }
      else if (command.op === "prepare-native" && typeof command.nonce === "string" && /^[a-f0-9-]{36}$/.test(command.nonce)) {
        for (const name of ["tool-output.txt", "shell-uid.txt", "stop-started.txt", "stop-finished.txt"]) rmSync(`/srv/zeros/files/workspace/${name}`, { force: true });
        const artifacts = freshNativeArtifacts(command.nonce);
        writeFileSync("/srv/zeros/files/workspace/tool-input.txt", artifacts.input);
        chownSync("/srv/zeros/files/workspace/tool-input.txt", 10001, 10001);
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
