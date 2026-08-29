import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { TerritoryGeneration } from "./types";

const HELPER_PROTOCOL_VERSION = 1 as const;
const DESCRIPTOR_VERSION = 1 as const;
const OUTPUT_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 8_000;

export interface MacosProcessIdentity {
  readonly version: typeof HELPER_PROTOCOL_VERSION;
  readonly pid: number;
  readonly uid: number;
  readonly startSec: string;
  readonly startUsec: string;
}

export interface MacosProcessDomainReapResult {
  readonly version: typeof HELPER_PROTOCOL_VERSION;
  readonly matched: number;
  readonly termSignals: number;
  readonly stopSignals: number;
  readonly killSignals: number;
  readonly remaining: number;
  readonly provedEmpty: true;
}

export interface MacosTcpListener {
  readonly port: number;
  readonly ipv4: boolean;
  readonly ipv6: boolean;
}

export interface MacosProcessDomainRecoveryResult {
  readonly discovered: number;
  readonly recovered: number;
  readonly active: number;
  readonly preserved: number;
}

export interface MacosProcessDomainDescriptor {
  readonly version: typeof DESCRIPTOR_VERSION;
  readonly platform: "darwin";
  readonly generation: TerritoryGeneration;
  readonly markerPath: string;
  readonly policyPath: string;
  readonly ownerUid: number;
  readonly engine: MacosProcessIdentity;
  readonly createdAt: number;
}

export interface MacosProcessDomainCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type MacosProcessDomainCommandRunner = (
  helperPath: string,
  args: readonly string[],
) => Promise<MacosProcessDomainCommandResult>;

export interface MacosProcessDomainOptions {
  readonly helperPath: string;
  readonly markerPath: string;
  readonly policyPath: string;
  readonly metadataPath: string;
  readonly generation: TerritoryGeneration;
  readonly enginePid?: number;
  readonly runner?: MacosProcessDomainCommandRunner;
}

export interface RecoverMacosProcessDomainsOptions {
  readonly helperPath: string;
  readonly sessionsRoot: string;
  readonly runner?: MacosProcessDomainCommandRunner;
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

/** The production helper runner. Exported so its output contract can be
 * tested directly; callers inject their own only in tests. */
export const macosProcessDomainCommandRunner: MacosProcessDomainCommandRunner =
  (helperPath, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(helperPath, [...args], {
        env: {
          HOME: "/var/empty",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: "/tmp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = boundedAppend(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk);
      });
      child.once("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, COMMAND_TIMEOUT_MS);
      // "close", not "exit": exit fires when the process ends, which can be
      // before its stdout pipe has been drained. Resolving there truncated the
      // helper's JSON under concurrent admissions and surfaced as the
      // misleading "returned invalid JSON" refusal.
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `macOS process-domain helper timed out after ${COMMAND_TIMEOUT_MS}ms`,
            ),
          );
          return;
        }
        resolve({
          exitCode: code ?? (signal ? 128 : 125),
          stdout,
          stderr,
        });
      });
    });

function isUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function parseObject(stdout: string): Record<string, unknown> {
  if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT) {
    throw new Error("macOS process-domain helper returned oversized output");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("macOS process-domain helper returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("macOS process-domain helper returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function parseIdentity(stdout: string): MacosProcessIdentity {
  const value = parseObject(stdout);
  if (
    value.version !== HELPER_PROTOCOL_VERSION ||
    !isUnsignedInteger(value.pid) ||
    value.pid <= 0 ||
    !isUnsignedInteger(value.uid) ||
    !isDecimal(value.startSec) ||
    !isDecimal(value.startUsec)
  ) {
    throw new Error("macOS process-domain helper returned invalid identity");
  }
  return value as unknown as MacosProcessIdentity;
}

function parseTcpListeners(stdout: string): readonly MacosTcpListener[] {
  const value = parseObject(stdout);
  if (
    value.version !== HELPER_PROTOCOL_VERSION ||
    !Array.isArray(value.listeners) ||
    value.listeners.length > 256
  ) {
    throw new Error("macOS process-domain helper returned invalid listeners");
  }
  let previous = 0;
  const listeners: MacosTcpListener[] = [];
  for (const candidate of value.listeners) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("macOS process-domain helper returned invalid listeners");
    }
    const listener = candidate as Record<string, unknown>;
    if (
      !isUnsignedInteger(listener.port) ||
      listener.port < 1 ||
      listener.port > 65_535 ||
      listener.port <= previous ||
      typeof listener.ipv4 !== "boolean" ||
      typeof listener.ipv6 !== "boolean" ||
      (!listener.ipv4 && !listener.ipv6) ||
      Object.keys(listener).sort().join("\0") !== "ipv4\0ipv6\0port"
    ) {
      throw new Error("macOS process-domain helper returned invalid listeners");
    }
    previous = listener.port;
    listeners.push(listener as unknown as MacosTcpListener);
  }
  return listeners;
}

function sameIdentity(
  left: MacosProcessIdentity,
  right: MacosProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.uid === right.uid &&
    left.startSec === right.startSec &&
    left.startUsec === right.startUsec
  );
}

function parseDescriptor(
  input: string,
  expected: {
    generation: string;
    markerPath: string;
    policyPath: string;
  },
): MacosProcessDomainDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("invalid macOS process-domain recovery descriptor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid macOS process-domain recovery descriptor");
  }
  const descriptor = value as Partial<MacosProcessDomainDescriptor>;
  if (
    descriptor.version !== DESCRIPTOR_VERSION ||
    descriptor.platform !== "darwin" ||
    descriptor.generation !== expected.generation ||
    descriptor.markerPath !== expected.markerPath ||
    descriptor.policyPath !== expected.policyPath ||
    !isUnsignedInteger(descriptor.ownerUid) ||
    !isUnsignedInteger(descriptor.createdAt) ||
    !descriptor.engine ||
    parseIdentity(JSON.stringify(descriptor.engine)).uid !== descriptor.ownerUid
  ) {
    throw new Error("invalid macOS process-domain recovery descriptor");
  }
  return descriptor as MacosProcessDomainDescriptor;
}

async function assertTrustedHelper(
  helperPath: string,
): Promise<{ canonical: string; metadata: Stats }> {
  if (!path.isAbsolute(helperPath)) {
    throw new Error("macOS process-domain helper path is not absolute");
  }
  const canonical = await realpath(helperPath);
  if (canonical !== helperPath) {
    throw new Error("macOS process-domain helper path is not canonical");
  }
  const metadata = await lstat(canonical);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("macOS process-domain helper is not immutable");
  }
  return { canonical, metadata };
}

/** Successful self-tests per (runner, exact helper identity). The protocol
 * answer is a property of the binary bytes, so re-proving it every admission
 * only re-pays a process spawn: the trust checks in assertTrustedHelper
 * (canonical path, immutability) still run per call, and a replaced binary
 * changes identity and re-tests. Failures are never cached. */
const selfTestedHelpers = new WeakMap<
  MacosProcessDomainCommandRunner,
  Set<string>
>();

export async function probeMacosProcessDomainHelper(
  helperPath: string,
  runner: MacosProcessDomainCommandRunner = macosProcessDomainCommandRunner,
): Promise<void> {
  const { canonical, metadata } = await assertTrustedHelper(helperPath);
  const identity =
    `${canonical}\0${metadata.dev}:${metadata.ino}:` +
    `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`;
  if (selfTestedHelpers.get(runner)?.has(identity)) return;
  const selfTest = parseObject(
    (await invoke(canonical, ["self-test"], runner)).stdout,
  );
  if (
    selfTest.version !== HELPER_PROTOCOL_VERSION ||
    selfTest.platform !== "darwin" ||
    selfTest.processIdentity !== true ||
    selfTest.sandboxInspection !== true ||
    typeof selfTest.callerSandboxed !== "boolean"
  ) {
    throw new Error("macOS process-domain helper self-test failed");
  }
  const proven = selfTestedHelpers.get(runner) ?? new Set<string>();
  proven.add(identity);
  selfTestedHelpers.set(runner, proven);
}

async function invoke(
  helperPath: string,
  args: readonly string[],
  runner: MacosProcessDomainCommandRunner,
  allowExitCodes: readonly number[] = [0],
): Promise<MacosProcessDomainCommandResult> {
  const result = await runner(helperPath, args);
  if (!allowExitCodes.includes(result.exitCode)) {
    throw new Error(`macOS process-domain helper failed (${result.exitCode})`);
  }
  return result;
}

export class MacosProcessDomain {
  readonly descriptor: MacosProcessDomainDescriptor;

  private constructor(
    private readonly helperPath: string,
    readonly metadataPath: string,
    descriptor: MacosProcessDomainDescriptor,
    private readonly runner: MacosProcessDomainCommandRunner,
  ) {
    this.descriptor = descriptor;
  }

  /** Rehydrate only after the caller has parsed and authenticated the durable
   * crash descriptor. Kept separate from create() because recovery must not
   * overwrite the evidence it is about to reap. */
  static fromRecoveryDescriptor(
    helperPath: string,
    metadataPath: string,
    descriptor: MacosProcessDomainDescriptor,
    runner: MacosProcessDomainCommandRunner,
  ): MacosProcessDomain {
    return new MacosProcessDomain(helperPath, metadataPath, descriptor, runner);
  }

  static async create(
    options: MacosProcessDomainOptions,
  ): Promise<MacosProcessDomain> {
    const { canonical: helperPath } = await assertTrustedHelper(
      options.helperPath,
    );
    const runner = options.runner ?? macosProcessDomainCommandRunner;
    await probeMacosProcessDomainHelper(helperPath, runner);
    const enginePid = options.enginePid ?? process.pid;
    const identityResult = await invoke(
      helperPath,
      ["identity", String(enginePid)],
      runner,
    );
    const engine = parseIdentity(identityResult.stdout);
    const currentUid = process.getuid?.();
    if (currentUid === undefined || engine.uid !== currentUid) {
      throw new Error("macOS process-domain helper returned the wrong owner");
    }
    const descriptor: MacosProcessDomainDescriptor = {
      version: DESCRIPTOR_VERSION,
      platform: "darwin",
      generation: options.generation,
      markerPath: options.markerPath,
      policyPath: options.policyPath,
      ownerUid: engine.uid,
      engine,
      createdAt: Date.now(),
    };
    await writeFile(options.metadataPath, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return new MacosProcessDomain(
      helperPath,
      options.metadataPath,
      descriptor,
      runner,
    );
  }

  private fingerprintArgs(): string[] {
    return [
      "--allow",
      this.descriptor.markerPath,
      "--deny",
      this.descriptor.policyPath,
      "--uid",
      String(this.descriptor.ownerUid),
      "--exclude",
      String(this.descriptor.engine.pid),
    ];
  }

  async matches(
    pid: number,
    options: { reportMismatch?: boolean } = {},
  ): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const result = await invoke(
      this.helperPath,
      ["match", ...this.fingerprintArgs(), "--pid", String(pid)],
      this.runner,
      [0, 4],
    );
    const value = parseObject(result.stdout);
    if (
      value.version !== HELPER_PROTOCOL_VERSION ||
      typeof value.match !== "boolean" ||
      (value.match ? result.exitCode !== 0 : result.exitCode !== 4)
    ) {
      throw new Error("macOS process-domain helper returned invalid match");
    }
    if (!value.match && options.reportMismatch === true) {
      const decisions = [
        ["eligible", value.eligible],
        ["sandboxed", value.sandboxed],
        ["allowRead", value.allowRead],
        ["allowWrite", value.allowWrite],
        ["denyRead", value.denyRead],
        ["denyWrite", value.denyWrite],
      ]
        .filter(([, decision]) =>
          ["boolean", "number"].includes(typeof decision),
        )
        .map(([name, decision]) => `${name}=${String(decision)}`)
        .join(" ");
      if (decisions) {
        console.error(`[zsr] macOS process-domain mismatch (${decisions})`);
      }
    }
    return value.match;
  }

  async listTcpListeners(): Promise<readonly MacosTcpListener[]> {
    const result = await invoke(
      this.helperPath,
      ["listeners", ...this.fingerprintArgs()],
      this.runner,
    );
    return parseTcpListeners(result.stdout);
  }

  async reap(): Promise<MacosProcessDomainReapResult> {
    const command = await invoke(
      this.helperPath,
      ["reap", ...this.fingerprintArgs()],
      this.runner,
    );
    const value = parseObject(command.stdout);
    if (
      value.version !== HELPER_PROTOCOL_VERSION ||
      !isUnsignedInteger(value.matched) ||
      !isUnsignedInteger(value.termSignals) ||
      !isUnsignedInteger(value.stopSignals) ||
      !isUnsignedInteger(value.killSignals) ||
      value.remaining !== 0 ||
      value.provedEmpty !== true
    ) {
      throw new Error("macOS process-domain teardown was not proven");
    }
    return value as unknown as MacosProcessDomainReapResult;
  }

  async retireMetadata(): Promise<void> {
    // Idempotent: a retried teardown (or a preparation-cleanup path that
    // already renamed the descriptor) must not throw ENOENT on the second
    // call. The rename to `.reaped` is the durable record either way.
    try {
      await rename(this.metadataPath, `${this.metadataPath}.reaped`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function safeDirectoryEntries(directory: string) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [];
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Reap every prior-generation Seatbelt domain before the engine publishes
 * authority or session GC can remove its immutable fingerprint. Malformed or
 * unverifiable descriptors are preserved and fail startup rather than silently
 * restoring code-write authority to a detached process. */
export async function recoverMacosProcessDomains(
  options: RecoverMacosProcessDomainsOptions,
): Promise<MacosProcessDomainRecoveryResult> {
  const runner = options.runner ?? macosProcessDomainCommandRunner;
  const descriptors: Array<{
    readonly metadataPath: string;
    readonly source: string;
  }> = [];
  for (const session of await safeDirectoryEntries(options.sessionsRoot)) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const boundaryRoot = path.join(
      options.sessionsRoot,
      session.name,
      "boundary",
    );
    for (const generation of await safeDirectoryEntries(boundaryRoot)) {
      if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
      const candidate = path.join(
        boundaryRoot,
        generation.name,
        "commands",
        "process-domain.json",
      );
      let handle;
      try {
        handle = await open(
          candidate,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const metadata = await handle.stat();
        if (metadata.isFile() && metadata.nlink === 1) {
          descriptors.push({
            metadataPath: candidate,
            source: await handle.readFile("utf8"),
          });
        }
      } finally {
        await handle.close();
      }
    }
  }
  if (descriptors.length === 0) {
    return { discovered: 0, recovered: 0, active: 0, preserved: 0 };
  }
  const { canonical: helperPath } = await assertTrustedHelper(
    options.helperPath,
  );
  await probeMacosProcessDomainHelper(helperPath, runner);
  let recovered = 0;
  let active = 0;
  let preserved = 0;
  const failures: unknown[] = [];
  for (const { metadataPath, source } of descriptors) {
    try {
      const generationRoot = path.dirname(path.dirname(metadataPath));
      const generation = path.basename(generationRoot);
      const markerPath = path.join(
        generationRoot,
        "tools",
        "process-domain.marker",
      );
      const policyPath = path.join(generationRoot, "policy.json");
      const descriptor = parseDescriptor(source, {
        generation,
        markerPath,
        policyPath,
      });
      if (descriptor.ownerUid !== process.getuid?.()) {
        throw new Error("macOS process-domain descriptor owner is invalid");
      }
      let recordedEngineIsAlive = false;
      try {
        const identity = parseIdentity(
          (
            await invoke(
              helperPath,
              ["identity", String(descriptor.engine.pid)],
              runner,
            )
          ).stdout,
        );
        recordedEngineIsAlive = sameIdentity(identity, descriptor.engine);
      } catch {
        // ESRCH, PID reuse, and inaccessible identity all mean that this exact
        // prior engine generation cannot be proven alive.
      }
      if (recordedEngineIsAlive) {
        active += 1;
        continue;
      }
      const domain = MacosProcessDomain.fromRecoveryDescriptor(
        helperPath,
        metadataPath,
        descriptor,
        runner,
      );
      await domain.reap();
      await domain.retireMetadata();
      recovered += 1;
    } catch (error) {
      preserved += 1;
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `could not recover ${failures.length} macOS process domain(s)`,
    );
  }
  return {
    discovered: descriptors.length,
    recovered,
    active,
    preserved,
  };
}
