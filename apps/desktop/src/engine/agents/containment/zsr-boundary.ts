import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  EXECUTION_BOUNDARY_STATUS_VERSION,
  type ExecutionBoundaryGitState,
  type ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import {
  nextCommandDescriptorPath,
  isDeniedZerosControlPort,
  prepareZsrPolicy,
  type PreparedZsrPolicy,
} from "./policy";
import {
  discoverCanonicalGitRepository,
  type CanonicalGitRepository,
} from "./canonical-git-repository";
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
import { boundaryParityRestrictions, newTerritoryGeneration } from "./status";
import { ZsrGitIntegrationBroker } from "./git-integration-broker";
import { AdmissionCancelledError } from "./types";
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
  TerritoryGeneration,
} from "./types";
import { stripEngineAuthorityEnv } from "../adapters/shared/config-isolation";
import {
  ensureSessionDir,
  removeSessionDir,
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
/** Retirement's twin of `SLOW_ADMISSION_REPORT_MS`. Teardown does real IO under
 * the promotion lock, so a slow one delays the NEXT admission — and reported
 * nothing until now. */
const SLOW_RETIREMENT_REPORT_MS = 1_500;
const PORT_DISCOVERY_INTERVAL_MS = 250;
const PORT_DISCOVERY_MISSING_POLLS = 8;
const MAX_AUTO_PORT_LEASES = 64;
const COMMAND_DESCRIPTOR_VERSION = 6 as const;

function canonicalExecutablePath(candidate: string): string | null {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) return null;
  try {
    const canonical = realpathSync(candidate);
    const stat = lstatSync(canonical);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0
      ? canonical
      : null;
  } catch {
    return null;
  }
}

/** SRT shells out to ripgrep while constructing filesystem policy. Keep that
 * dependency product-owned: packaged builds use the staged supervisor sibling,
 * source builds use the exact optional dependency, and cloud images may retain
 * their qualified system binary as a final fallback. */
function resolveZsrRipgrepPath(
  projectRoot: string,
  supervisorScript: string,
  explicit?: string,
): string | null {
  const configured = explicit?.trim();
  if (configured) return canonicalExecutablePath(configured) ?? configured;

  for (const candidate of [
    path.join(path.dirname(supervisorScript), "zsr-rg"),
    path.join(projectRoot, "binaries", "zsr-rg"),
  ]) {
    const canonical = canonicalExecutablePath(candidate);
    if (canonical) return canonical;
  }

  try {
    const packageName = "@vscode/ripgrep";
    const sourceRequire = createRequire(
      typeof __filename === "string"
        ? __filename
        : path.join(process.cwd(), "package.json"),
    );
    const packageEntry = sourceRequire.resolve(packageName);
    const packageRequire = createRequire(packageEntry);
    const binary = process.platform === "win32" ? "rg.exe" : "rg";
    const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const canonical = canonicalExecutablePath(
      packageRequire.resolve(`${platformPackage}/bin/${binary}`),
    );
    if (canonical) return canonical;
  } catch {
    // A compiled engine has no node_modules; packaged and cloud fallbacks remain.
  }

  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const canonical = canonicalExecutablePath(path.join(directory, binary));
    if (canonical) return canonical;
  }
  return null;
}

/** TLS-trust variables whose absence the admission canary pins. Host parity
 * must leave every one exactly as the caller set it and never synthesize one.
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
  const physicalDirectory = (candidate: string, label: string): string => {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) {
      throw new Error(`${label} is unavailable`);
    }
    const resolved = realpathSync(candidate);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} is not a physical directory`);
    }
    return resolved;
  };
  // OrbStack canonicalizes every host mount before constructing the lease.
  // Build the sharing key from that same physical namespace: a lexical symlink
  // outside the workspace can point at a protected directory inside it, and
  // filtering the key before realpath used to collapse distinct deny sets onto
  // whichever shared worker happened to start first.
  const workspaceRoot = physicalDirectory(
    request.workspaceRoot,
    "workspace root",
  );
  const additionalWriteRoots = [...(request.additionalReadWriteRoots ?? [])]
    .map((root) => physicalDirectory(root, "additional write root"))
    .sort();
  const projectionRoots = [workspaceRoot, ...additionalWriteRoots];
  const key = JSON.stringify({
    workspaceRoot,
    additionalWriteRoots,
    protectedDesignRoots: [
      ...(request.territory?.protectedDesignDirectories ?? []),
    ]
      .map((root) => physicalDirectory(root, "protected Design root"))
      // Match the worker's actual authority, not the host fence's app-wide
      // union. Unmounted sibling roots cannot change this VM's descriptor and
      // must not force a second private machine/port for the same workspace.
      .filter((root) =>
        projectionRoots.some((projected) =>
          pathInsideOrEqual(root, projected),
        ),
      )
      .sort(),
    executable: request.containerWorker?.executable
      ? realpathSync(request.containerWorker.executable)
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

/** Only the trusted supervisor sees this environment. In particular it never
 * receives provider/session values: those are carried in the private command
 * descriptor and materialized by `/usr/bin/env -i` inside Seatbelt/bwrap. */
function supervisorBootstrapEnv(
  policy: PreparedZsrPolicy,
  cloudToolchain?: CloudWorkerToolchain,
  ripgrepPath?: string | null,
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
    // SRT debug output is emitted by the trusted supervisor on stderr.
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
    ...(ripgrepPath ? { ZEROS_ZSR_RIPGREP_PATH: ripgrepPath } : {}),
    ...(cloudToolchain
      ? {
          ZEROS_ZSR_BWRAP_PATH: cloudToolchain.bwrap,
          ZEROS_ZSR_SETPRIV_PATH: cloudToolchain.setpriv,
        }
      : {
          ...(process.env.ZEROS_ZSR_BWRAP_PATH
            ? { ZEROS_ZSR_BWRAP_PATH: process.env.ZEROS_ZSR_BWRAP_PATH }
            : {}),
          ...(process.env.ZEROS_ZSR_SETPRIV_PATH
            ? { ZEROS_ZSR_SETPRIV_PATH: process.env.ZEROS_ZSR_SETPRIV_PATH }
            : {}),
        }),
  };
}

function containedChildEnv(
  request: BoundarySpawnRequest,
): Record<string, string> {
  const env = stripEngineAuthorityEnv({ ...request.env });
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("ZEROS_ZSR_") ||
      AMBIENT_CONTAINER_SELECTOR_ENV.has(name)
    ) {
      delete env[name];
    }
  }
  // This is the pre-ZSR child environment except for engine control
  // capabilities that were never user authority. The prepared boundary may
  // subsequently prefix its read-only Git integration dispatcher to PATH;
  // HOME, XDG roots, user Git settings, Keychain/SSH sockets, GH tokens,
  // proxy settings, and language-tool variables survive. Ambient container
  // selectors do not: only a generation-private worker may add them back.
  return env;
}

const AMBIENT_CONTAINER_SELECTOR_ENV = new Set([
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_HOST",
  "PODMAN_HOST",
]);

/** Known or explicitly advertised host-daemon sockets. Linux masks existing
 * endpoints in the mount namespace; macOS subtracts connect/bind operations in
 * SRT's host-parity Seatbelt profile. The list is deliberately endpoint-shaped
 * rather than a broad runtime-directory deny so SSH agents and ordinary local
 * tools retain host parity. */
function ambientContainerSocketPaths(
  environment: Readonly<Record<string, string>>,
): string[] {
  const sockets = new Set<string>([
    "/private/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman/podman.sock",
    "/var/run/docker.sock",
    "/var/run/podman/podman.sock",
  ]);
  const addSocket = (candidate: string | undefined): void => {
    const value = candidate?.trim();
    if (!value || value.includes("\0")) return;
    const socket = value.startsWith("unix://") ? value.slice(7) : value;
    if (!path.isAbsolute(socket)) return;
    sockets.add(path.normalize(socket));
  };
  for (const name of ["DOCKER_HOST", "CONTAINER_HOST", "PODMAN_HOST"]) {
    addSocket(environment[name]);
  }
  const home = environment.HOME?.trim();
  if (home && path.isAbsolute(home) && !home.includes("\0")) {
    addSocket(path.join(home, ".docker", "run", "docker.sock"));
    addSocket(path.join(home, ".orbstack", "run", "docker.sock"));
    addSocket(
      path.join(
        home,
        ".local",
        "share",
        "containers",
        "podman",
        "machine",
        "podman.sock",
      ),
    );
  }
  const xdgRuntime = environment.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntime && path.isAbsolute(xdgRuntime) && !xdgRuntime.includes("\0")) {
    addSocket(path.join(xdgRuntime, "docker.sock"));
    addSocket(path.join(xdgRuntime, "podman", "podman.sock"));
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    addSocket(path.join("/run/user", String(uid), "docker.sock"));
    addSocket(path.join("/run/user", String(uid), "podman", "podman.sock"));
  }
  return [...sockets].sort((left, right) => left.localeCompare(right));
}

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
// between this spawn and the child; under parity it must rewrite nothing. A silent injection
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

export interface ZsrBoundaryOptions {
  projectRoot: string;
  supervisorScript?: string;
  supervisorRuntime?: string;
  /** Product-owned ripgrep executable required by SRT policy construction. */
  ripgrepPath?: string;
  containerWorkerScript?: string;
  /** Linux helper copied into the dedicated OrbStack container machine. */
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
  gitDispatchBinary?: string;
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

/** Host-parity sessions use the workspace repository directly. Legacy status
 * states remain in the protocol, but this backend reports only native or
 * not-applicable. */
function boundaryGitState(
  request: BoundaryRequest,
): ExecutionBoundaryGitState {
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
    ...(request.containerWorker
      ? {
          services: {
            state: "ready" as const,
            activeCount: 1,
            kinds: ["podman" as const],
          },
        }
      : {}),
    git: { state: boundaryGitState(request) },
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
    // A ChildProcess `error` without a listener is process-fatal. Spawn-time
    // failures are awaited by PreparedZsrBoundary.spawn (or owned by the
    // synchronous wrapSpawn caller); retain a lifetime listener for the rarer
    // post-spawn errors so supervision never turns one into an engine crash.
    child.on("error", () => {});
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

/** Preparation may have created a durable macOS process fingerprint before a
 * later branch failed. Reap and retire that fingerprint before deleting its
 * policy tree; if reap is unproven, retaining the tree is required for startup
 * recovery to identify and kill the surviving process domain. */
export async function cleanupZsrPreparationProcessDomain(
  processDomain: Pick<MacosProcessDomain, "reap" | "retireMetadata"> | null,
  policyRoot: string,
): Promise<void> {
  if (processDomain) {
    await processDomain.reap();
    await processDomain.retireMetadata();
  }
  await rm(policyRoot, { recursive: true, force: true });
}

class PreparedZsrBoundary implements PreparedBoundary {
  readonly generation;
  readonly status;
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
  private portDiscoveryTimer: NodeJS.Timeout | null = null;
  private portDiscoveryInFlight = false;
  private portDiscoveryReady = false;
  private portDiscoveryState: PortDiscoveryStatus["state"] = "idle";
  private portDiscoveryIssue: PortDiscoveryIssue | null = null;
  private revoked = false;
  private revokePromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly request: BoundaryRequest,
    private readonly policy: PreparedZsrPolicy,
    private readonly runtime: string,
    private readonly supervisorScript: string,
    private readonly cloudWorkerToolchain: CloudWorkerToolchain | undefined,
    private readonly ripgrepPath: string | null,
    private readonly gitIntegrationBroker: ZsrGitIntegrationBroker | null,
    private readonly macosContainerWorker: MacosContainerWorkerLease | null,
    private readonly macosProcessDomain: MacosProcessDomain | null,
    generation: ReturnType<typeof newTerritoryGeneration>,
    backend: "zeros-srt" | "cloud-worker",
    private readonly onRetirementFailure: (error: unknown) => void,
  ) {
    this.generation = generation;
    this.status = statusFor(request, generation, backend);
    this.providerHomePath =
      request.providerStateEnv?.HOME ?? process.env.HOME ?? policy.paths.home;
  }

  matchesMacosProcessDomain(pid: number): Promise<boolean> {
    if (!this.macosProcessDomain) return Promise.resolve(true);
    return this.macosProcessDomain.matches(pid);
  }

  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec {
    if (this.revoked) throw new Error("execution boundary is revoked");
    if (!path.isAbsolute(request.command) || !path.isAbsolute(request.cwd)) {
      throw new Error("boundary spawn requires absolute command and cwd");
    }
    const descriptor = nextCommandDescriptorPath(this.policy.paths);
    const allowedUnixSockets = new Set(
      this.policy.document.runtime.allowedUnixSockets.map((socket) =>
        path.normalize(socket),
      ),
    );
    const deniedContainerSockets = ambientContainerSocketPaths(
      request.env,
    ).filter((socket) => !allowedUnixSockets.has(socket));
    const childEnvironment = containedChildEnv(request);
    if (this.gitIntegrationBroker) {
      Object.assign(
        childEnvironment,
        this.gitIntegrationBroker.childEnvironment(childEnvironment.PATH),
      );
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
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: COMMAND_DESCRIPTOR_VERSION,
        generation: this.generation,
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: childEnvironment,
        deniedContainerSockets,
        ...(containerWorker ? { containerWorker } : {}),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
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
      env: supervisorBootstrapEnv(
        this.policy,
        this.cloudWorkerToolchain,
        this.ripgrepPath,
      ),
      stdio: request.stdio ?? "pipe",
    };
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
    readonly { port: number; host: string }[]
  > {
    if (!this.macosProcessDomain) return [];
    return (await this.macosProcessDomain.listTcpListeners()).map(
      (listener) => ({
        port: listener.port,
        host: listener.ipv4 ? "127.0.0.1" : "::1",
      }),
    );
  }

  private async leaseDiscoveredPort(listener: {
    port: number;
    host: string;
  }): Promise<PortLease> {
    const request: PortRequest = {
      protocol: "tcp",
      preferredPort: listener.port,
      targetPort: listener.port,
      purpose: "dev-server",
    };
    return this.trackPortLease(
      {
        leaseId: `port:${this.generation}:${randomUUID()}`,
        generation: this.generation,
        host: listener.host,
        port: listener.port,
        targetPort: listener.port,
        revoke: async () => undefined,
      },
      request,
      "discovered",
    );
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
      for (const listener of listeners) {
        const existing = this.discoveredPorts.get(listener.port);
        if (existing) {
          existing.missingPolls = 0;
          continue;
        }
        failureIssue = "lease-allocation-failed";
        const lease = await this.leaseDiscoveredPort(listener);
        if (this.revoked) {
          await lease.revoke();
          return;
        }
        this.discoveredPorts.set(listener.port, { lease, missingPolls: 0 });
      }
      for (const [port, state] of this.discoveredPorts) {
        if (seen.has(port)) continue;
        state.missingPolls += 1;
        if (state.missingPolls < PORT_DISCOVERY_MISSING_POLLS) continue;
        this.discoveredPorts.delete(port);
        await state.lease.revoke();
      }
      const healthChanged =
        !this.portDiscoveryReady ||
        this.portDiscoveryState !== "ready" ||
        this.portDiscoveryIssue !== null;
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
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return this.trackProcess(child);
  }

  async requestPort(request: PortRequest): Promise<PortLease> {
    if (this.revoked) throw new Error("execution boundary is revoked");
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
    return this.trackPortLease(
      {
        leaseId: `port:${this.generation}:${request.protocol}:${port}`,
        generation: this.generation,
        host: "127.0.0.1",
        port,
        targetPort: port,
        revoke: async () => undefined,
      },
      request,
      "requested",
    );
  }

  revoke(): Promise<void> {
    if (this.revokePromise) return this.revokePromise;
    this.revoked = true;
    this.portDiscoveryState = "revoked";
    this.portDiscoveryIssue = null;
    if (this.portDiscoveryTimer) clearInterval(this.portDiscoveryTimer);
    this.portDiscoveryTimer = null;
    this.revokePromise = (async () => {
      const results = await Promise.allSettled([
        ...[...this.portLeases].map((lease) => lease.revoke()),
        this.macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
        this.gitIntegrationBroker?.close() ?? Promise.resolve(),
      ]);
      this.discoveredPorts.clear();
      this.portMappings.clear();
      this.publishPorts();
      this.portObservers.clear();
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
      try {
        await this.revoke();
      } catch (error) {
        failures.push(error);
      }
      stage("revoke");

      failures.push(...(await this.stopTrackedProcessesAndProve()));
      stage("processes");
      if (this.macosProcessDomain) {
        try {
          await this.macosProcessDomain.reap();
        } catch (error) {
          failures.push(error);
        }
      }
      stage("domain");
      if (failures.length === 0 && this.macosProcessDomain) {
        try {
          await this.macosProcessDomain.retireMetadata();
        } catch (error) {
          failures.push(error);
        }
      }
      stage("metadata");

      if (failures.length === 0) {
        const reclaimed = await Promise.allSettled([
          rm(this.policy.paths.root, { recursive: true, force: true }),
          rm(this.policy.paths.network, { recursive: true, force: true }),
        ]);
        failures.push(
          ...reclaimed.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          ),
        );
      }
      stage("reclaim");
      if (failures.length === 0) {
        try {
          await removeSessionDir(this.request.executionId);
        } catch (error) {
          failures.push(error);
        }
      }
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
  private readonly ripgrepPath: string | null;
  private readonly containerWorkerSource: string;
  private readonly macosContainerHostSource: string;
  private readonly macosContainerCloudInit: string;
  private readonly macosProcessDomainHelper: string;
  private readonly gitDispatchBinary: string;
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
    this.ripgrepPath = resolveZsrRipgrepPath(
      options.projectRoot,
      this.supervisorScript,
      options.ripgrepPath ??
        (options.cloudWorkerToolchain
          ? undefined
          : process.env.ZEROS_ZSR_RIPGREP_PATH),
    );
    this.containerWorkerSource =
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
    if (
      !this.ripgrepPath ||
      canonicalExecutablePath(this.ripgrepPath) === null
    ) {
      reasons.push("ZSR ripgrep runtime is missing");
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
    if (process.platform === "darwin") {
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
    // Cursor keeps its own crash-recovery overlay for older sessions. Current
    // host-parity boundaries create no mutable Git/HOME projection to recover.
    const { recoverCursorStateOverlays } =
      await import("../adapters/cursor-sdk/state-overlay");
    const recovery = await recoverCursorStateOverlays({
      sessionsRoot: sessionsRoot(),
    });
    if (recovery.conflicts > 0) {
      console.warn(
        `[zsr] preserved ${recovery.conflicts} Cursor state crash-recovery conflict(s)`,
      );
    }
    return {
      discovered: recovery.discovered,
      recovered: recovery.recovered,
      active: 0,
      preserved: recovery.preserved,
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
    let gitIntegrationBroker: ZsrGitIntegrationBroker | null = null;
    let policy: PreparedZsrPolicy | null = null;
    let designGitRepositories: readonly CanonicalGitRepository[] = [];
    // Checked before each step that acquires something. A cancel between two
    // steps unwinds through the same cleanup path as any other admission
    // failure, so the caller can never observe a half-acquired boundary.
    const abortIfCancelled = (): void => {
      if (signal?.aborted) throw new AdmissionCancelledError();
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
        ...(this.options.cloudWorker
          ? { cloudWorker: this.options.cloudWorker }
          : {}),
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
      const gitIntegrationWork =
        request.actor !== "design-agent"
          ? ZsrGitIntegrationBroker.start({
              generation,
              socketPath: path.join(policy.paths.networkServices, "g"),
              toolsRoot: policy.paths.tools,
              runtime: this.supervisorRuntime,
              workspaceRoot: request.workspaceRoot,
              integrationRoots: request.gitIntegrationRoots ?? [
                request.workspaceRoot,
                ...(request.additionalGitWorkspaceRoots ?? []),
              ],
              ...(existsSync(this.gitDispatchBinary)
                ? { gitDispatchBinary: this.gitDispatchBinary }
                : {}),
              ...(this.options.cloudWorker
                ? { workerIdentity: this.options.cloudWorker }
                : {}),
            })
          : Promise.resolve(null);
      const preparation = await Promise.allSettled([
        processDomainWork,
        toolWork,
        gitIntegrationWork,
      ]);
      if (preparation[0].status === "fulfilled") {
        macosProcessDomain = preparation[0].value;
      }
      if (preparation[2].status === "fulfilled") {
        gitIntegrationBroker = preparation[2].value;
      }
      const preparationFailure = preparation.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (preparationFailure) throw preparationFailure.reason;
      if (this.options.cloudWorker) {
        await prepareCloudWorkerPrivateState(
          policy,
          this.options.cloudWorker,
          gitIntegrationBroker
            ? [path.join(policy.paths.networkServices, "g")]
            : [],
        );
      }
      // Deliberately AFTER the await: the process domain must be assigned before
      // any throw, or a cancel that lands here would abandon a live kernel
      // fingerprint instead of retiring it in the cleanup path below.
      abortIfCancelled();
      if (macosContainerWorker) {
        await macosContainerWorker.start({
          generation,
          protectedRoots: request.territory?.protectedDesignDirectories ?? [],
        });
      }
    } catch (error) {
      return this.throwAfterPreparationCleanup(
        generation,
        error,
        [
          () => macosContainerWorker?.stopAndProve() ?? Promise.resolve(),
          () => gitIntegrationBroker?.close() ?? Promise.resolve(),
          ...(policy
            ? [
                () =>
                  cleanupZsrPreparationProcessDomain(
                    macosProcessDomain,
                    policy!.paths.root,
                  ),
              ]
            : []),
          ...(policy
            ? [
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
      this.options.cloudWorkerToolchain,
      this.ripgrepPath,
      gitIntegrationBroker,
      macosContainerWorker,
      macosProcessDomain,
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

  /** Host-parity admission performs only immutable filesystem-policy work.
   * Each admission is independent, so no machine-pressure queue is needed. */
  async prepare(
    initialRequest: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary> {
    const admissionStartedAt = Date.now();
    const probe = await this.probe(initialRequest);
    if (!probe.available || !probe.secureNestedIsolation) {
      throw new Error(probe.reasons.join("; ") || "ZSR is unavailable");
    }
    let request = initialRequest;
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
    return this.admitLocalHostParity(
      request,
      newTerritoryGeneration(),
      admissionStartedAt,
      control?.signal,
    );
  }

}
