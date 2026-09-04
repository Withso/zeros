import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionBoundaryActor } from "@zeros/protocol/containment";

import {
  zerosChannelDataDir,
  zerosDataDir,
  zerosDbPath,
  zerosStateRoot,
  worktreeSeedsRoot,
} from "../../db/paths";
import { designRecognitionStorePath } from "../../design/recognition-store";
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
const MAX_WORKTREE_SEED_DIRECTORIES = 16_384;

/** Path-scoped denial cannot protect an inode through an already-existing
 * writable hard-link alias. Audit the exact files that carry engine authority;
 * recursively walking arbitrary backup material under the seed root adds hot
 * admission latency and rejects files that seed recovery never reads. */
async function assertEngineAuthorityFileHasNoAlias(
  authorityPath: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(authorityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `engine authority contains a symbolic-link alias: ${authorityPath}`,
    );
  }
  if (!metadata.isFile()) {
    throw new Error(`engine authority is not a regular file: ${authorityPath}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(
      `engine authority has a pre-existing hard-link alias: ${authorityPath}`,
    );
  }
}

async function assertWorktreeSeedsHaveNoAliases(
  seedRoot: string,
): Promise<void> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(seedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      "engine worktree-seed authority is not a physical directory",
    );
  }
  const entries = await readdir(seedRoot, { withFileTypes: true });
  if (entries.length > MAX_WORKTREE_SEED_DIRECTORIES) {
    throw new Error("engine authority tree exceeds the bounded alias audit");
  }
  // Bound concurrency so an unusually large but valid workspace registry does
  // not turn one admission into an unbounded filesystem request burst.
  for (let offset = 0; offset < entries.length; offset += 256) {
    await Promise.all(
      entries.slice(offset, offset + 256).map(async (entry) => {
        const directory = path.join(seedRoot, entry.name);
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink()) {
          throw new Error(
            `engine authority contains a symbolic-link alias: ${directory}`,
          );
        }
        if (!metadata.isDirectory()) return;
        await assertEngineAuthorityFileHasNoAlias(
          path.join(directory, "workspace.json"),
        );
      }),
    );
  }
}

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
    /** Every session retains its deployment's ordinary filesystem authority,
     * with actor territory subtracted. Cloud additionally denies engine roots
     * before dropping to the worker uid. */
    readonly localHostParity: true;
    readonly allowedUnixSockets: readonly string[];
    readonly allowedLocalPorts: readonly number[];
    readonly deniedLocalPorts: readonly number[];
    /** Present only for the attested root-supervisor cloud backend. */
    readonly cloudWorker?: {
      readonly version: 1;
      readonly uid: number;
      readonly gid: number;
    };
  };
}

export interface ZsrPrivatePaths {
  readonly root: string;
  readonly home: string;
  readonly scratch: string;
  readonly providerState: string;
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
  /** Host-created service façades; readable/connectable but never writable by
   * the untrusted process. */
  readonly networkServices: string;
  /** Durable OCI state for the qualified cloud worker's generation-private
   * rootless Podman service. Desktop/native boundaries never allocate it. */
  readonly containerState?: string;
}

export interface PreparedZsrPolicy {
  readonly document: ZsrPolicyDocument;
  readonly paths: ZsrPrivatePaths;
}

export interface PrepareZsrPolicyOptions {
  /** Compatibility input for qualified code-worker Git integration. A Design
   * agent never receives writable Git metadata; supplied islands are added to
   * its deny set instead of reopening authority. */
  readonly localHostParityWriteIslands?: readonly string[];
  /** Generation-private Unix façades. Raw host service sockets are never
   * admitted here. */
  readonly allowedUnixSockets?: readonly string[];
  /** Record the dedicated identity used by the trusted cloud-worker
   * supervisor. The VM remains the tenant boundary. */
  readonly cloudWorker?: CloudWorkerRuntimeConfiguration;
  /** Preserve the qualified cloud image's Docker/Podman contract without
   * reviving any desktop VM or host-daemon bridge. Requires `cloudWorker`. */
  readonly cloudContainerWorker?: true;
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

/** Bun on macOS cannot realpath some Unix socket vnodes. Existing endpoints
 * are still canonicalized without weakening identity checks: resolve the
 * physical parent, then prove both leaf paths name the same non-symlink socket.
 * Prospective private endpoints retain the ordinary lexical fallback. */
async function canonicalUnixSocketOrLexical(input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("ZSR policy paths must be absolute and NUL-free");
  }
  const requested = path.normalize(input);
  let requestedMetadata;
  try {
    requestedMetadata = await lstat(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return canonicalExistingOrLexical(requested);
    }
    throw error;
  }
  if (!requestedMetadata.isSocket() || requestedMetadata.isSymbolicLink()) {
    throw new Error("an admitted Unix endpoint is not a physical socket");
  }
  const canonical = path.join(
    await realpath(path.dirname(requested)),
    path.basename(requested),
  );
  const canonicalMetadata = await lstat(canonical);
  if (
    !canonicalMetadata.isSocket() ||
    canonicalMetadata.isSymbolicLink() ||
    canonicalMetadata.dev !== requestedMetadata.dev ||
    canonicalMetadata.ino !== requestedMetadata.ino
  ) {
    throw new Error("an admitted Unix endpoint changed during validation");
  }
  return canonical;
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

/** Build the actor-scoped ZSR policy. Cloud Code workers that reach this
 * boundary keep host-parity authority minus protected territory; local Code
 * never calls this policy. Design agents receive read-only host context,
 * API-only durable mutation, and generation-private write islands. Engine
 * authority and generation control descriptors are always subtracted from
 * untrusted Design reads. */
export async function prepareZsrPolicy(
  request: BoundaryRequest,
  generation: TerritoryGeneration,
  options: PrepareZsrPolicyOptions = {},
): Promise<PreparedZsrPolicy> {
  if (
    options.cloudContainerWorker &&
    (!options.cloudWorker || request.actor === "design-agent")
  ) {
    throw new Error(
      "private container state is reserved for code actors on a cloud worker",
    );
  }
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
  if (
    (options.localHostParityWriteIslands?.length ?? 0) > 256 ||
    options.localHostParityWriteIslands?.some(
      (entry) => !path.isAbsolute(entry) || entry.includes("\0"),
    )
  ) {
    throw new Error("host-parity write islands must be bounded absolute paths");
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
    policy: path.join(root, "policy.json"),
    commands: path.join(root, "commands"),
    tools: path.join(root, "tools"),
    processIdentityMarker: path.join(root, "tools", "process-domain.marker"),
    processDomainMetadata: path.join(root, "commands", "process-domain.json"),
    network,
    networkRuntime: path.join(network, "runtime"),
    networkServices: path.join(network, "services"),
    ...(options.cloudContainerWorker
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
      paths.commands,
      paths.tools,
      paths.network,
      paths.networkRuntime,
      paths.networkServices,
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
      throw new Error("cloud container-worker state parent is not physical");
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
      throw new Error("cloud container-worker state is not physical");
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
  const additionalReadOnlyInputs = request.additionalReadOnlyRoots ?? [];
  if (additionalReadOnlyInputs.length > 64) {
    throw new Error("at most 64 additional read-only roots are allowed");
  }
  if (
    additionalReadOnlyInputs.some(
      (entry) => !path.isAbsolute(entry) || entry.includes("\0"),
    )
  ) {
    throw new Error("additional read-only roots must be absolute");
  }
  const additionalReadOnly = uniqueSorted(
    await Promise.all(additionalReadOnlyInputs.map(canonicalExistingOrLexical)),
  );
  for (const root of additionalReadOnly) {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "additional read-only roots must be physical directories",
      );
    }
  }
  const protectedWorkspaceInputs = request.protectedWorkspaceDirectories ?? [];
  if (protectedWorkspaceInputs.length > 16) {
    throw new Error("at most 16 protected workspace directories are allowed");
  }
  if (
    protectedWorkspaceInputs.some(
      (entry) =>
        !path.isAbsolute(entry) ||
        entry.includes("\0") ||
        path.resolve(entry) === path.parse(path.resolve(entry)).root,
    )
  ) {
    throw new Error(
      "protected workspace directories must be bounded absolute paths",
    );
  }
  const protectedWorkspaceDirectories = uniqueSorted(
    await Promise.all(protectedWorkspaceInputs.map(canonicalExistingOrLexical)),
  );
  for (const directory of protectedWorkspaceDirectories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error(
        "protected workspace directories must be physical directories",
      );
    }
  }
  const protectedWorkspaceWriteInputs =
    request.protectedWorkspaceWriteDirectories ?? [];
  if (protectedWorkspaceWriteInputs.length > 256) {
    throw new Error(
      "at most 256 protected workspace write directories are allowed",
    );
  }
  if (
    protectedWorkspaceWriteInputs.some(
      (entry) => !path.isAbsolute(entry) || entry.includes("\0"),
    )
  ) {
    throw new Error(
      "protected workspace write directories must be absolute paths",
    );
  }
  const protectedWorkspaceWriteDirectories = uniqueSorted(
    await Promise.all(
      protectedWorkspaceWriteInputs.map(canonicalExistingOrLexical),
    ),
  );
  for (const island of protectedWorkspaceWriteDirectories) {
    if (
      !protectedWorkspaceDirectories.some(
        (directory) =>
          island !== directory && pathIsInsideOrEqual(island, directory),
      )
    ) {
      throw new Error(
        "protected workspace write directories must be inside a protected collection",
      );
    }
    if (
      ![workspaceRoot, ...additional].some((grant) =>
        pathIsInsideOrEqual(island, grant),
      )
    ) {
      throw new Error(
        "protected workspace write directories must be inside an authorized root",
      );
    }
  }
  const protectedCodeInputs = request.protectedCodeDirectories ?? [];
  if (protectedCodeInputs.length > 256) {
    throw new Error("at most 256 protected code directories are allowed");
  }
  if (
    protectedCodeInputs.some(
      (entry) => !path.isAbsolute(entry) || entry.includes("\0"),
    )
  ) {
    throw new Error("protected code directories must be absolute paths");
  }
  const protectedCodeDirectories = await Promise.all(
    protectedCodeInputs.map(canonicalExistingOrLexical),
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
  const database = zerosDbPath();
  const engineAuthorityWriteDenies = await Promise.all(
    [
      designRecognitionStorePath(),
      database,
      `${database}-wal`,
      `${database}-shm`,
      `${database}-journal`,
      worktreeSeedsRoot(),
    ].map(canonicalExistingOrLexical),
  );
  await Promise.all([
    ...engineAuthorityWriteDenies
      .slice(0, -1)
      .map(assertEngineAuthorityFileHasNoAlias),
    assertWorktreeSeedsHaveNoAliases(
      engineAuthorityWriteDenies[engineAuthorityWriteDenies.length - 1]!,
    ),
  ]);
  // A Design agent is an API-only mutation actor. It may read the host context
  // needed by the provider, but its only filesystem write surfaces are its
  // generation-private provider cache and scratch/artifact directory. Code,
  // Design, Git metadata, and requested add-dirs remain read-only; durable
  // engine state is neither readable nor writable. Requested read/write roots
  // are therefore downgraded to reads.
  const codeWriteAuthority = request.actor !== "design-agent";

  let protectedDesignDirectories: string[] = [];
  if (request.territory) {
    const territoryWorkspace = await canonicalExistingOrLexical(
      request.territory.workspaceRoot,
    );
    if (comparisonPath(territoryWorkspace) !== comparisonPath(workspaceRoot)) {
      throw new Error("filesystem territory belongs to a different workspace");
    }
    protectedDesignDirectories = await Promise.all(
      request.territory.protectedDesignDirectories.map(
        canonicalExistingOrLexical,
      ),
    );
  }
  const hostFilesystemRoot = path.parse(workspaceRoot).root;
  const localHostParityWriteIslands = await Promise.all(
    (options.localHostParityWriteIslands ?? []).map(canonicalExistingOrLexical),
  );
  const allowWrite = uniqueSorted(
    codeWriteAuthority
      ? [
          hostFilesystemRoot,
          workspaceRoot,
          ...additional,
          ...protectedWorkspaceWriteDirectories,
          ...(paths.containerState ? [paths.containerState] : []),
        ]
      : [paths.providerState, paths.scratch],
  );
  const containerSocket = paths.containerState
    ? path.join(paths.containerState, "podman.sock")
    : null;
  const allowedUnixSockets = await Promise.all(
    [
      ...(options.allowedUnixSockets ?? []),
      ...(containerSocket ? [containerSocket] : []),
    ].map(canonicalUnixSocketOrLexical),
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
  // The additional roots were validated above even though the host root makes
  // their read grant implicit. Keep the exact worker state entry so the
  // supervisor can prove a descriptor did not name arbitrary host storage.
  const protectEngineReads =
    options.cloudWorker !== undefined || request.actor === "design-agent";
  const allowRead = uniqueSorted([
    hostFilesystemRoot,
    ...additionalReadOnly,
    ...(request.actor === "design-agent"
      ? [workspaceRoot, ...additional, paths.providerState, paths.scratch]
      : []),
    ...(paths.containerState ? [paths.containerState] : []),
  ]);
  const denyWrite = uniqueSorted([
    // This stable parent deny applies to both inverse actor roles. Their
    // respective allowWrite islands below it reopen only current code roots or
    // discovered Design roots, never a sibling that appears after admission.
    ...protectedWorkspaceDirectories,
    ...additionalReadOnly,
    ...(codeWriteAuthority
      ? [
          ...protectedDesignDirectories,
          // Design CONTENT is subtracted. Design RECOGNITION — committed
          // `.zeros` settings and canvas markers — stays native so ordinary
          // tree-level Git can update it. Sticky engine recognition prevents a
          // later repository edit from de-registering an admitted Design root.
        ]
      : [
          workspaceRoot,
          ...additional,
          ...protectedCodeDirectories,
          ...protectedDesignDirectories,
          ...localHostParityWriteIslands,
        ]),
    // Both actors are denied the small authority set that defines the next
    // admission: the database and sidecars, recovery seeds, and sticky Design
    // recognition. Otherwise either actor could weaken future territory.
    ...engineAuthorityWriteDenies,
    // A Design actor must not reach durable engine authority through the
    // desktop's shared uid. Cloud workers keep the same deny for root-owned
    // tenant state.
    ...(protectEngineReads ? engineRoots : []),
    paths.policy,
    paths.commands,
    paths.tools,
    paths.networkRuntime,
  ]);
  const denyRead = uniqueSorted([
    ...(protectEngineReads ? engineRoots : []),
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
      localHostParity: true,
      allowedUnixSockets: uniqueSorted(allowedUnixSockets),
      allowedLocalPorts: localPorts.sort((a, b) => a - b),
      deniedLocalPorts: [],
      ...(options.cloudWorker
        ? {
            cloudWorker: {
              version: 1,
              uid: options.cloudWorker.uid,
              gid: options.cloudWorker.gid,
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
