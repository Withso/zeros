#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const POLICY_VERSION = 1;
const COMMAND_VERSION = 6;
const INTERNAL_ENV_PREFIX = "ZEROS_ZSR_";
const GIT_DISPATCH_CONFIG_ENV = "ZEROS_ZSR_GIT_DISPATCH_CONFIG";
const MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
const MAX_POLICY_PATHS = 4_096;
const MAX_ARGUMENTS = 8_192;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const MAX_ENV_ENTRIES = 8_192;
const MAX_ENV_BYTES = 16 * 1024 * 1024;
const ACTORS = new Set(["agent-code", "repo-code-task", "design-agent"]);

function fail(message) {
  process.stderr.write(`[zsr-supervisor] ${message}\n`);
  process.exitCode = 125;
}

function readJson(file, label) {
  if (!path.isAbsolute(file) || file.includes("\0")) {
    throw new Error(`${label} path must be absolute`);
  }
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_DESCRIPTOR_BYTES
  ) {
    throw new Error(`${label} descriptor must be one bounded regular file`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} descriptor has the wrong owner`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} descriptor permissions are too broad`);
  }
  if (realpathSync(file) !== file) {
    throw new Error(`${label} descriptor path is not canonical`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} descriptor must be an object`);
  }
  return parsed;
}

function requireAbsolutePaths(values, label) {
  if (
    !Array.isArray(values) ||
    values.length > MAX_POLICY_PATHS ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        !path.isAbsolute(value) ||
        value.includes("\0"),
    )
  ) {
    throw new Error(`${label} must contain bounded absolute paths`);
  }
}

function validPortList(values) {
  return (
    Array.isArray(values) &&
    values.length <= 256 &&
    new Set(values).size === values.length &&
    values.every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
    )
  );
}

function validatePolicy(policy) {
  if (policy.version !== POLICY_VERSION) {
    throw new Error("unsupported policy version");
  }
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(policy.executionId) ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(policy.generation) ||
    !ACTORS.has(policy.actor) ||
    !path.isAbsolute(policy.cwd) ||
    !path.isAbsolute(policy.workspaceRoot) ||
    policy.cwd.includes("\0") ||
    policy.workspaceRoot.includes("\0")
  ) {
    throw new Error("policy identity is invalid");
  }
  requireAbsolutePaths(policy.filesystem?.allowRead, "allowRead");
  requireAbsolutePaths(policy.filesystem?.allowWrite, "allowWrite");
  requireAbsolutePaths(policy.filesystem?.denyWrite, "denyWrite");
  requireAbsolutePaths(policy.filesystem?.denyRead, "denyRead");
  requireAbsolutePaths(
    policy.runtime?.allowedUnixSockets,
    "allowedUnixSockets",
  );
  if (
    policy.runtime.localHostParity !== true ||
    policy.runtime.normalNetwork !== true ||
    policy.runtime.allowPty !== true ||
    !validPortList(policy.runtime.allowedLocalPorts) ||
    !validPortList(policy.runtime.deniedLocalPorts)
  ) {
    throw new Error("invalid host-parity runtime policy");
  }
  const cloudWorker = policy.runtime.cloudWorker;
  if (cloudWorker === undefined) return;
  const expectedKeys = ["gid", "uid", "version"];
  if (
    process.platform !== "linux" ||
    !cloudWorker ||
    Object.keys(cloudWorker).sort().join("\0") !==
      expectedKeys.join("\0") ||
    cloudWorker.version !== 1 ||
    !Number.isInteger(cloudWorker.uid) ||
    cloudWorker.uid <= 0 ||
    cloudWorker.uid > 2_147_483_647 ||
    !Number.isInteger(cloudWorker.gid) ||
    cloudWorker.gid <= 0 ||
    cloudWorker.gid > 2_147_483_647 ||
    typeof process.geteuid !== "function" ||
    process.geteuid() !== 0
  ) {
    throw new Error("invalid privileged cloud-worker policy");
  }
}

function pathInsideOrEqual(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function canonicalExecutable(file, label) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    file.includes("\0")
  ) {
    throw new Error(`${label} must be an absolute executable`);
  }
  const canonical = realpathSync(file);
  const stat = lstatSync(canonical);
  if (
    canonical !== file ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o111) === 0
  ) {
    throw new Error(`${label} must be a canonical regular executable`);
  }
  return canonical;
}

function validateContainerWorker(command, policy, policyPath) {
  const worker = command.containerWorker;
  if (worker === undefined) return;
  const expectedKeys = [
    "engine",
    "launcher",
    "node",
    "runtime",
    "socket",
    "state",
    "version",
  ];
  if (
    process.platform !== "linux" ||
    !worker ||
    typeof worker !== "object" ||
    Array.isArray(worker) ||
    Object.keys(worker).sort().join("\0") !== expectedKeys.join("\0") ||
    worker.version !== 1 ||
    worker.runtime !== "podman"
  ) {
    throw new Error("invalid container-worker descriptor");
  }
  for (const name of ["engine", "launcher", "node", "socket", "state"]) {
    if (
      typeof worker[name] !== "string" ||
      !path.isAbsolute(worker[name]) ||
      worker[name].includes("\0") ||
      /[\r\n]/.test(worker[name])
    ) {
      throw new Error("invalid container-worker path");
    }
  }
  canonicalExecutable(worker.node, "container-worker Node runtime");
  canonicalExecutable(worker.engine, "container-worker engine");
  const expectedLauncher = path.join(
    path.dirname(policyPath),
    "tools",
    "zsr-container-worker.mjs",
  );
  if (worker.launcher !== expectedLauncher) {
    throw new Error("container-worker launcher is outside private tools");
  }
  const launcherStat = lstatSync(worker.launcher);
  if (
    !launcherStat.isFile() ||
    launcherStat.isSymbolicLink() ||
    launcherStat.nlink !== 1 ||
    realpathSync(worker.launcher) !== worker.launcher ||
    (launcherStat.mode & 0o222) !== 0 ||
    (launcherStat.mode & 0o111) === 0 ||
    (typeof process.getuid === "function" &&
      launcherStat.uid !== process.getuid())
  ) {
    throw new Error("container-worker launcher is not immutable");
  }
  const stateStat = lstatSync(worker.state);
  const stateOwner = policy.runtime.cloudWorker?.uid ?? process.getuid?.();
  if (
    !stateStat.isDirectory() ||
    stateStat.isSymbolicLink() ||
    realpathSync(worker.state) !== worker.state ||
    (stateStat.mode & 0o077) !== 0 ||
    (stateOwner !== undefined && stateStat.uid !== stateOwner) ||
    !policy.filesystem.allowRead.includes(worker.state) ||
    !policy.filesystem.allowWrite.includes(worker.state)
  ) {
    throw new Error("container-worker state is not an admitted private root");
  }
  if (
    worker.socket !== path.join(worker.state, "podman.sock") ||
    !policy.runtime.allowedUnixSockets.includes(worker.socket)
  ) {
    throw new Error("container-worker socket is not admitted");
  }
  for (const executable of [worker.node, worker.engine]) {
    if (
      !policy.filesystem.allowRead.some((allowed) =>
        pathInsideOrEqual(executable, allowed),
      )
    ) {
      throw new Error("container-worker executable is outside read authority");
    }
  }
}

function validateCommand(command, policy, policyPath, commandPath) {
  if (command.version !== COMMAND_VERSION) {
    throw new Error("unsupported command version");
  }
  const allowedKeys = new Set([
    "args",
    "command",
    "containerWorker",
    "cwd",
    "deniedContainerSockets",
    "env",
    "generation",
    "version",
  ]);
  if (Object.keys(command).some((name) => !allowedKeys.has(name))) {
    throw new Error("command descriptor contains an unsupported field");
  }
  if (
    command.generation !== policy.generation ||
    !path.isAbsolute(command.command) ||
    command.command.includes("\0") ||
    !path.isAbsolute(command.cwd) ||
    command.cwd.includes("\0") ||
    path.dirname(commandPath) !== path.join(path.dirname(policyPath), "commands")
  ) {
    throw new Error("invalid command identity");
  }
  if (
    !Array.isArray(command.args) ||
    command.args.length > MAX_ARGUMENTS ||
    command.args.some(
      (arg) => typeof arg !== "string" || arg.includes("\0"),
    ) ||
    command.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) >
      MAX_ARGUMENT_BYTES
  ) {
    throw new Error("command args must be bounded strings");
  }
  if (
    !command.env ||
    typeof command.env !== "object" ||
    Array.isArray(command.env)
  ) {
    throw new Error("command env must be a complete environment object");
  }
  const entries = Object.entries(command.env);
  if (
    entries.length > MAX_ENV_ENTRIES ||
    entries.reduce(
      (total, [name, value]) =>
        total +
        Buffer.byteLength(name) +
        (typeof value === "string" ? Buffer.byteLength(value) : 0),
      0,
    ) > MAX_ENV_BYTES
  ) {
    throw new Error("command environment is too large");
  }
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw new Error("command environment contains an invalid entry");
    }
  }
  const gitDispatchConfig = command.env[GIT_DISPATCH_CONFIG_ENV];
  if (
    gitDispatchConfig !== undefined &&
    gitDispatchConfig !==
      path.join(path.dirname(policyPath), "tools", "git-dispatch.conf")
  ) {
    throw new Error("Git dispatcher configuration is invalid");
  }
  requireAbsolutePaths(
    command.deniedContainerSockets,
    "deniedContainerSockets",
  );
  if (
    command.deniedContainerSockets.length > 64 ||
    new Set(command.deniedContainerSockets).size !==
      command.deniedContainerSockets.length ||
    command.deniedContainerSockets.some((socket) =>
      policy.runtime.allowedUnixSockets.includes(socket),
    )
  ) {
    throw new Error("container socket subtraction is invalid");
  }
  validateContainerWorker(command, policy, policyPath);
}

function executableOnPath(name) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Continue searching the engine-authored supervisor PATH.
    }
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function trustedRootExecutable(file, label) {
  if (!file || !path.isAbsolute(file) || file.includes("\0")) {
    throw new Error(`${label} must be an absolute executable`);
  }
  const canonical = realpathSync(file);
  const stat = lstatSync(canonical);
  if (
    canonical !== file ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0
  ) {
    throw new Error(`${label} must be a root-owned non-writable executable`);
  }
  return canonical;
}

function linuxHelpers(policyRoot, cloudWorker) {
  if (process.platform !== "linux") return {};
  const bwrap = process.env.ZEROS_ZSR_BWRAP_PATH || executableOnPath("bwrap");
  if (!bwrap || !path.isAbsolute(bwrap)) {
    throw new Error("absolute bwrap unavailable");
  }
  if (cloudWorker) {
    const setpriv =
      process.env.ZEROS_ZSR_SETPRIV_PATH || executableOnPath("setpriv");
    return {
      bwrapPath: trustedRootExecutable(bwrap, "cloud-worker bwrap"),
      linuxPrivilegedWorker: {
        uid: cloudWorker.uid,
        gid: cloudWorker.gid,
        setprivPath: trustedRootExecutable(setpriv, "cloud-worker setpriv"),
      },
    };
  }
  const capEff = readFileSync("/proc/self/status", "utf8").match(
    /^CapEff:\s+(.+)$/m,
  )?.[1];
  if (!capEff || /^0+$/.test(capEff)) return { bwrapPath: bwrap };
  const setpriv =
    process.env.ZEROS_ZSR_SETPRIV_PATH || executableOnPath("setpriv");
  if (!setpriv || !path.isAbsolute(setpriv)) {
    throw new Error("setpriv unavailable for ambient-capability repair");
  }
  const wrapper = path.join(
    policyRoot,
    `bwrap-drop-capabilities-${process.pid}-${randomUUID()}`,
  );
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(setpriv)} --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all ${shellQuote(bwrap)} "$@"\n`,
    { encoding: "utf8", mode: 0o700, flag: "wx" },
  );
  chmodSync(wrapper, 0o700);
  return { bwrapPath: wrapper };
}

function completeConfig(policy, policyPath, commandPath, command) {
  const ripgrep =
    process.env.ZEROS_ZSR_RIPGREP_PATH ||
    executableOnPath(process.platform === "win32" ? "rg.exe" : "rg");
  if (!ripgrep) {
    throw new Error("absolute ripgrep unavailable");
  }
  return {
    hostParity: true,
    filesystem: {
      denyRead: [
        ...policy.filesystem.denyRead,
        ...command.deniedContainerSockets,
        policyPath,
        commandPath,
      ],
      allowRead: policy.filesystem.allowRead,
      allowWrite: policy.filesystem.allowWrite,
      denyWrite: [...policy.filesystem.denyWrite, policyPath, commandPath],
      allowWriteWithinDeny: [policyPath, commandPath].reduce(
        (allowed, protectedPath) =>
          allowed.filter(
            (candidate) => !pathInsideOrEqual(protectedPath, candidate),
          ),
        policy.filesystem.allowWrite.filter((candidate) =>
          policy.filesystem.denyWrite.some(
            (denied) =>
              pathInsideOrEqual(candidate, denied) && candidate !== denied,
          ),
        ),
      ),
      allowGitConfig: true,
      disableMandatoryWriteProtection: true,
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowAllUnixSockets: true,
      allowLocalBinding: true,
    },
    allowPty: true,
    ripgrep: {
      command: canonicalExecutable(ripgrep, "ripgrep"),
    },
    // The reviewed SRT patch turns this into explicit deny rules in the single
    // host-parity Seatbelt profile. Do not add a nested sandbox-exec here:
    // hosted macOS rejects applying it after the outer profile is active.
    allowAppleEvents: false,
    ...linuxHelpers(path.dirname(policyPath), policy.runtime.cloudWorker),
  };
}

function scrubSupervisorEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(INTERNAL_ENV_PREFIX)) delete process.env[name];
  }
}

function containedTarget(command) {
  const environment = Object.entries(command.env)
    .filter(
      ([name]) =>
        !name.startsWith(INTERNAL_ENV_PREFIX) ||
        name === GIT_DISPATCH_CONFIG_ENV,
    )
    .map(([name, value]) => `${name}=${value}`);
  const exact = ["/usr/bin/env", "-i", ...environment]
    .map(shellQuote)
    .join(" ");
  const targetArgv = command.containerWorker
    ? [
        command.containerWorker.node,
        command.containerWorker.launcher,
        "--engine",
        command.containerWorker.engine,
        "--state",
        command.containerWorker.state,
        "--socket",
        command.containerWorker.socket,
        "--",
        command.command,
        ...command.args,
      ]
    : [command.command, ...command.args];
  // Platform-specific restrictions belong to SRT's single generated profile.
  // Applying a second sandbox-exec here can be rejected after the outer macOS
  // Seatbelt profile is active.
  return `${exact} ${targetArgv.map(shellQuote).join(" ")}`;
}

async function cleanupSandboxRuntime(sandboxManager) {
  let failed = false;
  try {
    sandboxManager.cleanupAfterCommand();
  } catch {
    failed = true;
  }
  try {
    await sandboxManager.reset();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("sandbox runtime cleanup failed");
}

async function runWrappedCommand(wrapped, command, sandboxManager) {
  for (const name of Object.keys(wrapped.env)) {
    if (name.startsWith(INTERNAL_ENV_PREFIX)) delete wrapped.env[name];
  }
  const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: command.cwd,
    env: wrapped.env,
    stdio: "inherit",
  });
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping && signal !== "SIGKILL") return;
    stopping = true;
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => stop(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const originalParent = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid === originalParent) return;
    if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
    else stop("SIGKILL");
  }, 250);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearInterval(parentWatch);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    await cleanupSandboxRuntime(sandboxManager);
  }
}

async function run() {
  const policyIndex = process.argv.indexOf("--policy");
  const commandIndex = process.argv.indexOf("--command");
  const policyPath =
    policyIndex >= 0 ? process.argv[policyIndex + 1] : undefined;
  const commandPath =
    commandIndex >= 0 ? process.argv[commandIndex + 1] : undefined;
  if (!policyPath || !commandPath) {
    throw new Error("missing policy/command descriptor");
  }
  const policy = readJson(policyPath, "policy");
  const command = readJson(commandPath, "command");
  validatePolicy(policy);
  validateCommand(command, policy, policyPath, commandPath);
  const config = completeConfig(policy, policyPath, commandPath, command);
  unlinkSync(commandPath);
  scrubSupervisorEnvironment();

  const { SandboxManager, SandboxRuntimeConfigSchema } =
    await import("@anthropic-ai/sandbox-runtime");
  const parsedConfig = SandboxRuntimeConfigSchema.safeParse(config);
  if (!parsedConfig.success) {
    throw new Error("generated sandbox configuration is invalid");
  }
  await SandboxManager.initialize(parsedConfig.data, undefined, true);
  let wrapped;
  try {
    wrapped = await SandboxManager.wrapWithSandboxArgv(
      containedTarget(command),
      undefined,
      undefined,
      undefined,
      command.cwd,
      { commandId: `${policy.actor}:${policy.executionId}` },
    );
  } catch (error) {
    await cleanupSandboxRuntime(SandboxManager).catch(() => undefined);
    throw error;
  }
  const exit = await runWrappedCommand(wrapped, command, SandboxManager);
  if (typeof exit.code === "number") process.exitCode = exit.code;
  else if (exit.signal) process.exitCode = 128;
}

await run().catch((error) => {
  // Never serialize the policy or environment: both may include sensitive
  // provider paths or values.
  fail(error instanceof Error ? error.message.slice(0, 1_000) : String(error));
});
