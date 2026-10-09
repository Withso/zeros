import { spawn, spawnSync } from "node:child_process";
import {
  readSync,
  mkdtempSync,
  chownSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import {
  CloudEngineCgroup,
  cloudCgroupDirectory,
} from "./cloud-engine-cgroup.mjs";
import { resolveCloudRuntime, resolveCloudRuntimeChild } from "./cloud-runtime-root.mjs";
import { cloudComputerHostRepository, isCloudComputerRepositoryDirectory } from "./cloud-computer-checkout.mjs";
import { CLOUD_ENGINE_MUTABLE_LAYOUT } from "./prepare-cloud-image-files.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FIXED_ENV = {
  HOME: CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome,
  PATH: "",
  LANG: "C.UTF-8",
  LOGNAME: "zeros-engine",
  USER: "zeros-engine",
  SHELL: "/bin/bash",
};
function invalid() {
  return new Error("Invalid cloud setup process document");
}
export function validateCloudSetupPayload(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "command,environment,timeoutMs,version" ||
    value.version !== 1 ||
    typeof value.command !== "string" ||
    !value.command.trim() ||
    value.command.includes("\0") ||
    Buffer.byteLength(value.command) > 16384 ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 ||
    value.timeoutMs > 3600000 ||
    !value.environment ||
    typeof value.environment !== "object" ||
    Array.isArray(value.environment) ||
    Object.keys(value.environment).length > 128
  )
    throw invalid();
  let bytes = 0;
  for (const [key, content] of Object.entries(value.environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) ||
      key in FIXED_ENV ||
      /^(?:LD_|DYLD_)/.test(key) ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "BASH_ENV",
        "ENV",
        "PYTHONSTARTUP",
        "PERL5OPT",
        "RUBYOPT",
      ].includes(key) ||
      typeof content !== "string" ||
      content.includes("\0") ||
      Buffer.byteLength(content) > 65536
    )
      throw invalid();
    bytes += Buffer.byteLength(content);
  }
  if (bytes > 512 * 1024) throw invalid();
  return value;
}

/** Called only while the image-owned setup flock is held. The trusted child
 * blocks on fd 3 before it can fork. Every untrusted descendant inherits the
 * confirmed cgroup; success, timeout, cancellation and restart drain it. */
export async function runScopedCloudSetup(payload, {runtime = resolveCloudRuntime()} = {}) {
  validateCloudSetupPayload(payload);
  const document = Buffer.from(JSON.stringify(payload));
  if (document.length > MAX_DOCUMENT_BYTES) {
    document.fill(0);
    throw invalid();
  }
  const scope = new CloudEngineCgroup({runtime, kind:"setup"});
  await scope.retire();
  scope.prepare();
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.helpers.setupProcess, "--worker"], {
      cwd: "/",
      env: { PATH: `${runtime.binRoot}:/usr/bin:/bin`, HOME: "/root" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout = [],
      stderr = [];
    let size = 0,
      timedOut = false,
      overflow = false,
      failure = null,
      retirement = null;
    const retire = () => {
      retirement ??= scope.retire().catch((error) => {
        failure ??= error;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      });
      return retirement;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void retire();
    }, payload.timeoutMs);
    timer.unref?.();
    const collect = (target, chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        overflow = true;
        void retire();
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdin.on("error", (error) => {
      failure ??= error;
      void retire();
    });
    child.stdio[3].on("error", (error) => {
      failure ??= error;
      void retire();
    });
    child.once("error", (error) => {
      failure ??= error;
      void retire();
    });
    // Do not wait for close: detached children can retain these stdio pipes.
    child.once("exit", () => {
      void retire();
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      await retire();
      document.fill(0);
      if (failure) reject(failure);
      else
        resolve({
          code,
          signal,
          timedOut,
          overflow,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    try {
      scope.attach(child.pid);
      child.stdin.end(document);
      child.stdio[3].end(Buffer.from([42]));
    } catch (error) {
      failure ??= error;
      document.fill(0);
      child.kill("SIGKILL");
      void retire();
    }
  });
}

function worker() {
  const privileged = process.argv[2] === "--worker";
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== (privileged ? 0 : 10003) ||
    process.argv.length !== 3 ||
    (!privileged && process.argv[2] !== "--unprivileged")
  )
    throw invalid();
  // Computer admission binds the root worker to the full host runtime identity.
  // After setpriv, the child can resolve only its pinned executable and paths.
  const runtime = privileged ? resolveCloudRuntime() : resolveCloudRuntimeChild();
  const fixedEnvironment = {...FIXED_ENV, PATH:`${runtime.binRoot}:/usr/bin:/bin`};
  if (privileged) {
    const gate = Buffer.alloc(1);
    if (readSync(3, gate, 0, 1, null) !== 1 || gate[0] !== 42) throw invalid();
  }
  const data = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
  let length = 0;
  for (;;) {
    const count = readSync(0, data, length, data.length - length, null);
    if (!count) break;
    length += count;
    if (length > MAX_DOCUMENT_BYTES) throw invalid();
  }
  let payload;
  try {
    payload = validateCloudSetupPayload(
      JSON.parse(data.subarray(0, length).toString("utf8")),
    );
  } finally {
    data.fill(0);
  }
  // Never launch a privileged executable with repository-controlled locale,
  // loader, or language variables. Deliver the document again over stdin only
  // after setpriv has dropped the identity and all capabilities.
  const encoded = Buffer.from(JSON.stringify(payload));
  const repositoryDirectory = privileged ? cloudComputerHostRepository(runtime) :
    runtime.profile === "v4" ? process.cwd() : runtimeLayout.repository;
  if (repositoryDirectory !== runtimeLayout.repository && !isCloudComputerRepositoryDirectory(repositoryDirectory)) throw invalid();
  const result = privileged
    ? spawnSync(
        "/usr/bin/setpriv",
        [
          "--no-new-privs",
          "--bounding-set=-all",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--pdeathsig=SIGKILL",
          "--reuid=10003",
          "--regid=10003",
          "--clear-groups",
          runtime.node,
          runtime.helpers.setupProcess,
          "--unprivileged",
        ],
        {
          cwd: repositoryDirectory,
          env: { ...fixedEnvironment },
          input: encoded,
          stdio: ["pipe", "inherit", "inherit"],
          timeout: payload.timeoutMs,
          killSignal: "SIGKILL",
        },
      )
    : spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", payload.command],
        {
          // Setup precedes the engine's mount namespace. Its repository is
          // the host path; the logical path exists only inside that view.
          cwd: repositoryDirectory,
          env: { ...payload.environment, ...fixedEnvironment },
          stdio: ["ignore", "inherit", "inherit"],
          timeout: payload.timeoutMs,
          killSignal: "SIGKILL",
        },
      );
  encoded.fill(0);
  for (const key of Object.keys(payload.environment))
    payload.environment[key] = "";
  process.exitCode = result.status ?? 125;
}
export async function qualifyCloudSetupProcess() {
  const runtime = resolveCloudRuntime();
  const setupCgroup = cloudCgroupDirectory(runtime,"setup");
  const directory = mkdtempSync("/tmp/zeros-setup-qualification-");
  chownSync(directory, 10003, 10003);
  const marker = path.join(directory, "child.json");
  const counter = path.join(directory, "counter");
  const workerSource = `import pathlib,json,os,time\npathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({'uid':os.getuid(),'scope':pathlib.Path('/proc/self/cgroup').read_text(),'privileges':pathlib.Path('/proc/self/status').read_text()}))\ni=0\nwhile True:\n pathlib.Path(${JSON.stringify(counter)}).write_text(str(i));i+=1;time.sleep(0.02)\n`;
  const command = `python3 - <<'ZEROS_SETUP_CANARY'\nimport subprocess,pathlib,time\nsubprocess.Popen(['/usr/bin/setsid','/usr/bin/python3','-c',${JSON.stringify(workerSource)}])\nfor _ in range(100):\n if pathlib.Path(${JSON.stringify(counter)}).exists(): break\n time.sleep(0.02)\nelse: raise RuntimeError('child missing')\nprint('ready')\nZEROS_SETUP_CANARY`;
  try {
    const result = await runScopedCloudSetup({
      version: 1,
      command,
      timeoutMs: 10000,
      environment: {},
    });
    const identity = JSON.parse(readFileSync(marker, "utf8"));
    const before = readFileSync(counter, "utf8");
    await delay(100);
    const retired =
      !existsSync(setupCgroup) &&
      readFileSync(counter, "utf8") === before;
    const sameEngineIdentity =
      identity.uid === 10003 &&
      identity.scope.trim() === `0::${setupCgroup.slice("/sys/fs/cgroup".length)}` &&
      /^NoNewPrivs:\s+1$/m.test(identity.privileges) &&
      /^CapEff:\s+0+$/m.test(identity.privileges);
    const timeout = await runScopedCloudSetup({
      version: 1,
      command: "exec python3 -c 'import time; time.sleep(60)'",
      timeoutMs: 1000,
      environment: {},
    });
    const timeoutRetired =
      !existsSync(setupCgroup) &&
      (timeout.timedOut || timeout.code !== 0);
    if (result.code !== 0 || result.stdout.trim() !== "ready" || !sameEngineIdentity || !retired || !timeoutRetired)
      throw invalid();
    return { hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: retired, timeoutRetired };

  } finally {
    await new CloudEngineCgroup({runtime,kind:"setup"}).retire();
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (
      process.argv.length === 3 &&
      process.argv[2] === "--qualify" &&
      process.getuid?.() === 0
    ) {
      const report = await qualifyCloudSetupProcess();
      process.stdout.write(JSON.stringify(report) + "\n");
      process.exitCode = report.hostUid === 10003 && report.detachedDescendantsRetired && report.timeoutRetired ? 0 : 125;
    } else worker();
  } catch {
    process.stderr.write("Cloud setup process could not be admitted\n");
    process.exitCode = 125;
  }
}
