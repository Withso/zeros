import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EXECUTION_BOUNDARY_STATUS_VERSION,
  type ExecutionBoundaryGitState,
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
  armProviderHomeRecovery,
  prepareProviderHomeOverlay,
  preserveProviderHomeOverlay,
  prewarmProviderHomeOverlay,
  promoteProviderHomeOverlay,
  refillParkedProviderWorlds,
  recoverProviderHomeOverlays,
  sweepProviderHomeStorage,
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
  AdmissionGate,
  sharedAdmissionGate,
  type AdmissionSlot,
} from "./admission-gate";
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
  AdmissionControl,
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
import {
  ensureSessionDir,
  hasPendingCursorStateRecovery,
  removeSessionDir,
  sessionDir,
  sessionsRoot,
  writeSessionMeta,
} from "../session-paths";

const GRACE_MS = 2_000;
const FORCE_MS = 1_000;
const POLL_MS = 20;
const PROBE_TIMEOUT_MS = 15_000;
const FAILED_PROBE_CACHE_MS = 5_000;
/** Admissions at or above this report their stage breakdown. A user waiting
 * this long deserves an answer in the log about which stage they waited on. */
const SLOW_ADMISSION_REPORT_MS = 1_500;
/** How long after an admission the next session's provider world is built. Long
 * enough that the admission it follows — including its canary — is over. */
const PROVIDER_WORLD_PREWARM_DELAY_MS = 5_000;
/** Retirement's twin of `SLOW_ADMISSION_REPORT_MS`. Teardown does real IO under
 * the promotion lock, so a slow one delays the NEXT admission — and reported
 * nothing until now. */
const SLOW_RETIREMENT_REPORT_MS = 1_500;
const PORT_DISCOVERY_INTERVAL_MS = 250;
const PORT_DISCOVERY_MISSING_POLLS = 8;
const MAX_AUTO_PORT_LEASES = 64;
const COMMAND_DESCRIPTOR_VERSION = 5 as const;
/** Every TLS-trust variable the supervisor rewrites for the isolated profile,
 * mirrored from `CA_TRUST_VARS` in zsr-supervisor.mjs — that file ships as a
 * standalone .mjs (packaged as a bare resource and spawned by absolute path), so
 * it cannot import from src/ and the list has to exist twice.
 * __tests__/zsr-supervisor.test.ts pins the two copies to each other.
 *
 * Local host parity must leave every one of these exactly as the host set it.
 * The admission canary asserts that, because the only user-visible symptom of
 * getting it wrong is a certificate error from `git clone https://…`, `curl`, or
 * `pip install` deep inside a session that otherwise looks completely normal. */
export const CA_TRUST_ENV_NAMES = [
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
] as const;

const EMPTY_RECOVERY = {
  discovered: 0,
  recovered: 0,
  active: 0,
  preserved: 0,
} as const;

/** The state roots a local host-parity session never writes: the private-Git
 * recovery queue, provider-HOME projections, and parked provider worlds. Under
 * parity their presence means one thing — a pre-pivot build ran here — so this is
 * both the gate for the boot sweeps and the list to reclaim afterwards. */
function pivotedStateRoots(): readonly string[] {
  return [
    path.join(zerosDataDir(), "recovery", "shadow-git"),
    path.join(zerosDataDir(), "provider-home"),
    path.join(zerosDataDir(), "provider-home-parked"),
  ];
}

async function presentPivotedStateRoots(): Promise<string[]> {
  const present = await Promise.all(
    pivotedStateRoots().map(async (root) => {
      try {
        const metadata = await lstat(root);
        return metadata.isDirectory() && !metadata.isSymbolicLink()
          ? root
          : null;
      } catch {
        return null;
      }
    }),
  );
  return present.filter((root): root is string => root !== null);
}

/** Remove a swept root only once it is provably empty.
 *
 * The sweeps above already refuse to reclaim a projection whose state they could
 * not read, or that still carries a credential marker or unmerged tombstones — so
 * "empty" here is their verdict, not a second opinion. Anything they retained
 * keeps its root, and the next boot re-runs the sweep for it. Recursive deletion
 * is deliberately NOT used: this must never be the thing that discards state the
 * recovery path wanted to keep. */
async function pruneReclaimedPivotedStateRoots(
  roots: readonly string[],
): Promise<number> {
  let pruned = 0;
  for (const root of roots) {
    try {
      // Depth-first over the two-level provider/<key> layout the sweeps leave
      // behind, so an emptied parent is removed in the same pass as its children.
      for (const child of await readdir(root, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const childPath = path.join(root, child.name);
        if ((await readdir(childPath)).length === 0) {
          await rmdir(childPath);
        }
      }
      if ((await readdir(root)).length > 0) continue;
      await rmdir(root);
      pruned += 1;
    } catch {
      // Any surprise — a non-empty root, a racing writer, a permission error —
      // means leave it exactly as it is and try again next boot.
    }
  }
  return pruned;
}

interface SharedMacosContainerEntry {
  readonly lease: Promise<MacosContainerWorkerLease>;
  readonly controlExecutionId: string;
  references: number;
  stopping?: Promise<void>;
}

const sharedMacosContainerWorkers = new Map<
  string,
  SharedMacosContainerEntry
>();

class SharedMacosContainerWorkerLease implements MacosContainerWorkerLease {
  readonly hostPort: number;
  readonly machineName: string;
  readonly environment: Readonly<Record<string, string>>;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly key: string,
    private readonly entry: SharedMacosContainerEntry,
    private readonly delegate: MacosContainerWorkerLease,
  ) {
    this.hostPort = delegate.hostPort;
    this.machineName = delegate.machineName;
    this.environment = delegate.environment;
  }

  start(
    request: Parameters<MacosContainerWorkerLease["start"]>[0],
  ): Promise<void> {
    return this.delegate.start(request);
  }

  stopAndProve(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.entry.references -= 1;
      if (this.entry.references > 0) return;
      this.entry.stopping = (async () => {
        await this.delegate.stopAndProve();
        await removeSessionDir(this.entry.controlExecutionId);
      })();
      try {
        await this.entry.stopping;
      } finally {
        if (sharedMacosContainerWorkers.get(this.key) === this.entry) {
          sharedMacosContainerWorkers.delete(this.key);
        }
      }
    })();
    return this.stopPromise;
  }
}

function localWorkspaceContainerIdentity(request: BoundaryRequest): {
  key: string;
  controlExecutionId: string;
} {
  const key = JSON.stringify({
    workspaceRoot: path.resolve(request.workspaceRoot),
    additionalWriteRoots: [...(request.additionalReadWriteRoots ?? [])]
      .map((root) => path.resolve(root))
      .sort(),
    protectedDesignRoots: [
      ...(request.territory?.protectedDesignDirectories ?? []),
    ]
      .map((root) => path.resolve(root))
      .sort(),
    executable: request.containerWorker?.executable
      ? path.resolve(request.containerWorker.executable)
      : null,
  });
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return { key, controlExecutionId: `zsrw-${digest}` };
}

async function acquireSharedMacosContainerWorker(
  key: string,
  controlExecutionId: string,
  create: () => Promise<MacosContainerWorkerLease>,
): Promise<MacosContainerWorkerLease> {
  let entry = sharedMacosContainerWorkers.get(key);
  if (entry?.stopping) {
    await entry.stopping;
    return acquireSharedMacosContainerWorker(key, controlExecutionId, create);
  }
  if (!entry) {
    entry = {
      lease: Promise.resolve().then(create),
      controlExecutionId,
      references: 0,
    };
    sharedMacosContainerWorkers.set(key, entry);
  }
  entry.references += 1;
  try {
    return new SharedMacosContainerWorkerLease(key, entry, await entry.lease);
  } catch (error) {
    entry.references -= 1;
    if (
      entry.references === 0 &&
      sharedMacosContainerWorkers.get(key) === entry
    ) {
      sharedMacosContainerWorkers.delete(key);
    }
    throw error;
  }
}

function pathInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function minimalCoveringPaths(candidates: readonly string[]): string[] {
  const unique = [
    ...new Set(candidates.map((candidate) => path.resolve(candidate))),
  ];
  return unique.filter(
    (candidate) =>
      !unique.some(
        (parent) =>
          parent !== candidate && pathInsideOrEqual(candidate, parent),
      ),
  );
}

/** Electron-as-Node still asks the dynamic loader and Electron bootstrap to
 * read immutable files beside the executable. Dev-channel app bundles live
 * below Zeros' otherwise unreadable engine-state root, so admit only the
 * physical bundle contents that own the trusted runtime. The surrounding app
 * instance and all engine state remain absent, and the engine-root write deny
 * continues to cover this read-only carve-out. */
function electronRuntimeReadRoot(supervisorRuntime: string): string | null {
  if (process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON !== "1") return null;

  const requestedRuntime = path.resolve(supervisorRuntime);
  const runtime = realpathSync(requestedRuntime);
  const runtimeMetadata = lstatSync(requestedRuntime);
  if (
    !runtimeMetadata.isFile() ||
    runtimeMetadata.isSymbolicLink() ||
    runtime !== requestedRuntime ||
    (runtimeMetadata.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Electron supervisor runtime is not a trusted physical file",
    );
  }

  const runtimeDirectory = path.dirname(runtime);
  const contents = path.dirname(runtimeDirectory);
  const appBundle = path.dirname(contents);
  const isMacAppBundle =
    path.basename(runtimeDirectory) === "MacOS" &&
    path.basename(contents) === "Contents" &&
    path.extname(appBundle).toLocaleLowerCase("en-US") === ".app";
  const readRoot = isMacAppBundle ? contents : runtimeDirectory;
  for (const directory of isMacAppBundle
    ? [appBundle, contents, runtimeDirectory]
    : [runtimeDirectory]) {
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Electron supervisor runtime is not inside a trusted physical directory",
      );
    }
  }
  if (process.platform === "darwin" && !isMacAppBundle) {
    throw new Error(
      "Electron supervisor runtime is not inside a macOS app bundle",
    );
  }
  return readRoot;
}

async function discoverBoundaryGitRepositories(
  request: BoundaryRequest,
  options: { includeDesignActor?: boolean } = {},
): Promise<readonly CanonicalGitRepository[]> {
  if (request.actor === "design-agent" && !options.includeDesignActor) {
    return [];
  }
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
    // SRT debug output is emitted by the trusted supervisor/proxy on stderr.
    // Forward this opt-in diagnostic flag only to that layer; containedTarget
    // rebuilds the provider environment with `env -i`, so the agent cannot use
    // it to change logging or infer other supervisor state.
    ...(process.env.SRT_DEBUG ? { SRT_DEBUG: process.env.SRT_DEBUG } : {}),
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
  if (policy.document.runtime.localHostParity) {
    // This is the pre-ZSR child environment, byte for byte, except for engine
    // control capabilities that were never user authority. In particular HOME,
    // XDG roots, Git overrides, Keychain/SSH sockets, GH tokens, proxy settings,
    // language-tool variables, and container client variables all survive.
    return env;
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

/** Local desktop admission proves only the contract local ZSR now owns: the
 * ordinary host environment remains intact and the actor's exact write split
 * is enforced. It deliberately opens existing Design files without changing
 * bytes, so even a successful design-agent canary leaves engine-owned content
 * untouched. */
const HOST_PARITY_CANARY_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const spec = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const canOpenForWrite = (probe) => {
  try {
    if (probe.file) {
      const descriptor = fs.openSync(probe.file, fs.constants.O_WRONLY | fs.constants.O_CLOEXEC);
      fs.closeSync(descriptor);
    } else {
      fs.accessSync(probe.directory, fs.constants.W_OK);
    }
    return true;
  } catch { return false; }
};
let codeWrite = false;
try {
  fs.writeFileSync(spec.codeFile, "ok\n", { flag: "wx", mode: 0o600 });
  codeWrite = true;
  fs.unlinkSync(spec.codeFile);
} catch {}
const designWrite = spec.designProbes.map(canOpenForWrite);
let designAliasWrite = spec.designProbes.length === 0;
if (spec.designAlias) {
  const first = spec.designProbes[0];
  designAliasWrite = canOpenForWrite({
    directory: spec.designAlias,
    file: first.file ? path.join(spec.designAlias, path.basename(first.file)) : null,
  });
}
let hostRead = false;
try { fs.accessSync(spec.hostReadFile, fs.constants.R_OK); hostRead = true; } catch {}
let canonicalGitRead = spec.canonicalGitFiles.length === 0;
if (spec.canonicalGitFiles.length > 0) {
  canonicalGitRead = spec.canonicalGitFiles.every((file) => {
    try { fs.accessSync(file, fs.constants.R_OK); return true; } catch { return false; }
  });
}
const environmentExact = Object.entries(spec.expectedEnv).every(
  ([name, value]) => process.env[name] === value,
);
// Names the engine did not ask for must not appear at all. The supervisor sits
// between this spawn and the child, and it rewrites TLS-trust variables for the
// isolated profile; under parity it must rewrite nothing. A silent injection
// here is not cosmetic — it is what makes "git clone https://…" fail with a
// certificate error inside an otherwise host-identical session.
const environmentUninjected = spec.absentEnv.every(
  (name) => process.env[name] === undefined,
);
const result = {
  codeWrite,
  designWrite,
  designAliasWrite,
  hostRead,
  canonicalGitRead,
  environmentExact,
  environmentUninjected,
  sandboxPid: process.pid,
};
process.stdout.write(JSON.stringify(result) + "\n");
if (spec.processDomain) {
  const deadline = Date.now() + 10000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(spec.processDomain.releaseFile) && Date.now() < deadline) {
    Atomics.wait(waitCell, 0, 0, 4);
  }
  if (!fs.existsSync(spec.processDomain.releaseFile)) process.exitCode = 124;
}
`;

const EXACT_CANARY_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const entered = Date.now();
const spec = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
// Self-timing, reported back in the result and logged nested inside
// canary-attest. attest measures engine-spawn to this process's first line,
// which spans three process starts (supervisor, its sandbox bootstrap, this
// child) AND every probe below — one number for two very different classes of
// cost. "boot" separates them: it is everything before this line ran, so
// attest-minus-boot is the proof work itself.
const timings = {
  boot: typeof spec.spawnedAt === "number" ? entered - spec.spawnedAt : 0,
};
let timingCursor = entered;
const mark = (name) => {
  const now = Date.now();
  timings[name] = now - timingCursor;
  timingCursor = now;
};
// OPT-IN (ZEROS_ZSR_CANARY_DIAGNOSTICS=1). The FIRST child exec in this sandbox
// instance, before anything else runs, using a binary that does nothing. The
// earlier diagnostic ran git → git-repeat → true and found 1202-1870ms, then
// 242-343ms, then 1-4ms; that ordering cannot distinguish "the first exec here
// is expensive" from "git specifically is expensive", because true only ever ran
// after git had already warmed the instance. This measurement is the
// discriminator, and it decides what a warm-up would have to be: if trueFirst is
// ~1.2s and the git spawn below is then fast, ANY exec warms the instance; if
// trueFirst is a millisecond and git is still slow, only a real git call does.
if (spec.diagnostics) {
  const trueFirstStartedAt = Date.now();
  spawnSync("/usr/bin/true", [], { timeout: 5000 });
  timings.trueFirst = Date.now() - trueFirstStartedAt;
  // The discriminator that decides where the ~950ms of gitSpawn actually is.
  // git's OWN trace says the command runs in 0.215ms, so the time is outside
  // main() -- and a do-nothing binary above is 2ms, so it is not generic exec.
  // This runs git with NO repository, first, in the canary's own instance:
  //   ~900ms here and a fast gitSpawn  => the cost is the first git EXEC
  //   ~30ms here and a slow gitSpawn   => the cost is the projection ACCESS
  const versionBinary = (spec.gitProjections[0] || {}).gitBinary;
  if (versionBinary) {
    // The FLOOR: the same binary with the interposer's git redirect bypassed,
    // run FIRST so it also answers whether the git image itself is expensive.
    // Deleting DYLD_INSERT_LIBRARIES from the child does NOT do this -- the
    // rewrite happens in the PARENT's posix_spawn, so a child without the dylib
    // is still sent to the dispatcher. Only the documented bypass skips it.
    const bypass = { ...process.env };
    bypass.ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS = "1";
    const bypassStartedAt = Date.now();
    spawnSync(versionBinary, ["--version"], { env: bypass, timeout: 5000 });
    timings.gitBypassFirst = Date.now() - bypassStartedAt;
    const versionStartedAt = Date.now();
    spawnSync(versionBinary, ["--version"], { timeout: 5000 });
    timings.gitVersionFirst = Date.now() - versionStartedAt;
  }
  timingCursor = Date.now();
}
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
try {
  fs.writeFileSync(spec.codeFile, "ok\n", { flag: "wx" });
  result.codeWrite = fs.readFileSync(spec.codeFile, "utf8") === "ok\n";
  fs.unlinkSync(spec.codeFile);
  result.codeWrite = result.codeWrite && !fs.existsSync(spec.codeFile);
} catch {}
finally {
  try { fs.unlinkSync(spec.codeFile); } catch {}
}
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
mark("probes");
for (const projection of spec.gitProjections) {
  let projectionPrivate = false;
  const gitEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) {
    if (name.startsWith("GIT_") || name.startsWith("ZEROS_REAL_GIT")) delete gitEnv[name];
  }
  // OPT-IN. Git's own per-operation trace, on the ONE call that measures
  // 869-1117ms in the fence while the identical command from a later child of
  // the same boundary is 60-180ms and a cold repository-less "git --version" is
  // 32ms. Four external explanations have already died on measurement; this asks
  // git which of its own steps is slow instead of guessing a fifth.
  if (spec.diagnostics) gitEnv.GIT_TRACE_PERFORMANCE = "2";
  const spawnStartedAt = Date.now();
  const probe = spawnSync(
    projection.gitBinary,
    ["-C", projection.workspace, "rev-parse", "--absolute-git-dir"],
    { env: gitEnv, encoding: "utf8", timeout: 5000 },
  );
  if (spec.diagnostics && probe.stderr) {
    process.stderr.write("[canary-git-trace] " + probe.stderr.replace(/\n/g, "\n[canary-git-trace] ") + "\n");
  }
  // Split per projection: one git spawn inside the fence measured 1.1-1.3s in
  // production while the same command under the same generated profile
  // measures ~25ms standalone, so the spawn and the private-marker write have
  // to be reported apart before either can be blamed.
  timings.gitSpawn = (timings.gitSpawn || 0) + (Date.now() - spawnStartedAt);
  const discovered = probe.status === 0 ? probe.stdout.trim() : "";
  const markerStartedAt = Date.now();
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
  timings.gitMarker = (timings.gitMarker || 0) + (Date.now() - markerStartedAt);
  // OPT-IN ONLY. gitSpawnRepeat is the same command again in the same sandbox
  // instance: 5-6x faster in the 22:13 run, which is what established that the
  // cost is one-time per instance rather than per exec. trueLast is the
  // do-nothing binary AFTER git, kept as the control for trueFirst above --
  // together they say whether the warm state git leaves behind is general or
  // only covers the paths git itself touched. Never on by default: this block
  // adds its own second to an admission.
  if (spec.diagnostics) {
    const repeatStartedAt = Date.now();
    spawnSync(
      projection.gitBinary,
      ["-C", projection.workspace, "rev-parse", "--absolute-git-dir"],
      { env: gitEnv, encoding: "utf8", timeout: 5000 },
    );
    timings.gitSpawnRepeat =
      (timings.gitSpawnRepeat || 0) + (Date.now() - repeatStartedAt);
    const trueLastStartedAt = Date.now();
    spawnSync("/usr/bin/true", [], { env: gitEnv, timeout: 5000 });
    timings.trueLast =
      (timings.trueLast || 0) + (Date.now() - trueLastStartedAt);
  }
  result.gitProjectionPrivate.push(projectionPrivate);
}
mark("git");
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
mark("bind");
result.timings = timings;
process.stdout.write(JSON.stringify(result) + "\n");
if (spec.processDomain) {
  const deadline = Date.now() + 10000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  // 4ms, not 20ms. The engine's out-of-band process-domain verification is a
  // single native helper call; at a 20ms interval this loop added up to a full
  // interval of pure sleep to every admission, for nothing. Atomics.wait is
  // precise and costs no CPU while parked, so a tighter interval is free — and
  // the admission log now reports this wait separately (canary-release) so the
  // next measurement can tell polling apart from real verification cost.
  while (!fs.existsSync(spec.processDomain.releaseFile) && Date.now() < deadline) {
    Atomics.wait(waitCell, 0, 0, 4);
  }
  if (!fs.existsSync(spec.processDomain.releaseFile)) process.exitCode = 124;
}
`;

export interface ZsrBoundaryOptions {
  projectRoot: string;
  /** Local desktop default: preserve the pre-ZSR host environment and use ZSR
   * only as the actor-specific filesystem write fence. Tests and qualified
   * tenant backends may explicitly retain the isolated profile. */
  localHostParity?: boolean;
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
  gitDispatchBinary?: string;
  /** Deterministic qualification/test seam. Production constructors omit it
   * and execute the immutable native helper directly. */
  macosProcessDomainRunner?: MacosProcessDomainCommandRunner;
  /** Successful backend capability probes are process-lifetime stable. A
   * failure is retried after this bounded interval so installing/repairing a
   * helper does not require restarting the engine. */
  failedProbeCacheMs?: number;
  /** Deterministic test seam for admission queueing. Production shares one
   * process-wide gate because the cost being rationed is the machine's. */
  admissionGate?: AdmissionGate;
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

/** The Git row a user sees. Three genuinely different situations, and reporting
 * two of them as one is what made every local session claim "Not a Git
 * workspace": a private projection to promote (`ready`), the workspace's own
 * repository used directly (`native`), or no repository at all
 * (`not-applicable`). */
function boundaryGitState(
  request: BoundaryRequest,
  hasShadowGit: boolean,
  localHostParity: boolean,
): ExecutionBoundaryGitState {
  if (hasShadowGit) return "ready";
  if (!localHostParity) return "not-applicable";
  // `.git` is a directory in a normal checkout and a file in a linked worktree;
  // either proves the session is operating inside a repository. A submodule or
  // nested owner resolves to its own root before admission, so this does not
  // need to walk upwards.
  return existsSync(path.join(request.workspaceRoot, ".git"))
    ? "native"
    : "not-applicable";
}

function statusFor(
  request: BoundaryRequest,
  generation: ReturnType<typeof newTerritoryGeneration>,
  backend: "zeros-srt" | "cloud-worker",
  hasShadowGit: boolean,
  localHostParity: boolean,
): ExecutionBoundaryStatus {
  const restrictions = boundaryParityRestrictions(request);
  const containerRemediation =
    request.containerWorkerUnavailableReason === "insufficient-disk-space"
      ? "Free at least 4 GiB on the Mac startup volume to enable the isolated OrbStack Docker/Podman worker."
      : request.containerWorkerUnavailableReason === "design-actor-refused"
        ? "Design sessions never run containers. Run Docker/Podman work from a code session in this workspace."
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
    git: { state: boundaryGitState(request, hasShadowGit, localHostParity) },
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
  /** The projected HOME this session's provider runs with. Read by engine-side
   * adapters that must look at provider state where the CONTAINED process
   * actually writes it rather than in the user's real home. */
  readonly providerHomePath: string;
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
  /** Public on the PreparedBoundary contract: adapters with their own
   * provider-state overlay skip it under parity (see types.ts). */
  readonly localHostParity: boolean;
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
    this.localHostParity = policy.document.runtime.localHostParity === true;
    this.status = statusFor(
      request,
      generation,
      backend,
      Boolean(shadowGit),
      this.localHostParity,
    );
    this.providerHomePath = this.localHostParity
      ? (request.providerStateEnv?.HOME ??
        process.env.HOME ??
        policy.paths.home)
      : policy.paths.home;
    this.networkBridgeToken = networkBridgeToken;
    this.reverseSocketPath = path.join(policy.paths.networkBridge, "r");
    this.serviceSocketPath = path.join(policy.paths.networkBridge, "h");
    this.portPolicySocketPath = path.join(policy.paths.networkBridge, "p");
    this.localTcpPorts = policy.document.runtime.allowedLocalPorts.filter(
      (port) => !policy.document.runtime.deniedLocalPorts.includes(port),
    );
    this.portBroker =
      process.platform === "linux" && !this.localHostParity
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
      process.platform === "linux" && !this.localHostParity
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
    const credentialCapabilities = this.localHostParity
      ? []
      : deriveProviderCredentialProjection(
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

  private schedulePromotedProviderWorldPrewarm(): void {
    if (this.localHostParity) return;
    const providerId = this.request.providerId;
    if (!providerId) return;
    const timer = setTimeout(() => {
      void prewarmProviderHomeOverlay({
        providerId,
        workspaceRoot: this.policy.document.workspaceRoot,
        ...(this.request.providerStateScope
          ? { stateScope: this.request.providerStateScope }
          : {}),
        ...(this.request.providerStateEnv
          ? { providerStateEnv: this.request.providerStateEnv }
          : {}),
        deniedSourceRoots: this.policy.document.filesystem.denyRead,
        generationScopedDeniedRoots: [
          this.policy.paths.policy,
          this.policy.paths.commands,
          this.policy.paths.networkRuntime,
        ],
      });
    }, PROVIDER_WORLD_PREWARM_DELAY_MS);
    timer.unref();
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
    if (this.localHostParity) return;
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
    if (this.localHostParity) {
      const port = request.preferredPort ?? request.targetPort;
      if (!port || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("a valid preferred or target port is required");
      }
      if (
        request.targetPort !== undefined &&
        request.preferredPort !== undefined &&
        request.targetPort !== request.preferredPort
      ) {
        throw new Error("local host ports are not namespace-translated");
      }
      const delegated: PortLease = {
        leaseId: `port:${this.generation}:${request.protocol}:${port}`,
        generation: this.generation,
        host: "127.0.0.1",
        port,
        targetPort: port,
        revoke: async () => undefined,
      };
      return this.trackPortLease(delegated, request, "requested");
    }
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
    if (this.localHostParity) {
      const declared = this.request.localServices?.find(
        (service) =>
          service.serviceId === request.serviceId &&
          service.kind === request.kind,
      );
      if (!declared) {
        throw new Error("local service was not declared at admission");
      }
      let active = true;
      const lease: ServiceLease = {
        leaseId: `service:${this.generation}:${request.serviceId}`,
        generation: this.generation,
        env: {},
        revoke: async () => {
          if (!active) return;
          active = false;
          this.serviceLeases.delete(lease);
        },
      };
      this.serviceLeases.add(lease);
      return lease;
    }
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
      const retirementStages = new Map<string, number>();
      let stageStartedAt = startedAt;
      const stage = (name: string) => {
        const now = Date.now();
        retirementStages.set(name, now - stageStartedAt);
        stageStartedAt = now;
      };
      const failures: unknown[] = [];
      let revocationFailure: unknown;
      try {
        await this.revoke();
      } catch (error) {
        revocationFailure = error;
        failures.push(error);
      }
      stage("revoke");

      const processFailures = await this.stopTrackedProcessesAndProve();
      stage("processes");
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
      stage("domain");

      let gitFailure: unknown;
      let providerFailure: unknown;
      let providerRecoveryProven = false;
      // Promotion or recovery may read, move, and delete private mutable state.
      // It is safe only after both the process domain and every external
      // capability (notably an OrbStack VM that mounts the session root) have
      // been proven retired. An error from revoke() is therefore a proof
      // failure, not merely a diagnostic to append while cleanup continues.
      const mutableRuntimeProvenStopped =
        revocationFailure === undefined && processFailures.length === 0;
      if (mutableRuntimeProvenStopped) {
        try {
          await this.synchronizeGit();
          await this.shadowGit?.finalizeLinkedWorktrees();
        } catch (error) {
          gitFailure = error;
          failures.push(error);
        }
        stage("git-promote");
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
            // Promotion just moved the durable side of every parked world's
            // stamp, so any world waiting for this workspace is now a miss.
            // Rebuild it here rather than making the next admission pay: this is
            // the strongest prewarm signal there is, because nothing of this
            // session is left to contend with.
            this.schedulePromotedProviderWorldPrewarm();
          }
        } catch (error) {
          providerFailure = error;
          failures.push(error);
        }
        stage("provider-promote");
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
      if (mutableRuntimeProvenStopped && gitFailure && this.shadowGit) {
        try {
          await this.shadowGit.preserveForRecovery(gitFailure);
        } catch (error) {
          failures.push(error);
        }
      }
      if (mutableRuntimeProvenStopped && providerFailure && this.providerHome) {
        try {
          await preserveProviderHomeOverlay(this.providerHome, providerFailure);
          providerRecoveryProven = true;
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
      if (mutableRuntimeProvenStopped) this.macosPortPool?.release();
      let cursorStateRecoveryPending = false;
      if (mutableRuntimeProvenStopped) {
        cursorStateRecoveryPending = await hasPendingCursorStateRecovery(
          this.policy.paths.root,
        );
        if (cursorStateRecoveryPending) {
          failures.push(
            new Error("Cursor provider-state promotion is pending recovery"),
          );
        }
      }
      const disposableDirectories = [this.policy.paths.network];
      if (
        mutableRuntimeProvenStopped &&
        !gitFailure &&
        (!providerFailure || providerRecoveryProven) &&
        !cursorStateRecoveryPending
      ) {
        disposableDirectories.unshift(this.policy.paths.root);
      }
      for (const directory of disposableDirectories) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      stage("reclaim");
      if (failures.length === 0) {
        try {
          await removeSessionDir(this.request.executionId);
        } catch (error) {
          failures.push(error);
        }
      }
      // Retirement does real IO under the promotion lock — Git synchronization,
      // provider promotion, a process-domain reap, an OrbStack retirement — and
      // used to report none of it. An admission's twin of this line is what made
      // every stage above measurable; without it, a slow teardown is invisible
      // and can only be observed as the *next* admission waiting for a lock.
      //
      // On stderr, like every other diagnostic in this function: the
      // qualification fixtures parse their own STDOUT as a whole JSON document,
      // so an engine line there presents as a fence failure. The gate caught
      // exactly that when this line was first written to stdout.
      const retirement = Date.now() - startedAt;
      if (retirement >= SLOW_RETIREMENT_REPORT_MS || process.env.SRT_DEBUG) {
        console.error(
          `[zsr] retired ${this.request.providerId ?? this.request.actor} in ` +
            `${retirement}ms (` +
            [...retirementStages]
              .filter(([, ms]) => ms > 0)
              .map(([name, ms]) => `${name}=${ms}ms`)
              .join(" ") +
            `)`,
        );
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
  private readonly gitDispatchBinary: string;
  private readonly localHostParity: boolean;
  private capabilityProbeResult: CachedProbe | null = null;
  private capabilityProbeInFlight: Promise<CachedProbe> | null = null;
  /** Any failed proof poisons this process-lifetime boundary factory. A fresh
   * engine must run durable stale-domain recovery before it may admit more
   * repository-controlled bytes. Callers are free to report/aggregate the
   * original error, but cannot accidentally swallow the admission hold. */
  private readonly retirementFailures = new Map<TerritoryGeneration, unknown>();
  private readonly admissionGate: AdmissionGate;

  constructor(private readonly options: ZsrBoundaryOptions) {
    // Shared by default: the cost being rationed is the machine's, not this
    // factory's. Tests inject their own to assert ordering deterministically.
    this.admissionGate = options.admissionGate ?? sharedAdmissionGate;
    this.backend = options.cloudWorker ? "cloud-worker" : "zeros-srt";
    if (options.cloudWorker && options.localHostParity) {
      throw new Error("cloud workers cannot use local host parity");
    }
    // Host parity is a trusted desktop deployment decision, not a permissive
    // fallback. Any future caller that forgets to identify its environment
    // therefore receives the older isolated profile instead of accidentally
    // weakening a tenant boundary.
    this.localHostParity = options.localHostParity === true;
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
    this.gitDispatchBinary =
      options.gitDispatchBinary ??
      process.env.ZEROS_ZSR_GIT_DISPATCH_BINARY ??
      path.join(options.projectRoot, "binaries", "zsr-git-dispatch");
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

  private async provePreparationCleanup(
    generation: TerritoryGeneration,
    primaryError: unknown,
    cleanups: readonly (() => Promise<unknown>)[],
  ): Promise<void> {
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
  }

  private async throwAfterPreparationCleanup(
    generation: TerritoryGeneration,
    primaryError: unknown,
    cleanups: readonly (() => Promise<unknown>)[],
    executionId?: string,
  ): Promise<never> {
    await this.provePreparationCleanup(generation, primaryError, cleanups);
    if (executionId) {
      try {
        await removeSessionDir(executionId);
      } catch (cleanupError) {
        const failure = new AggregateError(
          [primaryError, cleanupError],
          "ZSR boundary preparation failed and its session root could not be removed",
        );
        this.retirementFailures.set(generation, failure);
        throw failure;
      }
    }
    throw primaryError;
  }

  /** Build the *next* session's provider world now, so the next admission for
   * this workspace renames it into place instead of copying the host tree again.
   *
   * Deliberately after the admission line is logged and on a timer rather than
   * inline: a prewarm is worth ~450 ms off a later admission and must never add
   * a millisecond to one in flight. `prewarmProviderHomeOverlay` declines on its
   * own if a build for the same key is already running or an admission is queued
   * behind the same promotion lock, and it never throws. */
  private scheduleProviderWorldPrewarm(
    request: BoundaryRequest,
    policy: PreparedZsrPolicy,
  ): void {
    if (!request.providerId || this.options.cloudWorker) return;
    const timer = setTimeout(() => {
      void prewarmProviderHomeOverlay({
        providerId: request.providerId,
        workspaceRoot: policy.document.workspaceRoot,
        ...(request.providerStateScope
          ? { stateScope: request.providerStateScope }
          : {}),
        ...(request.providerStateEnv
          ? { providerStateEnv: request.providerStateEnv }
          : {}),
        deniedSourceRoots: policy.document.filesystem.denyRead,
        // Enforced like every other denied root; excluded from the reusable-world
        // stamp because this generation created them for itself. Naming a root
        // here that is actually stable can only cost a park miss, never allow a
        // bad hit, so over-listing is the safe direction.
        generationScopedDeniedRoots: [
          policy.paths.policy,
          policy.paths.commands,
          policy.paths.networkRuntime,
        ],
      });
    }, PROVIDER_WORLD_PREWARM_DELAY_MS);
    timer.unref();
  }

  private async claimSessionOwnership(request: BoundaryRequest): Promise<void> {
    await ensureSessionDir(request.executionId);
    await writeSessionMeta(request.executionId, {
      agentId: request.providerId ?? request.actor,
      actor: request.actor,
      cwd: request.cwd,
      pid: process.pid,
      createdAt: Date.now(),
    });
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
      if (!this.localHostParity) {
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
    }
    if (reasons.length === 0 && !this.localHostParity) {
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
    return processRecovery;
  }

  async recoverStaleMutableState(): Promise<MacosProcessDomainRecoveryResult> {
    // The engine invokes this only after process-domain recovery and OrbStack
    // machine retirement. At that point no host child or VM can still mutate
    // the private Git/provider trees while they are reconciled.
    //
    // A local host-parity session produces NONE of this state: no private Git
    // projection, no provider-HOME overlay, no parked world. So these scans exist
    // for exactly one reason locally — residue written by a pre-pivot build — and
    // they are gated on that residue still being present. Each sweep reclaims what
    // it safely can and then `pruneReclaimedRoots` removes the roots once they
    // hold nothing, after which every later boot skips the walk entirely and the
    // pre-pivot stores stop occupying disk. Cloud/isolated engines keep running
    // them unconditionally: there they are the live crash-recovery path.
    const legacyRoots = this.localHostParity
      ? await presentPivotedStateRoots()
      : null;
    const sweepMutableState = legacyRoots === null || legacyRoots.length > 0;
    const gitRecovery = sweepMutableState
      ? await recoverShadowGitPreservations()
      : EMPTY_RECOVERY;
    const providerRecovery = await recoverProviderHomeOverlays({
      sessionsRoot: sessionsRoot(),
    });
    const providerStorage = sweepMutableState
      ? await sweepProviderHomeStorage()
      : null;
    if (providerStorage && providerStorage.archivesRemoved > 0) {
      console.log(
        `[zsr] pruned ${providerStorage.archivesRemoved} expired provider state archive(s)`,
      );
    }
    if (providerStorage && providerStorage.projectionsReclaimed > 0) {
      console.log(
        `[zsr] reclaimed ${providerStorage.projectionsReclaimed} unused provider state projection(s)`,
      );
    }
    if (legacyRoots?.length) {
      const pruned = await pruneReclaimedPivotedStateRoots(legacyRoots);
      if (pruned > 0) {
        console.log(
          `[zsr] reclaimed ${pruned} pre-parity provider/Git state root(s)`,
        );
      }
    }
    // Ready the worlds most recently in use, so the first chat opened after a
    // launch adopts instead of building. On a timer and never awaited: boot must
    // not wait on it, and it must not compete with boot's own IO either. Bounded
    // and sequential inside, so this is a trickle rather than a burst.
    if (!this.localHostParity) {
      const refill = setTimeout(() => {
        void refillParkedProviderWorlds()
          .then((refilled) => {
            if (refilled > 0) {
              console.log(`[zsr] prewarmed ${refilled} provider world(s)`);
            }
          })
          .catch(() => undefined);
      }, PROVIDER_WORLD_PREWARM_DELAY_MS);
      refill.unref();
    }
    // Session-scoped, unlike the two above: parity sessions still have session
    // directories, and a pre-pivot Cursor overlay can still be holding an unmerged
    // recovery baseline in one of them. Cheap, and it must keep running.
    const { recoverCursorStateOverlays } =
      await import("../adapters/cursor-sdk/state-overlay");
    const cursorRecovery = await recoverCursorStateOverlays({
      sessionsRoot: sessionsRoot(),
    });
    if (providerRecovery.conflicts > 0) {
      console.warn(
        `[zsr] preserved ${providerRecovery.conflicts} provider HOME crash-recovery conflict(s)`,
      );
    }
    if (cursorRecovery.conflicts > 0) {
      console.warn(
        `[zsr] preserved ${cursorRecovery.conflicts} Cursor state crash-recovery conflict(s)`,
      );
    }
    return {
      discovered:
        gitRecovery.discovered +
        providerRecovery.discovered +
        cursorRecovery.discovered,
      recovered:
        gitRecovery.recovered +
        providerRecovery.recovered +
        cursorRecovery.recovered,
      active: 0,
      preserved:
        gitRecovery.preserved +
        providerRecovery.preserved +
        cursorRecovery.preserved,
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

  private async runHostParityAdmissionCanary(
    boundary: PreparedZsrBoundary,
    policy: PreparedZsrPolicy,
    request: BoundaryRequest,
  ): Promise<string[]> {
    const canaryRoot = await mkdtemp(
      path.join(policy.paths.scratch, "host-parity-admission-"),
    );
    const codeFile = path.join(
      policy.document.cwd,
      `.zeros-zsr-code-write-${randomUUID()}`,
    );
    const designDirectories = [
      ...new Set(
        (request.territory?.protectedDesignDirectories ?? []).map((entry) =>
          path.resolve(entry),
        ),
      ),
    ];
    const designProbes = await Promise.all(
      designDirectories.map(async (directory) => ({
        directory,
        file: await this.regularProbeFile(directory),
      })),
    );
    const designAlias = designDirectories[0]
      ? path.join(canaryRoot, "design-alias")
      : null;
    if (designAlias) await symlink(designDirectories[0]!, designAlias, "dir");
    const releaseFile = path.join(canaryRoot, "process-domain-release");
    const processDomain =
      process.platform === "darwin" ? { releaseFile } : null;
    const expectedEnv = {
      HOME:
        request.providerStateEnv?.HOME ??
        process.env.HOME ??
        policy.document.workspaceRoot,
      GH_TOKEN: `zsr-gh-${boundary.generation}`,
      GITHUB_TOKEN: `zsr-github-${boundary.generation}`,
      SSH_AUTH_SOCK: path.join(canaryRoot, "host-ssh-agent.sock"),
    };
    const canonicalGitHead = path.join(
      policy.document.workspaceRoot,
      ".git",
      "HEAD",
    );
    const spec = {
      actor: policy.document.actor,
      codeFile,
      designDirectories,
      designProbes,
      designAlias,
      hostReadFile: this.supervisorRuntime,
      canonicalGitFiles: existsSync(canonicalGitHead) ? [canonicalGitHead] : [],
      expectedEnv,
      absentEnv: CA_TRUST_ENV_NAMES.filter(
        (name) => !(name in expectedEnv) && process.env[name] === undefined,
      ),
      processDomain,
    };
    let processHandle: BoundaryProcess | null = null;
    try {
      processHandle = await boundary.spawn({
        command: this.supervisorRuntime,
        args: [
          "-e",
          HOST_PARITY_CANARY_SOURCE,
          Buffer.from(JSON.stringify(spec)).toString("base64url"),
        ],
        cwd: policy.document.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...expectedEnv,
          HOST_PARITY_CANARY: boundary.generation,
          ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
            ? { ELECTRON_RUN_AS_NODE: "1" }
            : {}),
        },
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      let resolveLine: ((line: string) => void) | null = null;
      let rejectLine: ((error: Error) => void) | null = null;
      const firstLine = new Promise<string>((resolve, reject) => {
        resolveLine = resolve;
        rejectLine = reject;
      });
      processHandle.stdout?.setEncoding("utf8");
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stdout?.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-64 * 1024);
        const newline = stdout.indexOf("\n");
        if (newline >= 0 && resolveLine) {
          resolveLine(stdout.slice(0, newline));
          resolveLine = null;
          rejectLine = null;
        }
      });
      processHandle.stdout?.on("end", () => {
        if (processDomain && rejectLine) {
          rejectLine(new Error("host-parity canary produced no attestation"));
          resolveLine = null;
          rejectLine = null;
        }
      });
      processHandle.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4 * 1024);
      });
      const exitPromise = processHandle.wait();
      let lineTimer: NodeJS.Timeout | undefined;
      const liveText = processDomain
        ? await Promise.race([
            firstLine,
            new Promise<never>((_, reject) => {
              lineTimer = setTimeout(
                () => reject(new Error("host-parity canary timed out")),
                PROBE_TIMEOUT_MS,
              );
            }),
          ]).finally(() => {
            if (lineTimer) clearTimeout(lineTimer);
          })
        : null;
      const live = liveText
        ? (JSON.parse(liveText) as { sandboxPid?: number })
        : null;
      const processDomainMatched = processDomain
        ? Number.isSafeInteger(live?.sandboxPid) &&
          Number(live?.sandboxPid) > 0 &&
          (await boundary.matchesMacosProcessDomain(Number(live?.sandboxPid)))
        : true;
      if (processDomain) {
        await writeFile(releaseFile, "release\n", { mode: 0o600, flag: "wx" });
      }
      let exitTimer: NodeJS.Timeout | undefined;
      const exit = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error("host-parity canary exit timed out")),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (exitTimer) clearTimeout(exitTimer);
      });
      if (exit.code !== 0) {
        throw new Error(
          `host-parity canary exited ${exit.code ?? exit.signal}${
            stderr ? " with supervisor diagnostics" : ""
          }`,
        );
      }
      const result = JSON.parse(liveText ?? stdout.trim()) as {
        codeWrite?: boolean;
        designWrite?: boolean[];
        designAliasWrite?: boolean;
        hostRead?: boolean;
        canonicalGitRead?: boolean;
        environmentExact?: boolean;
        environmentUninjected?: boolean;
      };
      const designShouldBeWritable = policy.document.actor === "design-agent";
      const reasons: string[] = [];
      if (Boolean(result.codeWrite) === designShouldBeWritable) {
        reasons.push(
          designShouldBeWritable
            ? "host-parity design actor can write code territory"
            : "host-parity code actor cannot write code territory",
        );
      }
      if (
        !result.designWrite ||
        result.designWrite.length !== designProbes.length ||
        result.designWrite.some(
          (writable) => writable !== designShouldBeWritable,
        )
      ) {
        reasons.push("host-parity Design write split is not enforced");
      }
      if (designAlias && result.designAliasWrite !== designShouldBeWritable) {
        reasons.push("host-parity Design alias write split is not enforced");
      }
      if (!result.hostRead) reasons.push("host-parity cannot read the host");
      if (!result.canonicalGitRead) {
        reasons.push("host-parity cannot read canonical Git metadata");
      }
      if (!result.environmentExact) {
        reasons.push("host-parity did not preserve the child environment");
      }
      if (!result.environmentUninjected) {
        reasons.push(
          "host-parity injected TLS-trust variables the engine did not request",
        );
      }
      if (!processDomainMatched) {
        reasons.push("host-parity process-domain fingerprint did not match");
      }
      return reasons;
    } catch (error) {
      if (processDomain) {
        await writeFile(releaseFile, "release\n", {
          mode: 0o600,
          flag: "wx",
        }).catch(() => undefined);
      }
      if (processHandle) await processHandle.stopAndProve().catch(() => {});
      throw error;
    } finally {
      await rm(canaryRoot, { recursive: true, force: true });
      await rm(codeFile, { force: true });
    }
  }

  /** Run the behavioral canary and report both its verdict and where its time
   * went. The sub-timings exist because "the canary costs ~1s" was never
   * actionable: `setup` is probe-file/alias preparation in the engine, `attest`
   * is spawn → the sandboxed process's first attestation line (the supervisor +
   * fence + Node cold start), and `release` is everything after the engine's
   * out-of-band process-domain verification — the handshake the canary parks on.
   * Only one of those three can be optimized without weakening the proof, and
   * this is how a real run says which.
   *
   * A 441-admission Mac sample (2026-08-17) put `attest` at 1660ms p50 — 48% of
   * a median admission — while `setup` was 1ms and `release` 13ms. Direct
   * measurement then ruled out every cheap explanation: warm Node and
   * Electron-as-node starts are 40-60ms, `sandbox-exec` adds ~0, SRT's
   * import+initialize+wrap totals 100-200ms (log monitor and tlsTerminate
   * included), node-forge's RSA-2048 keygen is 11-70ms, a freshly copied
   * interposer dylib costs nothing to load, and denied operations inside the
   * fence are as cheap as allowed ones. So `attest` is reported one level
   * deeper by the canary itself — `canary-boot` (engine spawn → canary code
   * running), `canary-probes`, `canary-git`, `canary-bind` — because the
   * remaining candidates (three process starts versus per-repo `git rev-parse`
   * and the descendant bind probe, both of which cross a broker) call for
   * opposite fixes and guessing between them is what this instrumentation
   * exists to prevent. */
  private async runExactAdmissionCanary(
    boundary: PreparedZsrBoundary,
    policy: PreparedZsrPolicy,
    request: BoundaryRequest,
    repositories: readonly CanonicalGitRepository[],
    projections: readonly ShadowGitFilesystemProjection[],
    timings?: Array<readonly [string, number]>,
  ): Promise<string[]> {
    const canaryStartedAt = Date.now();
    let canaryMark = canaryStartedAt;
    const markCanary = (name: string): void => {
      const now = Date.now();
      timings?.push([name, now - canaryMark]);
      canaryMark = now;
    };
    const canaryRoot = await mkdtemp(
      path.join(policy.paths.scratch, "admission-"),
    );
    if (this.options.cloudWorker) {
      await chown(
        canaryRoot,
        this.options.cloudWorker.uid,
        this.options.cloudWorker.gid,
      );
      await chmod(canaryRoot, 0o700);
    }
    // Keep the only workspace mutation shorter than a Git-status debounce:
    // the untrusted canary creates, reads, and unlinks this exact code probe
    // synchronously. Longer-lived aliases and process-domain coordination stay
    // in engine-private scratch so they never surface as repository changes.
    const codeFile = path.join(
      policy.document.cwd,
      `.zeros-zsr-code-write-${randomUUID()}`,
    );
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
      // Opt-in extra spawns inside the fence, for localizing gitSpawn only.
      ...(process.env.ZEROS_ZSR_CANARY_DIAGNOSTICS === "1"
        ? { diagnostics: true }
        : {}),
      ...(this.options.cloudWorker
        ? {
            cloudWorker: this.options.cloudWorker,
            enginePid: process.pid,
          }
        : {}),
    };
    let processHandle: BoundaryProcess | null = null;
    markCanary("canary-setup");
    try {
      processHandle = await boundary.spawn({
        command: this.supervisorRuntime,
        args: [
          "-e",
          EXACT_CANARY_SOURCE,
          // Stamped here rather than in `spec` above so it is the instant the
          // spawn actually leaves the engine: the canary subtracts it to report
          // how much of attest was process startup versus proof work.
          Buffer.from(
            JSON.stringify({ ...spec, spawnedAt: Date.now() }),
          ).toString("base64url"),
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
        markCanary("canary-attest");
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
      markCanary(processDomain ? "canary-release" : "canary-attest");
      if (spec.diagnostics && stderr) {
        // Diagnostics-only, and stderr from the fence at that: printed, never
        // parsed, so `git`'s own performance trace can be read without giving
        // the child a channel that means anything.
        console.error(`[zsr] canary diagnostics\n${stderr.slice(-4 * 1024)}`);
      }
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
        timings?: Record<string, unknown>;
      };
      // The canary's own view of where attest went. Untrusted input used for
      // logging only — never for a verdict — so it is clamped to sane integers
      // and never allowed to invent stage names.
      for (const name of [
        "boot",
        "gitVersionFirst",
        "gitBypassFirst",
        "trueFirst",
        "probes",
        "git",
        "gitSpawn",
        "gitSpawnRepeat",
        "trueLast",
        "gitMarker",
        "bind",
      ] as const) {
        const reported = result.timings?.[name];
        if (typeof reported !== "number" || !Number.isFinite(reported))
          continue;
        const ms = Math.max(
          0,
          Math.min(PROBE_TIMEOUT_MS, Math.round(reported)),
        );
        timings?.push([`canary-${name}`, ms]);
      }
      const reasons: string[] = [];
      // The canary reports the same fact for every actor; only the expectation
      // inverts. A code actor must prove it still has ordinary code authority,
      // and a design actor must prove it has none — its mutations belong to
      // the typed Design API, never to the filesystem. Either way an orphaned
      // probe file left in the workspace fails the admission.
      if (policy.document.actor === "design-agent") {
        if (result.codeWrite || existsSync(codeFile)) {
          reasons.push("exact policy lets a design actor write code territory");
        }
      } else if (!result.codeWrite || existsSync(codeFile)) {
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
      await rm(codeFile, { force: true });
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
    const tools = path.join(privateRoot, "tools");
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
        mkdir(tools, { recursive: true, mode: 0o700 }),
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
                tools,
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
            : [tools],
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
            ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
              ? { ELECTRON_RUN_AS_NODE: "1" }
              : {}),
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
            // "close", not "exit": the canary's verdict is parsed out of
            // stdout, and exit can fire before that pipe has been drained.
            // Resolving there truncated the JSON under load and reported a
            // healthy boundary as unavailable.
            child.once("close", (code, signal) => resolve({ code, signal }));
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
        reasons.push(
          "live canary could create a file in protected Design territory",
        );
      }
      if (!result.designUnlinkDenied || unlinkUnchanged !== "original\n") {
        reasons.push(
          "live canary could unlink a file from protected Design territory",
        );
      }
      if (
        !result.designRenameOutDenied ||
        renameOutUnchanged !== "original\n" ||
        existsSync(renameOutDestination)
      ) {
        reasons.push(
          "live canary could rename a file out of protected Design territory",
        );
      }
      if (
        !result.designRenameInDenied ||
        renameInUnchanged !== "code\n" ||
        existsSync(designRenameInDestination)
      ) {
        reasons.push(
          "live canary could rename a file into protected Design territory",
        );
      }
      if (
        !result.designChmodDenied ||
        !chmodStat ||
        (chmodStat.mode & 0o777) !== 0o600
      ) {
        reasons.push(
          "live canary could change protected Design file permissions",
        );
      }
      if (
        !result.designSymlinkWriteDenied ||
        symlinkTargetUnchanged !== "original\n" ||
        existsSync(symlinkAlias)
      ) {
        reasons.push(
          "live canary could mutate protected Design through a symbolic-link alias",
        );
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

  private async admitLocalHostParity(
    initialRequest: BoundaryRequest,
    generation: TerritoryGeneration,
    admissionStartedAt: number,
    signal?: AbortSignal,
  ): Promise<PreparedBoundary> {
    let request = initialRequest;
    let macosContainerWorker: MacosContainerWorkerLease | null = null;
    let macosProcessDomain: MacosProcessDomain | null = null;
    let policy: PreparedZsrPolicy | null = null;
    let designGitRepositories: readonly CanonicalGitRepository[] = [];
    const networkBridgeToken = randomBytes(32);
    // Checked before each step that acquires something. A cancel between two
    // steps unwinds through the same cleanup path as any other admission
    // failure, so the caller can never observe a half-acquired boundary.
    const abortIfCancelled = (): void => {
      if (signal?.aborted) throw new Error("boundary admission was cancelled");
    };
    try {
      abortIfCancelled();
      await this.claimSessionOwnership(request);
      if (request.containerWorker?.backend === "orbstack-machine") {
        const containerIdentity = localWorkspaceContainerIdentity(request);
        const containerControl = await ensureSessionDir(
          containerIdentity.controlExecutionId,
        );
        try {
          macosContainerWorker = await acquireSharedMacosContainerWorker(
            containerIdentity.key,
            containerIdentity.controlExecutionId,
            async () => {
              const controller = this.macosContainerWorker(
                request.containerWorker!.executable,
              );
              for (let attempt = 0; attempt < 16; attempt += 1) {
                const candidate = await controller.reserve(
                  {
                    executionId: containerIdentity.controlExecutionId,
                    workspaceRoot: request.workspaceRoot,
                    additionalWriteRoots: request.additionalReadWriteRoots,
                    sessionRoot: containerControl.root,
                  },
                  { activation: "on-first-connection" },
                );
                if (!isDeniedZerosControlPort(candidate.hostPort)) {
                  return candidate;
                }
                await candidate.stopAndProve();
              }
              throw new Error(
                "could not allocate a safe private container port",
              );
            },
          );
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
            request = {
              ...request,
              containerWorker: undefined,
              containerWorkerUnavailableReason: error.reason,
            };
            await removeSessionDir(containerIdentity.controlExecutionId);
            console.warn(`[zsr] ${error.message}`);
          } else {
            throw error;
          }
        }
      }

      abortIfCancelled();
      if (request.actor === "design-agent") {
        designGitRepositories = await discoverBoundaryGitRepositories(request, {
          includeDesignActor: true,
        });
      }
      abortIfCancelled();
      policy = await prepareZsrPolicy(request, generation, {
        localHostParity: true,
        ...(designGitRepositories.length > 0
          ? {
              // Git replaces its index and refs atomically. Mounting an
              // individual existing index as a writable island makes rename(2)
              // fail with EBUSY even though opening the file succeeds. Grant
              // the minimal canonical metadata directories instead; this also
              // covers linked-worktree/common-dir and alternate-object layouts
              // without reopening any code-tree path.
              localHostParityWriteIslands: minimalCoveringPaths(
                designGitRepositories.flatMap((repository) => [
                  repository.gitDir,
                  repository.commonDir,
                  repository.objectDir,
                ]),
              ),
            }
          : {}),
      });
      const toolWork = (async () => {
        if (request.containerWorker?.backend !== "embedded-linux") return;
        const target = path.join(
          policy!.paths.tools,
          "zsr-container-worker.mjs",
        );
        await copyFile(this.containerWorkerSource, target);
        await chmod(target, 0o500);
      })();
      const processDomainWork =
        process.platform === "darwin"
          ? MacosProcessDomain.create({
              helperPath: this.macosProcessDomainHelper,
              markerPath: policy.paths.processIdentityMarker,
              policyPath: policy.paths.policy,
              metadataPath: policy.paths.processDomainMetadata,
              generation,
              runner: this.options.macosProcessDomainRunner,
            })
          : Promise.resolve(null);
      const [createdProcessDomain] = await Promise.all([
        processDomainWork,
        toolWork,
      ]);
      macosProcessDomain = createdProcessDomain;
      // Deliberately AFTER the await: the process domain must be assigned before
      // any throw, or a cancel that lands here would abandon a live kernel
      // fingerprint instead of retiring it in the cleanup path below.
      abortIfCancelled();
      if (macosContainerWorker) {
        await macosContainerWorker.start({
          generation,
          protectedRoots: request.territory?.protectedDesignDirectories ?? [],
          gitProjections: [],
        });
      }
    } catch (error) {
      networkBridgeToken.fill(0);
      return this.throwAfterPreparationCleanup(
        generation,
        error,
        [
          () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
          async () => {
            if (!macosProcessDomain) return;
            await macosProcessDomain.reap();
            await macosProcessDomain.retireMetadata();
          },
          ...(policy
            ? [
                () => rm(policy!.paths.root, { recursive: true, force: true }),
                () =>
                  rm(policy!.paths.network, { recursive: true, force: true }),
              ]
            : []),
        ],
        request.executionId,
      );
    }

    const boundary = new PreparedZsrBoundary(
      request,
      policy!,
      this.supervisorRuntime,
      this.supervisorScript,
      undefined,
      null,
      null,
      null,
      null,
      macosContainerWorker,
      macosProcessDomain,
      null,
      null,
      networkBridgeToken,
      generation,
      this.backend,
      (error) => this.retirementFailures.set(generation, error),
    );
    try {
      const reasons = await this.runHostParityAdmissionCanary(
        boundary,
        policy!,
        request,
      );
      if (reasons.length > 0) throw new Error(reasons.join("; "));
      // The canary is the longest single step of a parity admission, so this is
      // the check most likely to fire. It runs after the verdict rather than
      // instead of it: a cancelled admission must still leave nothing running,
      // and `stopAndProve` below is what proves that.
      abortIfCancelled();
      const elapsed = Date.now() - admissionStartedAt;
      if (elapsed >= SLOW_ADMISSION_REPORT_MS || process.env.SRT_DEBUG) {
        console.log(
          `[zsr] admitted host-parity ${request.providerId ?? request.actor} in ${elapsed}ms`,
        );
      }
      return boundary;
    } catch (error) {
      try {
        await boundary.stopAndProve();
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          "host-parity admission failed and teardown could not be proven",
        );
      }
      throw error;
    }
  }

  /** Admissions queue through a process-wide gate. Overlapping them starves
   * every stage (see admission-gate.ts for the measured numbers), and
   * engine-initiated work — chat titles, provider probes, `listSessions` —
   * must never sit in front of a session a person is waiting on. */
  async prepare(
    request: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary> {
    if (this.localHostParity) {
      // Code host-parity admission no longer copies provider worlds, discovers
      // or projects Git repositories, or provisions network brokers. The
      // future design actor discovers only canonical Git metadata for its
      // inverse write islands. Both are cheap independent filesystem-policy
      // work, so serializing them behind the isolated profile's
      // machine-pressure gate only recreates boot bursts.
      //
      // The signal still has to travel: a parity admission is short but not
      // atomic, and a chat closed mid-admission would otherwise leave a live
      // process domain, an OrbStack lease, and a policy document to be reaped by
      // teardown rather than never created. `admit` re-checks it at each of its
      // own await points.
      return this.admit(request, undefined, control?.signal);
    }
    return this.admissionGate.run(
      request.admissionPriority ?? "interactive",
      (slot) => this.admit(request, slot),
      { signal: control?.signal },
    );
  }

  /** The admission itself. Called with a gate slot already held, so the
   * container-worker fallback below re-enters HERE rather than through
   * `prepare` — re-acquiring the gate while holding a slot would deadlock. */
  private async admit(
    request: BoundaryRequest,
    slot?: AdmissionSlot,
    signal?: AbortSignal,
  ): Promise<PreparedBoundary> {
    // Admission is the single slowest thing a user waits on, and every stage
    // of it is load-bearing, so the useful thing is to say where the time
    // went rather than to guess. Only a slow admission reports; a fast one
    // stays silent.
    const admissionStartedAt = Date.now();
    const stages: Array<readonly [string, number]> = [];
    let stageStartedAt = admissionStartedAt;
    const stage = <T>(name: string, value: T): T => {
      const now = Date.now();
      stages.push([name, now - stageStartedAt]);
      stageStartedAt = now;
      return value;
    };
    // Private-Git phases, summed across every repository in the workspace and
    // logged nested inside `private-git` — the stage that is now frequently the
    // largest engine-side cost (509-2585ms measured) and has never been split.
    const gitPhases = new Map<string, number>();
    const probe = stage("probe", await this.probe(request));
    if (!probe.available || !probe.secureNestedIsolation) {
      throw new Error(probe.reasons.join("; ") || "ZSR is unavailable");
    }
    const generation = newTerritoryGeneration();
    // The current private container projection is code-oriented: repository
    // roots are writable and Design is subtracted. Giving that projection to a
    // design actor would invert its OS fence through the container API. Refuse
    // it until the worker protocol has an independently qualified inverse
    // projection. Host filesystem, network, database/API clients, and native
    // Git remain available to the design boundary; no production feature
    // selects this actor yet.
    if (request.actor === "design-agent" && request.containerWorker) {
      request = {
        ...request,
        containerWorker: undefined,
        containerWorkerUnavailableReason: "design-actor-refused",
      };
    }
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
    if (this.localHostParity) {
      return this.admitLocalHostParity(
        request,
        generation,
        admissionStartedAt,
        signal,
      );
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
      repositories = stage(
        "discover",
        await discoverBoundaryGitRepositories(request),
      );
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
    // `policy` used to bill everything between repository discovery and the
    // written policy document, which hid three unrelated things behind one
    // number. A 441-admission Mac sample put it at 30ms p50 but 811ms p90 with
    // 151 admissions over 400ms — a bimodal cost that is invisible without the
    // split, and that measuring the OrbStack CLI directly did not explain
    // (`orbctl version`/`status`/`list` are 10-70ms). So the group reports its
    // parts: one broker reservation per repository, the container-worker
    // reservation, then the policy document itself.
    stage("git-broker", null);
    const requestWithoutMacosContainerWorker = request;
    let macosContainerWorker: MacosContainerWorkerLease | null = null;
    if (request.containerWorker?.backend === "orbstack-machine") {
      try {
        await this.claimSessionOwnership(request);
        const privateSessionRoot = sessionDir(request.executionId);
        const controller = this.macosContainerWorker(
          request.containerWorker.executable,
        );
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const candidate = await controller.reserve(
            {
              executionId: request.executionId,
              workspaceRoot: request.workspaceRoot,
              additionalWriteRoots: request.additionalReadWriteRoots,
              sessionRoot: privateSessionRoot,
            },
            { activation: "on-first-connection" },
          );
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
          return this.throwAfterPreparationCleanup(
            generation,
            error,
            [
              () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
              ...reservedGitBrokers.map((broker) => () => broker.close()),
              () => localServiceBroker?.close() ?? Promise.resolve(),
              () => rm(privateNetworkRoot, { recursive: true, force: true }),
            ],
            request.executionId,
          );
        }
      }
    }
    stage("container-reserve", null);
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
          additionalAllowRead: [
            ...repositories.map((repository) => repository.objectDir),
            ...(() => {
              const runtimeReadRoot = electronRuntimeReadRoot(
                this.supervisorRuntime,
              );
              return runtimeReadRoot ? [runtimeReadRoot] : [];
            })(),
          ],
          allowedUnixSockets: localServiceBroker?.facadeUnixSocketPaths() ?? [],
          ...(this.options.cloudWorker
            ? { cloudWorker: this.options.cloudWorker }
            : {}),
        },
      );
      stage("policy", null);
      await this.claimSessionOwnership(request);
    } catch (error) {
      return this.throwAfterPreparationCleanup(
        generation,
        error,
        [
          () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
          ...reservedGitBrokers.map((broker) => () => broker.close()),
          () => localServiceBroker?.close() ?? Promise.resolve(),
          () => rm(privateNetworkRoot, { recursive: true, force: true }),
        ],
        request.executionId,
      );
    }
    let shadowGit: ShadowGitCollection | null = null;
    let providerHome: ProviderHomeOverlay | null = null;
    let localTcpBroker: ZsrLocalTcpBroker | null = null;
    let macosProcessDomain: MacosProcessDomain | null = null;
    let macosPortPool: MacosPortPoolReservation | null = null;
    let macosPortBindTarget: string | null = null;
    const networkBridgeToken = randomBytes(32);
    try {
      // ── Stage DAG (§5.2: sum → max) ──────────────────────────────────
      // Everything from here to the process domain is independent GIVEN THE
      // POLICY, and each piece writes into a different private root:
      //
      //   tool copies      → policy.paths.tools, policy.paths.scratch
      //   provider overlay → policy.paths.home
      //   shadow Git       → policy.paths.shadowGit  (a sibling of home)
      //   process domain   → policy.paths.{tools/marker, commands/metadata}
      //   local TCP broker → policy.paths.networkBridge (a socket, Linux only)
      //
      // Run serially this was a sum of four independent waits — one of them two
      // native execs, one ~45 git subprocesses, one a per-file tree copy. Run as
      // a fan-out it is their max. Nothing is reordered ACROSS a dependency:
      // the container worker still starts after shadow Git (it needs its
      // filesystem projections), the read-only host-root assertion still runs
      // after the overlay, recovery is still armed before any child, and the
      // canary still runs last, after every one of them.
      // Fired FIRST and deliberately never awaited here: it is ~900ms of
      // first-git-exec cost that has to overlap the members below rather than
      // follow them, and the canary is correct either way.
      const macosToolWork = (async () => {
        if (process.platform !== "darwin") return;
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
      })();
      const bridgeToolWork = (async () => {
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
      })();
      // Two native execs on macOS, and it needs only the policy document that
      // is already on disk — so it has no business waiting behind a file copy.
      const processDomainWork: Promise<MacosProcessDomain | null> =
        process.platform === "darwin"
          ? MacosProcessDomain.create({
              helperPath: this.macosProcessDomainHelper,
              markerPath: policy.paths.processIdentityMarker,
              policyPath: policy.paths.policy,
              metadataPath: policy.paths.processDomainMetadata,
              generation,
              runner: this.options.macosProcessDomainRunner,
            })
          : Promise.resolve(null);
      const localTcpPortsForBroker =
        policy.document.runtime.allowedLocalPorts.filter(
          (port) => !policy.document.runtime.deniedLocalPorts.includes(port),
        );
      const localTcpBrokerWork: Promise<ZsrLocalTcpBroker | null> =
        process.platform === "linux" && localTcpPortsForBroker.length > 0
          ? ZsrLocalTcpBroker.start({
              generation,
              socketPath: path.join(policy.paths.networkBridge, "h"),
              token: networkBridgeToken,
              allowedPorts: localTcpPortsForBroker,
            })
          : Promise.resolve(null);
      // Every branch of the fan-out must be settled before the catch below runs
      // its cleanup list, or a still-in-flight branch could publish a live
      // resource (a reserved port pool, a started broker, a created process
      // domain) AFTER teardown had already swept. `settleFanOut` awaits them all
      // and rethrows the first failure.
      const settleFanOut = async (primary?: unknown): Promise<void> => {
        const results = await Promise.allSettled([
          macosToolWork,
          bridgeToolWork,
          processDomainWork.then((domain) => {
            macosProcessDomain = domain;
          }),
          localTcpBrokerWork.then((broker) => {
            localTcpBroker = broker;
          }),
        ]);
        if (primary !== undefined) return;
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
      };
      // The provider HOME overlay and shadow Git are the two dominant
      // admission costs (on a real Mac each is a ~2.5s median) and they are
      // independent: the overlay only ever snapshots the provider-managed
      // relative paths under the private HOME, while shadow Git stays under
      // `<home>/git-repositories`, which the overlay never enumerates. The
      // only shared operation is an idempotent mkdir/chmod of the home root,
      // so overlapping them turns a sum into a max.
      //
      // Shadow Git is started here but still awaited in its original place:
      // recovery arming and the read-only host-root assertion keep their exact
      // prior ordering against the overlay, and nothing is reordered across
      // them. Everything shadow Git needs — the policy roots, the discovered
      // repositories, and the reserved remote brokers — already exists.
      const shadowGitWork: Promise<ShadowGitCollection | null> =
        repositories.length > 0
          ? ShadowGitCollection.create({
              repositories,
              additionalWriteRoots: request.additionalReadWriteRoots,
              shadowRoot: policy.paths.shadowGit,
              privateHome: policy.paths.home,
              commandsRoot: policy.paths.commands,
              toolsRoot: policy.paths.tools,
              toolRuntime: this.supervisorRuntime,
              // Absent in a partial checkout or an older packaged build; the
              // collection then keeps the shell-and-runtime dispatcher.
              ...(existsSync(this.gitDispatchBinary)
                ? { gitDispatchBinary: this.gitDispatchBinary }
                : {}),
              generation,
              ...(request.territory ? { territory: request.territory } : {}),
              remoteBrokers: reservedGitBrokers,
              onPhase: (name, ms) =>
                gitPhases.set(name, (gitPhases.get(name) ?? 0) + ms),
            })
          : Promise.resolve(null);
      // An overlay failure must not strand an in-flight collection, and the
      // in-flight rejection must not surface as an unhandled one either.
      let overlayFailure: unknown = null;
      try {
        providerHome = request.providerId
          ? await prepareProviderHomeOverlay({
              providerId: request.providerId,
              providerResumeId: request.providerResumeId,
              workspaceRoot: policy.document.workspaceRoot,
              ...(request.providerStateScope
                ? { stateScope: request.providerStateScope }
                : {}),
              localHome: policy.paths.home,
              ambientEnv: {
                ...process.env,
                ...(request.providerStateEnv ?? {}),
              },
              deniedSourceRoots: policy.document.filesystem.denyRead,
              generationScopedDeniedRoots: [
                policy.paths.policy,
                policy.paths.commands,
                policy.paths.networkRuntime,
              ],
            })
          : null;
      } catch (error) {
        overlayFailure = error;
      }
      if (overlayFailure) {
        await shadowGitWork
          .then((collection) => collection?.stop())
          .catch(() => undefined);
        // Settle the rest of the fan-out too, so nothing is still mid-flight
        // when the outer catch sweeps this generation's resources.
        await settleFanOut(overlayFailure);
        throw overlayFailure;
      }
      stage("provider-state", null);
      // Cloud worker roots are provisioned by the cloud lifecycle and remain
      // a separately qualified recovery surface. Local session roots carry a
      // durable merge baseline before any provider child is admitted.
      if (providerHome && !this.options.cloudWorker) {
        await armProviderHomeRecovery(providerHome);
      }
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
      // Join the fan-out: tool copies, the process domain, and the local TCP
      // broker were all started before the overlay and are collected here.
      // `settleFanOut` publishes each result onto its variable and rethrows the
      // first failure, so the outer catch's cleanup list still sees everything
      // that was actually created.
      // `undefined` is the no-failure sentinel settleFanOut keys on, so this
      // must stay undefined-initialized rather than null-initialized.
      let shadowGitFailure: unknown;
      try {
        shadowGit = await shadowGitWork;
      } catch (error) {
        shadowGitFailure = error ?? new Error("shadow Git preparation failed");
      }
      await settleFanOut(shadowGitFailure);
      if (shadowGitFailure !== undefined) throw shadowGitFailure;
      stage("private-git", null);
      if (macosContainerWorker) {
        try {
          await macosContainerWorker.start({
            generation,
            protectedRoots: request.territory?.protectedDesignDirectories ?? [],
            gitProjections: shadowGit?.filesystemProjections() ?? [],
          });
        } catch (error) {
          if (error instanceof MacosContainerWorkerUnavailableError) {
            networkBridgeToken.fill(0);
            await this.provePreparationCleanup(generation, error, [
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
            await removeSessionDir(request.executionId);
            console.warn(`[zsr] ${error.message}`);
            return this.admit({
              ...requestWithoutMacosContainerWorker,
              containerWorker: undefined,
              containerWorkerUnavailableReason: error.reason,
            });
          }
          throw error;
        }
      }
      if (this.options.cloudWorker) {
        await prepareCloudWorkerPrivateState(
          policy,
          this.options.cloudWorker,
          localServiceBroker?.facadeUnixSocketPaths() ?? [],
        );
      }
      // Already created, concurrently with the overlay and shadow Git (see the
      // stage DAG above). The marker stays here purely so the reported stage
      // sequence — and the measurement plan that reads it — is unchanged.
      stage("process-domain", null);
    } catch (error) {
      networkBridgeToken.fill(0);
      return this.throwAfterPreparationCleanup(
        generation,
        error,
        [
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
        ],
        request.executionId,
      );
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
      const canaryTimings: Array<readonly [string, number]> = [];
      const reasons = await this.runExactAdmissionCanary(
        boundary,
        policy,
        request,
        repositories,
        shadowGit?.filesystemProjections() ?? [],
        canaryTimings,
      );
      if (reasons.length > 0) throw new Error(reasons.join("; "));
      stage("canary", null);
      const total = Date.now() - admissionStartedAt;
      // Report the QUEUE separately from the work. The stage timers start once
      // a gate slot is held, so without this a queued session logs a fast
      // admission while the user watches a spinner — which is exactly the
      // measurement mistake this whole effort started from.
      const waited = slot?.waitedMs ?? 0;
      if (total + waited >= SLOW_ADMISSION_REPORT_MS || process.env.SRT_DEBUG) {
        const queue = slot
          ? ` queued=${waited}ms behind=${slot.runningOnEntry}+${slot.queuedOnEntry}`
          : "";
        console.log(
          `[zsr] admitted ${request.providerId ?? request.actor} in ${
            total + waited
          }ms (` +
            [
              ...(waited > 0 ? [`queue=${waited}ms`] : []),
              ...stages
                .filter(([, ms]) => ms > 0)
                .map(([name, ms]) => `${name}=${ms}ms`),
              // Private-Git phases, nested inside `private-git` above.
              ...[...gitPhases]
                .filter(([, ms]) => ms > 0)
                .map(([name, ms]) => `git-${name}=${ms}ms`),
              // Canary sub-timings, nested inside the `canary=` total above, so
              // a slow admission says WHICH part of the proof was slow.
              ...canaryTimings
                .filter(([, ms]) => ms > 0)
                .map(([name, ms]) => `${name}=${ms}ms`),
              // A park rate that quietly falls to zero is the whole failure mode
              // of prewarming, so every admission says which it got.
              ...(providerHome?.parked
                ? [`parked=${providerHome.parked}`]
                : []),
            ].join(" ") +
            `)${slot && waited > 0 ? queue : ""}`,
        );
      }
      this.scheduleProviderWorldPrewarm(request, policy);
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
