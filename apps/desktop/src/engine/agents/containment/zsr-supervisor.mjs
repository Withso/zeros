#!/usr/bin/env node

import { randomUUID, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import * as tls from "node:tls";

import {
  ZSR_RESOURCE_LIMITS,
  resourceLimitShell,
} from "./zsr-resource-limits.mjs";
import {
  createZsrCgroupScope,
  killAndRemoveZsrCgroup,
  wrapWithZsrCgroup,
} from "./zsr-cgroup.mjs";
import { startZsrPortPolicyControl } from "./zsr-port-policy-control.mjs";
import { withZsrRuntimeCleanup } from "./zsr-runtime-cleanup.mjs";
import {
  credentialInjectionAuthorities,
  schemaIssueSummary,
} from "./zsr-credential-authority.mjs";

const POLICY_VERSION = 1;
const COMMAND_VERSION = 5;
const PORT_POLICY_KEYS = [
  "bindPorts",
  "generation",
  "initialPorts",
  "socketPath",
  "token",
  "version",
];
const INTERNAL_ENV_PREFIX = "ZEROS_ZSR_";
const MAX_ENV_ENTRIES = 8_192;
const MAX_CREDENTIALS = 16;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const PROVIDER_CREDENTIAL_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CURSOR_API_KEY",
]);
const CA_TRUST_VARS = [
  "CODEX_CA_CERTIFICATE",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
  "NIX_SSL_CERT_FILE",
  "NPM_CONFIG_CAFILE",
  "npm_config_cafile",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
];
const MAX_CA_INPUT_FILES = 16;
const MAX_CA_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CA_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_CA_CERTIFICATES = 1_024;
const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const SRT_CHILD_ENV = [
  "SANDBOX_RUNTIME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GRPC_PROXY",
  "grpc_proxy",
  "FTP_PROXY",
  "ftp_proxy",
  "RSYNC_PROXY",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "CLOUDSDK_PROXY_USERNAME",
  "CLOUDSDK_PROXY_PASSWORD",
  "GIT_CONFIG_PARAMETERS",
];

function validCredentialAuthority(authority) {
  if (typeof authority !== "string" || authority.includes("\0")) return false;
  let hostname;
  let portText;
  if (authority.startsWith("[")) {
    const match = /^\[([^\]]+)\]:([1-9][0-9]{0,4})$/.exec(authority);
    if (!match || isIP(match[1]) !== 6) return false;
    hostname = match[1];
    portText = match[2];
  } else {
    const match =
      /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):([1-9][0-9]{0,4})$/.exec(
        authority,
      );
    if (!match) return false;
    hostname = match[1];
    portText = match[2];
  }
  const port = Number(portText);
  return (
    port <= 65535 &&
    hostname === hostname.toLowerCase() &&
    !hostname.includes("*") &&
    !hostname.endsWith(".") &&
    (isIP(hostname) !== 0 ||
      hostname.split(".").every((part) => part.length > 0 && part.length <= 63))
  );
}

function fail(message) {
  process.stderr.write(`[zsr-supervisor] ${message}\n`);
  process.exitCode = 125;
}

function readJson(file, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} descriptor must be one regular, unlinked file`);
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
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireAbsolutePaths(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => !path.isAbsolute(value))
  ) {
    throw new Error(`${label} must contain only absolute paths`);
  }
}

function validatePolicy(policy) {
  if (!policy || policy.version !== POLICY_VERSION) {
    throw new Error("unsupported policy version");
  }
  if (!path.isAbsolute(policy.cwd) || !path.isAbsolute(policy.workspaceRoot)) {
    throw new Error("policy cwd/workspace root must be absolute");
  }
  requireAbsolutePaths(policy.filesystem?.allowRead, "allowRead");
  requireAbsolutePaths(policy.filesystem?.allowWrite, "allowWrite");
  requireAbsolutePaths(policy.filesystem?.denyWrite, "denyWrite");
  requireAbsolutePaths(policy.filesystem?.denyRead, "denyRead");
  requireAbsolutePaths(
    policy.runtime?.allowedUnixSockets,
    "allowedUnixSockets",
  );
  if (policy.runtime.allowedUnixSockets.length > 64) {
    throw new Error("too many admitted Unix sockets");
  }
  if (
    process.platform === "linux" &&
    policy.runtime.allowedUnixSockets.length > 0 &&
    !policy.filesystem.denyRead.includes(path.parse(policy.workspaceRoot).root)
  ) {
    throw new Error("Linux Unix sockets require root read isolation");
  }
  if (policy.runtime?.normalNetwork !== true) {
    throw new Error("unsupported network policy");
  }
  if (
    policy.runtime.localHostParity !== undefined &&
    policy.runtime.localHostParity !== true
  ) {
    throw new Error("invalid local host-parity policy");
  }
  if (
    !Array.isArray(policy.runtime.deniedLocalPorts) ||
    policy.runtime.deniedLocalPorts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65535,
    )
  ) {
    throw new Error("invalid denied local port policy");
  }
  if (
    !Array.isArray(policy.runtime.allowedLocalPorts) ||
    policy.runtime.allowedLocalPorts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65535,
    )
  ) {
    throw new Error("invalid allowed local port policy");
  }
  const cloudWorker = policy.runtime.cloudWorker;
  if (cloudWorker !== undefined && policy.runtime.localHostParity) {
    throw new Error("cloud workers cannot use local host parity");
  }
  if (cloudWorker !== undefined) {
    const expectedCloudKeys = [
      "cgroupParent",
      "gid",
      "resources",
      "uid",
      "version",
    ];
    const expectedResourceKeys = [
      "cpuPeriodMicros",
      "cpuQuotaMicros",
      "memoryBytes",
      "processes",
    ];
    const resourceContract = {
      memoryBytes: ZSR_RESOURCE_LIMITS.memoryBytes,
      cpuQuotaMicros: ZSR_RESOURCE_LIMITS.cpuQuotaMicros,
      cpuPeriodMicros: ZSR_RESOURCE_LIMITS.cpuPeriodMicros,
      processes: ZSR_RESOURCE_LIMITS.processes,
    };
    if (
      process.platform !== "linux" ||
      !cloudWorker ||
      Object.keys(cloudWorker).sort().join("\0") !==
        expectedCloudKeys.join("\0") ||
      cloudWorker.version !== 1 ||
      !Number.isInteger(cloudWorker.uid) ||
      cloudWorker.uid <= 0 ||
      cloudWorker.uid > 2_147_483_647 ||
      !Number.isInteger(cloudWorker.gid) ||
      cloudWorker.gid <= 0 ||
      cloudWorker.gid > 2_147_483_647 ||
      typeof cloudWorker.cgroupParent !== "string" ||
      !path.isAbsolute(cloudWorker.cgroupParent) ||
      cloudWorker.cgroupParent.includes("\0") ||
      path.relative("/sys/fs/cgroup", cloudWorker.cgroupParent) === "" ||
      path.relative("/sys/fs/cgroup", cloudWorker.cgroupParent) === ".." ||
      path
        .relative("/sys/fs/cgroup", cloudWorker.cgroupParent)
        .startsWith(`..${path.sep}`) ||
      !cloudWorker.resources ||
      typeof cloudWorker.resources !== "object" ||
      Array.isArray(cloudWorker.resources) ||
      Object.keys(cloudWorker.resources).sort().join("\0") !==
        expectedResourceKeys.join("\0") ||
      expectedResourceKeys.some(
        (name) => cloudWorker.resources[name] !== resourceContract[name],
      ) ||
      typeof process.geteuid !== "function" ||
      process.geteuid() !== 0 ||
      !policy.filesystem.denyRead.includes(
        path.parse(policy.workspaceRoot).root,
      )
    ) {
      throw new Error("invalid privileged cloud-worker policy");
    }
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

function validateFilesystemProjections(command, policy, policyPath) {
  const mounts = command.filesystemProjections;
  if (mounts === undefined) return;
  if (process.platform !== "linux") {
    throw new Error("filesystem projections require the Linux bwrap backend");
  }
  if (!Array.isArray(mounts) || mounts.length < 1 || mounts.length > 33) {
    throw new Error("Git filesystem projections must be non-empty and bounded");
  }
  const policyRoot = path.dirname(policyPath);
  const privateGitRoot = path.join(policyRoot, "git");
  const privateGitToolsRoot = path.join(
    policyRoot,
    "tools",
    "git-repositories",
  );
  const sources = new Set();
  const destinations = new Set();
  for (const mount of mounts) {
    if (
      !mount ||
      typeof mount !== "object" ||
      Array.isArray(mount) ||
      typeof mount.source !== "string" ||
      typeof mount.destination !== "string" ||
      typeof mount.readOnly !== "boolean" ||
      !path.isAbsolute(mount.source) ||
      !path.isAbsolute(mount.destination) ||
      mount.source.includes("\0") ||
      mount.destination.includes("\0") ||
      sources.has(mount.source) ||
      destinations.has(mount.destination)
    ) {
      throw new Error("invalid or duplicate Git filesystem projection");
    }
    sources.add(mount.source);
    destinations.add(mount.destination);
    if (
      path.basename(mount.destination) !== ".git" ||
      !policy.filesystem.denyRead.includes(mount.destination) ||
      !policy.filesystem.denyWrite.includes(mount.destination) ||
      !policy.filesystem.allowWrite.some((allowed) =>
        pathInsideOrEqual(mount.destination, allowed),
      )
    ) {
      throw new Error(
        "Git projection destination is outside an exact denied control path",
      );
    }
    const directorySource = pathInsideOrEqual(mount.source, privateGitRoot);
    const fileSource = pathInsideOrEqual(mount.source, privateGitToolsRoot);
    if (
      (!mount.readOnly && !directorySource) ||
      (mount.readOnly && !fileSource)
    ) {
      throw new Error("Git projection source is outside private session state");
    }
    const sourceStat = lstatSync(mount.source);
    const destinationStat = lstatSync(mount.destination);
    if (
      sourceStat.isSymbolicLink() ||
      destinationStat.isSymbolicLink() ||
      (sourceStat.isFile() && sourceStat.nlink !== 1) ||
      realpathSync(mount.source) !== mount.source ||
      realpathSync(mount.destination) !== mount.destination
    ) {
      throw new Error(
        "Git projection paths must be canonical physical entries",
      );
    }
    if (
      typeof process.getuid === "function" &&
      sourceStat.uid !== process.getuid()
    ) {
      throw new Error("Git projection source has the wrong owner");
    }
    if ((sourceStat.mode & 0o077) !== 0) {
      throw new Error("Git projection source permissions are too broad");
    }
    if (!mount.readOnly) {
      if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) {
        throw new Error("invalid writable Git directory projection");
      }
    } else if (!sourceStat.isFile() || !destinationStat.isFile()) {
      throw new Error("invalid read-only Git worktree projection");
    }
  }
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
    (launcherStat.mode & 0o111) === 0
  ) {
    throw new Error("container-worker launcher is not immutable");
  }
  if (
    typeof process.getuid === "function" &&
    launcherStat.uid !== process.getuid()
  ) {
    // The launcher is created by the trusted supervisor identity. In the
    // privileged cloud profile that identity is root; only durable worker
    // state is handed to the non-root execution uid.
    throw new Error("container-worker launcher has the wrong owner");
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
  const expectedSocket = path.join(worker.state, "podman.sock");
  if (
    worker.socket !== expectedSocket ||
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

function validateCommand(command, generation, policy, policyPath) {
  if (!command || command.version !== COMMAND_VERSION) {
    throw new Error("unsupported command version");
  }
  const allowedCommandKeys = new Set([
    "args",
    "command",
    "containerWorker",
    "credentialCapabilities",
    "cwd",
    "env",
    "filesystemProjections",
    "generation",
    "internalProxyPorts",
    "networkBridge",
    "portPolicy",
    "version",
  ]);
  if (Object.keys(command).some((name) => !allowedCommandKeys.has(name))) {
    throw new Error("command descriptor contains an unsupported field");
  }
  if (command.generation !== generation)
    throw new Error("stale territory generation");
  if (!path.isAbsolute(command.command) || !path.isAbsolute(command.cwd)) {
    throw new Error("command and cwd must be absolute");
  }
  validateContainerWorker(command, policy, policyPath);
  if (
    !Array.isArray(command.args) ||
    command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("command args must be strings");
  }
  if (
    !command.env ||
    typeof command.env !== "object" ||
    Array.isArray(command.env)
  ) {
    throw new Error("command env must be a complete environment object");
  }
  const entries = Object.entries(command.env);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new Error("command environment contains too many entries");
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("command environment contains an invalid name");
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error("command environment contains an invalid value");
    }
  }
  if (command.credentialCapabilities !== undefined) {
    if (
      !Array.isArray(command.credentialCapabilities) ||
      command.credentialCapabilities.length < 1 ||
      command.credentialCapabilities.length > MAX_CREDENTIALS
    ) {
      throw new Error("invalid provider credential capabilities");
    }
    const names = new Set();
    for (const capability of command.credentialCapabilities) {
      if (
        !capability ||
        typeof capability !== "object" ||
        Array.isArray(capability) ||
        !PROVIDER_CREDENTIAL_NAMES.has(capability.name) ||
        names.has(capability.name) ||
        (capability.allowPlaintext !== true &&
          capability.allowPlaintext !== false) ||
        !Array.isArray(capability.injectAuthorities) ||
        capability.injectAuthorities.length < 1 ||
        capability.injectAuthorities.length > 8 ||
        new Set(capability.injectAuthorities).size !==
          capability.injectAuthorities.length ||
        capability.injectAuthorities.some(
          (authority) => !validCredentialAuthority(authority),
        )
      ) {
        throw new Error("invalid provider credential capability");
      }
      const value = command.env[capability.name];
      if (
        typeof value !== "string" ||
        value.trim() === "" ||
        Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES
      ) {
        throw new Error("provider credential capability has no bounded value");
      }
      names.add(capability.name);
    }
  }
  if (command.networkBridge !== undefined) {
    const bridge = command.networkBridge;
    if (
      process.platform !== "linux" ||
      !bridge ||
      bridge.version !== 1 ||
      bridge.generation !== generation ||
      typeof bridge.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(bridge.token)
    ) {
      throw new Error("invalid network bridge descriptor");
    }
    for (const name of [
      "reverseSocketPath",
      "runtime",
      "script",
      "descriptor",
    ]) {
      if (
        typeof bridge[name] !== "string" ||
        !path.isAbsolute(bridge[name]) ||
        bridge[name].includes("\0")
      ) {
        throw new Error("invalid network bridge path");
      }
    }
  }
  const portPolicy = command.portPolicy;
  let invalidPortPolicy;
  if (
    !portPolicy ||
    typeof portPolicy !== "object" ||
    Array.isArray(portPolicy) ||
    Object.keys(portPolicy).sort().join("\0") !== PORT_POLICY_KEYS.join("\0")
  )
    invalidPortPolicy = "fields";
  else if (portPolicy.version !== 1) invalidPortPolicy = "version";
  else if (portPolicy.generation !== generation)
    invalidPortPolicy = "generation";
  else if (
    typeof portPolicy.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(portPolicy.token)
  )
    invalidPortPolicy = "token";
  else if (
    typeof portPolicy.socketPath !== "string" ||
    !path.isAbsolute(portPolicy.socketPath) ||
    portPolicy.socketPath.includes("\0")
  )
    invalidPortPolicy = "socket";
  else if (
    !Array.isArray(portPolicy.initialPorts) ||
    portPolicy.initialPorts.length > 256 ||
    portPolicy.initialPorts.some(
      (port, index) =>
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        (index > 0 && portPolicy.initialPorts[index - 1] >= port) ||
        policy.runtime.deniedLocalPorts.includes(port),
    )
  )
    invalidPortPolicy = "ports";
  else if (
    !Array.isArray(portPolicy.bindPorts) ||
    portPolicy.bindPorts.length > 256 ||
    portPolicy.bindPorts.some(
      (port, index) =>
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        (index > 0 && portPolicy.bindPorts[index - 1] >= port) ||
        policy.runtime.deniedLocalPorts.includes(port) ||
        policy.runtime.allowedLocalPorts.includes(port),
    ) ||
    (process.platform !== "darwin" && portPolicy.bindPorts.length > 0)
  )
    invalidPortPolicy = "bind-ports";
  else if (
    command.networkBridge &&
    portPolicy.token !== command.networkBridge.token
  )
    invalidPortPolicy = "bridge-token";
  if (invalidPortPolicy) {
    throw new Error(
      `invalid dynamic port-policy descriptor (${invalidPortPolicy})`,
    );
  }
  if (
    !command.internalProxyPorts ||
    !Number.isInteger(command.internalProxyPorts.http) ||
    !Number.isInteger(command.internalProxyPorts.socks) ||
    command.internalProxyPorts.http < 1024 ||
    command.internalProxyPorts.http > 65535 ||
    command.internalProxyPorts.socks < 1024 ||
    command.internalProxyPorts.socks > 65535 ||
    command.internalProxyPorts.http === command.internalProxyPorts.socks ||
    portPolicy.bindPorts.includes(command.internalProxyPorts.http) ||
    portPolicy.bindPorts.includes(command.internalProxyPorts.socks)
  ) {
    throw new Error("invalid internal proxy ports");
  }
  validateFilesystemProjections(command, policy, policyPath);
}

function executableOnPath(name) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Continue searching.
    }
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/** Snapshot user-configured PEM trust files before untrusted code starts.
 *
 * SRT's proxy is the TLS client for terminated provider connections, while
 * NODE_EXTRA_CA_CERTS is read only when Node starts. Feeding a sanitized,
 * immutable snapshot into tlsTerminate.extraCaCertPaths preserves corporate
 * and private gateway trust without exposing a combined cert+private-key file
 * to the child or accepting a workspace file that can change after admission.
 */
function snapshotCaTrust(command, policyPath) {
  const configured = CA_TRUST_VARS.flatMap((name) => {
    const value = command.env[name]?.trim();
    return value ? [{ name, value }] : [];
  });
  if (configured.length > MAX_CA_INPUT_FILES) {
    throw new Error("too many configured CA trust files");
  }

  const files = new Map();
  for (const { name, value } of configured) {
    let canonical;
    try {
      canonical = realpathSync(
        path.isAbsolute(value) ? value : path.resolve(command.cwd, value),
      );
    } catch {
      throw new Error(`configured CA trust file from ${name} is unavailable`);
    }
    if (!files.has(canonical)) files.set(canonical, name);
  }
  if (files.size > MAX_CA_INPUT_FILES) {
    throw new Error("too many distinct configured CA trust files");
  }

  let totalBytes = 0;
  const certificates = new Map();
  const systemRoots = [...tls.rootCertificates];
  if (typeof tls.getCACertificates === "function") {
    try {
      systemRoots.push(...tls.getCACertificates("system"));
    } catch {
      // Older/embedded Node runtimes may not expose an OS root snapshot. The
      // bundled Mozilla roots remain a safe baseline; configured site-local
      // roots are still appended below.
    }
  }
  for (const block of systemRoots) {
    const certificate = new X509Certificate(block);
    certificates.set(certificate.fingerprint256, block.trim());
    if (certificates.size > MAX_CA_CERTIFICATES) {
      throw new Error("system CA trust exceeds its bounded certificate quota");
    }
  }
  for (const [file, name] of files) {
    let descriptor;
    try {
      descriptor = openSync(
        file,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_CA_FILE_BYTES) {
        throw new Error("not a bounded regular file");
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_CA_TOTAL_BYTES) {
        throw new Error("aggregate CA trust input is too large");
      }
      const pem = readFileSync(descriptor, "utf8");
      const blocks = pem.match(PEM_CERTIFICATE);
      if (!blocks?.length) throw new Error("contains no PEM certificate");
      for (const block of blocks) {
        let certificate;
        try {
          certificate = new X509Certificate(block);
        } catch {
          throw new Error("contains an invalid PEM certificate");
        }
        certificates.set(certificate.fingerprint256, block.trim());
        if (certificates.size > MAX_CA_CERTIFICATES) {
          throw new Error("contains too many certificates");
        }
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "cannot be read safely";
      throw new Error(`configured CA trust file from ${name} ${reason}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  const snapshot = path.join(
    path.dirname(policyPath),
    "tools",
    `provider-ca-${process.pid}-${randomUUID()}.pem`,
  );
  writeFileSync(snapshot, `${[...certificates.values()].join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    path: snapshot,
    sourceNames: configured.map(({ name }) => name),
    dispose() {
      try {
        unlinkSync(snapshot);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

function trustedRootExecutable(file, label) {
  if (!file || !path.isAbsolute(file)) {
    throw new Error(`${label} must be an absolute executable`);
  }
  const canonical = realpathSync(file);
  const stat = lstatSync(canonical);
  if (
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
  const socat = process.env.ZEROS_ZSR_SOCAT_PATH || executableOnPath("socat");
  if (!bwrap || !path.isAbsolute(bwrap))
    throw new Error("absolute bwrap unavailable");
  if (!socat || !path.isAbsolute(socat))
    throw new Error("absolute socat unavailable");

  if (cloudWorker) {
    const setpriv =
      process.env.ZEROS_ZSR_SETPRIV_PATH || executableOnPath("setpriv");
    return {
      bwrapPath: trustedRootExecutable(bwrap, "cloud-worker bwrap"),
      socatPath: trustedRootExecutable(socat, "cloud-worker socat"),
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
  if (!capEff || /^0+$/.test(capEff))
    return { bwrapPath: bwrap, socatPath: socat };
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
  return { bwrapPath: wrapper, socatPath: socat };
}

function completeConfig(
  policy,
  policyPath,
  commandPath,
  command,
  extraCaCertPath,
) {
  const helpers = linuxHelpers(
    path.dirname(policyPath),
    policy.runtime.cloudWorker,
  );
  const localHostParity = policy.runtime.localHostParity === true;
  const seccompPath = localHostParity
    ? undefined
    : process.env.ZEROS_ZSR_SECCOMP_PATH;
  const deniedDomains = [
    // Cloud metadata/link-local credentials are never part of ordinary
    // internet parity. Numeric aliases are canonicalized by SRT before match.
    "169.254.169.254",
    "metadata.google.internal",
    "100.100.100.200",
    ...policy.runtime.deniedLocalPorts.flatMap((port) => [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
    ]),
  ];
  const credentials = localHostParity
    ? undefined
    : command.credentialCapabilities?.map((capability) => ({
        name: capability.name,
        mode: "mask",
        injectHosts: credentialInjectionAuthorities(
          capability.injectAuthorities,
        ),
        ...(capability.allowPlaintext ? { allowPlaintextInject: true } : {}),
      }));
  const credentialAuthorities = [
    ...new Set(
      command.credentialCapabilities?.flatMap(
        (capability) => capability.injectAuthorities,
      ) ?? [],
    ),
  ];
  return {
    ...(localHostParity ? { hostParity: true } : {}),
    filesystem: {
      denyRead: [...policy.filesystem.denyRead, policyPath, commandPath],
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
      ...(command.filesystemProjections
        ? { bindMounts: command.filesystemProjections }
        : {}),
    },
    network: localHostParity
      ? {
          disabled: true,
          allowedDomains: [],
          deniedDomains: [],
          allowedLocalPorts: [],
          allowedBindPorts: [],
          allowAllUnixSockets: true,
          allowLocalBinding: true,
        }
      : {
          allowedDomains: ["*"],
          deniedDomains,
          allowedLocalPorts: [
            ...new Set([
              ...policy.runtime.allowedLocalPorts,
              ...command.portPolicy.initialPorts,
              ...command.portPolicy.bindPorts,
            ]),
          ].sort((left, right) => left - right),
          allowedBindPorts: [...command.portPolicy.bindPorts],
          strictAllowlist: true,
          // macOS can filter by exact pathname. Linux's seccomp switch is global,
          // so policy validation requires a root read allowlist before AF_UNIX is
          // enabled; only generation-private façade paths remain visible.
          ...(process.platform === "darwin"
            ? {
                allowUnixSockets: policy.runtime.allowedUnixSockets,
                allowAllUnixSockets: false,
              }
            : {
                allowAllUnixSockets:
                  Boolean(policy.runtime.cloudWorker) ||
                  policy.runtime.allowedUnixSockets.length > 0,
              }),
          allowLocalBinding: process.platform !== "darwin",
          ...(credentialAuthorities.length > 0
            ? {
                tlsTerminate: {
                  includeDomains: credentialAuthorities,
                  ...(extraCaCertPath
                    ? { extraCaCertPaths: [extraCaCertPath] }
                    : {}),
                },
              }
            : {}),
        },
    ...(credentials?.length ? { credentials: { envVars: credentials } } : {}),
    allowPty: policy.runtime.allowPty,
    ...(localHostParity
      ? { allowAppleEvents: true }
      : { git: { safeDirectories: [policy.workspaceRoot] } }),
    ...helpers,
    ...(seccompPath ? { seccomp: { applyPath: seccompPath } } : {}),
  };
}

function scrubSupervisorEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(INTERNAL_ENV_PREFIX)) delete process.env[name];
  }
}

function installSrtPolicyEnvironment(command, policy) {
  const bridge = command.networkBridge;
  const values = {
    ...(policy.runtime.localHostParity
      ? {}
      : { ZEROS_ZSR_DENY_SECURITY_SERVER: "1" }),
    ZEROS_ZSR_INTERNAL_HTTP_PORT: String(command.internalProxyPorts.http),
    ZEROS_ZSR_INTERNAL_SOCKS_PORT: String(command.internalProxyPorts.socks),
    ...(bridge
      ? {
          ZEROS_ZSR_NETWORK_BRIDGE: "1",
          ZEROS_ZSR_NETWORK_BRIDGE_RUNTIME: bridge.runtime,
          ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: bridge.script,
          ZEROS_ZSR_NETWORK_BRIDGE_DESCRIPTOR: bridge.descriptor,
          ZEROS_ZSR_NETWORK_BRIDGE_SOCKET: bridge.reverseSocketPath,
        }
      : {}),
  };
  Object.assign(process.env, values);
  return () => {
    for (const name of Object.keys(values)) delete process.env[name];
  };
}

function installProviderCredentialEnvironment(command) {
  const installed = new Map();
  for (const capability of command.credentialCapabilities ?? []) {
    const value = command.env[capability.name];
    installed.set(capability.name, value);
    delete command.env[capability.name];
    process.env[capability.name] = value;
  }
  return {
    values: installed,
    clear() {
      for (const name of installed.keys()) delete process.env[name];
    },
  };
}

function assertNoRawCredentialInWrapper(wrapped, credentials) {
  for (const [name, real] of credentials) {
    const leakedInArgv = wrapped.argv.some((argument) =>
      real.length >= 8
        ? argument.includes(real)
        : argument.includes(`${name}=${real}`),
    );
    if (
      leakedInArgv ||
      wrapped.env[name] === real ||
      Object.values(wrapped.env).some((value) => value === real)
    ) {
      throw new Error(
        `sandbox wrapper retained raw provider credential ${name}`,
      );
    }
  }
}

/** Build a shell command whose environment is created only after the OS
 * sandbox has taken effect. The supervisor and SRT's outer bash/bwrap or
 * sandbox-exec bootstrap keep their small, engine-authored environment, so a
 * child LD_PRELOAD, DYLD_*, BASH_ENV, NODE_OPTIONS, or PATH value cannot run
 * code before containment. `env -i` also makes the supplied child environment
 * authoritative instead of ambient-merging it back in. */
function containedTarget(command, localHostParity = false) {
  const environment = Object.entries(command.env).map(([name, value]) => {
    // Rendering is interpolation, so a non-string that reached this map would
    // become a plausible-looking literal (`undefined`, `null`, `[object
    // Object]`) in the child environment rather than an error. validateCommand()
    // proves this for the descriptor as it arrived; re-prove it here because the
    // CA-trust rewrite between the two once broke exactly this invariant, and a
    // silently mistyped TLS/proxy variable fails as an unattributable
    // certificate error inside the session.
    if (typeof value !== "string") {
      throw new Error("child environment value is not a string");
    }
    return `${name}=${value}`;
  });
  const exact = ["/usr/bin/env", "-i", ...environment]
    .map(shellQuote)
    .join(" ");
  // SRT installs its authenticated proxy and CA environment only after the OS
  // boundary is active. Preserve that narrow runtime-owned set across env -i;
  // never merge arbitrary supervisor/host variables back into the provider.
  // Local/private HTTP requests intentionally use the authenticated proxy so
  // its exact loopback/metadata policy applies instead of bypassing it.
  const hasCredentialCapabilities = Boolean(
    command.credentialCapabilities?.length,
  );
  const runtimeNames = hasCredentialCapabilities
    ? [...SRT_CHILD_ENV, ...CA_TRUST_VARS]
    : SRT_CHILD_ENV;
  const runtime = [
    ...runtimeNames.map((name) => `${name}="\${${name}-}"`),
    ...(hasCredentialCapabilities
      ? ['CODEX_CA_CERTIFICATE="${SSL_CERT_FILE-}"']
      : []),
  ].join(" ");
  const credentials = (command.credentialCapabilities ?? [])
    .map(({ name }) => `${name}="\${${name}-}"`)
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
  const argv = targetArgv.map(shellQuote).join(" ");
  if (localHostParity) return `${exact} ${argv}`;
  return `${resourceLimitShell()}${exact} ${runtime} ${credentials} NO_PROXY='' no_proxy='' ${argv}`;
}

async function run() {
  const policyIndex = process.argv.indexOf("--policy");
  const commandIndex = process.argv.indexOf("--command");
  const policyPath =
    policyIndex >= 0 ? process.argv[policyIndex + 1] : undefined;
  const commandPath =
    commandIndex >= 0 ? process.argv[commandIndex + 1] : undefined;
  if (!policyPath || !commandPath)
    throw new Error("missing policy/command descriptor");
  const policy = readJson(policyPath, "policy");
  const command = readJson(commandPath, "command");
  validatePolicy(policy);
  validateCommand(command, policy.generation, policy, policyPath);
  const localHostParity = policy.runtime.localHostParity === true;
  const caSnapshot = localHostParity
    ? { path: undefined, sourceNames: [], dispose() {} }
    : snapshotCaTrust(command, policyPath);
  let config;
  try {
    config = completeConfig(
      policy,
      policyPath,
      commandPath,
      command,
      caSnapshot.path,
    );
  } catch (error) {
    caSnapshot.dispose();
    throw error;
  }
  // Replace host trust paths with a private immutable bundle before entering
  // Seatbelt/bwrap. File-authenticated CLIs (notably Codex) have no masked env
  // credential, but their native root-store APIs are unavailable after the
  // macOS Keychain services are denied; they still need ordinary TLS parity.
  //
  // `caSnapshot.path` is REQUIRED here, not optional: local host parity takes no
  // snapshot at all (the host's own trust configuration is the contract), and
  // containedTarget() renders the child environment by interpolation — so
  // assigning an absent path would export the literal string `undefined` to
  // every TLS-honoring tool in the session (`git clone https://…`, `curl`,
  // `pip install` all fail with certificate errors). Leave the host's names
  // exactly as they arrived whenever there is no private bundle to point at.
  for (const name of caSnapshot.sourceNames) delete command.env[name];
  if (caSnapshot.path && !command.credentialCapabilities?.length) {
    for (const name of CA_TRUST_VARS) command.env[name] = caSnapshot.path;
  }
  // The one-shot command descriptor may contain provider arguments. Remove it
  // before any untrusted code starts; the parsed object remains only in this
  // supervisor's memory and cannot be replayed by a later generation.
  unlinkSync(commandPath);
  scrubSupervisorEnvironment();
  const providerCredentials = localHostParity
    ? { values: new Map(), clear() {} }
    : installProviderCredentialEnvironment(command);
  let wrapped;
  let sandboxManager;
  let portPolicyControl;
  try {
    const { SandboxManager, SandboxRuntimeConfigSchema } =
      await import("@anthropic-ai/sandbox-runtime");
    sandboxManager = SandboxManager;
    const parsedConfig = SandboxRuntimeConfigSchema.safeParse(config);
    if (!parsedConfig.success) {
      // Schema messages echo hosts and paths, so only issue codes cross this
      // boundary — which leaves a credential-shaped rejection unattributable
      // from a user's log. Name the invariant this supervisor is responsible
      // for instead, using counts rather than values.
      const declared = config.credentials?.envVars?.length ?? 0;
      const authorities = config.network.tlsTerminate?.includeDomains?.length;
      const credentialShape = schemaIssueSummary(parsedConfig.error).includes(
        "credentials.",
      )
        ? `; ${declared} masked credential(s) over ` +
          `${authorities ?? 0} TLS-terminated authority(ies), ` +
          `allowedDomains=${config.network.allowedDomains.length}`
        : "";
      throw new Error(
        `generated sandbox configuration is invalid (${schemaIssueSummary(
          parsedConfig.error,
        )})${credentialShape}`,
      );
    }
    await SandboxManager.initialize(parsedConfig.data, undefined, true);
    if (!localHostParity) {
      const portPolicyToken = Buffer.from(
        command.portPolicy.token,
        "base64url",
      );
      try {
        portPolicyControl = await startZsrPortPolicyControl({
          socketPath: command.portPolicy.socketPath,
          generation: policy.generation,
          token: portPolicyToken,
          staticPorts: config.network.allowedLocalPorts,
          deniedPorts: policy.runtime.deniedLocalPorts,
          onPorts(effectivePorts) {
            config = {
              ...config,
              network: {
                ...config.network,
                allowedLocalPorts: [...effectivePorts],
              },
            };
            SandboxManager.updateConfig(config);
          },
        });
      } finally {
        portPolicyToken.fill(0);
      }
    }
    const target = containedTarget(command, localHostParity);
    const clearSrtPolicyEnvironment = installSrtPolicyEnvironment(
      command,
      policy,
    );
    try {
      wrapped = await SandboxManager.wrapWithSandboxArgv(
        target,
        undefined,
        undefined,
        undefined,
        command.cwd,
        { commandId: `${policy.actor}:${policy.executionId}` },
      );
    } finally {
      clearSrtPolicyEnvironment();
    }
  } catch (error) {
    await portPolicyControl?.close().catch(() => undefined);
    if (sandboxManager) {
      try {
        sandboxManager.cleanupAfterCommand();
        await sandboxManager.reset();
      } catch {
        // Preserve the admission error. The supervisor exits immediately, and
        // boot recovery proves its process domain empty before re-admission.
      }
    }
    caSnapshot.dispose();
    throw error;
  } finally {
    providerCredentials.clear();
  }
  const cloudWorker = policy.runtime.cloudWorker;
  let cgroupScope = null;
  let parentWatch;
  let exit;
  const runtimeState = {
    portPolicyControl,
    sandboxManager,
    get cgroupScope() {
      return cgroupScope;
    },
    killCgroup: killAndRemoveZsrCgroup,
  };
  try {
    exit = await withZsrRuntimeCleanup(runtimeState, async () => {
      assertNoRawCredentialInWrapper(wrapped, providerCredentials.values);
      for (const capability of command.credentialCapabilities ?? []) {
        delete wrapped.env[capability.name];
      }
      for (const name of Object.keys(wrapped.env)) {
        if (name.startsWith(INTERNAL_ENV_PREFIX)) delete wrapped.env[name];
      }

      cgroupScope = cloudWorker
        ? createZsrCgroupScope({
            parent: cloudWorker.cgroupParent,
            generation: `${policy.generation}:${process.pid}:${randomUUID()}`,
            limits: cloudWorker.resources,
          })
        : null;
      const launchArgv = cgroupScope
        ? wrapWithZsrCgroup(cgroupScope, wrapped.argv)
        : wrapped.argv;
      const child = spawn(launchArgv[0], launchArgv.slice(1), {
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
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => stop(signal));
      }
      const originalParent = process.ppid;
      parentWatch = setInterval(() => {
        if (process.ppid !== originalParent) {
          // The engine disappeared without performing normal revocation. The
          // supervisor is the process-group leader, so killing the group reaches
          // ordinary macOS descendants too. Linux bwrap additionally uses a PID
          // namespace plus --die-with-parent for descendants that call setsid().
          if (process.platform !== "win32")
            process.kill(-process.pid, "SIGKILL");
          else stop("SIGKILL");
        }
      }, 250);

      try {
        return await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
      } finally {
        if (parentWatch) clearInterval(parentWatch);
      }
    });
  } finally {
    caSnapshot.dispose();
  }
  if (typeof exit.code === "number") process.exitCode = exit.code;
  else if (exit.signal) process.exitCode = 128;
}

await run().catch((error) => {
  // Never serialize the policy or environment: both may include sensitive
  // provider paths or values. The message is bounded and path-neutralized by
  // the engine before it reaches renderer diagnostics.
  fail(error instanceof Error ? error.message.slice(0, 1_000) : String(error));
});
