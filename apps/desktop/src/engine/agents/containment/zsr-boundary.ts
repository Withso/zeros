import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lchown,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EXECUTION_BOUNDARY_STATUS_VERSION,
  type ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import {
  zerosChannelDataDir,
  zerosDataDir,
  zerosStateRoot,
} from "../../db/paths";

import {
  nextCommandDescriptorPath,
  isDeniedZerosControlPort,
  prepareZsrPolicy,
  zsrNetworkRoot,
  type PreparedZsrPolicy,
} from "./policy";
import {
  discoverCanonicalGitRepository,
  recoverShadowGitPreservations,
  type CanonicalGitRepository,
  type ShadowGitFilesystemProjection,
  type ShadowGitPromotionResult,
} from "./shadow-git";
import { ShadowGitCollection } from "./shadow-git-collection";
import { ShadowGitRemoteBroker } from "./shadow-git-remote-broker";
import {
  prepareProviderHomeOverlay,
  preserveProviderHomeOverlay,
  promoteProviderHomeOverlay,
  type ProviderHomeOverlay,
} from "./provider-home-overlay";
import { deriveProviderCredentialProjection } from "./provider-credential-projection";
import {
  MacosContainerWorkerUnavailableError,
  MacosOrbStackContainerWorker,
  type MacosContainerWorkerLease,
} from "./macos-orbstack-container-worker";
import {
  MacosProcessDomain,
  probeMacosProcessDomainHelper,
  recoverMacosProcessDomains,
  type MacosProcessDomainCommandRunner,
  type MacosProcessDomainRecoveryResult,
} from "./macos-process-domain";
import {
  reserveMacosPortPool,
  type MacosPortPoolReservation,
} from "./zsr-macos-port-pool";
import { boundaryParityRestrictions, newTerritoryGeneration } from "./status";
import {
  ZsrLocalTcpBroker,
  ZsrPortPolicyClient,
  ZsrReversePortBroker,
} from "./zsr-port-broker";
import { ZsrLocalServiceBroker } from "./zsr-service-broker";
import { recoverZsrCgroupScopes } from "./zsr-cgroup.mjs";
import type {
  BoundaryLaunchSpec,
  BoundaryProcess,
  BoundaryProcessExit,
  BoundaryProbeResult,
  BoundaryRequest,
  BoundarySpawnRequest,
  CloudWorkerIdentity,
  CloudWorkerRuntimeConfiguration,
  CloudWorkerToolchain,
  ExecutionBoundary,
  PortLease,
  PortDiscoveryIssue,
  PortDiscoveryStatus,
  PortMapping,
  PortRequest,
  PreparedBoundary,
  ServiceLease,
  ServiceRequest,
  TerritoryGeneration,
} from "./types";
import { stripEngineAuthorityEnv } from "../adapters/shared/config-isolation";
import { sessionDir, sessionsRoot } from "../session-paths";

const GRACE_MS = 2_000;
const FORCE_MS = 1_000;
const POLL_MS = 20;
const PROBE_TIMEOUT_MS = 15_000;
const FAILED_PROBE_CACHE_MS = 5_000;
const PORT_DISCOVERY_INTERVAL_MS = 250;
const PORT_DISCOVERY_MISSING_POLLS = 8;
const MAX_AUTO_PORT_LEASES = 64;
const COMMAND_DESCRIPTOR_VERSION = 5 as const;

function pathInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function discoverBoundaryGitRepositories(
  request: BoundaryRequest,
): Promise<readonly CanonicalGitRepository[]> {
  if (request.actor === "design-agent") return [];
  const repositories: CanonicalGitRepository[] = [];
  const primary = await discoverCanonicalGitRepository(request.workspaceRoot);
  if (primary) repositories.push(primary);

  const requested = request.additionalGitWorkspaceRoots ?? [];
  if (requested.length > 32 || new Set(requested).size !== requested.length) {
    throw new Error(
      "additional Git workspace roots must be unique and bounded",
    );
  }
  const grants = await Promise.all(
    (request.additionalReadWriteRoots ?? []).map(async (root) => {
      if (!path.isAbsolute(root) || root.includes("\0")) {
        throw new Error("additional Git workspace grant is invalid");
      }
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  const protectedRoots = (
    request.territory?.protectedDesignDirectories ?? []
  ).map((root) => path.resolve(root));
  const deniedPaths = (
    request.territory?.writeCapabilities.deniedPaths ?? []
  ).map((root) => path.resolve(root));

  for (const requestedRoot of requested) {
    if (!path.isAbsolute(requestedRoot) || requestedRoot.includes("\0")) {
      throw new Error("additional Git workspace root is invalid");
    }
    const root = await realpath(requestedRoot);
    if (
      root === primary?.workspaceRoot ||
      repositories.some((repository) => repository.workspaceRoot === root)
    ) {
      throw new Error("additional Git workspace root duplicates a repository");
    }
    if (!grants.some((grant) => pathInsideOrEqual(root, grant))) {
      throw new Error("additional Git workspace root is outside write grants");
    }
    if (!protectedRoots.some((design) => pathInsideOrEqual(design, root))) {
      throw new Error(
        "additional Git workspace root has no protected Design territory",
      );
    }
    const repository = await discoverCanonicalGitRepository(root);
    if (!repository || repository.workspaceRoot !== root) {
      throw new Error("additional Git workspace owner could not be verified");
    }
    if (
      !deniedPaths.some(
        (denied) =>
          denied === repository.gitEntry ||
          pathInsideOrEqual(repository.gitEntry, denied),
      )
    ) {
      throw new Error(
        "additional Git workspace metadata is not part of the denied territory",
      );
    }
    repositories.push(repository);
  }
  return repositories;
}

function allocateInternalProxyPorts(
  policy: PreparedZsrPolicy,
  additionalUnavailable: readonly number[] = [],
): {
  http: number;
  socks: number;
} {
  const unavailable = new Set([
    ...policy.document.runtime.allowedLocalPorts,
    ...policy.document.runtime.deniedLocalPorts,
    ...additionalUnavailable,
    // Keep the common development and conventional proxy corpus free even if
    // a future random-range change accidentally overlaps it.
    1080,
    3000,
    3128,
    5173,
    8000,
    8080,
  ]);
  const allocate = (): number => {
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const candidate = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000);
      if (!unavailable.has(candidate)) {
        unavailable.add(candidate);
        return candidate;
      }
    }
    throw new Error("could not allocate internal sandbox proxy ports");
  };
  return { http: allocate(), socks: allocate() };
}

/** Only the trusted supervisor sees this environment. In particular it never
 * receives provider/session values: those are carried in the private command
 * descriptor and materialized by `/usr/bin/env -i` inside Seatbelt/bwrap. */
function supervisorBootstrapEnv(
  policy: PreparedZsrPolicy,
  cloudToolchain?: CloudWorkerToolchain,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: policy.paths.home,
    // SRT creates a private mux Unix socket beneath TMPDIR. The durable session
    // tree can exceed Darwin's sockaddr_un path limit, so trusted runtime
    // scratch lives under the short generation network root and is subtracted
    // from the untrusted filesystem policy.
    TMPDIR: policy.paths.networkRuntime,
    XDG_CACHE_HOME: path.join(policy.paths.home, ".cache"),
    XDG_DATA_HOME: path.join(policy.paths.home, ".local", "share"),
    // On supported Node releases this makes the trusted supervisor/proxy use
    // the OS trust store (including enterprise roots in macOS Keychain and
    // Windows certificate stores). Older Node releases safely ignore it.
    NODE_USE_SYSTEM_CA: "1",
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
    ...(cloudToolchain
      ? {
          ZEROS_ZSR_BWRAP_PATH: cloudToolchain.bwrap,
          ZEROS_ZSR_SOCAT_PATH: cloudToolchain.socat,
          ZEROS_ZSR_SETPRIV_PATH: cloudToolchain.setpriv,
        }
      : {
          ...(process.env.ZEROS_ZSR_BWRAP_PATH
            ? { ZEROS_ZSR_BWRAP_PATH: process.env.ZEROS_ZSR_BWRAP_PATH }
            : {}),
          ...(process.env.ZEROS_ZSR_SOCAT_PATH
            ? { ZEROS_ZSR_SOCAT_PATH: process.env.ZEROS_ZSR_SOCAT_PATH }
            : {}),
          ...(process.env.ZEROS_ZSR_SETPRIV_PATH
            ? { ZEROS_ZSR_SETPRIV_PATH: process.env.ZEROS_ZSR_SETPRIV_PATH }
            : {}),
          ...(process.env.ZEROS_ZSR_SECCOMP_PATH
            ? { ZEROS_ZSR_SECCOMP_PATH: process.env.ZEROS_ZSR_SECCOMP_PATH }
            : {}),
        }),
  };
}

function containedChildEnv(
  request: BoundarySpawnRequest,
  policy: PreparedZsrPolicy,
  shadowGit: ShadowGitCollection | null,
  providerHome: ProviderHomeOverlay | null,
  serviceEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = stripEngineAuthorityEnv({ ...request.env });
  for (const name of Object.keys(env)) {
    if (name.startsWith("ZEROS_ZSR_")) delete env[name];
  }
  Object.assign(env, {
    HOME: policy.paths.home,
    TMPDIR: policy.paths.scratch,
    XDG_CONFIG_HOME: path.join(policy.paths.home, ".config"),
    XDG_CACHE_HOME: path.join(policy.paths.home, ".cache"),
    XDG_DATA_HOME: path.join(policy.paths.home, ".local", "share"),
    XDG_STATE_HOME: path.join(policy.paths.home, ".local", "state"),
    ...(providerHome?.env ?? {}),
  });
  // A Docker/Podman daemon API is equivalent to host filesystem authority: a
  // client can ask it to bind-mount Design or engine state even when this
  // process cannot open those paths. Never inherit a host daemon endpoint.
  // Qualified container workflows replace these sentinels with a per-session
  // isolated worker capability, not a byte tunnel to the ambient daemon.
  for (const name of [
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "CONTAINER_CONNECTION",
    "CONTAINER_SSHKEY",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    DOCKER_HOST: `unix://${path.join(policy.paths.networkServices, "container-worker-unavailable.sock")}`,
    CONTAINER_HOST: `unix://${path.join(policy.paths.networkServices, "container-worker-unavailable.sock")}`,
  });
  if (shadowGit) {
    for (const name of Object.keys(env)) {
      if (
        name === "GIT_DIR" ||
        name === "GIT_COMMON_DIR" ||
        name === "GIT_WORK_TREE" ||
        name === "GIT_INDEX_FILE" ||
        name === "GIT_OBJECT_DIRECTORY" ||
        name === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
        name === "GIT_NAMESPACE" ||
        name === "GIT_CEILING_DIRECTORIES" ||
        name === "GIT_ASKPASS" ||
        name === "GIT_SSH" ||
        name === "GIT_SSH_COMMAND" ||
        name === "GIT_EXEC_PATH" ||
        name === "GIT_PROXY_COMMAND" ||
        name === "SSH_ASKPASS" ||
        name === "SSH_AUTH_SOCK" ||
        name === "GPG_AGENT_INFO" ||
        name === "GH_TOKEN" ||
        name === "GITHUB_TOKEN" ||
        name.startsWith("GIT_CONFIG") ||
        name.startsWith("ZEROS_GIT_AUTH_") ||
        name.startsWith("ZEROS_REAL_GIT") ||
        name.startsWith("ZEROS_REAL_GH") ||
        name === "ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS"
      ) {
        delete env[name];
      }
    }
    Object.assign(env, shadowGit.childEnvironment(env.PATH));
  }
  // Git setup must not be able to replace the private provider HOME.
  Object.assign(env, providerHome?.env ?? { HOME: policy.paths.home });
  // Leased service façades override their original host endpoints last. The
  // raw target never survives in a standard client variable.
  Object.assign(env, serviceEnvironment);
  return env;
}

const CANARY_SOURCE = String.raw`
const fs = require("node:fs");
const spec = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const result = {
  codeWrite: false,
  designWriteDenied: false,
  designHardlinkDenied: false,
  designCreateDenied: false,
  designUnlinkDenied: false,
  designRenameOutDenied: false,
  designRenameInDenied: false,
  designChmodDenied: false,
  designSymlinkWriteDenied: false,
  secretReadDenied: false,
};
try { fs.writeFileSync(spec.codeFile, "ok\n"); result.codeWrite = true; } catch {}
try { fs.writeFileSync(spec.designFile, "mutated\n"); } catch { result.designWriteDenied = true; }
try { fs.linkSync(spec.designFile, spec.hardlinkAlias); }
catch { result.designHardlinkDenied = true; }
finally {
  try { fs.unlinkSync(spec.hardlinkAlias); } catch {}
}
try { fs.writeFileSync(spec.designCreateFile, "escaped\n", { flag: "wx" }); }
catch { result.designCreateDenied = true; }
try { fs.unlinkSync(spec.designUnlinkFile); }
catch { result.designUnlinkDenied = true; }
try { fs.renameSync(spec.designRenameOutFile, spec.renameOutDestination); }
catch { result.designRenameOutDenied = true; }
try { fs.renameSync(spec.renameInSource, spec.designRenameInDestination); }
catch { result.designRenameInDenied = true; }
try { fs.chmodSync(spec.designChmodFile, 0o666); }
catch { result.designChmodDenied = true; }
try {
  fs.symlinkSync(spec.designSymlinkTargetFile, spec.symlinkAlias);
  const fd = fs.openSync(spec.symlinkAlias, fs.constants.O_WRONLY | fs.constants.O_CLOEXEC);
  fs.closeSync(fd);
} catch { result.designSymlinkWriteDenied = true; }
finally {
  try { fs.unlinkSync(spec.symlinkAlias); } catch {}
}
try { fs.readFileSync(spec.secret, "utf8"); } catch { result.secretReadDenied = true; }
process.stdout.write(JSON.stringify(result));
`;

const EXACT_CANARY_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const spec = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const result = {
  codeWrite: false,
  policyReadDenied: false,
  processDomainMarkerReadable: !spec.processDomain,
  sandboxPid: process.pid,
  environmentExact: false,
  designWriteDenied: [],
  designAliasWriteDenied: false,
  controlWriteDenied: [],
  controlReadDenied: [],
  gitProjectionPrivate: [],
  cloudWorkerIdentity: !spec.cloudWorker,
  engineProcessHidden: !spec.cloudWorker,
  dynamicBindMapped: !spec.bindPorts,
  privateStateWrite: false,
  engineRootWriteDenied: false,
};
try { fs.writeFileSync(spec.codeFile, "ok\n", { flag: "wx" }); result.codeWrite = true; } catch {}
try { fs.writeFileSync(spec.privateWriteFile, "private\n", { flag: "wx" }); result.privateStateWrite = true; } catch {}
try { fs.writeFileSync(spec.engineWriteFile, "escaped\n", { flag: "wx" }); }
catch { result.engineRootWriteDenied = true; }
try { fs.readFileSync(spec.policyFile, "utf8"); } catch { result.policyReadDenied = true; }
if (spec.processDomain) {
  try {
    result.processDomainMarkerReadable =
      fs.readFileSync(spec.processDomain.markerFile, "utf8") === spec.generation + "\n";
  } catch {}
}
result.environmentExact =
  process.env.ZEROS_ADMISSION_SENTINEL === spec.generation &&
  !process.env.ZEROS_LOCAL_WS_TOKEN &&
  !process.env.ZEROS_CONTROL_FD &&
  !process.env.ZEROS_ZSR_AMBIENT_SECRET;
for (const probe of spec.designProbes) {
  let denied = false;
  try {
    if (probe.file) {
      const fd = fs.openSync(probe.file, fs.constants.O_WRONLY | fs.constants.O_CLOEXEC);
      fs.closeSync(fd);
    } else {
      fs.accessSync(probe.directory, fs.constants.W_OK);
    }
  } catch { denied = true; }
  result.designWriteDenied.push(denied);
}
if (!spec.designAlias) result.designAliasWriteDenied = true;
else {
  try { fs.accessSync(spec.designAlias, fs.constants.W_OK); }
  catch { result.designAliasWriteDenied = true; }
}
for (const file of spec.controlWriteFiles) {
  let denied = false;
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CLOEXEC);
    fs.closeSync(fd);
  } catch { denied = true; }
  result.controlWriteDenied.push(denied);
}
for (const file of spec.controlReadFiles) {
  let denied = false;
  try { fs.readFileSync(file); } catch { denied = true; }
  result.controlReadDenied.push(denied);
}
for (const projection of spec.gitProjections) {
  let projectionPrivate = false;
  const gitEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) {
    if (name.startsWith("GIT_") || name.startsWith("ZEROS_REAL_GIT")) delete gitEnv[name];
  }
  const probe = spawnSync(
    projection.gitBinary,
    ["-C", projection.workspace, "rev-parse", "--absolute-git-dir"],
    { env: gitEnv, encoding: "utf8", timeout: 5000 },
  );
  const discovered = probe.status === 0 ? probe.stdout.trim() : "";
  if (path.resolve(discovered) === projection.expectedGitDir) {
    try {
      fs.writeFileSync(
        path.join(discovered, projection.markerName),
        spec.generation + "\n",
        { flag: "wx", mode: 0o600 },
      );
      projectionPrivate = true;
    } catch {}
  }
  result.gitProjectionPrivate.push(projectionPrivate);
}
if (spec.cloudWorker) {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const field = (name) => new RegExp("^" + name + ":\\s+(.+)$", "m").exec(status)?.[1]?.trim();
  const zeroCaps = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(
    (name) => /^0+$/.test(field(name) || ""),
  );
  const groups = typeof process.getgroups === "function" ? process.getgroups() : [];
  result.cloudWorkerIdentity =
    process.getuid?.() === spec.cloudWorker.uid &&
    process.getgid?.() === spec.cloudWorker.gid &&
    groups.every((gid) => gid === spec.cloudWorker.gid) &&
    zeroCaps &&
    field("NoNewPrivs") === "1";
  result.engineProcessHidden = !fs.existsSync("/proc/" + spec.enginePid);
}
if (spec.bindPorts) {
  const bindProbe = spawnSync(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const server=net.createServer();" +
        "server.once('error',()=>process.exit(2));" +
        "server.listen(0,'127.0.0.1',()=>{" +
        "process.stdout.write(String(server.address().port));server.close();});",
    ],
    { env: process.env, encoding: "utf8", timeout: 5000 },
  );
  const mappedPort = Number(bindProbe.stdout.trim());
  result.dynamicBindMapped =
    bindProbe.status === 0 && spec.bindPorts.includes(mappedPort);
}
process.stdout.write(JSON.stringify(result) + "\n");
if (spec.processDomain) {
  const deadline = Date.now() + 10000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(spec.processDomain.releaseFile) && Date.now() < deadline) {
    Atomics.wait(waitCell, 0, 0, 20);
  }
  if (!fs.existsSync(spec.processDomain.releaseFile)) process.exitCode = 124;
}
`;

export interface ZsrBoundaryOptions {
  projectRoot: string;
  supervisorScript?: string;
  supervisorRuntime?: string;
  networkBridgeScript?: string;
  containerWorkerScript?: string;
  /** Linux helper copied into the isolated OrbStack machine on macOS. */
  macosContainerHostScript?: string;
  /** Immutable provisioning contract for the dedicated OrbStack machine. */
  macosContainerCloudInit?: string;
  /** Deterministic test seam; production constructs the real controller. */
  macosContainerWorkerFactory?: (
    orbPath: string,
  ) => Pick<MacosOrbStackContainerWorker, "reserve">;
  /** Package-owned Darwin helper used to identify Seatbelt descendants that
   * escaped their original POSIX process group. */
  macosProcessDomainHelper?: string;
  /** Package-owned post-Seatbelt interposer for exact dynamic TCP binding. */
  macosPortBindLibrary?: string;
  /** Deterministic qualification/test seam. Production constructors omit it
   * and execute the immutable native helper directly. */
  macosProcessDomainRunner?: MacosProcessDomainCommandRunner;
  /** Successful backend capability probes are process-lifetime stable. A
   * failure is retried after this bounded interval so installing/repairing a
   * helper does not require restarting the engine. */
  failedProbeCacheMs?: number;
  /** Set only from a validated root-owned cloud deployment marker. */
  cloudWorker?: CloudWorkerRuntimeConfiguration;
  /** Immutable helper paths from that same marker. Qualification fixtures may
   * omit this and supply explicit constructor/env overrides instead. */
  cloudWorkerToolchain?: CloudWorkerToolchain;
}

async function grantWritableTreeToWorker(
  root: string,
  identity: CloudWorkerIdentity,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await lchown(candidate, identity.uid, identity.gid);
    } else {
      if (entry.isDirectory()) {
        await grantWritableTreeToWorker(candidate, identity);
      }
      await chown(candidate, identity.uid, identity.gid);
    }
  }
  await chown(root, identity.uid, identity.gid);
  await chmod(root, 0o700);
}

async function grantReadOnlyTreeToWorker(
  root: string,
  identity: CloudWorkerIdentity,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await lchown(candidate, 0, identity.gid);
      continue;
    }
    if (entry.isDirectory()) {
      await grantReadOnlyTreeToWorker(candidate, identity);
    }
    const metadata = await lstat(candidate);
    const owner = metadata.mode & 0o700;
    await chown(candidate, 0, identity.gid);
    await chmod(candidate, owner | (owner >> 3));
  }
  await chown(root, 0, identity.gid);
  await chmod(root, 0o750);
}

async function prepareCloudWorkerPrivateState(
  policy: PreparedZsrPolicy,
  identity: CloudWorkerIdentity,
  unixSockets: readonly string[],
): Promise<void> {
  await Promise.all(
    [
      policy.paths.home,
      policy.paths.scratch,
      policy.paths.providerState,
      policy.paths.shadowGit,
      policy.paths.networkClientState,
    ].map((directory) => grantWritableTreeToWorker(directory, identity)),
  );
  if (policy.paths.containerState) {
    const metadata = await lstat(policy.paths.containerState);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("cloud container-worker state is not physical");
    }
    // This durable tree can contain an OCI image store with hundreds of
    // thousands of entries. Its only writer is this fixed worker uid, so once
    // the empty root is handed over, recursively chowning every image layer on
    // every admission is both unnecessary and a severe startup regression.
    await chown(policy.paths.containerState, identity.uid, identity.gid);
    await chmod(policy.paths.containerState, 0o700);
  }
  await grantReadOnlyTreeToWorker(policy.paths.tools, identity);
  await Promise.all([
    chown(policy.paths.root, 0, identity.gid),
    chmod(policy.paths.root, 0o710),
    chown(policy.paths.network, 0, identity.gid),
    chmod(policy.paths.network, 0o710),
    chown(policy.paths.networkServices, 0, identity.gid),
    chmod(policy.paths.networkServices, 0o710),
  ]);
  for (const socket of unixSockets) {
    const metadata = await lstat(socket);
    if (!metadata.isSocket() || metadata.isSymbolicLink()) {
      throw new Error("cloud-worker service façade is not a physical socket");
    }
    await chown(socket, 0, identity.gid);
    await chmod(socket, 0o620);
  }
}

interface CachedProbe {
  readonly checkedAt: number;
  readonly result: BoundaryProbeResult;
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroup(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

function statusFor(
  request: BoundaryRequest,
  generation: ReturnType<typeof newTerritoryGeneration>,
  backend: "zeros-srt" | "cloud-worker",
  hasShadowGit: boolean,
): ExecutionBoundaryStatus {
  const restrictions = boundaryParityRestrictions(request);
  const containerRemediation =
    request.containerWorkerUnavailableReason === "insufficient-disk-space"
      ? "Free at least 4 GiB on the Mac startup volume to enable the isolated OrbStack Docker/Podman worker."
      : request.containerWorkerUnavailableReason ===
          "private-runtime-unavailable"
        ? "Start or update the qualified OrbStack runtime, then retry the session to enable isolated Docker/Podman workflows."
        : process.platform === "darwin"
          ? "Install a qualified OrbStack runtime to enable isolated Docker/Podman workflows for this session."
          : "Install rootless Podman in the qualified worker image to enable isolated Docker/Podman workflows.";
  const remediation = [
    ...(restrictions.includes("container-workflows-unavailable")
      ? [containerRemediation]
      : []),
  ].join(" ");
  const serviceKinds = [
    ...new Set([
      ...(request.localServices ?? []).map((service) => service.kind),
      ...(request.containerWorker ? (["podman"] as const) : []),
    ]),
  ].sort();
  return {
    version: EXECUTION_BOUNDARY_STATUS_VERSION,
    actor: request.actor,
    state: "ready",
    backend,
    designProtection: {
      required: Boolean(request.territory),
      enforced: Boolean(request.territory),
      protectedDirectoryCount:
        request.territory?.protectedDesignDirectories.length ?? 0,
      ...(request.territory ? { territoryGeneration: generation } : {}),
    },
    parity: {
      level: restrictions.length === 0 ? "full" : "restricted",
      restrictions,
    },
    services: {
      state: "ready",
      activeCount:
        (request.localServices?.length ?? 0) +
        (request.containerWorker ? 1 : 0),
      kinds: serviceKinds,
    },
    git: { state: hasShadowGit ? "ready" : "not-applicable" },
    checkedAt: Date.now(),
    ...(remediation ? { remediation } : {}),
  };
}

class TrackedBoundaryProcess implements BoundaryProcess {
  readonly pid: number;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  private readonly exited: Promise<BoundaryProcessExit>;
  private stopPromise: Promise<void> | null = null;

  constructor(readonly child: ChildProcess) {
    if (!child.pid) throw new Error("boundary supervisor has no pid");
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
  }

  wait(): Promise<BoundaryProcessExit> {
    return this.exited;
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    if (process.platform !== "win32") {
      try {
        process.kill(-this.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    this.child.kill(signal);
  }

  stopAndProve(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const startedAt = Date.now();
      if (process.platform === "win32") {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGTERM");
          await Promise.race([
            this.exited,
            new Promise((resolve) => setTimeout(resolve, GRACE_MS)),
          ]);
          if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill("SIGKILL");
            await this.exited;
          }
        }
        return;
      }
      if (!processGroupExists(this.pid)) return;
      await this.signal("SIGTERM");
      if (await waitForGroup(this.pid, GRACE_MS)) return;
      await this.signal("SIGKILL");
      if (!(await waitForGroup(this.pid, FORCE_MS))) {
        throw new Error(`boundary process group ${this.pid} survived SIGKILL`);
      }
      await this.exited;
      if (process.env.SRT_DEBUG) {
        console.error(
          `[zsr] process group ${this.pid} stopped in ${Date.now() - startedAt}ms`,
        );
      }
    })();
    return this.stopPromise;
  }
}

/** A process root created by node-pty in the shared Node host. We do not own a
 * ChildProcess object in the Bun engine, but node-pty makes the reported pid
 * the PTY session/process-group leader. Tracking that group gives boundary
 * revocation the same terminate-and-prove semantics as direct provider
 * spawns. */
class TrackedBoundaryProcessGroup implements BoundaryProcess {
  readonly child = undefined;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  private stopPromise: Promise<void> | null = null;

  constructor(readonly pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("boundary PTY process group has an invalid pid");
    }
  }

  async wait(): Promise<BoundaryProcessExit> {
    while (processGroupExists(this.pid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
    return { code: null, signal: null };
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("PTY process-group tracking is unavailable on Windows");
    }
    try {
      process.kill(-this.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  stopAndProve(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (!processGroupExists(this.pid)) return;
      await this.signal("SIGTERM");
      if (await waitForGroup(this.pid, GRACE_MS)) return;
      await this.signal("SIGKILL");
      if (!(await waitForGroup(this.pid, FORCE_MS))) {
        throw new Error(
          `boundary PTY process group ${this.pid} survived SIGKILL`,
        );
      }
    })();
    return this.stopPromise;
  }
}

class PreparedZsrBoundary implements PreparedBoundary {
  readonly generation;
  readonly status;
  private readonly processes = new Set<BoundaryProcess>();
  private readonly pendingProcessRetirements = new Set<Promise<void>>();
  private processRegistrationEpoch = 0;
  private readonly portLeases = new Set<PortLease>();
  private readonly portMappings = new Map<string, PortMapping>();
  private readonly portObservers = new Set<
    (ports: readonly PortMapping[]) => void
  >();
  private readonly discoveredPorts = new Map<
    number,
    { lease: PortLease; missingPolls: number }
  >();
  private readonly serviceLeases = new Set<ServiceLease>();
  private readonly serviceEnvironment = new Map<string, string>();
  private readonly networkBridgeToken: Buffer;
  private readonly reverseSocketPath: string;
  private readonly serviceSocketPath: string;
  private readonly portPolicySocketPath: string;
  private readonly localTcpPorts: readonly number[];
  private readonly portBroker: ZsrReversePortBroker | null;
  private readonly portPolicyClient: ZsrPortPolicyClient;
  private portDiscoveryTimer: NodeJS.Timeout | null = null;
  private portDiscoveryInFlight = false;
  private portDiscoveryReady = false;
  private portDiscoveryState: PortDiscoveryStatus["state"] = "idle";
  private portDiscoveryIssue: PortDiscoveryIssue | null = null;
  private policyIssued = false;
  private revoked = false;
  private revokePromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly request: BoundaryRequest,
    private readonly policy: PreparedZsrPolicy,
    private readonly runtime: string,
    private readonly supervisorScript: string,
    private readonly cloudWorkerToolchain: CloudWorkerToolchain | undefined,
    private readonly shadowGit: ShadowGitCollection | null,
    private readonly providerHome: ProviderHomeOverlay | null,
    private readonly localTcpBroker: ZsrLocalTcpBroker | null,
    private readonly localServiceBroker: ZsrLocalServiceBroker | null,
    private readonly macosContainerWorker: MacosContainerWorkerLease | null,
    private readonly macosProcessDomain: MacosProcessDomain | null,
    private readonly macosPortPool: MacosPortPoolReservation | null,
    private readonly macosPortBindLibrary: string | null,
    networkBridgeToken: Buffer,
    generation: ReturnType<typeof newTerritoryGeneration>,
    backend: "zeros-srt" | "cloud-worker",
    private readonly onRetirementFailure: (error: unknown) => void,
  ) {
    this.generation = generation;
    this.status = statusFor(request, generation, backend, Boolean(shadowGit));
    this.networkBridgeToken = networkBridgeToken;
    this.reverseSocketPath = path.join(policy.paths.networkBridge, "r");
    this.serviceSocketPath = path.join(policy.paths.networkBridge, "h");
    this.portPolicySocketPath = path.join(policy.paths.networkBridge, "p");
    this.localTcpPorts = policy.document.runtime.allowedLocalPorts.filter(
      (port) => !policy.document.runtime.deniedLocalPorts.includes(port),
    );
    this.portBroker =
      process.platform === "linux"
        ? new ZsrReversePortBroker({
            generation,
            socketPath: this.reverseSocketPath,
            token: this.networkBridgeToken,
          })
        : null;
    this.portPolicyClient = new ZsrPortPolicyClient({
      generation,
      socketPath: this.portPolicySocketPath,
      token: this.networkBridgeToken,
    });
  }

  matchesMacosProcessDomain(pid: number): Promise<boolean> {
    if (!this.macosProcessDomain) return Promise.resolve(true);
    return this.macosProcessDomain.matches(pid);
  }

  privateStateDirectory(namespace: string): string {
    if (this.revoked) throw new Error("execution boundary is revoked");
    const normalized = namespace.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
      throw new Error("invalid private-state namespace");
    }
    const parent = this.policy.paths.providerState;
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error("private-state parent is not a physical directory");
    }
    if (realpathSync(parent) !== parent) {
      throw new Error("private-state parent is not canonical");
    }
    const directory = path.join(parent, normalized);
    try {
      mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("private-state namespace is not a physical directory");
      }
    }
    if (realpathSync(directory) !== directory) {
      throw new Error("private-state namespace is not canonical");
    }
    chmodSync(directory, 0o700);
    return directory;
  }

  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec {
    if (this.revoked) throw new Error("execution boundary is revoked");
    if (!path.isAbsolute(request.command) || !path.isAbsolute(request.cwd)) {
      throw new Error("boundary spawn requires absolute command and cwd");
    }
    const descriptor = nextCommandDescriptorPath(this.policy.paths);
    const macosBindPorts = this.macosBindPorts();
    const internalProxyPorts = allocateInternalProxyPorts(
      this.policy,
      macosBindPorts,
    );
    const networkBridge =
      process.platform === "linux"
        ? {
            version: 1,
            generation: this.generation,
            token: this.networkBridgeToken.toString("base64url"),
            reverseSocketPath: this.reverseSocketPath,
            runtime: this.runtime,
            script: path.join(
              this.policy.paths.tools,
              "zsr-network-bridge.mjs",
            ),
            descriptor: path.join(
              this.policy.paths.networkBridge,
              `c-${randomUUID().slice(0, 8)}.json`,
            ),
          }
        : undefined;
    const filesystemProjections =
      process.platform === "linux" && this.shadowGit
        ? this.shadowGit.filesystemProjections()
        : undefined;
    const childEnvironment = containedChildEnv(
      request,
      this.policy,
      this.shadowGit,
      this.providerHome,
      Object.fromEntries(this.serviceEnvironment),
    );
    if (this.macosPortPool && this.macosPortBindLibrary) {
      const existingInterposers = (childEnvironment.DYLD_INSERT_LIBRARIES ?? "")
        .split(":")
        .filter(
          (entry) => entry.length > 0 && entry !== this.macosPortBindLibrary,
        );
      Object.assign(childEnvironment, {
        DYLD_INSERT_LIBRARIES: [
          this.macosPortBindLibrary,
          ...existingInterposers,
        ].join(":"),
        ZEROS_ZSR_MACOS_BIND_PORTS: macosBindPorts.join(","),
        ZEROS_ZSR_MACOS_PASSTHROUGH_PORTS: [
          ...new Set([
            ...this.localTcpPorts,
            internalProxyPorts.http,
            internalProxyPorts.socks,
          ]),
        ]
          .sort((left, right) => left - right)
          .join(","),
        ZEROS_ZSR_MACOS_DENIED_PORTS:
          this.policy.document.runtime.deniedLocalPorts.join(","),
        ZEROS_ZSR_MACOS_PORT_MAP: path.join(
          this.policy.paths.scratch,
          ".zsr-port-map",
        ),
      });
    }
    const containerWorker =
      this.request.containerWorker?.backend === "embedded-linux" &&
      this.policy.paths.containerState
        ? {
            version: 1 as const,
            runtime: "podman" as const,
            node: realpathSync(this.runtime),
            engine: this.request.containerWorker.executable,
            launcher: path.join(
              this.policy.paths.tools,
              "zsr-container-worker.mjs",
            ),
            state: this.policy.paths.containerState,
            socket: path.join(this.policy.paths.containerState, "podman.sock"),
          }
        : undefined;
    if (containerWorker) {
      Object.assign(childEnvironment, {
        DOCKER_HOST: `unix://${containerWorker.socket}`,
        CONTAINER_HOST: `unix://${containerWorker.socket}`,
      });
    } else if (this.macosContainerWorker) {
      Object.assign(childEnvironment, this.macosContainerWorker.environment);
    }
    const credentialCapabilities = deriveProviderCredentialProjection(
      this.request.providerId,
      childEnvironment,
    );
    if (networkBridge) {
      writeFileSync(
        networkBridge.descriptor,
        `${JSON.stringify({
          version: networkBridge.version,
          generation: networkBridge.generation,
          token: networkBridge.token,
          reverseSocketPath: networkBridge.reverseSocketPath,
          localTcpPorts: this.localTcpPorts,
          ignoredTcpPorts: [
            ...new Set([
              ...this.localTcpPorts,
              internalProxyPorts.http,
              internalProxyPorts.socks,
            ]),
          ].sort((left, right) => left - right),
          ...(this.localTcpPorts.length > 0
            ? { serviceSocketPath: this.serviceSocketPath }
            : {}),
        })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: COMMAND_DESCRIPTOR_VERSION,
        generation: this.generation,
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        internalProxyPorts,
        env: childEnvironment,
        ...(credentialCapabilities.length > 0
          ? { credentialCapabilities }
          : {}),
        ...(filesystemProjections ? { filesystemProjections } : {}),
        ...(networkBridge ? { networkBridge } : {}),
        portPolicy: {
          version: 1,
          generation: this.generation,
          token: this.networkBridgeToken.toString("base64url"),
          socketPath: this.portPolicySocketPath,
          initialPorts: [
            ...new Set(this.activePorts().map((mapping) => mapping.targetPort)),
          ].sort((left, right) => left - right),
          bindPorts: macosBindPorts,
        },
        ...(containerWorker ? { containerWorker } : {}),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    this.policyIssued = true;
    const env = supervisorBootstrapEnv(this.policy, this.cloudWorkerToolchain);
    return {
      command: this.runtime,
      args: [
        this.supervisorScript,
        "--policy",
        this.policy.paths.policy,
        "--command",
        descriptor,
      ],
      cwd: request.cwd,
      env,
      stdio: request.stdio ?? "pipe",
    };
  }

  private macosBindPorts(): number[] {
    if (!this.macosPortPool) return [];
    const denied = new Set(this.policy.document.runtime.deniedLocalPorts);
    return [
      ...new Set([
        ...this.macosPortPool.ports,
        ...this.activePorts().map((mapping) => mapping.targetPort),
      ]),
    ]
      .filter((port) => !denied.has(port))
      .sort((left, right) => left - right);
  }

  admittedMacosBindPorts(): readonly number[] {
    return this.macosBindPorts();
  }

  activePorts(): readonly PortMapping[] {
    return [...this.portMappings.values()].sort(
      (left, right) =>
        left.port - right.port ||
        left.targetPort - right.targetPort ||
        left.leaseId.localeCompare(right.leaseId),
    );
  }

  portDiscoveryStatus(): PortDiscoveryStatus {
    return {
      state: this.portDiscoveryState,
      ...(this.portDiscoveryIssue ? { issue: this.portDiscoveryIssue } : {}),
    };
  }

  onPortsChanged(
    listener: (ports: readonly PortMapping[]) => void,
  ): () => void {
    this.portObservers.add(listener);
    listener(this.activePorts());
    return () => this.portObservers.delete(listener);
  }

  private publishPorts(): void {
    const snapshot = this.activePorts();
    for (const observer of this.portObservers) {
      try {
        observer(snapshot);
      } catch {
        // A diagnostic observer cannot interrupt lease enforcement or teardown.
        console.warn("[zsr] boundary port observer failed");
      }
    }
  }

  private trackPortLease(
    delegated: PortLease,
    request: PortRequest,
    source: PortMapping["source"],
  ): PortLease {
    let active = true;
    const lease: PortLease = {
      ...delegated,
      revoke: async () => {
        if (!active) return;
        active = false;
        await delegated.revoke();
        this.portLeases.delete(lease);
        this.portMappings.delete(lease.leaseId);
        this.publishPorts();
      },
    };
    this.portLeases.add(lease);
    this.portMappings.set(lease.leaseId, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      protocol: "tcp",
      host: lease.host,
      port: lease.port,
      targetPort: lease.targetPort,
      displayPort: request.preferredPort ?? lease.targetPort,
      purpose: request.purpose,
      source,
    });
    this.publishPorts();
    return lease;
  }

  private dynamicTargetPorts(): number[] {
    const denied = new Set(this.policy.document.runtime.deniedLocalPorts);
    return [
      ...new Set(
        this.activePorts()
          .map((mapping) => mapping.targetPort)
          .filter((port) => !denied.has(port)),
      ),
    ].sort((left, right) => left - right);
  }

  private async publishDynamicPortPolicy(): Promise<void> {
    await this.portPolicyClient.setLocalPorts(this.dynamicTargetPorts());
  }

  private startPortDiscovery(): void {
    if (this.revoked || this.portDiscoveryTimer) return;
    this.portDiscoveryState = "discovering";
    this.portDiscoveryIssue = null;
    this.publishPorts();
    const poll = () => void this.pollPortDiscovery();
    this.portDiscoveryTimer = setInterval(poll, PORT_DISCOVERY_INTERVAL_MS);
    this.portDiscoveryTimer.unref();
    poll();
  }

  private async listDiscoveredTcpListeners(): Promise<
    readonly { port: number; host: string; displayPort?: number }[]
  > {
    if (this.portBroker) {
      return (await this.portBroker.listTcpListeners()).map((port) => ({
        port,
        host: "127.0.0.1",
      }));
    }
    if (this.macosProcessDomain) {
      const displayPorts = await this.macosVirtualDisplayPorts();
      return (await this.macosProcessDomain.listTcpListeners()).map(
        (listener) => ({
          port: listener.port,
          host: listener.ipv4 ? "127.0.0.1" : "::1",
          ...(displayPorts.get(listener.port)
            ? { displayPort: displayPorts.get(listener.port) }
            : {}),
        }),
      );
    }
    return [];
  }

  /** Read only the bounded cooperative alias map emitted by the macOS bind
   * interposer. It influences display parity (5173 stays 5173), never network
   * authority: listener discovery and the admitted kernel port remain the
   * source of truth. Malformed or ambiguous content is ignored wholesale. */
  private async macosVirtualDisplayPorts(): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (!this.macosPortPool) return result;
    const mapPath = path.join(this.policy.paths.scratch, ".zsr-port-map");
    try {
      const metadata = await lstat(mapPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 8_192 ||
        metadata.nlink !== 1
      ) {
        return result;
      }
      const pool = new Set(this.macosPortPool.ports);
      const contents = await readFile(mapPath, "utf8");
      if (Buffer.byteLength(contents, "utf8") !== metadata.size) return result;
      for (const line of contents.split("\n")) {
        if (!line) continue;
        const match = /^(\d{1,5}) (\d{1,5})$/.exec(line);
        if (!match) return new Map();
        const requested = Number(match[1]);
        const actual = Number(match[2]);
        if (
          requested < 1 ||
          requested > 65_535 ||
          actual < 1 ||
          actual > 65_535 ||
          !pool.has(actual)
        ) {
          return new Map();
        }
        const prior = result.get(actual);
        if (prior !== undefined && prior !== requested) return new Map();
        result.set(actual, requested);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return new Map();
    }
    return result;
  }

  private async leaseDiscoveredPort(listener: {
    port: number;
    host: string;
    displayPort?: number;
  }): Promise<PortLease> {
    const request: PortRequest = {
      protocol: "tcp",
      preferredPort: listener.displayPort ?? listener.port,
      targetPort: listener.port,
      purpose: "dev-server",
    };
    let delegated: PortLease;
    if (this.portBroker) {
      // Automatic listeners never claim their familiar host port directly.
      // The browser receives only an authenticated preview façade, while this
      // unadvertised random endpoint remains an engine-internal transport.
      delegated = await this.portBroker.lease({
        protocol: "tcp",
        targetPort: request.targetPort,
        purpose: request.purpose,
      });
    } else {
      delegated = {
        leaseId: `port:${this.generation}:${randomUUID()}`,
        generation: this.generation,
        host: listener.host,
        port: listener.port,
        targetPort: listener.port,
        revoke: async () => undefined,
      };
    }
    return this.trackPortLease(delegated, request, "discovered");
  }

  private async pollPortDiscovery(): Promise<void> {
    if (this.revoked || this.portDiscoveryInFlight) return;
    this.portDiscoveryInFlight = true;
    let failureIssue: PortDiscoveryIssue = "listener-inspection-failed";
    try {
      const ignored = new Set([
        ...this.policy.document.runtime.allowedLocalPorts,
        ...this.policy.document.runtime.deniedLocalPorts,
      ]);
      const listeners = (await this.listDiscoveredTcpListeners())
        .filter((listener) => !ignored.has(listener.port))
        .sort((left, right) => left.port - right.port);
      if (listeners.length > MAX_AUTO_PORT_LEASES) {
        failureIssue = "listener-capacity-exceeded";
        throw new Error("session opened too many development listeners");
      }
      if (this.revoked) return;
      const seen = new Set(listeners.map((listener) => listener.port));
      let changed = false;
      failureIssue = "lease-allocation-failed";
      for (const listener of listeners) {
        const existing = this.discoveredPorts.get(listener.port);
        if (existing) {
          existing.missingPolls = 0;
          continue;
        }
        const lease = await this.leaseDiscoveredPort(listener);
        if (this.revoked) {
          await lease.revoke();
          return;
        }
        this.discoveredPorts.set(listener.port, { lease, missingPolls: 0 });
        changed = true;
      }
      for (const [port, state] of this.discoveredPorts) {
        if (seen.has(port)) continue;
        state.missingPolls += 1;
        if (state.missingPolls < PORT_DISCOVERY_MISSING_POLLS) continue;
        this.discoveredPorts.delete(port);
        await state.lease.revoke();
        changed = true;
      }
      if (changed || !this.portDiscoveryReady) {
        failureIssue = "policy-update-failed";
        await this.publishDynamicPortPolicy();
      }
      const healthChanged =
        this.portDiscoveryState !== "ready" || this.portDiscoveryIssue !== null;
      this.portDiscoveryReady = true;
      this.portDiscoveryState = "ready";
      this.portDiscoveryIssue = null;
      if (healthChanged) this.publishPorts();
    } catch {
      const healthChanged =
        this.portDiscoveryState !== "degraded" ||
        this.portDiscoveryIssue !== failureIssue;
      this.portDiscoveryState = "degraded";
      this.portDiscoveryIssue = failureIssue;
      if (healthChanged) this.publishPorts();
    } finally {
      this.portDiscoveryInFlight = false;
    }
  }

  trackProcess(child: ChildProcess): BoundaryProcess {
    const tracked = new TrackedBoundaryProcess(child);
    this.processRegistrationEpoch += 1;
    this.processes.add(tracked);
    this.startPortDiscovery();
    void tracked.wait().finally(() => this.processes.delete(tracked));
    if (this.revoked) void this.retireTrackedProcess(tracked);
    return tracked;
  }

  trackProcessGroup(pid: number): BoundaryProcess {
    const tracked = new TrackedBoundaryProcessGroup(pid);
    this.processRegistrationEpoch += 1;
    this.processes.add(tracked);
    this.startPortDiscovery();
    void tracked.wait().finally(() => this.processes.delete(tracked));
    // The PTY host reports its pid asynchronously. Stop can race that frame;
    // adopting after revocation must tighten authority, never reject and leave
    // an untracked process behind.
    if (this.revoked) void this.retireTrackedProcess(tracked);
    return tracked;
  }

  private retireTrackedProcess(process: BoundaryProcess): Promise<void> {
    const retirement = process.stopAndProve();
    if (!this.pendingProcessRetirements.has(retirement)) {
      this.pendingProcessRetirements.add(retirement);
      void retirement.then(
        () => this.pendingProcessRetirements.delete(retirement),
        (error) => {
          this.pendingProcessRetirements.delete(retirement);
          this.onRetirementFailure(error);
        },
      );
    }
    return retirement;
  }

  private async stopTrackedProcessesAndProve(): Promise<unknown[]> {
    const failures = new Set<unknown>();
    // The PTY host reports its process-group id asynchronously. A queued
    // adoption must join the same proof rather than arriving just after the
    // initial snapshot. One event-loop turn establishes a stable epoch; any
    // later defensive adoption is killed immediately and poisons admissions.
    for (;;) {
      const observedEpoch = this.processRegistrationEpoch;
      const results = await Promise.allSettled(
        [...this.processes].map((process) =>
          this.retireTrackedProcess(process),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") failures.add(result.reason);
      }
      const pending = await Promise.allSettled([
        ...this.pendingProcessRetirements,
      ]);
      for (const result of pending) {
        if (result.status === "rejected") failures.add(result.reason);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (
        observedEpoch === this.processRegistrationEpoch &&
        this.pendingProcessRetirements.size === 0
      ) {
        return [...failures];
      }
    }
  }

  async spawn(request: BoundarySpawnRequest): Promise<BoundaryProcess> {
    const spec = this.wrapSpawn(request);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: spec.stdio === "inherit" ? "inherit" : ["pipe", "pipe", "pipe"],
      detached: true,
    });
    return this.trackProcess(child);
  }

  async requestPort(request: PortRequest): Promise<PortLease> {
    if (this.revoked) throw new Error("execution boundary is revoked");
    const denied = new Set(this.policy.document.runtime.deniedLocalPorts);
    if (
      (request.preferredPort !== undefined &&
        denied.has(request.preferredPort)) ||
      (request.targetPort !== undefined && denied.has(request.targetPort))
    ) {
      throw new Error("a reserved control port cannot be leased");
    }
    if (this.portBroker) {
      const lease = this.trackPortLease(
        await this.portBroker.lease(request),
        request,
        "requested",
      );
      if (this.portDiscoveryReady) {
        try {
          await this.publishDynamicPortPolicy();
        } catch (error) {
          await lease.revoke();
          throw error;
        }
      }
      return lease;
    }
    if (request.protocol !== "tcp") {
      throw new Error("UDP port leases are unavailable on this platform");
    }
    const port =
      request.preferredPort ??
      this.macosPortPool?.ports.find(
        (candidate) =>
          !this.activePorts().some(
            (mapping) => mapping.targetPort === candidate,
          ),
      );
    if (!port || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        "a valid preferred port is required for a direct-network lease",
      );
    }
    if (port < 1024) {
      throw new Error("privileged development ports cannot be leased");
    }
    if (this.localTcpPorts.includes(port)) {
      throw new Error("a local service capability cannot also be a dev port");
    }
    if (
      this.macosPortPool &&
      this.policyIssued &&
      !this.macosPortPool.ports.includes(port)
    ) {
      throw new Error(
        "an exact macOS port must be requested before the process launches",
      );
    }
    if (request.targetPort !== undefined && request.targetPort !== port) {
      throw new Error(
        "a distinct namespace target port is only valid on bridged Linux",
      );
    }
    const delegated: PortLease = {
      leaseId: `port:${this.generation}:${port}`,
      generation: this.generation,
      host: "127.0.0.1",
      port,
      targetPort: request.targetPort ?? port,
      revoke: async () => undefined,
    };
    const lease = this.trackPortLease(delegated, request, "requested");
    if (this.portDiscoveryReady) {
      try {
        await this.publishDynamicPortPolicy();
      } catch (error) {
        await lease.revoke();
        throw error;
      }
    }
    return lease;
  }

  async requestLocalService(request: ServiceRequest): Promise<ServiceLease> {
    if (this.revoked) throw new Error("execution boundary is revoked");
    if (!request.serviceId.trim()) throw new Error("service id is required");
    if (!this.localServiceBroker) {
      throw new Error("local service was not declared at admission");
    }
    const delegated = this.localServiceBroker.lease(
      request.serviceId,
      request.kind,
      this.generation,
    );
    for (const [name, value] of Object.entries(delegated.env)) {
      const existing = this.serviceEnvironment.get(name);
      if (existing !== undefined && existing !== value) {
        await delegated.revoke();
        throw new Error(`local service environment collision for ${name}`);
      }
    }
    for (const [name, value] of Object.entries(delegated.env)) {
      this.serviceEnvironment.set(name, value);
    }
    let active = true;
    const lease: ServiceLease = {
      leaseId: delegated.leaseId,
      generation: delegated.generation,
      env: delegated.env,
      revoke: async () => {
        if (!active) return;
        active = false;
        await delegated.revoke();
        for (const [name, value] of Object.entries(delegated.env)) {
          if (this.serviceEnvironment.get(name) === value) {
            this.serviceEnvironment.delete(name);
          }
        }
        this.serviceLeases.delete(lease);
      },
    };
    this.serviceLeases.add(lease);
    return lease;
  }

  async synchronizeGit(): Promise<ShadowGitPromotionResult> {
    if (!this.shadowGit) {
      return {
        state: "not-applicable",
        updatedRefs: 0,
        indexUpdated: false,
      };
    }
    return this.shadowGit.synchronize();
  }

  revoke(): Promise<void> {
    if (this.revokePromise) return this.revokePromise;
    this.revoked = true;
    this.portDiscoveryState = "revoked";
    this.portDiscoveryIssue = null;
    if (this.portDiscoveryTimer) clearInterval(this.portDiscoveryTimer);
    this.portDiscoveryTimer = null;
    this.portPolicyClient.close();
    this.revokePromise = (async () => {
      const operations = [
        ...[...this.portLeases].map((lease) => lease.revoke()),
        ...[...this.serviceLeases].map((lease) => lease.revoke()),
        this.portBroker?.close() ?? Promise.resolve(),
        this.localTcpBroker?.close() ?? Promise.resolve(),
        this.localServiceBroker?.close() ?? Promise.resolve(),
        this.macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
        this.shadowGit?.revokeRemoteCapability() ?? Promise.resolve(),
      ];
      const results = await Promise.allSettled(operations);
      this.discoveredPorts.clear();
      this.portMappings.clear();
      this.publishPorts();
      this.portObservers.clear();
      this.networkBridgeToken.fill(0);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "failed to revoke boundary capabilities",
        );
      }
    })();
    return this.revokePromise;
  }

  stopAndProve(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const startedAt = Date.now();
      const failures: unknown[] = [];
      try {
        await this.revoke();
      } catch (error) {
        failures.push(error);
      }

      const processFailures = await this.stopTrackedProcessesAndProve();
      if (process.env.SRT_DEBUG) {
        console.error(
          `[zsr] tracked process groups stopped after ${Date.now() - startedAt}ms`,
        );
      }
      if (this.macosProcessDomain) {
        try {
          await this.macosProcessDomain.reap();
          if (process.env.SRT_DEBUG) {
            console.error(
              `[zsr] macOS process domain reaped after ${Date.now() - startedAt}ms`,
            );
          }
        } catch (error) {
          processFailures.push(error);
        }
      }
      failures.push(...processFailures);

      let gitFailure: unknown;
      let providerFailure: unknown;
      if (processFailures.length === 0) {
        try {
          await this.synchronizeGit();
          await this.shadowGit?.finalizeLinkedWorktrees();
        } catch (error) {
          gitFailure = error;
          failures.push(error);
        }
        try {
          if (this.providerHome) {
            const promotion = await promoteProviderHomeOverlay(
              this.providerHome,
            );
            if (promotion.conflicts.length > 0) {
              console.warn(
                `[zsr] preserved ${promotion.conflicts.length} concurrent provider ` +
                  `HOME conflict(s) in the recovery directory`,
              );
            }
          }
        } catch (error) {
          providerFailure = error;
          failures.push(error);
        }
      } else {
        gitFailure = new Error(
          "Git promotion skipped because process-domain teardown was not proven",
        );
        providerFailure = new Error(
          "provider HOME promotion skipped because process-domain teardown was not proven",
        );
      }

      try {
        await this.shadowGit?.stop();
      } catch (error) {
        failures.push(error);
        gitFailure ??= error;
      }
      if (gitFailure && this.shadowGit) {
        try {
          await this.shadowGit.preserveForRecovery(gitFailure);
        } catch (error) {
          failures.push(error);
        }
      }
      if (providerFailure && this.providerHome) {
        try {
          await preserveProviderHomeOverlay(this.providerHome, providerFailure);
        } catch (error) {
          failures.push(error);
        }
      }
      if (processFailures.length === 0 && this.macosProcessDomain) {
        try {
          await this.macosProcessDomain.retireMetadata();
        } catch (error) {
          failures.push(error);
        }
      }
      if (processFailures.length === 0) this.macosPortPool?.release();
      const disposableDirectories = [this.policy.paths.network];
      if (processFailures.length === 0 && !gitFailure) {
        disposableDirectories.unshift(this.policy.paths.root);
      }
      for (const directory of disposableDirectories) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "execution boundary teardown failed",
        );
      }
    })().catch((error) => {
      this.onRetirementFailure(error);
      throw error;
    });
    return this.stopPromise;
  }
}

export class ZsrExecutionBoundary implements ExecutionBoundary {
  readonly backend: "zeros-srt" | "cloud-worker";
  private readonly supervisorScript: string;
  private readonly supervisorRuntime: string;
  private readonly networkBridgeSource: string;
  private readonly containerWorkerSource: string;
  private readonly macosContainerHostSource: string;
  private readonly macosContainerCloudInit: string;
  private readonly macosProcessDomainHelper: string;
  private readonly macosPortBindLibrary: string;
  private capabilityProbeResult: CachedProbe | null = null;
  private capabilityProbeInFlight: Promise<CachedProbe> | null = null;
  /** Any failed proof poisons this process-lifetime boundary factory. A fresh
   * engine must run durable stale-domain recovery before it may admit more
   * repository-controlled bytes. Callers are free to report/aggregate the
   * original error, but cannot accidentally swallow the admission hold. */
  private readonly retirementFailures = new Map<TerritoryGeneration, unknown>();

  constructor(private readonly options: ZsrBoundaryOptions) {
    this.backend = options.cloudWorker ? "cloud-worker" : "zeros-srt";
    this.supervisorScript =
      options.cloudWorkerToolchain?.supervisor ??
      options.supervisorScript ??
      process.env.ZEROS_ZSR_SUPERVISOR_SCRIPT ??
      path.join(
        options.projectRoot,
        "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
      );
    this.supervisorRuntime =
      options.cloudWorkerToolchain?.node ??
      options.supervisorRuntime ??
      process.env.ZEROS_ZSR_SUPERVISOR_RUNTIME ??
      process.env.ZEROS_PTY_HOST_RUNTIME ??
      process.execPath;
    this.networkBridgeSource =
      options.cloudWorkerToolchain?.networkBridge ??
      options.networkBridgeScript ??
      process.env.ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT ??
      path.join(
        options.projectRoot,
        "apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs",
      );
    this.containerWorkerSource =
      options.cloudWorkerToolchain?.containerWorker ??
      options.containerWorkerScript ??
      process.env.ZEROS_ZSR_CONTAINER_WORKER_SCRIPT ??
      path.join(
        options.projectRoot,
        "apps/desktop/src/engine/agents/containment/zsr-container-worker.mjs",
      );
    this.macosContainerHostSource =
      options.macosContainerHostScript ??
      process.env.ZEROS_ZSR_ORBSTACK_CONTAINER_HOST_SCRIPT ??
      path.join(
        options.projectRoot,
        "apps/desktop/src/engine/agents/containment/zsr-orbstack-container-host.mjs",
      );
    this.macosContainerCloudInit =
      options.macosContainerCloudInit ??
      process.env.ZEROS_ZSR_ORBSTACK_CLOUD_INIT ??
      path.join(
        options.projectRoot,
        "apps/desktop/src/engine/agents/containment/zsr-orbstack-cloud-init.yaml",
      );
    this.macosProcessDomainHelper =
      options.macosProcessDomainHelper ??
      process.env.ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER ??
      path.join(options.projectRoot, "binaries", "zsr-macos-process-domain");
    this.macosPortBindLibrary =
      options.macosPortBindLibrary ??
      process.env.ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY ??
      path.join(options.projectRoot, "binaries", "zsr-macos-port-bind.dylib");
  }

  private macosContainerWorker(
    orbPath: string,
  ): Pick<MacosOrbStackContainerWorker, "reserve"> {
    return (
      this.options.macosContainerWorkerFactory?.(orbPath) ??
      new MacosOrbStackContainerWorker({
        orbPath,
        cloudInitPath: this.macosContainerCloudInit,
        hostScriptPath: this.macosContainerHostSource,
        containerWorkerPath: this.containerWorkerSource,
      })
    );
  }

  private async throwAfterPreparationCleanup(
    generation: TerritoryGeneration,
    primaryError: unknown,
    cleanups: readonly (() => Promise<unknown>)[],
  ): Promise<never> {
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
    );
    const cleanupFailures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      const failure = new AggregateError(
        [primaryError, ...cleanupFailures],
        "ZSR boundary preparation failed and cleanup could not be proven",
      );
      this.retirementFailures.set(generation, failure);
      throw failure;
    }
    throw primaryError;
  }

  private async runCapabilityProbe(): Promise<CachedProbe> {
    const reasons: string[] = [];
    if (process.platform !== "darwin" && process.platform !== "linux") {
      reasons.push(`unsupported platform ${process.platform}`);
    }
    if (
      !path.isAbsolute(this.supervisorScript) ||
      !existsSync(this.supervisorScript)
    ) {
      reasons.push("ZSR supervisor is missing");
    }
    if (
      !path.isAbsolute(this.supervisorRuntime) ||
      !existsSync(this.supervisorRuntime)
    ) {
      reasons.push("ZSR supervisor runtime is missing");
    }
    if (process.platform === "darwin" && reasons.length === 0) {
      try {
        await probeMacosProcessDomainHelper(
          this.macosProcessDomainHelper,
          this.options.macosProcessDomainRunner,
        );
      } catch {
        reasons.push("ZSR macOS process-domain helper is unavailable");
      }
      try {
        const metadata = lstatSync(this.macosPortBindLibrary);
        if (
          !path.isAbsolute(this.macosPortBindLibrary) ||
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          realpathSync(this.macosPortBindLibrary) !==
            this.macosPortBindLibrary ||
          (metadata.mode & 0o022) !== 0
        ) {
          throw new Error("invalid bind-port library");
        }
      } catch {
        reasons.push("ZSR macOS bind-port interposer is unavailable");
      }
    }
    if (reasons.length === 0) {
      try {
        reasons.push(...(await this.runBehavioralProbe()));
      } catch (error) {
        reasons.push(
          `ZSR live canary failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      checkedAt: Date.now(),
      result: {
        backend: this.backend,
        available: reasons.length === 0,
        secureNestedIsolation: reasons.length === 0,
        reasons,
      },
    };
  }

  async recoverStaleProcesses(): Promise<MacosProcessDomainRecoveryResult> {
    let processRecovery: MacosProcessDomainRecoveryResult;
    if (process.platform === "linux" && this.options.cloudWorker) {
      processRecovery = await recoverZsrCgroupScopes(
        this.options.cloudWorker.cgroupParent,
      );
    } else if (process.platform === "darwin") {
      processRecovery = await recoverMacosProcessDomains({
        helperPath: this.macosProcessDomainHelper,
        sessionsRoot: sessionsRoot(),
        runner: this.options.macosProcessDomainRunner,
      });
    } else {
      processRecovery = {
        discovered: 0,
        recovered: 0,
        active: 0,
        preserved: 0,
      };
    }
    if (processRecovery.active > 0) {
      throw new Error(
        `${processRecovery.active} process domain(s) still belong to a live engine`,
      );
    }
    // Only inspect/copy private Git recovery state after every stale writer is
    // proven dead. The recovery routine then repairs durable linked-worktree
    // pointers before session GC can reclaim their original metadata.
    const gitRecovery = await recoverShadowGitPreservations();
    return {
      discovered: processRecovery.discovered + gitRecovery.discovered,
      recovered: processRecovery.recovered + gitRecovery.recovered,
      active: 0,
      preserved: processRecovery.preserved + gitRecovery.preserved,
    };
  }

  private async cachedCapabilityProbe(): Promise<BoundaryProbeResult> {
    const now = Date.now();
    const cached = this.capabilityProbeResult;
    if (cached) {
      const failureTtl =
        this.options.failedProbeCacheMs ?? FAILED_PROBE_CACHE_MS;
      if (cached.result.available || now - cached.checkedAt < failureTtl) {
        return cached.result;
      }
      this.capabilityProbeResult = null;
    }
    if (!this.capabilityProbeInFlight) {
      const pending = this.runCapabilityProbe();
      this.capabilityProbeInFlight = pending;
      void pending.then(
        (result) => {
          this.capabilityProbeResult = result;
          if (this.capabilityProbeInFlight === pending) {
            this.capabilityProbeInFlight = null;
          }
        },
        () => {
          if (this.capabilityProbeInFlight === pending) {
            this.capabilityProbeInFlight = null;
          }
        },
      );
    }
    return (await this.capabilityProbeInFlight).result;
  }

  private async regularProbeFile(directory: string): Promise<string | null> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.slice(0, 256)) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const candidate = path.join(directory, entry.name);
        const stat = await lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      }
    } catch {
      // An absent prospective Design lease is still checked through access(2).
    }
    return null;
  }

  private async runExactAdmissionCanary(
    boundary: PreparedZsrBoundary,
    policy: PreparedZsrPolicy,
    request: BoundaryRequest,
    repositories: readonly CanonicalGitRepository[],
    projections: readonly ShadowGitFilesystemProjection[],
  ): Promise<string[]> {
    const canaryRoot = await mkdtemp(
      path.join(policy.document.cwd, ".zeros-zsr-admission-"),
    );
    if (this.options.cloudWorker) {
      await chown(
        canaryRoot,
        this.options.cloudWorker.uid,
        this.options.cloudWorker.gid,
      );
      await chmod(canaryRoot, 0o700);
    }
    const codeFile = path.join(canaryRoot, "code-write");
    const privateWriteFile = path.join(
      policy.paths.scratch,
      `.private-write-${randomUUID()}`,
    );
    const engineWriteFile = path.join(
      policy.paths.root,
      `.engine-write-${randomUUID()}`,
    );
    const protectedDirectories = [
      ...new Set(
        (request.territory?.protectedDesignDirectories ?? []).map((entry) =>
          path.resolve(entry),
        ),
      ),
    ];
    const designProbes = await Promise.all(
      protectedDirectories.map(async (directory) => ({
        directory,
        file: await this.regularProbeFile(directory),
      })),
    );
    let designAlias: string | null = null;
    if (protectedDirectories[0]) {
      designAlias = path.join(canaryRoot, "design-alias");
      await symlink(protectedDirectories[0], designAlias, "dir");
    }
    const toolControlFile = await this.regularProbeFile(policy.paths.tools);
    if (projections.length !== repositories.length) {
      throw new Error("Git projection count does not match repositories");
    }
    const gitProjections = repositories.map((repository, index) => {
      const projection = projections[index]!;
      const gitEntryIsDirectory = lstatSync(repository.gitEntry).isDirectory();
      let privateGitDir = projection.source;
      if (projection.readOnly) {
        const match = /^gitdir: (.+)\r?\n?$/.exec(
          readFileSync(projection.source, "utf8"),
        );
        if (!match || !path.isAbsolute(match[1]!)) {
          throw new Error("private Git worktree projection is invalid");
        }
        privateGitDir = match[1]!;
      }
      return {
        gitBinary: repository.gitBinary,
        workspace: repository.workspaceRoot,
        expectedGitDir:
          process.platform === "linux" && gitEntryIsDirectory
            ? repository.gitEntry
            : privateGitDir,
        privateGitDir,
        canonicalGitDir: repository.gitDir,
        markerName: `.zeros-zsr-projection-${randomUUID()}`,
      };
    });
    const canonicalControlFiles = repositories.flatMap((repository, index) => {
      const projection = gitProjections[index];
      const gitEntryIsDirectory = lstatSync(repository.gitEntry).isDirectory();
      return [
        repository.gitEntry,
        repository.indexPath,
        path.join(repository.gitDir, "HEAD"),
        path.join(repository.commonDir, "config"),
      ].filter((candidate) => {
        if (
          process.platform === "linux" &&
          projection &&
          (candidate === repository.gitEntry ||
            (gitEntryIsDirectory &&
              pathInsideOrEqual(candidate, repository.gitEntry)))
        ) {
          return false;
        }
        try {
          const metadata = lstatSync(candidate);
          return metadata.isFile() && !metadata.isSymbolicLink();
        } catch {
          return false;
        }
      });
    });
    const processDomainReleaseFile = path.join(
      canaryRoot,
      "process-domain-release",
    );
    const processDomain =
      process.platform === "darwin"
        ? {
            markerFile: policy.paths.processIdentityMarker,
            releaseFile: processDomainReleaseFile,
          }
        : null;
    const spec = {
      generation: boundary.generation,
      codeFile,
      privateWriteFile,
      engineWriteFile,
      policyFile: policy.paths.policy,
      designProbes,
      designAlias,
      controlWriteFiles: [
        ...canonicalControlFiles,
        ...(toolControlFile ? [toolControlFile] : []),
      ],
      controlReadFiles: canonicalControlFiles,
      gitProjections,
      processDomain,
      bindPorts:
        process.platform === "darwin"
          ? boundary.admittedMacosBindPorts()
          : null,
      ...(this.options.cloudWorker
        ? {
            cloudWorker: this.options.cloudWorker,
            enginePid: process.pid,
          }
        : {}),
    };
    let processHandle: BoundaryProcess | null = null;
    try {
      processHandle = await boundary.spawn({
        command: this.supervisorRuntime,
        args: [
          "-e",
          EXACT_CANARY_SOURCE,
          Buffer.from(JSON.stringify(spec)).toString("base64url"),
        ],
        cwd: policy.document.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: policy.paths.home,
          TMPDIR: policy.paths.scratch,
          ZEROS_ADMISSION_SENTINEL: boundary.generation,
          ZEROS_ZSR_AMBIENT_SECRET: "must-not-cross",
          ZEROS_LOCAL_WS_TOKEN: "must-not-cross",
          ZEROS_CONTROL_FD: "99",
          ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
            ? { ELECTRON_RUN_AS_NODE: "1" }
            : {}),
        },
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      let resolveFirstLine: ((line: string) => void) | null = null;
      let rejectFirstLine: ((error: Error) => void) | null = null;
      const firstLine = new Promise<string>((resolve, reject) => {
        resolveFirstLine = resolve;
        rejectFirstLine = reject;
      });
      processHandle.stdout?.setEncoding("utf8");
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stdout?.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-64 * 1024);
        const newline = stdout.indexOf("\n");
        if (newline >= 0 && resolveFirstLine) {
          resolveFirstLine(stdout.slice(0, newline));
          resolveFirstLine = null;
          rejectFirstLine = null;
        }
      });
      processHandle.stdout?.on("end", () => {
        if (processDomain && rejectFirstLine) {
          rejectFirstLine(
            new Error(
              `exact admission canary produced no process-domain attestation${
                stderr ? " (supervisor reported diagnostics)" : ""
              }${
                process.env.SRT_DEBUG && stderr
                  ? `: ${stderr.slice(-2_000)}`
                  : ""
              }`,
            ),
          );
          resolveFirstLine = null;
          rejectFirstLine = null;
        }
      });
      processHandle.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4 * 1024);
      });
      const exitPromise = processHandle.wait();
      let liveResultText: string | null = null;
      let processDomainMatched = !processDomain;
      if (processDomain) {
        let lineTimer: NodeJS.Timeout | undefined;
        liveResultText = await Promise.race([
          firstLine,
          new Promise<never>((_, reject) => {
            lineTimer = setTimeout(
              () => reject(new Error("process-domain attestation timed out")),
              PROBE_TIMEOUT_MS,
            );
          }),
        ]).finally(() => {
          if (lineTimer) clearTimeout(lineTimer);
        });
        const liveResult = JSON.parse(liveResultText) as {
          sandboxPid?: number;
        };
        processDomainMatched =
          Number.isSafeInteger(liveResult.sandboxPid) &&
          Number(liveResult.sandboxPid) > 0 &&
          (await boundary.matchesMacosProcessDomain(
            Number(liveResult.sandboxPid),
          ));
        await writeFile(processDomainReleaseFile, "release\n", {
          mode: 0o600,
          flag: "wx",
        });
      }
      let exitTimer: NodeJS.Timeout | undefined;
      const exit = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error("exact admission canary timed out")),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (exitTimer) clearTimeout(exitTimer);
      });
      if (exit.code !== 0) {
        throw new Error(
          `exact admission canary exited ${exit.code ?? exit.signal}${
            stderr ? " with supervisor diagnostics" : ""
          }`,
        );
      }
      const result = JSON.parse(liveResultText ?? stdout.trim()) as {
        codeWrite?: boolean;
        policyReadDenied?: boolean;
        processDomainMarkerReadable?: boolean;
        sandboxPid?: number;
        environmentExact?: boolean;
        designWriteDenied?: boolean[];
        designAliasWriteDenied?: boolean;
        controlWriteDenied?: boolean[];
        controlReadDenied?: boolean[];
        gitProjectionPrivate?: boolean[];
        cloudWorkerIdentity?: boolean;
        engineProcessHidden?: boolean;
        dynamicBindMapped?: boolean;
        privateStateWrite?: boolean;
        engineRootWriteDenied?: boolean;
      };
      const reasons: string[] = [];
      if (!result.codeWrite || (await readFile(codeFile, "utf8")) !== "ok\n") {
        reasons.push("exact policy cannot write normal code territory");
      }
      if (
        !result.privateStateWrite ||
        (await readFile(privateWriteFile, "utf8").catch(() => null)) !==
          "private\n"
      ) {
        reasons.push("exact policy cannot write private session state");
      }
      if (!result.engineRootWriteDenied || existsSync(engineWriteFile)) {
        reasons.push("exact policy can write unprojected engine state");
      }
      if (!result.policyReadDenied) {
        reasons.push("exact policy can read engine-private policy state");
      }
      if (processDomain && !result.processDomainMarkerReadable) {
        reasons.push(
          "exact policy cannot read its immutable process-domain marker",
        );
      }
      if (processDomain && !processDomainMatched) {
        reasons.push(
          "macOS kernel process-domain fingerprint did not match the admitted child",
        );
      }
      if (!result.environmentExact) {
        reasons.push(
          "exact policy did not preserve the authoritative child environment",
        );
      }
      const designResults = result.designWriteDenied;
      if (
        !designResults ||
        designResults.length !== designProbes.length ||
        designResults.some((denied) => !denied)
      ) {
        reasons.push(
          "exact policy can open protected Design territory for writing",
        );
      }
      if (designAlias && !result.designAliasWriteDenied) {
        reasons.push(
          "exact policy can write protected Design through an alias",
        );
      }
      const controlResults = result.controlWriteDenied;
      if (
        !controlResults ||
        controlResults.length !== spec.controlWriteFiles.length ||
        controlResults.some((denied) => !denied)
      ) {
        reasons.push(
          "exact policy can open canonical Git control state for writing",
        );
      }
      const controlReadResults = result.controlReadDenied;
      if (
        !controlReadResults ||
        controlReadResults.length !== spec.controlReadFiles.length ||
        controlReadResults.some((denied) => !denied)
      ) {
        reasons.push("exact policy can read canonical Git control state");
      }
      const projectionResults = result.gitProjectionPrivate;
      if (
        !projectionResults ||
        projectionResults.length !== gitProjections.length
      ) {
        reasons.push("Git projection canary returned an invalid result set");
      }
      for (const [index, gitProjection] of gitProjections.entries()) {
        const privateMarker = path.join(
          gitProjection.privateGitDir,
          gitProjection.markerName,
        );
        const canonicalMarker = path.join(
          gitProjection.canonicalGitDir,
          gitProjection.markerName,
        );
        const privateContent = await readFile(privateMarker, "utf8").catch(
          () => null,
        );
        if (
          !projectionResults?.[index] ||
          privateContent !== `${boundary.generation}\n` ||
          existsSync(canonicalMarker)
        ) {
          reasons.push(
            `Git projection ${index + 1} did not resolve to private shadow control state`,
          );
        }
        await rm(privateMarker, { force: true });
      }
      if (this.options.cloudWorker && !result.cloudWorkerIdentity) {
        reasons.push(
          "cloud worker did not enter its non-root zero-capability identity",
        );
      }
      if (this.options.cloudWorker && !result.engineProcessHidden) {
        reasons.push("cloud worker can inspect the trusted engine process");
      }
      if (process.platform === "darwin" && !result.dynamicBindMapped) {
        reasons.push(
          "macOS random development port escaped its exact admitted pool",
        );
      }
      return reasons;
    } catch (error) {
      if (processDomain) {
        await writeFile(processDomainReleaseFile, "release\n", {
          mode: 0o600,
          flag: "wx",
        }).catch((releaseError) => {
          if ((releaseError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw releaseError;
          }
        });
      }
      if (processHandle) await processHandle.stopAndProve().catch(() => {});
      throw error;
    } finally {
      await rm(canaryRoot, { recursive: true, force: true });
    }
  }

  private async runBehavioralProbe(): Promise<string[]> {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-probe-")),
    );
    const workspace = this.options.cloudWorker
      ? await realpath(
          await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-workspace-probe-")),
        )
      : path.join(root, "workspace");
    const design = path.join(workspace, "Zeros Design");
    const codeFile = path.join(workspace, "code.txt");
    const designFile = path.join(design, "protected.txt");
    const designCreateFile = path.join(design, "created.txt");
    const designUnlinkFile = path.join(design, "unlink.txt");
    const designRenameOutFile = path.join(design, "rename-out.txt");
    const designRenameInDestination = path.join(design, "rename-in.txt");
    const designChmodFile = path.join(design, "chmod.txt");
    const designSymlinkTargetFile = path.join(design, "symlink-target.txt");
    const hardlinkAlias = path.join(
      workspace,
      `.zeros-zsr-hardlink-${randomUUID()}`,
    );
    const symlinkAlias = path.join(
      workspace,
      `.zeros-zsr-symlink-${randomUUID()}`,
    );
    const renameOutDestination = path.join(
      workspace,
      `.zeros-zsr-rename-out-${randomUUID()}`,
    );
    const renameInSource = path.join(
      workspace,
      `.zeros-zsr-rename-in-${randomUUID()}`,
    );
    const secret = path.join(root, "engine-secret");
    const privateRoot = path.join(root, "private");
    const commands = path.join(privateRoot, "commands");
    const policyPath = path.join(privateRoot, "policy.json");
    const commandPath = path.join(commands, "canary.json");
    const childHome = this.options.cloudWorker
      ? path.join(workspace, ".home")
      : privateRoot;
    const generation = newTerritoryGeneration();
    try {
      await Promise.all([
        mkdir(design, { recursive: true, mode: 0o700 }),
        mkdir(commands, { recursive: true, mode: 0o700 }),
        mkdir(childHome, { recursive: true, mode: 0o700 }),
      ]);
      if (this.options.cloudWorker) {
        await Promise.all([
          chown(
            workspace,
            this.options.cloudWorker.uid,
            this.options.cloudWorker.gid,
          ),
          chown(
            childHome,
            this.options.cloudWorker.uid,
            this.options.cloudWorker.gid,
          ),
        ]);
        await Promise.all([chmod(workspace, 0o700), chmod(childHome, 0o700)]);
        await chmod(root, 0o711);
      }
      await Promise.all([
        writeFile(designFile, "original\n", { mode: 0o600 }),
        writeFile(designUnlinkFile, "original\n", { mode: 0o600 }),
        writeFile(designRenameOutFile, "original\n", { mode: 0o600 }),
        writeFile(designChmodFile, "original\n", { mode: 0o600 }),
        writeFile(designSymlinkTargetFile, "original\n", { mode: 0o600 }),
        writeFile(renameInSource, "code\n", { mode: 0o600 }),
        writeFile(secret, "engine-only\n", { mode: 0o600 }),
      ]);
      if (this.options.cloudWorker) {
        await Promise.all(
          [
            design,
            designFile,
            designUnlinkFile,
            designRenameOutFile,
            designChmodFile,
            designSymlinkTargetFile,
            renameInSource,
          ].map((entry) =>
            chown(
              entry,
              this.options.cloudWorker!.uid,
              this.options.cloudWorker!.gid,
            ),
          ),
        );
      }
      const policy = {
        version: 1,
        executionId: "admission-canary",
        generation,
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        filesystem: {
          allowRead: this.options.cloudWorker
            ? [
                workspace,
                "/usr",
                "/bin",
                "/sbin",
                "/lib",
                "/lib64",
                "/etc",
                "/opt",
                ...(process.execPath.startsWith("/vercel/") ? ["/vercel"] : []),
                process.execPath,
              ]
            : [],
          allowWrite: [workspace],
          denyWrite: [design, policyPath, commands],
          denyRead: [
            ...(this.options.cloudWorker ? [path.parse(workspace).root] : []),
            secret,
            policyPath,
            commands,
          ],
        },
        runtime: {
          normalNetwork: true,
          allowPty: true,
          allowedUnixSockets: [],
          allowedLocalPorts: [],
          deniedLocalPorts: [],
          ...(this.options.cloudWorker
            ? {
                cloudWorker: {
                  version: 1,
                  uid: this.options.cloudWorker.uid,
                  gid: this.options.cloudWorker.gid,
                  cgroupParent: this.options.cloudWorker.cgroupParent,
                  resources: this.options.cloudWorker.resources,
                },
              }
            : {}),
        },
      };
      const targetRuntime = this.supervisorRuntime;
      await writeFile(policyPath, `${JSON.stringify(policy)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(
        commandPath,
        `${JSON.stringify({
          version: COMMAND_DESCRIPTOR_VERSION,
          generation,
          command: targetRuntime,
          args: [
            "-e",
            CANARY_SOURCE,
            Buffer.from(
              JSON.stringify({
                codeFile,
                designFile,
                designCreateFile,
                designUnlinkFile,
                designRenameOutFile,
                designRenameInDestination,
                designChmodFile,
                designSymlinkTargetFile,
                hardlinkAlias,
                symlinkAlias,
                renameOutDestination,
                renameInSource,
                secret,
              }),
            ).toString("base64url"),
          ],
          cwd: workspace,
          internalProxyPorts: { http: 41_001, socks: 41_002 },
          portPolicy: {
            version: 1,
            generation,
            token: randomBytes(32).toString("base64url"),
            socketPath: path.join(root, "p"),
            initialPorts: [],
            bindPorts: [],
          },
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: childHome,
            TMPDIR: childHome,
          },
        })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      const child = spawn(
        this.supervisorRuntime,
        [
          this.supervisorScript,
          "--policy",
          policyPath,
          "--command",
          commandPath,
        ],
        {
          cwd: workspace,
          detached: true,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? root,
            TMPDIR: root,
            ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
              ? { ELECTRON_RUN_AS_NODE: "1" }
              : {}),
            ...(this.options.cloudWorkerToolchain
              ? {
                  ZEROS_ZSR_BWRAP_PATH: this.options.cloudWorkerToolchain.bwrap,
                  ZEROS_ZSR_SOCAT_PATH: this.options.cloudWorkerToolchain.socat,
                  ZEROS_ZSR_SETPRIV_PATH:
                    this.options.cloudWorkerToolchain.setpriv,
                }
              : {
                  ...(process.env.ZEROS_ZSR_BWRAP_PATH
                    ? {
                        ZEROS_ZSR_BWRAP_PATH: process.env.ZEROS_ZSR_BWRAP_PATH,
                      }
                    : {}),
                  ...(process.env.ZEROS_ZSR_SOCAT_PATH
                    ? {
                        ZEROS_ZSR_SOCAT_PATH: process.env.ZEROS_ZSR_SOCAT_PATH,
                      }
                    : {}),
                  ...(process.env.ZEROS_ZSR_SETPRIV_PATH
                    ? {
                        ZEROS_ZSR_SETPRIV_PATH:
                          process.env.ZEROS_ZSR_SETPRIV_PATH,
                      }
                    : {}),
                  ...(process.env.ZEROS_ZSR_SECCOMP_PATH
                    ? {
                        ZEROS_ZSR_SECCOMP_PATH:
                          process.env.ZEROS_ZSR_SECCOMP_PATH,
                      }
                    : {}),
                }),
            ...(process.env.SRT_DEBUG
              ? { SRT_DEBUG: process.env.SRT_DEBUG }
              : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (!child.pid) throw new Error("canary supervisor did not start");
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (process.env.SRT_DEBUG) process.stderr.write(chunk);
      });
      let probeTimer: NodeJS.Timeout | undefined;
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
          },
        ),
        new Promise<never>((_, reject) => {
          probeTimer = setTimeout(
            () => reject(new Error("live canary timed out")),
            PROBE_TIMEOUT_MS,
          );
        }),
      ])
        .catch(async (error) => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // Already exited.
          }
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}${
              stderr ? `: ${stderr.slice(-2_000)}` : ""
            }`,
          );
        })
        .finally(() => {
          if (probeTimer) clearTimeout(probeTimer);
        });
      if (exit.code !== 0) {
        throw new Error(
          `live canary exited ${exit.code ?? exit.signal}: ${stderr.slice(-500)}`,
        );
      }
      const result = JSON.parse(stdout.trim()) as {
        codeWrite?: boolean;
        designWriteDenied?: boolean;
        designHardlinkDenied?: boolean;
        designCreateDenied?: boolean;
        designUnlinkDenied?: boolean;
        designRenameOutDenied?: boolean;
        designRenameInDenied?: boolean;
        designChmodDenied?: boolean;
        designSymlinkWriteDenied?: boolean;
        secretReadDenied?: boolean;
      };
      const readFixture = (file: string) =>
        readFile(file, "utf8").catch(() => null);
      const [
        unchanged,
        unlinkUnchanged,
        renameOutUnchanged,
        symlinkTargetUnchanged,
        renameInUnchanged,
        chmodStat,
      ] = await Promise.all([
        readFixture(designFile),
        readFixture(designUnlinkFile),
        readFixture(designRenameOutFile),
        readFixture(designSymlinkTargetFile),
        readFixture(renameInSource),
        lstat(designChmodFile).catch(() => null),
      ]);
      const reasons: string[] = [];
      if (!result.codeWrite || (await readFile(codeFile, "utf8")) !== "ok\n") {
        reasons.push("live canary could not write normal code territory");
      }
      if (!result.designWriteDenied || unchanged !== "original\n") {
        reasons.push("live canary could mutate protected Design territory");
      }
      if (!result.designHardlinkDenied || existsSync(hardlinkAlias)) {
        reasons.push(
          "live canary could create a writable hard-link alias for protected Design territory",
        );
      }
      if (!result.designCreateDenied || existsSync(designCreateFile)) {
        reasons.push("live canary could create a file in protected Design territory");
      }
      if (!result.designUnlinkDenied || unlinkUnchanged !== "original\n") {
        reasons.push("live canary could unlink a file from protected Design territory");
      }
      if (
        !result.designRenameOutDenied ||
        renameOutUnchanged !== "original\n" ||
        existsSync(renameOutDestination)
      ) {
        reasons.push("live canary could rename a file out of protected Design territory");
      }
      if (
        !result.designRenameInDenied ||
        renameInUnchanged !== "code\n" ||
        existsSync(designRenameInDestination)
      ) {
        reasons.push("live canary could rename a file into protected Design territory");
      }
      if (
        !result.designChmodDenied ||
        !chmodStat ||
        (chmodStat.mode & 0o777) !== 0o600
      ) {
        reasons.push("live canary could change protected Design file permissions");
      }
      if (
        !result.designSymlinkWriteDenied ||
        symlinkTargetUnchanged !== "original\n" ||
        existsSync(symlinkAlias)
      ) {
        reasons.push("live canary could mutate protected Design through a symbolic-link alias");
      }
      if (!result.secretReadDenied) {
        reasons.push("live canary could read engine-private state");
      }
      return reasons;
    } finally {
      await rm(root, { recursive: true, force: true });
      if (workspace !== path.join(root, "workspace")) {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }

  async probe(_request: BoundaryRequest): Promise<BoundaryProbeResult> {
    if (this.retirementFailures.size > 0) {
      return {
        backend: this.backend,
        available: false,
        secureNestedIsolation: false,
        reasons: [
          "a prior execution boundary could not be proven stopped; restart Zeros to run stale process-domain recovery",
        ],
      };
    }
    return this.cachedCapabilityProbe();
  }

  async prepare(request: BoundaryRequest): Promise<PreparedBoundary> {
    const probe = await this.probe(request);
    if (!probe.available || !probe.secureNestedIsolation) {
      throw new Error(probe.reasons.join("; ") || "ZSR is unavailable");
    }
    const generation = newTerritoryGeneration();
    if (request.containerWorker) {
      const injectedMacosController = Boolean(
        this.options.macosContainerWorkerFactory &&
        request.containerWorker.backend === "orbstack-machine",
      );
      if (
        request.containerWorker.runtime !== "podman" ||
        (process.platform === "linux" &&
          request.containerWorker.backend !== "embedded-linux" &&
          !injectedMacosController) ||
        (process.platform === "darwin" &&
          request.containerWorker.backend !== "orbstack-machine") ||
        (process.platform !== "linux" &&
          process.platform !== "darwin" &&
          !injectedMacosController) ||
        !path.isAbsolute(request.containerWorker.executable) ||
        request.containerWorker.executable.includes("\0")
      ) {
        throw new Error("container-worker request is invalid");
      }
      const executable = realpathSync(request.containerWorker.executable);
      const metadata = lstatSync(executable);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o111) === 0
      ) {
        throw new Error("container-worker executable is unavailable");
      }
      request = {
        ...request,
        containerWorker: { ...request.containerWorker, executable },
      };
    }
    const declaredServices = request.localServices ?? [];
    const privateNetworkRoot = zsrNetworkRoot(generation);
    const privateServiceRoot = path.join(privateNetworkRoot, "services");
    const privateClientStateRoot = path.join(privateNetworkRoot, "clients");
    const preallowedPorts = new Set([
      ...(request.allowedLocalPorts ?? []),
      ...(request.trustedLocalPorts ?? []),
    ]);
    for (const service of declaredServices) {
      if (
        service.transport === "tcp" &&
        isDeniedZerosControlPort(service.targetPort)
      ) {
        throw new Error(
          "local service target is a reserved Zeros control port",
        );
      }
      if (
        service.transport === "tcp" &&
        preallowedPorts.has(service.targetPort)
      ) {
        throw new Error(
          "local service target is already directly admitted and cannot be revocable",
        );
      }
    }
    await Promise.all(
      [privateNetworkRoot, privateServiceRoot, privateClientStateRoot].map(
        async (directory) => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
        },
      ),
    );
    let localServiceBroker: ZsrLocalServiceBroker | null = null;
    try {
      localServiceBroker =
        declaredServices.length > 0
          ? await ZsrLocalServiceBroker.reserve(declaredServices, {
              socketRoot: privateServiceRoot,
              clientStateRoot: privateClientStateRoot,
              forbiddenTargetRoots: [
                zerosDataDir(),
                zerosChannelDataDir(),
                zerosStateRoot(),
                privateNetworkRoot,
              ],
            })
          : null;
    } catch (error) {
      return this.throwAfterPreparationCleanup(generation, error, [
        () => rm(privateNetworkRoot, { recursive: true, force: true }),
      ]);
    }
    let repositories: readonly CanonicalGitRepository[];
    try {
      repositories = await discoverBoundaryGitRepositories(request);
    } catch (error) {
      return this.throwAfterPreparationCleanup(generation, error, [
        () => localServiceBroker?.close() ?? Promise.resolve(),
        () => rm(privateNetworkRoot, { recursive: true, force: true }),
      ]);
    }
    const reservedGitBrokers: ShadowGitRemoteBroker[] = [];
    for (
      let repositoryIndex = 0;
      repositoryIndex < repositories.length;
      repositoryIndex += 1
    ) {
      let reservedGitBroker: ShadowGitRemoteBroker | null = null;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = await ShadowGitRemoteBroker.reserve();
        if (!isDeniedZerosControlPort(candidate.port)) {
          reservedGitBroker = candidate;
          break;
        }
        try {
          await candidate.close();
        } catch (error) {
          this.retirementFailures.set(generation, error);
          return this.throwAfterPreparationCleanup(generation, error, [
            ...reservedGitBrokers.map((broker) => () => broker.close()),
            () => localServiceBroker?.close() ?? Promise.resolve(),
            () => rm(privateNetworkRoot, { recursive: true, force: true }),
          ]);
        }
      }
      if (!reservedGitBroker) {
        return this.throwAfterPreparationCleanup(
          generation,
          new Error("could not allocate a safe shadow Git broker port"),
          [
            ...reservedGitBrokers.map((broker) => () => broker.close()),
            () => localServiceBroker?.close() ?? Promise.resolve(),
            () => rm(privateNetworkRoot, { recursive: true, force: true }),
          ],
        );
      }
      reservedGitBrokers.push(reservedGitBroker);
    }
    let macosContainerWorker: MacosContainerWorkerLease | null = null;
    if (request.containerWorker?.backend === "orbstack-machine") {
      try {
        const privateSessionRoot = sessionDir(request.executionId);
        await mkdir(privateSessionRoot, { recursive: true, mode: 0o700 });
        await chmod(privateSessionRoot, 0o700);
        const controller = this.macosContainerWorker(
          request.containerWorker.executable,
        );
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const candidate = await controller.reserve({
            executionId: request.executionId,
            workspaceRoot: request.workspaceRoot,
            additionalWriteRoots: request.additionalReadWriteRoots,
            sessionRoot: privateSessionRoot,
          });
          if (!isDeniedZerosControlPort(candidate.hostPort)) {
            macosContainerWorker = candidate;
            break;
          }
          await candidate.stopAndProve();
        }
        if (!macosContainerWorker) {
          throw new Error("could not allocate a safe private container port");
        }
        request = {
          ...request,
          allowedLocalPorts: [
            ...(request.allowedLocalPorts ?? []),
            macosContainerWorker.hostPort,
          ],
        };
      } catch (error) {
        if (
          error instanceof MacosContainerWorkerUnavailableError &&
          !macosContainerWorker
        ) {
          // Keep the code session usable and publish the existing
          // container-workflows-unavailable parity restriction. Never fall
          // back to the ambient Docker/OrbStack control socket.
          request = {
            ...request,
            containerWorker: undefined,
            containerWorkerUnavailableReason: error.reason,
          };
          console.warn(`[zsr] ${error.message}`);
        } else {
          return this.throwAfterPreparationCleanup(generation, error, [
            () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
            ...reservedGitBrokers.map((broker) => () => broker.close()),
            () => localServiceBroker?.close() ?? Promise.resolve(),
            () => rm(privateNetworkRoot, { recursive: true, force: true }),
          ]);
        }
      }
    }
    let policy: PreparedZsrPolicy;
    try {
      policy = await prepareZsrPolicy(
        reservedGitBrokers.length > 0
          ? {
              ...request,
              allowedLocalPorts: [
                ...(request.allowedLocalPorts ?? []),
                ...reservedGitBrokers.map((broker) => broker.port),
                ...(localServiceBroker?.facadePorts() ?? []),
              ],
            }
          : {
              ...request,
              allowedLocalPorts: [
                ...(request.allowedLocalPorts ?? []),
                ...(localServiceBroker?.facadePorts() ?? []),
              ],
            },
        generation,
        {
          additionalDenyWrite: repositories.flatMap((repository) => [
            repository.gitEntry,
            repository.gitDir,
            repository.commonDir,
            repository.objectDir,
            repository.indexPath,
          ]),
          additionalDenyRead: repositories.flatMap((repository) => [
            repository.gitEntry,
            repository.gitDir,
            repository.commonDir,
            repository.indexPath,
          ]),
          additionalAllowRead: repositories.map(
            (repository) => repository.objectDir,
          ),
          allowedUnixSockets: localServiceBroker?.facadeUnixSocketPaths() ?? [],
          ...(this.options.cloudWorker
            ? { cloudWorker: this.options.cloudWorker }
            : {}),
        },
      );
    } catch (error) {
      return this.throwAfterPreparationCleanup(generation, error, [
        () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
        ...reservedGitBrokers.map((broker) => () => broker.close()),
        () => localServiceBroker?.close() ?? Promise.resolve(),
        () => rm(privateNetworkRoot, { recursive: true, force: true }),
      ]);
    }
    let shadowGit: ShadowGitCollection | null = null;
    let providerHome: ProviderHomeOverlay | null = null;
    let localTcpBroker: ZsrLocalTcpBroker | null = null;
    let macosProcessDomain: MacosProcessDomain | null = null;
    let macosPortPool: MacosPortPoolReservation | null = null;
    let macosPortBindTarget: string | null = null;
    const networkBridgeToken = randomBytes(32);
    try {
      if (process.platform === "darwin") {
        macosPortPool = reserveMacosPortPool({
          excludedPorts: [
            ...policy.document.runtime.allowedLocalPorts,
            ...policy.document.runtime.deniedLocalPorts,
          ],
        });
        macosPortBindTarget = path.join(
          policy.paths.tools,
          "zsr-macos-port-bind.dylib",
        );
        await copyFile(this.macosPortBindLibrary, macosPortBindTarget);
        await chmod(macosPortBindTarget, 0o400);
        await writeFile(path.join(policy.paths.scratch, ".zsr-port-map"), "", {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      }
      const networkBridgeTarget = path.join(
        policy.paths.tools,
        "zsr-network-bridge.mjs",
      );
      await copyFile(this.networkBridgeSource, networkBridgeTarget);
      await chmod(networkBridgeTarget, 0o500);
      if (request.containerWorker?.backend === "embedded-linux") {
        const containerWorkerTarget = path.join(
          policy.paths.tools,
          "zsr-container-worker.mjs",
        );
        await copyFile(this.containerWorkerSource, containerWorkerTarget);
        await chmod(containerWorkerTarget, 0o500);
      }
      providerHome = request.providerId
        ? await prepareProviderHomeOverlay({
            providerId: request.providerId,
            workspaceRoot: policy.document.workspaceRoot,
            localHome: policy.paths.home,
            ambientEnv: {
              ...process.env,
              ...(request.providerStateEnv ?? {}),
            },
            deniedSourceRoots: policy.document.filesystem.denyRead,
          })
        : null;
      if (providerHome && providerHome.preparationConflicts.length > 0) {
        console.warn(
          `[zsr] preserved ${providerHome.preparationConflicts.length} concurrent ` +
            `provider HOME conflict(s) before session admission`,
        );
      }
      if (
        process.platform === "linux" &&
        policy.document.runtime.allowedUnixSockets.length > 0 &&
        providerHome
      ) {
        for (const root of providerHome.readOnlyHostRoots) {
          if (
            !policy.document.filesystem.allowRead.some((allowed) =>
              pathInsideOrEqual(root, allowed),
            )
          ) {
            throw new Error(
              "provider HOME compatibility root was not admitted read-only",
            );
          }
        }
      }
      const localTcpPorts = policy.document.runtime.allowedLocalPorts.filter(
        (port) => !policy.document.runtime.deniedLocalPorts.includes(port),
      );
      localTcpBroker =
        process.platform === "linux" && localTcpPorts.length > 0
          ? await ZsrLocalTcpBroker.start({
              generation,
              socketPath: path.join(policy.paths.networkBridge, "h"),
              token: networkBridgeToken,
              allowedPorts: localTcpPorts,
            })
          : null;
      shadowGit =
        repositories.length > 0
          ? await ShadowGitCollection.create({
              repositories,
              additionalWriteRoots: request.additionalReadWriteRoots,
              shadowRoot: policy.paths.shadowGit,
              privateHome: policy.paths.home,
              commandsRoot: policy.paths.commands,
              toolsRoot: policy.paths.tools,
              toolRuntime: this.supervisorRuntime,
              generation,
              ...(request.territory ? { territory: request.territory } : {}),
              remoteBrokers: reservedGitBrokers,
            })
          : null;
      if (macosContainerWorker) {
        await macosContainerWorker.start({
          generation,
          protectedRoots: request.territory?.protectedDesignDirectories ?? [],
          gitProjections: shadowGit?.filesystemProjections() ?? [],
        });
      }
      if (this.options.cloudWorker) {
        await prepareCloudWorkerPrivateState(
          policy,
          this.options.cloudWorker,
          localServiceBroker?.facadeUnixSocketPaths() ?? [],
        );
      }
      if (process.platform === "darwin") {
        macosProcessDomain = await MacosProcessDomain.create({
          helperPath: this.macosProcessDomainHelper,
          markerPath: policy.paths.processIdentityMarker,
          policyPath: policy.paths.policy,
          metadataPath: policy.paths.processDomainMetadata,
          generation,
          runner: this.options.macosProcessDomainRunner,
        });
      }
    } catch (error) {
      networkBridgeToken.fill(0);
      return this.throwAfterPreparationCleanup(generation, error, [
        () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
        () => shadowGit?.stop() ?? Promise.resolve(),
        ...reservedGitBrokers.map((broker) => () => broker.close()),
        () => localTcpBroker?.close() ?? Promise.resolve(),
        () => localServiceBroker?.close() ?? Promise.resolve(),
        async () => {
          macosPortPool?.release();
        },
        () => rm(policy.paths.root, { recursive: true, force: true }),
        () => rm(policy.paths.network, { recursive: true, force: true }),
      ]);
    }
    const boundary = new PreparedZsrBoundary(
      request,
      policy,
      this.supervisorRuntime,
      this.supervisorScript,
      this.options.cloudWorkerToolchain,
      shadowGit,
      providerHome,
      localTcpBroker,
      localServiceBroker,
      macosContainerWorker,
      macosProcessDomain,
      macosPortPool,
      macosPortBindTarget,
      networkBridgeToken,
      generation,
      this.backend,
      (error) => this.retirementFailures.set(generation, error),
    );
    try {
      const reasons = await this.runExactAdmissionCanary(
        boundary,
        policy,
        request,
        repositories,
        shadowGit?.filesystemProjections() ?? [],
      );
      if (reasons.length > 0) throw new Error(reasons.join("; "));
      return boundary;
    } catch (error) {
      try {
        await boundary.stopAndProve();
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          "exact ZSR admission failed and teardown could not be proven",
        );
      }
      throw error;
    }
  }
}
