#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lchown,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  ZSR_RESOURCE_LIMITS,
  resourceLimitShell,
} from "../../apps/desktop/src/engine/agents/containment/zsr-resource-limits.mjs";
import {
  createZsrCgroupScope,
  killAndRemoveZsrCgroup,
  wrapWithZsrCgroup,
} from "../../apps/desktop/src/engine/agents/containment/zsr-cgroup.mjs";
import { buildQualificationCommand, shellQuote } from "./command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeChild = path.join(here, "probe-child.mjs");
const nativeAttackSource = path.join(here, "native-attacks.c");
const openCodeRuntimeFixture = path.join(here, "opencode-runtime-fixture.mjs");
const containerWorkerLauncher = path.join(
  path.dirname(here),
  "..",
  "apps/desktop/src/engine/agents/containment/zsr-container-worker.mjs",
);
const macosEngineBoundaryProbe = path.join(here, "macos-engine-boundary.ts");
const localHostParityProbe = path.join(here, "local-host-parity.ts");
const dynamicPortProbe = path.join(here, "dynamic-ports.ts");
const packageJsonPath = fileURLToPath(
  new URL(
    "../../node_modules/@anthropic-ai/sandbox-runtime/package.json",
    import.meta.url,
  ),
);
const expectedVersion = "0.0.73";
const args = new Set(process.argv.slice(2));
const workerMode = args.has("--worker");

function result(name, status, detail) {
  return { name, status, ...(detail ? { detail } : {}) };
}

/** The JSON report a fixture wrote, out of a stdout that may also carry engine
 * diagnostics.
 *
 * A fixture builds a real boundary, so the engine legitimately logs while it
 * runs — `[zsr] admitted …` on a slow admission, `[zsr] retired …` on a slow
 * teardown. Requiring stdout to be *nothing but* the report made every such line
 * present as a fence failure with the useless detail "fixture produced no
 * parseable report", and it did exactly that twice on 2026-08-17: first for
 * `macos-detached-process-domain` (attributed at the time to a live dev app, then
 * to transience — both wrong), and again for it plus `macos-dynamic-dev-ports`
 * the moment a retirement report was added. The report is the LAST balanced JSON
 * object on stdout; nothing about the checks themselves is loosened, because the
 * checks are the parsed fields. */
function fixtureReport(stdout) {
  const text = String(stdout ?? "");
  for (let start = text.lastIndexOf("{"); start >= 0; ) {
    const candidate = text.slice(start);
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not a complete document from here; try the previous opening brace.
    }
    start = text.lastIndexOf("{", start - 1);
  }
  throw new Error("fixture produced no parseable report");
}

/** Why a spawned fixture failed, in a form a human can act on.
 *
 * The old form was `error ?? stderr ?? "fixture exited N"`, and `??` only falls
 * through on null/undefined — so a fixture that exited cleanly with a report
 * whose fields simply did not match produced an EMPTY stderr, an omitted
 * `detail`, and a `--require-secure` failure with no stated reason at all. That
 * happened for real on 2026-08-17. Always say the exit status and what the
 * fixture actually reported. */
function fixtureFailureDetail(spawned, observed) {
  const parts = [
    spawned.error ? safeError(spawned.error) : "",
    `status=${spawned.status === null ? `signal ${spawned.signal}` : spawned.status}`,
    observed ? `observed: ${observed}` : "",
    spawned.stderr ? `stderr: ${safeError(spawned.stderr)}` : "",
  ].filter(Boolean);
  return parts.join("; ").slice(0, 1_000);
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replaceAll(os.homedir(), "<home>")
    .replaceAll(process.cwd(), "<workspace>")
    .slice(0, 1_000);
}

function executableOnPath(name) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function packagedFixtureEnvironment() {
  return {
    ...process.env,
    ZEROS_ZSR_SUPERVISOR_SCRIPT: path.resolve(
      here,
      "../../binaries/zsr-supervisor.mjs",
    ),
    ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: path.resolve(
      here,
      "../../binaries/zsr-network-bridge.mjs",
    ),
    ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER: path.resolve(
      here,
      "../../binaries/zsr-macos-process-domain",
    ),
    ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY: path.resolve(
      here,
      "../../binaries/zsr-macos-port-bind.dylib",
    ),
  };
}

async function localHostParityMain() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const report = {
    schemaVersion: 1,
    runtime: {
      name: packageJson.name,
      version: packageJson.version,
      expectedVersion,
      license: packageJson.license,
    },
    platform: process.platform,
    arch: process.arch,
    backend: "local-host-parity+srt",
    secure: false,
    checks: [
      result(
        "exact-pin",
        packageJson.version === expectedVersion ? "pass" : "fail",
        `${packageJson.name}@${packageJson.version}`,
      ),
      result("license", packageJson.license === "Apache-2.0" ? "pass" : "fail"),
    ],
  };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    report.checks.push(result("platform", "unsupported", process.platform));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (args.has("--require-secure")) process.exitCode = 1;
    return;
  }

  const fixture = spawnSync(
    process.execPath,
    ["--import", "tsx", localHostParityProbe],
    {
      cwd: path.resolve(here, "../.."),
      env: packagedFixtureEnvironment(),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 256 * 1024,
    },
  );
  let observed;
  try {
    observed = fixtureReport(fixture.stdout);
  } catch (error) {
    report.checks.push(
      result(
        "local-host-parity-canary",
        "fail",
        fixtureFailureDetail(fixture, safeError(error)),
      ),
    );
  }
  if (observed) {
    const code = observed.code ?? {};
    const design = observed.design ?? {};
    const checks = [
      ["host-machine-read", code.hostRead === true],
      ["code-workspace-write", code.codeWrite === true],
      [
        "multiple-design-write-denial",
        Array.isArray(code.designDenied) &&
          code.designDenied.length === 3 &&
          code.designDenied.every(Boolean),
      ],
      [
        "native-git-all-subcommands",
        code.canonicalGit === true &&
          Array.isArray(code.gitStatuses) &&
          code.gitStatuses.length === 5 &&
          code.gitStatuses.every((status) => status === 0),
      ],
      [
        "native-git-stderr",
        typeof code.rawGitErrors === "string" &&
          !code.rawGitErrors.includes("[zsr"),
      ],
      ["pre-push-hook", observed.prePushHook === true],
      ["real-home", observed.hostHomePreserved === true],
      ["provider-home", observed.providerHomePreserved === true],
      ["gh-token", observed.ghTokenPreserved === true],
      ["github-token", observed.githubTokenPreserved === true],
      ["ssh-agent", observed.sshAgentPreserved === true],
      ["gh-cli", code.ghAvailable === true],
      ["keychain", code.keychainAvailable === true],
      ["direct-local-service", code.directService === true],
      ["direct-agent-port", code.directPort === true],
      ["direct-requested-port", observed.directRequestedPort === true],
      [
        "host-network-environment",
        code.proxyUnchanged === true && code.noNetworkBridge === true,
      ],
      // Named separately from `host-network-environment` (which covers proxy
      // variables only) because TLS trust is what actually breaks `git clone
      // https://…`, `curl`, and `pip install` when the supervisor rewrites it.
      ["host-tls-trust-environment", code.caTrustExact === true],
      // The recognition split. The canvas marker is unwritable because it sits
      // inside protected Design territory; the `.zeros` pointer stays writable
      // because it is committed repository content and denying it broke every
      // `git pull` that had to rewrite it. De-registration is covered by
      // engine-side sticky recognition, which is deliberately NOT a filesystem
      // rule — both halves are asserted so neither can drift silently.
      ["design-marker-write-denial", code.markerDenied === true],
      ["repo-settings-host-parity-write", code.repoSettingsWritable === true],
      // The one case a matching Design tree hides: git itself writing a protected
      // path. Refused on that path, with the bytes intact.
      [
        "design-git-restore-denial",
        code.designRestoreRefused === true &&
          code.designRestoreBytes === '{"mode":"code-protected-v2"}\n',
      ],
      ["design-code-write-denial", design.codeDenied === true],
      ["design-primary-write", design.primaryWrite === true],
      ["design-secondary-write", design.secondaryWrite === true],
      ["design-outside-cache-write", design.outsideWrite === true],
      ["design-canonical-git-write", design.canonicalGitWrite === true],
      ["design-preserves-code", observed.codeFileUnchangedByDesign === true],
      [
        "local-admission-fast-path",
        Number.isFinite(observed.codeAdmissionMs) &&
          Number.isFinite(observed.designAdmissionMs),
      ],
    ];
    const detailFor = (name) => {
      if (name === "local-admission-fast-path") {
        return `code=${observed.codeAdmissionMs}ms design=${observed.designAdmissionMs}ms`;
      }
      // Name the variables, not just the verdict: the failure this check exists
      // for is a rewritten TLS-trust path, and "which one" is the whole
      // remediation. Values are engine/host paths, never credentials.
      if (
        name === "host-tls-trust-environment" &&
        Array.isArray(code.caTrustDrift) &&
        code.caTrustDrift.length > 0
      ) {
        return code.caTrustDrift.slice(0, 16).join(" ");
      }
      return undefined;
    };
    for (const [name, passed] of checks) {
      report.checks.push(
        result(
          name,
          fixture.status === 0 && passed ? "pass" : "fail",
          detailFor(name),
        ),
      );
    }
  }

  if (process.platform === "darwin") {
    const lifecycle = spawnSync(
      process.execPath,
      ["--import", "tsx", macosEngineBoundaryProbe],
      {
        cwd: path.resolve(here, "../.."),
        env: packagedFixtureEnvironment(),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 128 * 1024,
      },
    );
    let passed = false;
    let detail = "";
    try {
      const lifecycleReport = fixtureReport(lifecycle.stdout);
      passed =
        lifecycle.status === 0 &&
        lifecycleReport.normalTeardown === true &&
        lifecycleReport.crashRecovery === true &&
        lifecycleReport.recovered === 1;
      detail =
        `normalTeardown=${lifecycleReport.normalTeardown} ` +
        `crashRecovery=${lifecycleReport.crashRecovery} ` +
        `recovered=${lifecycleReport.recovered}`;
    } catch (error) {
      detail = safeError(error);
    }
    report.checks.push(
      result(
        "macos-detached-process-domain",
        passed ? "pass" : "fail",
        passed ? undefined : fixtureFailureDetail(lifecycle, detail),
      ),
    );
  } else {
    report.checks.push(result("macos-detached-process-domain", "not-required"));
  }

  report.secure = report.checks.every((check) =>
    ["pass", "not-required"].includes(check.status),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.has("--require-secure") && !report.secure) process.exitCode = 1;
}

async function reserveTcpServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing TCP address");
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

async function chownTree(root, uid, gid) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) await lchown(candidate, uid, gid);
    else {
      if (entry.isDirectory()) await chownTree(candidate, uid, gid);
      await chown(candidate, uid, gid);
    }
  }
  await chown(root, uid, gid);
}

async function worker() {
  const descriptorPath = process.argv[process.argv.indexOf("--worker") + 1];
  if (!descriptorPath || !path.isAbsolute(descriptorPath)) {
    throw new Error("worker descriptor must be absolute");
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const config = {
    filesystem: {
      denyRead: descriptor.denyRead,
      allowRead: descriptor.allowRead,
      allowWrite: descriptor.allowWrite,
      denyWrite: descriptor.denyWrite,
      allowGitConfig: true,
      disableMandatoryWriteProtection: true,
      ...(process.platform === "linux"
        ? { bindMounts: descriptor.bindMounts }
        : {}),
    },
    network: {
      allowedDomains: ["*"],
      deniedDomains: ["169.254.169.254", "metadata.google.internal"],
      strictAllowlist: true,
      allowedLocalPorts: [
        descriptor.servicePort,
        ...(descriptor.containerWorker
          ? [descriptor.containerWorker.publishedPort]
          : []),
      ],
      ...(process.platform === "darwin"
        ? {
            allowUnixSockets: descriptor.allowedUnixSocket
              ? [descriptor.allowedUnixSocket]
              : [],
            allowAllUnixSockets: false,
          }
        : {
            allowAllUnixSockets: Boolean(descriptor.allowedUnixSocket),
          }),
      allowLocalBinding: true,
    },
    allowPty: true,
    ...(descriptor.cloudWorker
      ? { linuxPrivilegedWorker: descriptor.cloudWorker }
      : {}),
    bwrapPath: descriptor.bwrapPath,
    socatPath: descriptor.socatPath,
    ...(descriptor.seccompPath
      ? { seccomp: { applyPath: descriptor.seccompPath } }
      : {}),
    git: { safeDirectories: [descriptor.root] },
  };

  let designFd;
  let child;
  let localServiceBridge;
  let cgroupScope;
  try {
    // Open before SRT, then deliberately do not include it in child stdio. The
    // production supervisor follows the same close-on-spawn contract.
    designFd = openSync(
      path.join(descriptor.design, "tracked.txt"),
      constants.O_WRONLY,
    );
    await SandboxManager.initialize(config, undefined, true);
    process.stderr.write("[zsr-qualification] initialized\n");
    if (descriptor.cgroup) {
      cgroupScope = createZsrCgroupScope({
        parent: descriptor.cgroup.parent,
        generation: `${descriptor.generation}:${process.pid}:${randomUUID()}`,
        limits: descriptor.cgroup.resources,
      });
    }
    const probeCommand = [
      process.execPath,
      descriptor.probeChild,
      descriptor.root,
      String(descriptor.servicePort),
      String(descriptor.reversePort),
      descriptor.allowedUnixSocket,
      descriptor.ambientUnixSocket,
      descriptor.resultFile,
      String(descriptor.cloudWorker?.uid ?? -1),
      String(descriptor.cloudWorker?.gid ?? -1),
      String(descriptor.enginePid ?? -1),
      String(descriptor.resourceLimits.processes),
      String(descriptor.resourceLimits.openFiles),
      descriptor.openCodeFixture,
      cgroupScope?.path ?? "",
      String(descriptor.resourceLimits.memoryBytes),
      String(descriptor.resourceLimits.cpuQuotaMicros),
      String(descriptor.resourceLimits.cpuPeriodMicros),
      descriptor.containerWorker?.engine ?? "",
      descriptor.containerWorker?.rootfsArchive ?? "",
      String(descriptor.containerWorker?.publishedPort ?? -1),
      descriptor.nativeAttackHelper,
    ];
    const commandParts = descriptor.containerWorker
      ? [
          process.execPath,
          descriptor.containerWorker.launcher,
          "--engine",
          descriptor.containerWorker.engine,
          "--state",
          descriptor.containerWorker.state,
          "--socket",
          descriptor.containerWorker.socket,
          "--",
          ...probeCommand,
        ]
      : probeCommand;
    const containerEnvironment = descriptor.containerWorker
      ? `DOCKER_HOST=${shellQuote(`unix://${descriptor.containerWorker.socket}`)} CONTAINER_HOST=${shellQuote(`unix://${descriptor.containerWorker.socket}`)} `
      : "";
    const command = buildQualificationCommand({
      debug: Boolean(process.env.SRT_DEBUG),
      diagnostics: [
        "id >&2",
        `namei -l ${shellQuote(descriptor.probeChild)} >&2`,
        `stat ${shellQuote(descriptor.probeChild)} >&2`,
      ],
      resourcePrelude: resourceLimitShell(),
      environmentPrelude: containerEnvironment,
      argv: commandParts,
    });
    process.env.ZEROS_ZSR_DENY_SECURITY_SERVER = "1";
    if (process.platform === "linux") {
      localServiceBridge = createServer((peer) => {
        let frame = Buffer.alloc(0);
        peer.on("data", (chunk) => {
          frame = Buffer.concat([frame, chunk]);
          if (frame.length > 4_096) return peer.destroy();
          const newline = frame.indexOf(0x0a);
          if (newline < 0) return;
          peer.removeAllListeners("data");
          try {
            const request = JSON.parse(
              frame.subarray(0, newline).toString("utf8"),
            );
            if (
              newline !== frame.length - 1 ||
              request.version !== 1 ||
              request.operation !== "connect-local-tcp" ||
              request.generation !== descriptor.generation ||
              request.token !== descriptor.bridgeToken ||
              request.port !== descriptor.servicePort
            ) {
              peer.destroy();
              return;
            }
            const target = connect({
              host: "127.0.0.1",
              port: descriptor.servicePort,
            });
            target.once("connect", () => {
              peer.write("OK\n");
              peer.pipe(target);
              target.pipe(peer);
            });
            target.once("error", () => peer.destroy());
            peer.once("close", () => target.destroy());
          } catch {
            peer.destroy();
          }
        });
      });
      await new Promise((resolve, reject) => {
        localServiceBridge.once("error", reject);
        localServiceBridge.listen(descriptor.serviceSocket, resolve);
      });
      await chmod(descriptor.serviceSocket, 0o600);
      await writeFile(
        descriptor.bridgeDescriptor,
        `${JSON.stringify({
          version: 1,
          generation: descriptor.generation,
          token: descriptor.bridgeToken,
          reverseSocketPath: descriptor.reverseSocket,
          localTcpPorts: [descriptor.servicePort],
          ignoredTcpPorts: [
            descriptor.servicePort,
            descriptor.internalHttpPort,
            descriptor.internalSocksPort,
          ].sort((left, right) => left - right),
          serviceSocketPath: descriptor.serviceSocket,
        })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      Object.assign(process.env, {
        ZEROS_ZSR_NETWORK_BRIDGE: "1",
        ZEROS_ZSR_NETWORK_BRIDGE_RUNTIME: process.execPath,
        ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: descriptor.bridgeScript,
        ZEROS_ZSR_NETWORK_BRIDGE_DESCRIPTOR: descriptor.bridgeDescriptor,
        ZEROS_ZSR_NETWORK_BRIDGE_SOCKET: descriptor.reverseSocket,
        ZEROS_ZSR_INTERNAL_HTTP_PORT: String(descriptor.internalHttpPort),
        ZEROS_ZSR_INTERNAL_SOCKS_PORT: String(descriptor.internalSocksPort),
      });
    }
    let wrapped;
    try {
      wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        undefined,
        undefined,
        undefined,
        descriptor.root,
        { commandId: "zsr-qualification" },
      );
    } finally {
      for (const name of Object.keys(process.env)) {
        if (
          name.startsWith("ZEROS_ZSR_NETWORK_BRIDGE") ||
          name.startsWith("ZEROS_ZSR_INTERNAL_") ||
          name === "ZEROS_ZSR_DENY_SECURITY_SERVER"
        ) {
          delete process.env[name];
        }
      }
    }
    if (process.env.SRT_DEBUG) {
      process.stderr.write(
        `[zsr-qualification] wrapped argv ${JSON.stringify(wrapped.argv)}\n`,
      );
    }
    const securityServerDenied =
      process.platform !== "darwin" ||
      !wrapped.argv.some(
        (value) =>
          value.includes("com.apple.SecurityServer") &&
          value.includes("allow mach-lookup"),
      );
    const securitydXpcDenied =
      process.platform !== "darwin" ||
      !wrapped.argv.some(
        (value) =>
          value.includes("com.apple.securityd.xpc") &&
          value.includes("allow mach-lookup"),
      );
    if (!securityServerDenied || !securitydXpcDenied) {
      throw new Error("macOS profile exposes ambient Keychain Mach authority");
    }
    process.stdout.write(
      `${JSON.stringify({
        type: "profile",
        securityServerDenied,
        securitydXpcDenied,
      })}\n`,
    );
    const launchArgv = cgroupScope
      ? wrapWithZsrCgroup(cgroupScope, wrapped.argv)
      : wrapped.argv;
    child = spawn(launchArgv[0], launchArgv.slice(1), {
      cwd: descriptor.root,
      env: wrapped.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stderr.write("[zsr-qualification] spawned canary\n");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4_096);
    });

    const readyDeadline = Date.now() + 15_000;
    let ready;
    while (!ready && child.exitCode === null && Date.now() < readyDeadline) {
      try {
        const parsed = JSON.parse(
          await readFile(descriptor.resultFile, "utf8"),
        );
        if (parsed.type === "ready") ready = parsed;
      } catch {
        // Result is written atomically enough for a bounded retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!ready) {
      throw new Error(
        `sandbox canary did not become ready: ${stderr || `exit ${child.exitCode}`}`,
      );
    }
    process.stderr.write("[zsr-qualification] canary ready\n");
    if (process.platform === "linux") {
      const discovered = await new Promise((resolve, reject) => {
        const connection = connect(descriptor.reverseSocket);
        let response = "";
        connection.setEncoding("utf8");
        connection.setTimeout(3_000, () =>
          connection.destroy(new Error("timeout")),
        );
        connection.once("connect", () =>
          connection.write(
            `${JSON.stringify({
              version: 1,
              operation: "list-tcp-listeners",
              generation: descriptor.generation,
              token: descriptor.bridgeToken,
            })}\n`,
          ),
        );
        connection.on("data", (chunk) => {
          response += chunk;
          if (!response.endsWith("\n")) return;
          connection.end();
          try {
            resolve(JSON.parse(response).listeners);
          } catch (error) {
            reject(error);
          }
        });
        connection.once("error", reject);
      });
      process.stdout.write(
        `${JSON.stringify({
          type: "listener-discovery",
          ok:
            Array.isArray(discovered) &&
            discovered.includes(descriptor.reversePort) &&
            !discovered.includes(descriptor.servicePort) &&
            !discovered.includes(descriptor.internalHttpPort) &&
            !discovered.includes(descriptor.internalSocksPort),
        })}\n`,
      );
    }
    const reverse = await new Promise((resolve, reject) => {
      const connection =
        process.platform === "linux"
          ? connect(descriptor.reverseSocket)
          : connect({ host: "127.0.0.1", port: descriptor.reversePort });
      let response = "";
      let authenticated = process.platform !== "linux";
      connection.setEncoding("utf8");
      connection.setTimeout(3_000, () =>
        connection.destroy(new Error("timeout")),
      );
      connection.on("connect", () => {
        if (process.platform !== "linux") {
          connection.write("browser");
          return;
        }
        connection.write(
          `${JSON.stringify({
            version: 1,
            operation: "connect-tcp",
            generation: descriptor.generation,
            token: descriptor.bridgeToken,
            port: descriptor.reversePort,
          })}\n`,
        );
      });
      connection.on("data", (chunk) => {
        if (!authenticated) {
          if (chunk !== "OK\n") {
            connection.destroy(new Error("bridge authentication failed"));
            return;
          }
          authenticated = true;
          connection.write("browser");
          return;
        }
        response += chunk;
        connection.destroy();
        resolve(response);
      });
      connection.on("error", reject);
    });
    process.stderr.write("[zsr-qualification] reverse port reached\n");
    process.stdout.write(
      `${JSON.stringify({ type: "reverse", ok: reverse === "agent:browser" })}\n`,
    );
    process.stdout.write(`${JSON.stringify(ready)}\n`);
    const exit = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    process.stderr.write("[zsr-qualification] canary exited\n");
    if (exit.code !== 0) {
      throw new Error(
        `sandbox canary exited ${exit.code ?? exit.signal}: ${stderr}`,
      );
    }
    const done = JSON.parse(await readFile(descriptor.resultFile, "utf8"));
    if (done.type !== "done")
      throw new Error("sandbox canary omitted final result");
    process.stdout.write(`${JSON.stringify(done)}\n`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (designFd !== undefined) closeSync(designFd);
    if (localServiceBridge) {
      await closeServer(localServiceBridge).catch(() => undefined);
    }
    try {
      SandboxManager.cleanupAfterCommand();
      await SandboxManager.reset().catch(() => undefined);
    } finally {
      await killAndRemoveZsrCgroup(cgroupScope);
    }
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const report = {
    schemaVersion: 1,
    runtime: {
      name: packageJson.name,
      version: packageJson.version,
      expectedVersion,
      license: packageJson.license,
    },
    platform: process.platform,
    arch: process.arch,
    backend: args.has("--cloud-worker") ? "cloud-worker+srt" : "srt",
    secure: false,
    checks: [],
  };
  report.checks.push(
    result(
      "exact-pin",
      packageJson.version === expectedVersion ? "pass" : "fail",
      `${packageJson.name}@${packageJson.version}`,
    ),
  );
  report.checks.push(
    result("license", packageJson.license === "Apache-2.0" ? "pass" : "fail"),
  );

  if (process.platform !== "darwin" && process.platform !== "linux") {
    report.checks.push(result("platform", "unsupported", process.platform));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = args.has("--require-secure") ? 1 : 0;
    return;
  }

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "zeros-zsr-qualification-"),
  );
  const root = args.has("--cloud-worker")
    ? path.join("/tmp", `zeros-zw-${randomUUID().slice(0, 8)}`)
    : path.join(temporaryRoot, "workspace");
  const design = path.join(root, "Zeros Design");
  const prospective = path.join(root, "Future Design");
  const code = path.join(root, "code");
  const privateState = args.has("--cloud-worker")
    ? path.join("/tmp", `zeros-zp-${randomUUID().slice(0, 8)}`)
    : path.join(temporaryRoot, "private-state");
  const privateHome = path.join(privateState, "home");
  const canonicalControl = path.join(root, ".git");
  const privateControl = path.join(privateState, "projected-git");
  const networkDir = path.join("/tmp", `zeros-zq-${randomUUID().slice(0, 8)}`);
  const networkBridgeDir = path.join(networkDir, "bridge");
  const networkServiceDir = path.join(networkDir, "services");
  const descriptorPath = path.join(privateState, "descriptor.json");
  const bridgeDescriptor = path.join(networkBridgeDir, "c.json");
  const reverseSocket = path.join(networkBridgeDir, "r");
  const serviceSocket = path.join(networkBridgeDir, "h");
  const allowedUnixSocket = path.join(networkServiceDir, "allowed.sock");
  const ambientUnixSocket = path.join(
    "/tmp",
    `zeros-zsr-ambient-${randomUUID().slice(0, 8)}.sock`,
  );
  const resultFile = path.join(code, ".zsr-probe-result.json");
  const privateProbeChild = path.join(privateState, "probe-child.mjs");
  const privateNativeAttackHelper = path.join(privateState, "native-attacks");
  const privateOpenCodeFixture = path.join(
    privateState,
    "opencode-runtime-fixture.mjs",
  );
  const privateBridgeScript = path.join(privateState, "network-bridge.mjs");
  const privateContainerWorker = path.join(
    privateState,
    "container-worker.mjs",
  );
  const containerState = path.join(privateState, "container-state");
  const containerSocket = path.join(containerState, "podman.sock");
  const containerRootfs = path.join(privateState, "container-rootfs");
  const containerRootfsArchive = path.join(
    privateState,
    "container-rootfs.tar",
  );
  let localService;
  let allowedUnixService;
  let ambientUnixService;
  try {
    const cloudWorkerRequested = args.has("--cloud-worker");
    if (
      cloudWorkerRequested &&
      (process.platform !== "linux" ||
        typeof process.geteuid !== "function" ||
        process.geteuid() !== 0)
    ) {
      throw new Error(
        "cloud-worker qualification requires a root Linux supervisor",
      );
    }
    const cloudUid = Number.parseInt(
      process.env.ZEROS_ZSR_QUALIFICATION_UID ??
        process.env.SUDO_UID ??
        "65534",
      10,
    );
    const cloudGid = Number.parseInt(
      process.env.ZEROS_ZSR_QUALIFICATION_GID ??
        process.env.SUDO_GID ??
        "65534",
      10,
    );
    const cloudWorker = cloudWorkerRequested
      ? { uid: cloudUid, gid: cloudGid }
      : undefined;
    if (
      cloudWorker &&
      (!Number.isInteger(cloudWorker.uid) ||
        cloudWorker.uid <= 0 ||
        !Number.isInteger(cloudWorker.gid) ||
        cloudWorker.gid <= 0)
    ) {
      throw new Error("cloud-worker qualification uid/gid is invalid");
    }
    const cgroupParent = cloudWorker
      ? process.env.ZEROS_ZSR_CGROUP_PARENT
      : undefined;
    if (
      cloudWorker &&
      (!cgroupParent ||
        !path.isAbsolute(cgroupParent) ||
        cgroupParent.includes("\0"))
    ) {
      throw new Error("cloud-worker qualification cgroup parent is invalid");
    }
    await mkdir(networkDir, { recursive: false, mode: 0o700 });
    await Promise.all([
      mkdir(design, { recursive: true }),
      // Seatbelt path filters cannot reserve a vnode which does not exist.
      // Production admission creates the same empty Design-owned lease before
      // compiling the code-agent profile; the canary must qualify that exact
      // contract, not an impossible nonexistent-path promise.
      mkdir(prospective, { recursive: true, mode: 0o700 }),
      mkdir(code, { recursive: true }),
      mkdir(path.join(root, ".vscode"), { recursive: true }),
      mkdir(path.join(root, ".claude", "commands"), { recursive: true }),
      mkdir(privateHome, { recursive: true, mode: 0o700 }),
      mkdir(canonicalControl, { recursive: true, mode: 0o700 }),
      mkdir(privateControl, { recursive: true, mode: 0o700 }),
      mkdir(networkBridgeDir, { recursive: true, mode: 0o700 }),
      mkdir(networkServiceDir, { recursive: true, mode: 0o700 }),
      mkdir(containerState, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(path.join(design, "tracked.txt"), "before\n"),
      writeFile(path.join(design, "delete.txt"), "before\n"),
      writeFile(path.join(design, "rename-source.txt"), "before\n"),
      writeFile(path.join(code, "rename-source.txt"), "before\n"),
      writeFile(path.join(code, "delete.txt"), "before\n"),
      writeFile(path.join(root, ".mcp.json"), "{}\n"),
      writeFile(path.join(root, ".vscode", "settings.json"), "{}\n"),
      writeFile(path.join(root, ".gitmodules"), "# before\n"),
      writeFile(path.join(canonicalControl, "identity"), "canonical\n"),
      writeFile(path.join(privateControl, "identity"), "private\n"),
    ]);
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(design, path.join(code, "design-alias"), "dir"),
    );
    await Promise.all([
      copyFile(probeChild, privateProbeChild),
      copyFile(openCodeRuntimeFixture, privateOpenCodeFixture),
      copyFile(
        path.join(
          path.dirname(here),
          "..",
          "apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs",
        ),
        privateBridgeScript,
      ),
      copyFile(containerWorkerLauncher, privateContainerWorker),
    ]);
    await Promise.all([
      chmod(privateProbeChild, 0o555),
      chmod(privateOpenCodeFixture, 0o555),
      chmod(privateBridgeScript, 0o555),
      chmod(privateContainerWorker, 0o555),
    ]);

    const compiler = executableOnPath("cc") ?? executableOnPath("clang");
    if (!compiler) {
      throw new Error(
        "native openat/mmap/rename qualification requires a C compiler",
      );
    }
    const compilation = spawnSync(
      compiler,
      [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        nativeAttackSource,
        "-o",
        privateNativeAttackHelper,
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (compilation.status !== 0) {
      throw new Error("native attack helper compilation failed");
    }
    await chmod(privateNativeAttackHelper, 0o555);
    report.checks.push(result("native-attack-helper", "pass"));

    const podman =
      process.platform === "linux" ? executableOnPath("podman") : null;
    const busybox =
      process.platform === "linux" ? executableOnPath("busybox") : null;
    let containerWorker;
    if (podman || cloudWorker) {
      if (!podman || !busybox) {
        throw new Error(
          "container-worker qualification requires Podman and a static BusyBox fixture",
        );
      }
      await Promise.all([
        mkdir(path.join(containerRootfs, "bin"), {
          recursive: true,
          mode: 0o755,
        }),
        mkdir(path.join(containerRootfs, "tmp"), {
          recursive: true,
          mode: 0o1777,
        }),
        mkdir(path.join(containerRootfs, "www"), {
          recursive: true,
          mode: 0o755,
        }),
      ]);
      await Promise.all([
        copyFile(busybox, path.join(containerRootfs, "bin", "busybox")),
        writeFile(
          path.join(containerRootfs, "www", "index.html"),
          "zsr-container-port\n",
          { mode: 0o644 },
        ),
      ]);
      await chmod(path.join(containerRootfs, "bin", "busybox"), 0o755);
      const tar = executableOnPath("tar");
      if (!tar)
        throw new Error("tar is unavailable for container qualification");
      const archived = spawnSync(
        tar,
        [
          "--numeric-owner",
          "--owner=0",
          "--group=0",
          "-C",
          containerRootfs,
          "-cf",
          containerRootfsArchive,
          ".",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      if (archived.status !== 0) {
        throw new Error("could not build the container qualification archive");
      }
      const portReservation = await reserveTcpServer(() => undefined);
      const publishedPort = portReservation.port;
      await closeServer(portReservation.server);
      containerWorker = {
        engine: podman,
        launcher: privateContainerWorker,
        state: containerState,
        socket: containerSocket,
        rootfsArchive: containerRootfsArchive,
        publishedPort,
      };
    }
    if (cloudWorker) {
      await Promise.all([
        chownTree(root, cloudWorker.uid, cloudWorker.gid),
        chownTree(privateHome, cloudWorker.uid, cloudWorker.gid),
        chownTree(privateControl, cloudWorker.uid, cloudWorker.gid),
        chownTree(containerState, cloudWorker.uid, cloudWorker.gid),
        ...(containerWorker
          ? [
              chownTree(containerRootfs, cloudWorker.uid, cloudWorker.gid),
              chown(containerRootfsArchive, cloudWorker.uid, cloudWorker.gid),
            ]
          : []),
      ]);
      await Promise.all([
        chmod(root, 0o700),
        chmod(privateHome, 0o700),
        chmod(privateControl, 0o700),
        chmod(temporaryRoot, 0o711),
        chmod(privateState, 0o711),
        chown(networkDir, 0, cloudWorker.gid),
        chmod(networkDir, 0o710),
        chown(networkServiceDir, 0, cloudWorker.gid),
        chmod(networkServiceDir, 0o710),
      ]);
    }

    localService = await reserveTcpServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => socket.end("pong"));
    });
    const reverseReservation = await reserveTcpServer(() => undefined);
    const reversePort = reverseReservation.port;
    await closeServer(reverseReservation.server);

    if (process.platform !== "win32") {
      allowedUnixService = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.on("data", () => socket.end("allowed-unix-pong"));
      });
      await new Promise((resolve, reject) => {
        allowedUnixService.once("error", reject);
        allowedUnixService.listen(allowedUnixSocket, resolve);
      });
      ambientUnixService = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.on("data", () => socket.end("ambient-unix-pong"));
      });
      await new Promise((resolve, reject) => {
        ambientUnixService.once("error", reject);
        ambientUnixService.listen(ambientUnixSocket, resolve);
      });
      if (cloudWorker) {
        await Promise.all([
          chown(allowedUnixSocket, 0, cloudWorker.gid),
          chmod(allowedUnixSocket, 0o620),
          chmod(ambientUnixSocket, 0o666),
        ]);
      }
    }

    let bwrapPath;
    let socatPath;
    let seccompPath;
    let cloudSetpriv;
    if (process.platform === "linux") {
      const bwrap = executableOnPath("bwrap");
      const socat = executableOnPath("socat");
      const setpriv = executableOnPath("setpriv");
      cloudSetpriv = executableOnPath("setpriv");
      if (!bwrap || !socat)
        throw new Error("absolute bwrap/socat helpers unavailable");
      bwrapPath = bwrap;
      socatPath = socat;
      const capProbe = spawnSync(
        "sh",
        ["-c", "grep '^CapEff:' /proc/self/status"],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
        },
      ).stdout.trim();
      const hasAmbientCapabilities = !/CapEff:\s+0+$/.test(capProbe);
      if (hasAmbientCapabilities && !cloudWorker) {
        if (!setpriv)
          throw new Error("setpriv is required to drop ambient capabilities");
        const wrapper = path.join(privateState, "bwrap-drop-capabilities");
        await writeFile(
          wrapper,
          `#!/bin/sh\nexec ${shellQuote(setpriv)} --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all ${shellQuote(bwrap)} "$@"\n`,
          { mode: 0o700 },
        );
        await chmod(wrapper, 0o700);
        bwrapPath = wrapper;
        report.checks.push(result("ambient-capability-repair", "pass"));
      } else {
        report.checks.push(result("ambient-capability-repair", "not-required"));
      }
      if (cloudWorker) {
        if (!cloudSetpriv) {
          throw new Error("setpriv is required for cloud-worker identity drop");
        }
        report.checks.push(result("privileged-namespace-backend", "pass"));
      }
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const candidate = path.join(
        path.dirname(packageJsonPath),
        "vendor",
        "seccomp",
        arch,
        "apply-seccomp",
      );
      if (existsSync(candidate)) seccompPath = candidate;
    }

    await writeFile(
      descriptorPath,
      JSON.stringify({
        root,
        design,
        allowRead:
          process.platform === "linux"
            ? [
                root,
                privateState,
                networkDir,
                "/usr",
                "/bin",
                "/sbin",
                "/lib",
                "/lib64",
                "/etc",
                "/opt",
                "/nix",
                "/sys",
                "/vercel",
                process.execPath,
                path.dirname(process.execPath),
              ]
            : [privateControl, networkDir],
        allowWrite: [
          root,
          privateHome,
          privateControl,
          networkBridgeDir,
          ...(containerWorker ? [containerState] : []),
        ],
        denyRead:
          process.platform === "linux"
            ? ["/", canonicalControl, descriptorPath]
            : [canonicalControl, descriptorPath],
        denyWrite: [canonicalControl, design, prospective, descriptorPath],
        bindMounts: [
          {
            source: privateControl,
            destination: canonicalControl,
            readOnly: false,
          },
        ],
        bwrapPath,
        socatPath,
        seccompPath,
        probeChild: privateProbeChild,
        nativeAttackHelper: privateNativeAttackHelper,
        openCodeFixture: privateOpenCodeFixture,
        servicePort: localService.port,
        reversePort,
        internalHttpPort: 40_001,
        internalSocksPort: 40_002,
        generation: randomUUID(),
        bridgeToken: randomBytes(32).toString("base64url"),
        bridgeScript: privateBridgeScript,
        bridgeDescriptor,
        reverseSocket,
        serviceSocket,
        allowedUnixSocket,
        ambientUnixSocket,
        resultFile,
        resourceLimits: ZSR_RESOURCE_LIMITS,
        ...(containerWorker ? { containerWorker } : {}),
        ...(cgroupParent
          ? {
              cgroup: {
                parent: cgroupParent,
                resources: {
                  memoryBytes: ZSR_RESOURCE_LIMITS.memoryBytes,
                  cpuQuotaMicros: ZSR_RESOURCE_LIMITS.cpuQuotaMicros,
                  cpuPeriodMicros: ZSR_RESOURCE_LIMITS.cpuPeriodMicros,
                  processes: ZSR_RESOURCE_LIMITS.processes,
                },
              },
            }
          : {}),
        ...(cloudWorker
          ? {
              cloudWorker: {
                ...cloudWorker,
                setprivPath: cloudSetpriv,
              },
              enginePid: process.pid,
            }
          : {}),
      }),
      { mode: 0o600 },
    );

    const workerEnv = {
      PATH: process.env.PATH ?? "",
      HOME: privateHome,
      TMPDIR: os.tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      NO_COLOR: "1",
      ...(process.env.SRT_DEBUG ? { SRT_DEBUG: process.env.SRT_DEBUG } : {}),
    };
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--worker", descriptorPath],
      {
        cwd: root,
        env: workerEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8_192);
      if (process.env.SRT_DEBUG) process.stderr.write(chunk);
    });
    let workerDeadline;
    const exit = await Promise.race([
      new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      ),
      new Promise((_, reject) => {
        workerDeadline = setTimeout(
          () => reject(new Error("qualification worker timed out")),
          120_000,
        );
      }),
    ])
      .catch((error) => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        throw new Error(`${safeError(error)}; worker stderr: ${stderr}`);
      })
      .finally(() => clearTimeout(workerDeadline));
    if (exit.code !== 0)
      throw new Error(stderr || `worker exited ${exit.code ?? exit.signal}`);

    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const done = events.findLast((event) => event.type === "done");
    const reverse = events.findLast((event) => event.type === "reverse");
    const listenerDiscovery = events.findLast(
      (event) => event.type === "listener-discovery",
    );
    const profile = events.findLast((event) => event.type === "profile");
    if (!done) throw new Error("worker omitted final result");
    const outcomes = done.result;
    const mustSucceed = [
      "designRead",
      "codeWrite",
      "codeRename",
      "codeDelete",
      "projectMcpWrite",
      "projectVscodeWrite",
      "projectClaudeCommandWrite",
      "projectGitmodulesWrite",
      "privateControlProjection",
      "grandchildDesignWrite",
      "ambientAuthorityAbsent",
      "hostProcessHidden",
      "resourceLimits",
      "localService",
      "commonDevPortsAvailable",
      ...(cloudWorker
        ? ["cloudWorkerIdentity", "engineProcessHidden", "cloudCgroup"]
        : []),
      ...(allowedUnixService ? ["allowedUnixService"] : []),
      ...(containerWorker ? ["containerWorker"] : []),
    ];
    const mustFail = [
      "designTrackedWrite",
      "designCreate",
      "designDelete",
      "designRename",
      "designChmod",
      "designAncestorRename",
      "designSymlinkAliasWrite",
      "designHardlinkInto",
      "designHardlinkAlias",
      "designSymlinkInto",
      "designOpenatWrite",
      "designOpenatCreate",
      "designMmapWrite",
      "designRenameExchange",
      "designDanglingAliasCreate",
      "prospectiveDesignCreate",
      ...(ambientUnixService ? ["ambientUnixService"] : []),
    ];
    for (const name of mustSucceed) {
      report.checks.push(result(name, outcomes[name]?.ok ? "pass" : "fail"));
    }
    report.checks.push(
      result(
        "opencode-whole-runtime",
        outcomes.opencodeWholeRuntime?.ok ? "pass" : "fail",
      ),
    );
    report.checks.push(
      result(
        "isolated-container-worker",
        containerWorker
          ? outcomes.containerWorker?.ok
            ? "pass"
            : "fail"
          : "not-required",
      ),
    );
    for (const name of mustFail) {
      report.checks.push(result(name, outcomes[name]?.ok ? "fail" : "pass"));
    }
    report.checks.push(result("reverse-port", reverse?.ok ? "pass" : "fail"));
    report.checks.push(
      result(
        "dynamic-listener-discovery",
        process.platform === "linux"
          ? listenerDiscovery?.ok
            ? "pass"
            : "fail"
          : "not-required",
      ),
    );
    report.checks.push(
      result(
        "security-server-denied",
        profile?.securityServerDenied ? "pass" : "fail",
      ),
    );
    report.checks.push(
      result(
        "securityd-xpc-denied",
        profile?.securitydXpcDenied ? "pass" : "fail",
      ),
    );
    const designContents = await readFile(
      path.join(design, "tracked.txt"),
      "utf8",
    );
    report.checks.push(
      result(
        "design-unchanged",
        designContents === "before\n" ? "pass" : "fail",
      ),
    );
    report.checks.push(
      result(
        "no-hardlink-alias",
        !existsSync(path.join(code, "design-hardlink")) ? "pass" : "fail",
      ),
    );
    report.checks.push(
      result(
        "no-openat-create",
        !existsSync(path.join(design, "openat-created.txt")) ? "pass" : "fail",
      ),
    );
    report.checks.push(
      result(
        "prospective-lease-empty",
        (await readdir(prospective)).length === 0 ? "pass" : "fail",
      ),
    );
    const descriptorMode = (await stat(descriptorPath)).mode & 0o777;
    report.checks.push(
      result("private-policy-mode", descriptorMode === 0o600 ? "pass" : "fail"),
    );
    if (process.platform === "linux") {
      const privateMarker = await readFile(
        path.join(privateControl, "agent-marker"),
        "utf8",
      ).catch(() => null);
      const canonicalMarkerExists = existsSync(
        path.join(canonicalControl, "agent-marker"),
      );
      report.checks.push(
        result(
          "private-control-write",
          privateMarker === "private-write\n" && !canonicalMarkerExists
            ? "pass"
            : "fail",
        ),
      );
    }
    if (process.platform === "darwin") {
      const lifecycle = spawnSync(
        process.execPath,
        ["--import", "tsx", macosEngineBoundaryProbe],
        {
          cwd: path.resolve(here, "../.."),
          env: {
            ...process.env,
            ZEROS_ZSR_SUPERVISOR_SCRIPT: path.resolve(
              here,
              "../../binaries/zsr-supervisor.mjs",
            ),
            ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: path.resolve(
              here,
              "../../binaries/zsr-network-bridge.mjs",
            ),
            ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER: path.resolve(
              here,
              "../../binaries/zsr-macos-process-domain",
            ),
            ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY: path.resolve(
              here,
              "../../binaries/zsr-macos-port-bind.dylib",
            ),
          },
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 128 * 1024,
        },
      );
      let lifecyclePassed = false;
      let lifecycleObserved = "";
      try {
        const parsed = fixtureReport(lifecycle.stdout);
        lifecyclePassed =
          lifecycle.status === 0 &&
          parsed.normalTeardown === true &&
          parsed.crashRecovery === true &&
          parsed.recovered === 1;
        lifecycleObserved =
          `normalTeardown=${parsed.normalTeardown} ` +
          `crashRecovery=${parsed.crashRecovery} recovered=${parsed.recovered}`;
      } catch {
        lifecyclePassed = false;
        lifecycleObserved = "fixture produced no parseable report";
      }
      report.checks.push(
        result(
          "macos-detached-process-domain",
          lifecyclePassed ? "pass" : "fail",
          lifecyclePassed
            ? undefined
            : fixtureFailureDetail(lifecycle, lifecycleObserved),
        ),
      );
      const dynamicPorts = spawnSync(
        process.execPath,
        ["--import", "tsx", dynamicPortProbe],
        {
          cwd: path.resolve(here, "../.."),
          env: {
            ...process.env,
            ZEROS_ZSR_SUPERVISOR_SCRIPT: path.resolve(
              here,
              "../../binaries/zsr-supervisor.mjs",
            ),
            ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: path.resolve(
              here,
              "../../binaries/zsr-network-bridge.mjs",
            ),
            ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER: path.resolve(
              here,
              "../../binaries/zsr-macos-process-domain",
            ),
            ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY: path.resolve(
              here,
              "../../binaries/zsr-macos-port-bind.dylib",
            ),
          },
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 128 * 1024,
        },
      );
      let dynamicPortsPassed = false;
      let dynamicPortsObserved = "";
      try {
        const parsed = fixtureReport(dynamicPorts.stdout);
        dynamicPortsObserved = Object.entries(parsed)
          .filter(([, value]) => value !== true)
          .map(([name, value]) => `${name}=${value}`)
          .join(" ");
        dynamicPortsPassed =
          dynamicPorts.status === 0 &&
          parsed.randomPort === true &&
          parsed.http === true &&
          parsed.websocket === true &&
          parsed.selfConnect === true &&
          parsed.rawSelfConnect === true &&
          parsed.unassignedBindDenied === true &&
          parsed.explicitVirtualized === true &&
          parsed.revoked === true;
      } catch {
        dynamicPortsPassed = false;
        dynamicPortsObserved = "fixture produced no parseable report";
      }
      report.checks.push(
        result(
          "macos-dynamic-dev-ports",
          dynamicPortsPassed ? "pass" : "fail",
          dynamicPortsPassed
            ? undefined
            : fixtureFailureDetail(dynamicPorts, dynamicPortsObserved),
        ),
      );
    } else {
      report.checks.push(
        result("macos-detached-process-domain", "not-required"),
      );
      report.checks.push(result("macos-dynamic-dev-ports", "not-required"));
    }
    report.secure = report.checks.every((check) =>
      ["pass", "not-required"].includes(check.status),
    );
  } catch (error) {
    report.checks.push(result("live-canary", "fail", safeError(error)));
  } finally {
    if (localService)
      await closeServer(localService.server).catch(() => undefined);
    if (allowedUnixService)
      await closeServer(allowedUnixService).catch(() => undefined);
    if (ambientUnixService)
      await closeServer(ambientUnixService).catch(() => undefined);
    await rm(ambientUnixSocket, { force: true }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (!root.startsWith(`${temporaryRoot}${path.sep}`)) {
      await rm(root, { recursive: true, force: true });
    }
    if (!privateState.startsWith(`${temporaryRoot}${path.sep}`)) {
      await rm(privateState, { recursive: true, force: true });
    }
    await rm(networkDir, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.has("--require-secure") && !report.secure) process.exitCode = 1;
}

if (workerMode) {
  await worker().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
} else if (!args.has("--cloud-worker") && !args.has("--isolated")) {
  await localHostParityMain().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
} else {
  await main();
}
