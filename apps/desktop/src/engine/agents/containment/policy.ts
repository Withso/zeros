import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionBoundaryActor } from "@zeros/protocol/containment";

import {
  zerosChannelDataDir,
  zerosDataDir,
  zerosStateRoot,
} from "../../db/paths";
import { sessionDir } from "../session-paths";
import {
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_BETA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
  ENGINE_PORT_SPAN,
  engineBasePort,
} from "../../runtime";
import type {
  BoundaryRequest,
  CloudWorkerRuntimeConfiguration,
  TerritoryGeneration,
} from "./types";

export const ZSR_POLICY_VERSION = 1 as const;

export interface ZsrPolicyDocument {
  readonly version: typeof ZSR_POLICY_VERSION;
  readonly executionId: string;
  readonly generation: TerritoryGeneration;
  readonly actor: ExecutionBoundaryActor;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly filesystem: {
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
    readonly denyRead: readonly string[];
  };
  readonly runtime: {
    readonly normalNetwork: true;
    readonly allowPty: true;
    readonly allowedUnixSockets: readonly string[];
    readonly allowedLocalPorts: readonly number[];
    readonly deniedLocalPorts: readonly number[];
    /** Present only for the attested root-supervisor cloud backend. */
    readonly cloudWorker?: {
      readonly version: 1;
      readonly uid: number;
      readonly gid: number;
      readonly cgroupParent: string;
      readonly resources: CloudWorkerRuntimeConfiguration["resources"];
    };
  };
}

export interface ZsrPrivatePaths {
  readonly root: string;
  readonly home: string;
  readonly scratch: string;
  readonly providerState: string;
  readonly shadowGit: string;
  readonly policy: string;
  readonly commands: string;
  readonly tools: string;
  /** Immutable generation fingerprint readable only by descendants carrying
   * this exact Seatbelt policy. A trusted host helper uses the kernel decision
   * for this path to find descendants that escaped their POSIX process group. */
  readonly processIdentityMarker: string;
  /** Crash-recovery descriptor. It contains process identity and path
   * fingerprints only, never provider credentials or command arguments. */
  readonly processDomainMetadata: string;
  /** Short, private path used for Unix sockets whose sockaddr_un names cannot
   * fit beneath the durable session tree on macOS/Linux. */
  readonly network: string;
  /** Short trusted-only scratch used by SRT's internal Unix sockets. Kept out
   * of the child view so an agent cannot replace or interfere with its mux. */
  readonly networkRuntime: string;
  /** Writable only for the trusted pre-seccomp reverse bridge. */
  readonly networkBridge: string;
  /** Host-created service façades; readable/connectable but never writable by
   * the untrusted process. */
  readonly networkServices: string;
  /** Generation-private writable client state for socket protocols such as
   * GnuPG. It contains only broker-sanitized public/configuration data. */
  readonly networkClientState: string;
  /** Durable per-session OCI image/container store. It is the sole
   * engine-state subtree intentionally projected to an embedded worker. */
  readonly containerState?: string;
}

export interface PreparedZsrPolicy {
  readonly document: ZsrPolicyDocument;
  readonly paths: ZsrPrivatePaths;
}

export interface PrepareZsrPolicyOptions {
  /** Canonical control metadata discovered by a trusted backend before policy
   * construction (for example a linked worktree's gitdir/common dir). */
  readonly additionalDenyWrite?: readonly string[];
  /** Canonical control state that must be absent from the child view. */
  readonly additionalDenyRead?: readonly string[];
  /** Narrow immutable pools projected back inside an absent control root. */
  readonly additionalAllowRead?: readonly string[];
  /** Generation-private Unix façades. Raw host service sockets are never
   * admitted here. Linux couples any entry to a root read allowlist because
   * seccomp can allow AF_UNIX only globally, not by pathname. */
  readonly allowedUnixSockets?: readonly string[];
  /** Force a root-absent filesystem view and record the dedicated identity
   * used by the trusted cloud-worker supervisor. */
  readonly cloudWorker?: CloudWorkerRuntimeConfiguration;
}

export function zsrNetworkRoot(generation: TerritoryGeneration): string {
  // macOS's per-user TMPDIR is itself long enough that SRT's `srt-mux-PID-N`
  // socket can exceed sockaddr_un even after shortening the generation. The
  // canonical /private/tmp root keeps the complete name safely below the
  // kernel limit; the unpredictable mode-0700 generation directory remains
  // the authority boundary.
  const temporaryRoot =
    process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  return path.join(
    temporaryRoot,
    `zeros-zn-${String(generation).slice(0, 20)}`,
  );
}

/** Resolve every existing ancestor, not just the final path. `realpath(path)`
 * followed by a lexical fallback is unsafe for prospective paths: on macOS,
 * `/var/new` and `/private/var/new` are the same future vnode even though the
 * missing leaf prevents a direct realpath. */
async function canonicalExistingOrLexical(input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("ZSR policy paths must be absolute and NUL-free");
  }
  const absolute = path.normalize(input);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function comparisonPath(input: string): string {
  const normalized = path.normalize(input).replace(/[\\/]+$/, "");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.normalize("NFC").toLocaleLowerCase("en-US")
    : normalized;
}

function pathIsInsideOrEqual(candidate: string, parent: string): boolean {
  const childKey = comparisonPath(candidate);
  const parentKey = comparisonPath(parent);
  if (childKey === parentKey) return true;
  const relative = path.relative(parentKey, childKey);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
  );
}

function environmentPort(name: string): number | null {
  const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return validPort(value) ? value : null;
}

function deniedZerosControlPorts(trusted: readonly number[]): number[] {
  if (trusted.some((port) => !validPort(port))) {
    throw new Error("trusted local service ports must be valid TCP ports");
  }
  const trustedSet = new Set(trusted);
  const denied = new Set<number>();
  for (const base of new Set([
    ENGINE_BASE_PORT_PROD,
    ENGINE_BASE_PORT_BETA,
    ENGINE_BASE_PORT_ALPHA,
    ENGINE_BASE_PORT_DEV,
    engineBasePort(),
  ])) {
    for (let offset = 0; offset < ENGINE_PORT_SPAN + 2; offset += 1) {
      denied.add(base + offset);
    }
  }
  for (const name of ["ZEROS_CLOUD_PORT", "CONDUCTOR_PORT"]) {
    const port = environmentPort(name);
    if (port) denied.add(port);
  }
  for (const port of trustedSet) denied.delete(port);
  return [...denied].sort((a, b) => a - b);
}

/** Used by internal capability allocators before the immutable policy is
 * serialized. Internal random listeners remain ordinary allowed ports and may
 * never carve a hole in a reserved Zeros control range. */
export function isDeniedZerosControlPort(port: number): boolean {
  return deniedZerosControlPorts([]).includes(port);
}

/** Build the backend-neutral normal-authority-minus-territory policy. The
 * engine-private policy/command descriptors are never placed in allowWrite;
 * only purpose-specific provider state, scratch, HOME, and shadow Git roots
 * are mutable from inside the boundary. */
export async function prepareZsrPolicy(
  request: BoundaryRequest,
  generation: TerritoryGeneration,
  options: PrepareZsrPolicyOptions = {},
): Promise<PreparedZsrPolicy> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.executionId)) {
    throw new Error("invalid execution id");
  }
  if (
    !path.isAbsolute(request.cwd) ||
    !path.isAbsolute(request.workspaceRoot)
  ) {
    throw new Error("boundary cwd and workspace root must be absolute");
  }
  if (
    options.cloudWorker &&
    (process.platform !== "linux" ||
      !Number.isInteger(options.cloudWorker.uid) ||
      options.cloudWorker.uid <= 0 ||
      options.cloudWorker.uid > 2_147_483_647 ||
      !Number.isInteger(options.cloudWorker.gid) ||
      options.cloudWorker.gid <= 0 ||
      options.cloudWorker.gid > 2_147_483_647)
  ) {
    throw new Error("cloud worker requires a valid non-root Linux uid/gid");
  }

  const workspaceRoot = await canonicalExistingOrLexical(request.workspaceRoot);
  const cwd = await canonicalExistingOrLexical(request.cwd);
  if (!pathIsInsideOrEqual(cwd, workspaceRoot)) {
    throw new Error("boundary cwd must be inside its workspace root");
  }

  const requestedRoot = options.cloudWorker
    ? path.join(os.tmpdir(), `zeros-zp-${String(generation).slice(0, 20)}`)
    : path.join(sessionDir(request.executionId), "boundary", generation);
  await mkdir(requestedRoot, {
    recursive: !options.cloudWorker,
    mode: 0o700,
  });
  await chmod(requestedRoot, 0o700);
  const root = await realpath(requestedRoot);
  const network = zsrNetworkRoot(generation);
  const paths: ZsrPrivatePaths = {
    root,
    home: path.join(root, "home"),
    scratch: path.join(root, "scratch"),
    providerState: path.join(root, "provider"),
    shadowGit: path.join(root, "git"),
    policy: path.join(root, "policy.json"),
    commands: path.join(root, "commands"),
    tools: path.join(root, "tools"),
    processIdentityMarker: path.join(root, "tools", "process-domain.marker"),
    processDomainMetadata: path.join(root, "commands", "process-domain.json"),
    network,
    networkRuntime: path.join(network, "runtime"),
    networkBridge: path.join(network, "bridge"),
    networkServices: path.join(network, "services"),
    networkClientState: path.join(network, "clients"),
    ...(request.containerWorker?.backend === "embedded-linux"
      ? {
          containerState: path.join(
            sessionDir(request.executionId),
            "container-worker",
          ),
        }
      : {}),
  };
  await Promise.all(
    [
      paths.home,
      paths.scratch,
      paths.providerState,
      paths.shadowGit,
      paths.commands,
      paths.tools,
      paths.network,
      paths.networkRuntime,
      paths.networkBridge,
      paths.networkServices,
      paths.networkClientState,
    ].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
  if (paths.containerState) {
    const containerStateParent = path.dirname(paths.containerState);
    await mkdir(containerStateParent, { recursive: true, mode: 0o700 });
    const parentMetadata = await lstat(containerStateParent);
    if (
      !parentMetadata.isDirectory() ||
      parentMetadata.isSymbolicLink() ||
      (await realpath(containerStateParent)) !== containerStateParent
    ) {
      throw new Error("container-worker state parent is not physical");
    }
    try {
      await mkdir(paths.containerState, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(paths.containerState);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(paths.containerState)) !== paths.containerState
    ) {
      throw new Error("container-worker state is not a physical directory");
    }
    await chmod(paths.containerState, 0o700);
  }
  await writeFile(paths.processIdentityMarker, `${generation}\n`, {
    encoding: "utf8",
    mode: 0o400,
    flag: "wx",
  });

  const additionalInputs = request.additionalReadWriteRoots ?? [];
  if (additionalInputs.length > 32) {
    throw new Error("at most 32 additional read/write roots are allowed");
  }
  if (additionalInputs.some((entry) => !path.isAbsolute(entry))) {
    throw new Error("additional read/write roots must be absolute");
  }
  const additional = await Promise.all(
    additionalInputs.map(canonicalExistingOrLexical),
  );
  for (const root of additional) {
    try {
      if (!(await lstat(root)).isDirectory()) {
        throw new Error("additional read/write roots must be directories");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const readOnlyInputs = request.additionalReadOnlyRoots ?? [];
  if (readOnlyInputs.length > 128) {
    throw new Error("at most 128 additional read-only roots are allowed");
  }
  if (readOnlyInputs.some((entry) => !path.isAbsolute(entry))) {
    throw new Error("additional read-only roots must be absolute");
  }
  const additionalReadOnly = await Promise.all(
    readOnlyInputs.map(canonicalExistingOrLexical),
  );
  const engineRoots = await Promise.all(
    [
      zerosDataDir(),
      zerosChannelDataDir(),
      zerosStateRoot(),
      // The operator-only cloud validation harness deliberately uses the
      // stable production root even when this app instance is a dev channel.
      // It contains bridge/provider bearers and must never be projected into a
      // code actor's host-home view.
      path.join(os.homedir(), ".zeros", "cloud-workspace-validation"),
    ].map(canonicalExistingOrLexical),
  );
  for (const rootCandidate of [workspaceRoot, ...additional]) {
    const enclosingEngineRoot = engineRoots.find((engineRoot) =>
      pathIsInsideOrEqual(rootCandidate, engineRoot),
    );
    if (enclosingEngineRoot) {
      throw new Error(
        "a code write root cannot be inside Zeros engine-private state",
      );
    }
  }

  let territoryDenies: string[] = [];
  if (request.territory) {
    const territoryWorkspace = await canonicalExistingOrLexical(
      request.territory.workspaceRoot,
    );
    if (comparisonPath(territoryWorkspace) !== comparisonPath(workspaceRoot)) {
      throw new Error("filesystem territory belongs to a different workspace");
    }
    territoryDenies = await Promise.all(
      [
        ...request.territory.protectedDesignDirectories,
        ...request.territory.writeCapabilities.deniedPaths,
      ].map(canonicalExistingOrLexical),
    );
  }
  const allowWrite = uniqueSorted([
    workspaceRoot,
    ...additional,
    paths.home,
    paths.scratch,
    paths.providerState,
    paths.shadowGit,
    paths.networkBridge,
    paths.networkClientState,
    ...(paths.containerState ? [paths.containerState] : []),
  ]);
  const containerSocket = paths.containerState
    ? path.join(paths.containerState, "podman.sock")
    : null;
  const allowedUnixSockets = await Promise.all(
    [
      ...(options.allowedUnixSockets ?? []),
      ...(containerSocket ? [containerSocket] : []),
    ].map(canonicalExistingOrLexical),
  );
  for (const socket of allowedUnixSockets) {
    if (
      !pathIsInsideOrEqual(socket, paths.networkServices) &&
      socket !== containerSocket
    ) {
      throw new Error(
        "Unix socket admission is outside private boundary state",
      );
    }
  }
  const linuxUnixIsolation =
    process.platform === "linux" &&
    (allowedUnixSockets.length > 0 || Boolean(options.cloudWorker));
  const executableTopLevel = path.join(
    path.parse(process.execPath).root,
    path
      .relative(path.parse(process.execPath).root, process.execPath)
      .split(path.sep)[0] ?? "",
  );
  const additionalExecutableRoot = ["/home", "/root", "/tmp", "/var"].includes(
    executableTopLevel,
  )
    ? []
    : [executableTopLevel];
  const platformReadRoots = linuxUnixIsolation
    ? [
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc",
        "/opt",
        "/nix",
        "/sys",
        "/var/cache",
        "/var/lib/dpkg",
        process.execPath,
        path.dirname(process.execPath),
        ...additionalExecutableRoot,
      ]
    : [];
  const allowRead = uniqueSorted([
    workspaceRoot,
    ...additional,
    ...additionalReadOnly,
    ...platformReadRoots,
    paths.home,
    paths.scratch,
    paths.providerState,
    paths.shadowGit,
    paths.tools,
    paths.network,
    paths.networkBridge,
    paths.networkServices,
    paths.networkClientState,
    ...(paths.containerState ? [paths.containerState] : []),
    ...allowedUnixSockets,
    ...(await Promise.all(
      (options.additionalAllowRead ?? []).map(canonicalExistingOrLexical),
    )),
  ]);
  const denyWrite = uniqueSorted([
    ...territoryDenies,
    ...(await Promise.all(
      (options.additionalDenyWrite ?? []).map(canonicalExistingOrLexical),
    )),
    ...engineRoots,
    paths.policy,
    paths.commands,
    paths.tools,
    paths.networkRuntime,
  ]);
  const denyRead = uniqueSorted([
    ...(linuxUnixIsolation ? [path.parse(workspaceRoot).root] : []),
    ...engineRoots,
    ...(await Promise.all(
      (options.additionalDenyRead ?? []).map(canonicalExistingOrLexical),
    )),
    paths.policy,
    paths.commands,
    paths.networkRuntime,
  ]);
  const localPorts = [
    ...new Set([
      ...(request.allowedLocalPorts ?? []),
      ...(request.trustedLocalPorts ?? []),
    ]),
  ];
  if (localPorts.length > 256 || localPorts.some((port) => !validPort(port))) {
    throw new Error("local service ports must be 256 valid TCP ports or fewer");
  }
  const document: ZsrPolicyDocument = {
    version: ZSR_POLICY_VERSION,
    executionId: request.executionId,
    generation,
    actor: request.actor,
    cwd,
    workspaceRoot,
    filesystem: { allowRead, allowWrite, denyWrite, denyRead },
    runtime: {
      normalNetwork: true,
      allowPty: true,
      allowedUnixSockets: uniqueSorted(allowedUnixSockets),
      allowedLocalPorts: localPorts.sort((a, b) => a - b),
      deniedLocalPorts: deniedZerosControlPorts(
        request.trustedLocalPorts ?? [],
      ),
      ...(options.cloudWorker
        ? {
            cloudWorker: {
              version: 1,
              uid: options.cloudWorker.uid,
              gid: options.cloudWorker.gid,
              cgroupParent: options.cloudWorker.cgroupParent,
              resources: options.cloudWorker.resources,
            } as const,
          }
        : {}),
    },
  };
  await writeFile(paths.policy, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { document, paths };
}

/** Allocate one mode-0600 launch descriptor synchronously later through the
 * supervisor implementation. Exported for deterministic filename validation. */
export function nextCommandDescriptorPath(paths: ZsrPrivatePaths): string {
  return path.join(paths.commands, `${randomUUID()}.json`);
}
