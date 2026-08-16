import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { ShadowGitFilesystemProjection } from "./shadow-git";
import type { TerritoryGeneration } from "./types";
import { ORBSTACK_MACHINE_RECOVERY_HOLD_FILE } from "../session-paths";

const MACHINE_PREFIX = "zeros-zsr-";
const MACHINE_MEMORY_MIB = 3_072;
const MACHINE_CPUS = 2;
const MACHINE_DISK_BYTES = 16 * 1024 * 1024 * 1024;
const MINIMUM_CREATE_FREE_BYTES = 4n * 1024n * 1024n * 1024n;
const COMMAND_TIMEOUT_MS = 120_000;
const CREATE_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const FORWARDED_BRIDGE_TIMEOUT_MS = 10_000;
const RUNTIME_USER_TIMEOUT_MS = 30_000;
const RUNTIME_USER_RETRY_MS = 100;
const DELETE_PROOF_ATTEMPTS = 20;
const DELETE_PROOF_RETRY_MS = 100;
const DELETE_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RUNTIME_ASSET_BYTES = 2 * 1024 * 1024;

const SAFE_ORB_OPERATIONS = new Set([
  "create",
  "delete",
  "info",
  "list",
  "push",
  "start",
  "status",
  "version",
]);
const SAFE_ORB_MACHINE_OPERATIONS = new Map([
  ["cloud-init", "cloud-init"],
  ["/bin/cat", "runtime-marker"],
  ["/usr/bin/getent", "runtime-identity"],
  ["/usr/bin/install", "runtime-install"],
  ["/usr/bin/node", "runtime-host"],
  ["/usr/bin/sha256sum", "runtime-attestation"],
]);

function safeOrbOperation(args: readonly string[]): string {
  const candidate = args[0] ?? "";
  if (SAFE_ORB_OPERATIONS.has(candidate)) return candidate;
  if (candidate === "-m") {
    return SAFE_ORB_MACHINE_OPERATIONS.get(args[4] ?? "") ?? "machine-exec";
  }
  return "operation";
}

export interface OrbStackCommandRunner {
  run(
    args: readonly string[],
    options?: { timeoutMs?: number; allowFailure?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  spawn(args: readonly string[]): ChildProcess;
}

export interface MacosContainerReservationRequest {
  readonly executionId: string;
  readonly workspaceRoot: string;
  readonly additionalWriteRoots?: readonly string[];
  /** Existing engine-private session root selectively mounted into the VM so
   * only the later Git source can be projected into the worker namespace. */
  readonly sessionRoot: string;
}

export interface MacosContainerStartRequest {
  readonly generation: TerritoryGeneration;
  readonly protectedRoots: readonly string[];
  readonly gitProjections: readonly ShadowGitFilesystemProjection[];
}

export interface MacosContainerWorkerLease {
  readonly hostPort: number;
  readonly machineName: string;
  readonly environment: Readonly<Record<string, string>>;
  start(request: MacosContainerStartRequest): Promise<void>;
  stopAndProve(): Promise<void>;
}

export class MacosContainerWorkerUnavailableError extends Error {
  override readonly name = "MacosContainerWorkerUnavailableError";

  constructor(
    readonly reason: "insufficient-disk-space" | "private-runtime-unavailable",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function assertOwnedOrbStackMachineName(machineName: string): void {
  if (!/^zeros-zsr-[a-f0-9]{20}$/.test(machineName)) {
    throw new Error("refusing to delete a non-ZSR OrbStack machine");
  }
}

function listedOrbStackMachineNames(stdout: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OrbStack returned malformed machine inventory");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as { name?: unknown }).name !== "string",
    )
  ) {
    throw new Error("OrbStack returned malformed machine inventory");
  }
  return new Set(parsed.map((entry) => (entry as { name: string }).name));
}

/** Delete only a lease-derived ZSR machine and prove it disappeared from a
 * successful signed-CLI inventory. A failed `info` call is not absence proof:
 * the OrbStack service itself may be unavailable or out of disk space. */
export async function deleteOrbStackMachineAndProve(
  runner: OrbStackCommandRunner,
  machineName: string,
): Promise<void> {
  assertOwnedOrbStackMachineName(machineName);
  await runner.run(["delete", "--force", machineName], {
    timeoutMs: DELETE_COMMAND_TIMEOUT_MS,
    allowFailure: true,
  });
  for (let attempt = 0; attempt < DELETE_PROOF_ATTEMPTS; attempt += 1) {
    const inventory = await runner.run(["list", "--format", "json"], {
      allowFailure: true,
    });
    if (
      inventory.code === 0 &&
      !listedOrbStackMachineNames(inventory.stdout).has(machineName)
    ) {
      return;
    }
    if (attempt + 1 < DELETE_PROOF_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, DELETE_PROOF_RETRY_MS),
      );
    }
  }
  throw new Error("OrbStack worker deletion was not proven");
}

export interface MacosOrbStackContainerWorkerOptions {
  readonly orbPath: string;
  readonly cloudInitPath: string;
  readonly hostScriptPath: string;
  readonly containerWorkerPath: string;
  readonly runner?: OrbStackCommandRunner;
  /** Deterministic test seam. Production measures OrbStack's home-volume
   * allocation target before creating a new sparse VM. */
  readonly freeDiskBytes?: () => bigint;
  /** Deterministic test seam for the loopback proxy reservation. */
  readonly reserveHostPort?: (server: Server) => Promise<number>;
  /** Deterministic test seam for a failed forwarded-bridge attestation. */
  readonly forwardedBridgeTimeoutMs?: number;
  /** Deterministic test seam. Production mints an independent bridge secret. */
  readonly sessionKeyFactory?: () => string;
  /** Test seam for exercising the controller without a macOS code-signing
   * environment. Production callers must use the default attestor. */
  readonly orbAttestor?: (candidate: string) => string;
}

interface OrbStackMachineInfo {
  readonly record: {
    readonly name: string;
    readonly state: string;
    readonly image: {
      readonly distro: string;
      readonly version: string;
      readonly arch: string;
    };
    readonly config: {
      readonly isolated: boolean;
      readonly isolate_network: boolean;
      readonly forward_ssh_agent: boolean;
      readonly default_username: string;
      readonly mounts: readonly {
        readonly source: string;
        readonly destination: string;
      }[];
      readonly memory_limit_mib: number;
      readonly cpu_limit: number;
      readonly disk_limit_bytes: number;
    };
  };
  readonly ip4?: string;
  readonly ip6?: string;
}

interface OrbStackRuntimeIdentity {
  readonly uid: number;
  readonly gid: number;
}

interface OrbStackRecoveryHoldV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly machineName: string;
  readonly mountRoots: readonly string[];
}

interface OrbStackRecoveryHoldV2 {
  readonly version: 2;
  readonly executionId: string;
  readonly machineName: string;
  readonly mountRoots: readonly string[];
  /** Prevents another same-channel engine from treating an active lease as a
   * crash. PID reuse is handled conservatively: a live PID retains the hold
   * and blocks the second engine instead of deleting authority it cannot own. */
  readonly ownerPid: number;
}

type OrbStackRecoveryHold = OrbStackRecoveryHoldV1 | OrbStackRecoveryHoldV2;

function boundedAppend(current: string, chunk: unknown): string {
  return (current + String(chunk)).slice(-MAX_OUTPUT_BYTES);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

export function createOrbStackCommandRunner(
  orbPath: string,
): OrbStackCommandRunner {
  return {
    run: async (args, options = {}) => {
      const child = spawn(orbPath, [...args], {
        argv0: "orb",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout = boundedAppend(stdout, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = boundedAppend(stderr, chunk);
      });
      const timeout = setTimeout(
        () => child.kill("SIGKILL"),
        options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      );
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve(exitCode ?? 125));
      }).finally(() => clearTimeout(timeout));
      if (code !== 0 && !options.allowFailure) {
        throw new Error(
          `OrbStack command "${safeOrbOperation(args)}" failed; diagnostics were redacted`,
        );
      }
      return { code, stdout, stderr };
    },
    spawn: (args) =>
      spawn(orbPath, [...args], {
        argv0: "orb",
        stdio: ["ignore", "pipe", "pipe"],
      }),
  };
}

function physicalExecutable(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate) || !existsSync(candidate)) {
    throw new Error(`${label} is unavailable`);
  }
  const resolved = realpathSync(candidate);
  const stat = lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} is not an immutable executable`);
  }
  return resolved;
}

const ORBSTACK_TEAM_ID = "HUAQ24HBR6";
const ORBSTACK_CLI_IDENTIFIER = "dev.kdrag0n.MacVirt.scli";
const ORBSTACK_CODE_SIGNING_REQUIREMENT =
  `anchor apple generic and identifier "${ORBSTACK_CLI_IDENTIFIER}" ` +
  `and certificate leaf[subject.OU] = "${ORBSTACK_TEAM_ID}"`;

export type OrbStackCodeSignVerifier = (
  command: string,
  args: readonly string[],
) => {
  readonly status: number | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
};

function runCodeSignVerification(
  command: string,
  args: readonly string[],
): ReturnType<OrbStackCodeSignVerifier> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function attestOrbStackCli(
  candidate: string,
  verifier: OrbStackCodeSignVerifier = runCodeSignVerification,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "darwin") {
    throw new Error("OrbStack CLI attestation requires macOS");
  }
  const executable = physicalExecutable(candidate, "OrbStack CLI");
  const suffix = path.join(
    "OrbStack.app",
    "Contents",
    "MacOS",
    "scli.app",
    "Contents",
    "MacOS",
    "scli",
  );
  if (!executable.endsWith(`${path.sep}${suffix}`)) {
    throw new Error("OrbStack CLI is outside its signed application bundle");
  }
  const bundle = executable.slice(
    0,
    executable.length - suffix.length + "OrbStack.app".length,
  );
  const verified = verifier("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    bundle,
  ]);
  // Parsing TeamIdentifier from display output is not a trust decision. Apple
  // documents that certificate trust is not evaluated unless the explicit
  // requirement asks for it; `anchor apple generic` binds this identity to an
  // Apple-issued signing chain before any machine command is trusted.
  const requirement = verifier("/usr/bin/codesign", [
    "--verify",
    "--strict",
    `-R=${ORBSTACK_CODE_SIGNING_REQUIREMENT}`,
    executable,
  ]);
  const details = verifier("/usr/bin/codesign", [
    "-d",
    "--verbose=2",
    executable,
  ]);
  const identity = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (
    verified.status !== 0 ||
    requirement.status !== 0 ||
    details.status !== 0 ||
    !identity.includes(`Identifier=${ORBSTACK_CLI_IDENTIFIER}`) ||
    !identity.includes(`TeamIdentifier=${ORBSTACK_TEAM_ID}`)
  ) {
    throw new Error("OrbStack CLI code-signing identity is untrusted");
  }
  return executable;
}

function physicalFile(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate) || !existsSync(candidate)) {
    throw new Error(`${label} is unavailable`);
  }
  const resolved = realpathSync(candidate);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a physical file`);
  }
  return resolved;
}

function physicalDirectory(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate) || !existsSync(candidate)) {
    throw new Error(`${label} is unavailable`);
  }
  const resolved = realpathSync(candidate);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory`);
  }
  return resolved;
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

function minimalMountRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted
        .slice(0, index)
        .some((parent) => pathInsideOrEqual(candidate, parent)),
  );
}

export function orbStackMachineName(
  executionId: string,
  mountRoots: readonly string[],
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) {
    throw new Error("invalid execution id for OrbStack worker");
  }
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        executionId,
        mountRoots: [...mountRoots].sort(),
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `${MACHINE_PREFIX}${identity}`;
}

function exactRecoveryHold(
  executionId: string,
  machineName: string,
  mountRoots: readonly string[],
): OrbStackRecoveryHoldV2 {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw new Error("OrbStack recovery owner identity is unavailable");
  }
  return {
    version: 2,
    executionId,
    machineName,
    mountRoots: [...mountRoots],
    ownerPid: process.pid,
  };
}

function prepareOrbStackRecoveryHold(
  sessionRoot: string,
  executionId: string,
  machineName: string,
  mountRoots: readonly string[],
): string {
  const holdPath = path.join(sessionRoot, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE);
  const expected = exactRecoveryHold(executionId, machineName, mountRoots);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      holdPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(expected)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(holdPath, 0o600);
    return holdPath;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup below remains authoritative.
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      let cleanupError: unknown;
      try {
        rmSync(holdPath, { force: true });
        if (existsSync(holdPath)) {
          throw new Error("partial OrbStack recovery hold removal failed");
        }
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OrbStack recovery hold creation failed and cleanup was not proven",
        );
      }
      throw error;
    }
  }
  const metadata = lstatSync(holdPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("OrbStack recovery hold is not a physical file");
  }
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(holdPath, "utf8"));
  } catch {
    throw new Error("OrbStack recovery hold is malformed");
  }
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error("OrbStack recovery hold does not match its lease");
  }
  chmodSync(holdPath, 0o600);
  return holdPath;
}

function removeOrbStackRecoveryHold(holdPath: string): void {
  rmSync(holdPath, { force: true });
  if (existsSync(holdPath)) {
    throw new Error("OrbStack recovery hold removal was not proven");
  }
}

function expectedArchitecture(): "arm64" | "amd64" {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "amd64";
  throw new Error(`unsupported macOS architecture ${process.arch}`);
}

export function validateOrbStackMachineInfo(
  info: OrbStackMachineInfo,
  machineName: string,
  mountRoots: readonly string[],
): void {
  const expectedMounts = [...mountRoots]
    .map((root) => ({ source: root, destination: root }))
    .sort((left, right) => left.source.localeCompare(right.source));
  const actualMounts = [...(info.record?.config?.mounts ?? [])].sort(
    (left, right) => left.source.localeCompare(right.source),
  );
  if (
    info.record?.name !== machineName ||
    info.record.state !== "running" ||
    info.record.image.distro !== "ubuntu" ||
    info.record.image.version !== "noble" ||
    info.record.image.arch !== expectedArchitecture() ||
    info.record.config.isolated !== true ||
    info.record.config.isolate_network !== true ||
    info.record.config.forward_ssh_agent !== false ||
    info.record.config.default_username !== "zeros-agent" ||
    info.record.config.memory_limit_mib !== MACHINE_MEMORY_MIB ||
    info.record.config.cpu_limit !== MACHINE_CPUS ||
    info.record.config.disk_limit_bytes !== MACHINE_DISK_BYTES ||
    actualMounts.length !== expectedMounts.length ||
    actualMounts.some(
      (mount, index) =>
        mount.source !== expectedMounts[index]?.source ||
        mount.destination !== expectedMounts[index]?.destination,
    )
  ) {
    throw new Error("OrbStack worker attestation does not match its lease");
  }
  if (!info.ip4 && !info.ip6) {
    throw new Error("OrbStack worker has no private address");
  }
}

async function listenOnRandomLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("container proxy did not receive a TCP port");
  }
  return address.port;
}

async function probeForwardedContainerApi(
  port: number,
  sessionKey: string,
): Promise<boolean> {
  const challenge = randomBytes(32).toString("hex");
  const expected = createHmac("sha256", sessionKey)
    .update(challenge)
    .digest("hex");
  return await new Promise((resolve) => {
    const peer = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    let response = "";
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      peer.destroy();
      resolve(ready);
    };
    peer.setEncoding("utf8");
    peer.setTimeout(500, () => finish(false));
    peer.once("connect", () =>
      peer.end(
        `GET /_zeros_zsr/attest/${challenge} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      ),
    );
    peer.on("data", (chunk) => {
      response = (response + chunk).slice(0, 8_192);
    });
    peer.once("end", () => {
      const separator = response.indexOf("\r\n\r\n");
      if (separator < 0) return finish(false);
      const headers = response.slice(0, separator);
      const body = response.slice(separator + 4);
      const actualProof = Buffer.from(body, "ascii");
      const expectedProof = Buffer.from(expected, "ascii");
      finish(
        /^HTTP\/1\.[01] 200\b/.test(headers) &&
          /(?:^|\r\n)Content-Length:\s*64\s*(?:\r\n|$)/i.test(headers) &&
          actualProof.byteLength === expectedProof.byteLength &&
          timingSafeEqual(actualProof, expectedProof),
      );
    });
    peer.once("error", () => finish(false));
  });
}

class OrbStackContainerLease implements MacosContainerWorkerLease {
  readonly environment: Readonly<Record<string, string>>;
  private target: { host: string; port: number } | null = null;
  private child: ChildProcess | null = null;
  private descriptorPath: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly peers = new Set<Socket>();

  constructor(
    readonly hostPort: number,
    readonly machineName: string,
    private readonly server: Server,
    private readonly request: MacosContainerReservationRequest,
    private readonly mountRoots: readonly string[],
    private readonly sessionKey: string,
    private readonly runtimeIdentity: OrbStackRuntimeIdentity,
    private readonly runner: OrbStackCommandRunner,
    private readonly recoveryHoldPath: string,
    private readonly forwardedBridgeTimeoutMs: number,
  ) {
    const endpoint = `tcp://127.0.0.1:${hostPort}`;
    this.environment = Object.freeze({
      DOCKER_HOST: endpoint,
      CONTAINER_HOST: endpoint,
    });
    this.server.on("connection", (peer) => {
      this.peers.add(peer);
      peer.once("close", () => this.peers.delete(peer));
      const target = this.target;
      if (!target) {
        peer.destroy(new Error("private container worker is not ready"));
        return;
      }
      const upstream = connect(target);
      this.peers.add(upstream);
      upstream.once("close", () => this.peers.delete(upstream));
      peer.on("error", () => upstream.destroy());
      upstream.on("error", () => peer.destroy());
      peer.on("end", () => upstream.end());
      upstream.on("end", () => peer.end());
      peer.pipe(upstream, { end: false });
      upstream.pipe(peer, { end: false });
    });
  }

  start(request: MacosContainerStartRequest): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce(request);
    return this.startPromise;
  }

  private async startOnce(request: MacosContainerStartRequest): Promise<void> {
    if (this.stopPromise) throw new Error("container worker lease is stopping");
    const protectedRoots = [
      ...new Set(
        request.protectedRoots.map((root) =>
          physicalDirectory(root, "protected Design root"),
        ),
      ),
    ].sort();
    if (
      protectedRoots.some(
        (root) =>
          !this.mountRoots.some((parent) => pathInsideOrEqual(root, parent)),
      )
    ) {
      throw new Error("protected Design root is outside the VM projection");
    }
    if (request.gitProjections.length > 33) {
      throw new Error("private Git projection set is too large");
    }
    const gitProjections = request.gitProjections.map((projection) => ({
      source: projection.readOnly
        ? physicalFile(projection.source, "private Git source")
        : physicalDirectory(projection.source, "private Git source"),
      destination: projection.readOnly
        ? physicalFile(projection.destination, "Git destination")
        : physicalDirectory(projection.destination, "Git destination"),
      readOnly: projection.readOnly,
    }));
    if (
      new Set(gitProjections.map((projection) => projection.source)).size !==
        gitProjections.length ||
      new Set(gitProjections.map((projection) => projection.destination))
        .size !== gitProjections.length ||
      gitProjections.some(
        (projection) =>
          path.basename(projection.destination) !== ".git" ||
          !this.mountRoots.some((root) =>
            pathInsideOrEqual(projection.destination, root),
          ) ||
          !pathInsideOrEqual(projection.source, this.request.sessionRoot),
      )
    ) {
      throw new Error("private Git projections are outside their exact lease");
    }
    this.descriptorPath = path.join(
      this.request.sessionRoot,
      `orbstack-container-${String(request.generation).slice(0, 20)}-${randomUUID()}.json`,
    );
    writeFileSync(
      this.descriptorPath,
      `${JSON.stringify({
        version: 1,
        executionId: this.request.executionId,
        generation: request.generation,
        sessionKey: this.sessionKey,
        uid: this.runtimeIdentity.uid,
        gid: this.runtimeIdentity.gid,
        workspaceRoot: this.request.workspaceRoot,
        writeRoots: this.mountRoots.filter(
          (root) => root !== this.request.sessionRoot,
        ),
        protectedRoots,
        gitProjections,
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    chmodSync(this.descriptorPath, 0o600);

    await this.runner.run(
      [
        "-m",
        this.machineName,
        "-u",
        "root",
        NODE_PATH,
        HOST_VM_PATH,
        "--recover",
        this.sessionKey,
      ],
      { allowFailure: true },
    );
    const child = this.runner.spawn([
      "-m",
      this.machineName,
      "-u",
      "root",
      NODE_PATH,
      HOST_VM_PATH,
      "--descriptor",
      this.descriptorPath,
    ]);
    this.child = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const ready = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("private container worker timed out")),
        START_TIMEOUT_MS,
      );
      child.stdout?.on("data", (chunk) => {
        stdout = boundedAppend(stdout, chunk);
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as {
              version?: unknown;
              ready?: unknown;
              port?: unknown;
            };
            if (
              value.version === 1 &&
              value.ready === true &&
              Number.isInteger(value.port) &&
              Number(value.port) >= 1 &&
              Number(value.port) <= 65_535
            ) {
              clearTimeout(timeout);
              resolve(Number(value.port));
              return;
            }
          } catch {
            // Ignore bounded trusted-runtime chatter.
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(
          new Error(
            `private container worker exited before readiness${
              stderr ? "; diagnostics were redacted" : ""
            }`,
          ),
        );
      });
    });
    try {
      const port = await ready;
      if (port === this.hostPort) {
        throw new Error("OrbStack forwarded port collided with its ZSR proxy");
      }
      const deadline = Date.now() + this.forwardedBridgeTimeoutMs;
      while (!(await probeForwardedContainerApi(port, this.sessionKey))) {
        if (Date.now() >= deadline) {
          throw new Error("OrbStack container forwarding did not become ready");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      this.target = { host: "127.0.0.1", port };
    } catch (error) {
      await this.stopAndProve();
      throw error;
    }
  }

  stopAndProve(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.target = null;
    for (const peer of this.peers) peer.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (!(await waitForExit(child, STOP_TIMEOUT_MS))) child.kill("SIGKILL");
      await waitForExit(child, STOP_TIMEOUT_MS);
    }
    // Recovery removes the generation's mounts/firewall state while the guest
    // is reachable. Deleting and inventory-proving the engine-owned machine is
    // the authoritative process/resource boundary and also prevents one sparse
    // VM from leaking for every closed agent session.
    await this.runner
      .run(
        [
          "-m",
          this.machineName,
          "-u",
          "root",
          NODE_PATH,
          HOST_VM_PATH,
          "--recover",
          this.sessionKey,
        ],
        { allowFailure: true },
      )
      .catch(() => undefined);
    await deleteOrbStackMachineAndProve(this.runner, this.machineName);
    removeOrbStackRecoveryHold(this.recoveryHoldPath);
    if (this.descriptorPath) {
      try {
        rmSync(this.descriptorPath, { force: true });
      } catch {
        // The descriptor remains engine-private and generation-bound. Report
        // no private path through user-facing diagnostics.
      }
    }
  }
}

const NODE_PATH = "/usr/bin/node";
const HOST_VM_PATH = "/opt/zeros-zsr/zsr-orbstack-container-host.mjs";
const WORKER_VM_PATH = "/opt/zeros-zsr/zsr-container-worker.mjs";
const RUNTIME_MARKER =
  '{"version":1,"backend":"orbstack-rootless-podman","distribution":"ubuntu-24.04"}';

export class MacosOrbStackContainerWorker {
  private readonly orbPath: string;
  private readonly cloudInitPath: string;
  private readonly hostScriptPath: string;
  private readonly containerWorkerPath: string;
  private readonly runner: OrbStackCommandRunner;
  private readonly freeDiskBytes: () => bigint;
  private readonly reserveHostPort: (server: Server) => Promise<number>;
  private readonly forwardedBridgeTimeoutMs: number;
  private readonly sessionKeyFactory: () => string;

  constructor(options: MacosOrbStackContainerWorkerOptions) {
    this.orbPath = (options.orbAttestor ?? attestOrbStackCli)(options.orbPath);
    this.cloudInitPath = physicalFile(
      options.cloudInitPath,
      "OrbStack cloud-init contract",
    );
    this.hostScriptPath = physicalFile(
      options.hostScriptPath,
      "OrbStack container host",
    );
    this.containerWorkerPath = physicalFile(
      options.containerWorkerPath,
      "container worker",
    );
    this.runner = options.runner ?? createOrbStackCommandRunner(this.orbPath);
    this.freeDiskBytes =
      options.freeDiskBytes ??
      (() => {
        const filesystem = statfsSync(os.homedir(), { bigint: true });
        return filesystem.bavail * filesystem.bsize;
      });
    this.reserveHostPort = options.reserveHostPort ?? listenOnRandomLoopback;
    this.sessionKeyFactory =
      options.sessionKeyFactory ?? (() => randomBytes(16).toString("hex"));
    this.forwardedBridgeTimeoutMs =
      options.forwardedBridgeTimeoutMs ?? FORWARDED_BRIDGE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.forwardedBridgeTimeoutMs) ||
      this.forwardedBridgeTimeoutMs < 50 ||
      this.forwardedBridgeTimeoutMs > FORWARDED_BRIDGE_TIMEOUT_MS
    ) {
      throw new Error("invalid OrbStack forwarded-bridge timeout");
    }
  }

  deleteMachineAndProve(machineName: string): Promise<void> {
    return deleteOrbStackMachineAndProve(this.runner, machineName);
  }

  async reserve(
    request: MacosContainerReservationRequest,
  ): Promise<MacosContainerWorkerLease> {
    if (process.platform !== "darwin" && !process.env.VITEST) {
      throw new Error("OrbStack container workers require macOS");
    }
    const workspaceRoot = physicalDirectory(
      request.workspaceRoot,
      "workspace root",
    );
    const sessionRoot = physicalDirectory(request.sessionRoot, "session root");
    const additional = (request.additionalWriteRoots ?? []).map((root) =>
      physicalDirectory(root, "additional write root"),
    );
    if (
      [workspaceRoot, ...additional].some((root) =>
        pathInsideOrEqual(sessionRoot, root),
      )
    ) {
      throw new Error(
        "a Mac container write root cannot enclose Zeros engine state",
      );
    }
    const mountRoots = minimalMountRoots([
      workspaceRoot,
      ...additional,
      sessionRoot,
    ]);
    if (!mountRoots.includes(workspaceRoot)) {
      throw new Error("workspace cannot be nested in another VM write grant");
    }
    const normalizedRequest = { ...request, workspaceRoot, sessionRoot };
    const machineName = orbStackMachineName(request.executionId, mountRoots);
    const { runtimeIdentity, recoveryHoldPath } = await this.ensureMachine(
      machineName,
      mountRoots,
      sessionRoot,
      request.executionId,
    );
    const server = createServer({ allowHalfOpen: true });
    try {
      const hostPort = await this.reserveHostPort(server);
      const sessionKey = this.sessionKeyFactory();
      if (!/^[a-f0-9]{32}$/.test(sessionKey)) {
        throw new Error("invalid OrbStack private bridge identity");
      }
      return new OrbStackContainerLease(
        hostPort,
        machineName,
        server,
        normalizedRequest,
        mountRoots,
        sessionKey,
        runtimeIdentity,
        this.runner,
        recoveryHoldPath,
        this.forwardedBridgeTimeoutMs,
      );
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      try {
        await deleteOrbStackMachineAndProve(this.runner, machineName);
        removeOrbStackRecoveryHold(recoveryHoldPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OrbStack worker proxy admission failed and cleanup was not proven",
        );
      }
      throw new MacosContainerWorkerUnavailableError(
        "private-runtime-unavailable",
        "The isolated OrbStack container proxy is temporarily unavailable",
        { cause: error },
      );
    }
  }

  private async ensureMachine(
    machineName: string,
    mountRoots: readonly string[],
    sessionRoot: string,
    executionId: string,
  ): Promise<{
    runtimeIdentity: OrbStackRuntimeIdentity;
    recoveryHoldPath: string;
  }> {
    let version;
    try {
      version = await this.runner.run(["version"]);
    } catch (error) {
      throw new MacosContainerWorkerUnavailableError(
        "private-runtime-unavailable",
        "The qualified OrbStack runtime is temporarily unavailable",
        { cause: error },
      );
    }
    const match = /^Version:\s+(\d+)\.(\d+)\.(\d+)\s+\(\d+\)\s*$/m.exec(
      version.stdout,
    );
    if (
      !match ||
      Number(match[1]) !== 2 ||
      Number(match[2]) !== 2 ||
      Number(match[3]) !== 1
    ) {
      throw new MacosContainerWorkerUnavailableError(
        "private-runtime-unavailable",
        "The installed OrbStack version is outside the qualified range",
      );
    }
    const status = await this.runner.run(["status"], { allowFailure: true });
    if (status.code !== 0) {
      await this.runner.run(["start"], {
        timeoutMs: CREATE_TIMEOUT_MS,
        allowFailure: true,
      });
    }
    let info = await this.readMachineInfo(machineName, true);
    let recoveryHoldPath: string | null = null;
    try {
      if (!info) {
        if (this.freeDiskBytes() < MINIMUM_CREATE_FREE_BYTES) {
          throw new MacosContainerWorkerUnavailableError(
            "insufficient-disk-space",
            "OrbStack needs at least 4 GiB free before ZSR can create an isolated container worker",
          );
        }
        recoveryHoldPath = prepareOrbStackRecoveryHold(
          sessionRoot,
          executionId,
          machineName,
          mountRoots,
        );
        const architecture = expectedArchitecture();
        const created = await this.runner.run(
          [
            "create",
            "--arch",
            architecture,
            "--isolated",
            "--isolate-network",
            "--memory",
            `${MACHINE_MEMORY_MIB}M`,
            "--cpus",
            String(MACHINE_CPUS),
            "--disk",
            "16G",
            "--user",
            "zeros-agent",
            "--user-data",
            this.cloudInitPath,
            ...mountRoots.flatMap((root) => ["--mount", `${root}:${root}`]),
            "ubuntu:24.04",
            machineName,
          ],
          { timeoutMs: CREATE_TIMEOUT_MS, allowFailure: true },
        );
        if (created.code !== 0) {
          // OrbStack 2.2.x can finish creating an isolated machine and then
          // lose its local scon control-RPC reply ("Post http://sconrpc: EOF").
          // Never trust stderr to classify that outcome: it may contain host
          // paths. Recover only when the signed CLI can attest the exact,
          // lease-derived identity. The complete configuration and runtime are
          // still verified below before a lease is returned.
          info = await this.readMachineInfo(machineName, true);
          if (!info) {
            throw new Error(
              "OrbStack did not create an attestable isolated worker",
            );
          }
        }
        await this.waitForCloudInit(machineName);
        info = await this.readMachineInfo(machineName, false);
      } else {
        recoveryHoldPath = prepareOrbStackRecoveryHold(
          sessionRoot,
          executionId,
          machineName,
          mountRoots,
        );
      }
      if (!info)
        throw new Error("OrbStack worker did not publish its identity");
      if (info.record.state === "stopped") {
        await this.runner.run(["start", machineName], {
          timeoutMs: CREATE_TIMEOUT_MS,
        });
        info = await this.readMachineInfo(machineName, false);
        if (!info) {
          throw new Error("OrbStack worker disappeared while restarting");
        }
      }
      validateOrbStackMachineInfo(info, machineName, mountRoots);
      const runtimeIdentity = await this.waitForRuntimeIdentity(machineName);
      await this.provisionRuntime(machineName, sessionRoot);
      return { runtimeIdentity, recoveryHoldPath };
    } catch (error) {
      if (!recoveryHoldPath) throw error;
      try {
        await deleteOrbStackMachineAndProve(this.runner, machineName);
        removeOrbStackRecoveryHold(recoveryHoldPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OrbStack worker admission failed and cleanup was not proven",
        );
      }
      if (error instanceof MacosContainerWorkerUnavailableError) throw error;
      throw new MacosContainerWorkerUnavailableError(
        "private-runtime-unavailable",
        "The isolated OrbStack container worker could not be securely provisioned",
        { cause: error },
      );
    }
  }

  private async waitForCloudInit(machineName: string): Promise<void> {
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    do {
      const result = await this.runner.run(
        ["-m", machineName, "-u", "root", "cloud-init", "status", "--wait"],
        { timeoutMs: COMMAND_TIMEOUT_MS, allowFailure: true },
      );
      if (result.code === 0) return;
      if (/^\s*status:\s*(?:error|degraded)\b/im.test(result.stdout)) {
        throw new Error("OrbStack cloud-init reported a provisioning error");
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, RUNTIME_USER_RETRY_MS),
      );
    } while (Date.now() < deadline);
    throw new Error("OrbStack cloud-init did not complete in time");
  }

  private async waitForRuntimeIdentity(
    machineName: string,
  ): Promise<OrbStackRuntimeIdentity> {
    const hostUid = process.getuid?.();
    if (!Number.isInteger(hostUid) || Number(hostUid) < 0) {
      throw new Error("Mac owner identity is unavailable");
    }
    const deadline = Date.now() + RUNTIME_USER_TIMEOUT_MS;
    do {
      const result = await this.runner.run(
        [
          "-m",
          machineName,
          "-u",
          "root",
          "/usr/bin/getent",
          "passwd",
          "zeros-agent",
        ],
        { allowFailure: true },
      );
      if (result.code === 0) {
        const fields = result.stdout.trim().split(":");
        const uid = Number(fields[2]);
        const gid = Number(fields[3]);
        if (
          fields.length === 7 &&
          fields[0] === "zeros-agent" &&
          Number.isSafeInteger(uid) &&
          Number.isSafeInteger(gid) &&
          uid === hostUid &&
          (uid > 0 || Boolean(process.env.VITEST)) &&
          gid > 0 &&
          fields[5] === "/home/zeros-agent"
        ) {
          return { uid, gid };
        }
        throw new Error(
          "OrbStack runtime identity does not match the Mac owner",
        );
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, RUNTIME_USER_RETRY_MS),
      );
    } while (Date.now() < deadline);
    throw new Error("OrbStack runtime identity was not published in time");
  }

  private async readMachineInfo(
    machineName: string,
    allowMissing: boolean,
  ): Promise<OrbStackMachineInfo | null> {
    const result = await this.runner.run(
      ["info", machineName, "--format", "json"],
      { allowFailure: allowMissing },
    );
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout) as OrbStackMachineInfo;
    } catch {
      throw new Error("OrbStack returned malformed machine attestation");
    }
  }

  private async provisionRuntime(
    machineName: string,
    sessionRoot: string,
  ): Promise<void> {
    const marker = await this.runner.run([
      "-m",
      machineName,
      "-u",
      "root",
      "/bin/cat",
      "/etc/zeros-zsr/runtime.json",
    ]);
    if (marker.stdout.trim() !== RUNTIME_MARKER) {
      throw new Error("OrbStack worker runtime contract is stale");
    }
    const assets = [
      [this.hostScriptPath, HOST_VM_PATH],
      [this.containerWorkerPath, WORKER_VM_PATH],
    ] as const;
    const staged: string[] = [];
    try {
      for (const [source, destination] of assets) {
        const contents = await readFile(source);
        if (contents.byteLength > MAX_RUNTIME_ASSET_BYTES) {
          throw new Error("OrbStack runtime asset exceeds its size contract");
        }
        const incoming = path.join(
          sessionRoot,
          `orbstack-runtime-asset-${randomUUID()}-${path.basename(source)}`,
        );
        writeFileSync(incoming, contents, {
          mode: 0o600,
          flag: "wx",
        });
        chmodSync(incoming, 0o600);
        physicalFile(incoming, "staged OrbStack runtime asset");
        staged.push(incoming);
        await this.runner.run([
          "-m",
          machineName,
          "-u",
          "root",
          "/usr/bin/install",
          "-m",
          "0555",
          "-o",
          "root",
          "-g",
          "root",
          incoming,
          destination,
        ]);
        const remote = await this.runner.run([
          "-m",
          machineName,
          "-u",
          "root",
          "/usr/bin/sha256sum",
          destination,
        ]);
        const expected = createHash("sha256").update(contents).digest("hex");
        if (remote.stdout.trim().split(/\s+/, 1)[0] !== expected) {
          throw new Error("OrbStack runtime asset attestation failed");
        }
      }
    } finally {
      for (const incoming of staged) rmSync(incoming, { force: true });
    }
  }
}

export interface OrbStackRecoverySweepResult {
  readonly recovered: number;
  readonly retained: number;
  readonly active: number;
}

interface ValidatedOrbStackRecoveryHold {
  readonly holdPath: string;
  readonly value: OrbStackRecoveryHold;
}

function readValidatedOrbStackRecoveryHold(
  sessionDirectory: string,
): ValidatedOrbStackRecoveryHold | null {
  const holdPath = path.join(
    sessionDirectory,
    ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
  );
  let metadata;
  try {
    metadata = lstatSync(holdPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("OrbStack recovery hold is not a physical file");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(holdPath, "utf8"));
  } catch {
    throw new Error("OrbStack recovery hold is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OrbStack recovery hold is malformed");
  }
  const record = value as Partial<OrbStackRecoveryHold>;
  const keys = Object.keys(value).sort();
  const sessionRoot = realpathSync(sessionDirectory);
  const isV1 =
    record.version === 1 &&
    JSON.stringify(keys) ===
      JSON.stringify(["executionId", "machineName", "mountRoots", "version"]);
  const isV2 =
    record.version === 2 &&
    JSON.stringify(keys) ===
      JSON.stringify([
        "executionId",
        "machineName",
        "mountRoots",
        "ownerPid",
        "version",
      ]) &&
    Number.isSafeInteger(
      (record as Partial<OrbStackRecoveryHoldV2>).ownerPid,
    ) &&
    Number((record as Partial<OrbStackRecoveryHoldV2>).ownerPid) > 0;
  if (
    (!isV1 && !isV2) ||
    typeof record.executionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(record.executionId) ||
    path.basename(sessionRoot) !== record.executionId ||
    typeof record.machineName !== "string" ||
    !Array.isArray(record.mountRoots) ||
    record.mountRoots.length < 2 ||
    record.mountRoots.length > 66 ||
    record.mountRoots.some(
      (root) =>
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        root.includes("\0") ||
        path.normalize(root) !== root,
    )
  ) {
    throw new Error("OrbStack recovery hold is malformed");
  }
  const mountRoots = record.mountRoots as string[];
  if (
    JSON.stringify(mountRoots) !==
      JSON.stringify(minimalMountRoots(mountRoots)) ||
    !mountRoots.includes(sessionRoot) ||
    record.machineName !== orbStackMachineName(record.executionId, mountRoots)
  ) {
    throw new Error("OrbStack recovery hold does not match its session");
  }
  return {
    holdPath,
    value:
      record.version === 2
        ? {
            version: 2,
            executionId: record.executionId,
            machineName: record.machineName,
            mountRoots,
            ownerPid: Number(
              (record as Partial<OrbStackRecoveryHoldV2>).ownerPid,
            ),
          }
        : {
            version: 1,
            executionId: record.executionId,
            machineName: record.machineName,
            mountRoots,
          },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/** Recover engine-owned macOS container machines left by a crash or failed
 * teardown. Invalid holds are retained rather than interpreted as deletion
 * authority, and generic session GC keeps their selective-mount roots alive. */
export async function recoverOrphanedOrbStackMachines(options: {
  readonly sessionsRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runner?: OrbStackCommandRunner;
  readonly isProcessAlive?: (pid: number) => boolean;
}): Promise<OrbStackRecoverySweepResult> {
  let entries;
  try {
    entries = await readdir(options.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { recovered: 0, retained: 0, active: 0 };
    }
    throw error;
  }
  const holds: ValidatedOrbStackRecoveryHold[] = [];
  let retained = 0;
  let active = 0;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const hold = readValidatedOrbStackRecoveryHold(
        path.join(options.sessionsRoot, entry.name),
      );
      if (!hold) continue;
      if (hold.value.version === 2 && isProcessAlive(hold.value.ownerPid)) {
        active += 1;
        continue;
      }
      holds.push(hold);
    } catch {
      retained += 1;
    }
  }
  if (holds.length === 0) return { recovered: 0, retained, active };
  let runner = options.runner;
  if (!runner) {
    const executable = findOrbStackCli(options.env ?? process.env);
    if (!executable) {
      return { recovered: 0, retained: retained + holds.length, active };
    }
    runner = createOrbStackCommandRunner(executable);
  }
  let recovered = 0;
  for (const hold of holds) {
    try {
      await deleteOrbStackMachineAndProve(runner, hold.value.machineName);
      removeOrbStackRecoveryHold(hold.holdPath);
      recovered += 1;
    } catch {
      retained += 1;
    }
  }
  return { recovered, retained, active };
}

/** Find OrbStack only through physical, immutable installation paths. An
 * ambient Docker/Podman socket is deliberately not a fallback. */
export function findOrbStackCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
  attest: (candidate: string) => string = attestOrbStackCli,
): string | null {
  const candidates = [
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry))
      .map((entry) => path.join(entry, "orb")),
    ...(env.HOME && path.isAbsolute(env.HOME)
      ? [path.join(env.HOME, ".orbstack", "bin", "orb")]
      : []),
    "/Applications/OrbStack.app/Contents/MacOS/bin/orb",
  ];
  for (const candidate of candidates) {
    try {
      return attest(candidate);
    } catch {
      // Continue to the next trusted installation location.
    }
  }
  return null;
}
