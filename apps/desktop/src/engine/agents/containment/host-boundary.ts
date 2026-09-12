import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EXECUTION_BOUNDARY_STATUS_VERSION } from "@zeros/protocol/containment";

import {
  ensureSessionDir,
  HOST_PROCESS_RECOVERY_HOLD_FILE,
  removeSessionDir,
  sessionsRoot,
  writeSessionMeta,
} from "../session-paths";

import type {
  AdmissionControl,
  BoundaryProcess,
  BoundaryProcessExit,
  BoundaryProbeResult,
  BoundaryRequest,
  BoundarySpawnRequest,
  ExecutionBoundary,
  ExecutionBoundaryRecoveryResult,
  PortLease,
  PortMapping,
  PreparedBoundary,
  TerritoryGeneration,
} from "./types";

const execFileAsync = promisify(execFile);
const PROCESS_POLL_MS = 20;
const GRACEFUL_STOP_MS = 2_000;
const FORCE_STOP_MS = 1_000;
const HOST_LIFECYCLE_VERSION = 1 as const;
const MAX_RECOVERY_DESCRIPTOR_BYTES = 64 * 1024;
const CLAIM_SETTLE_MS = 500;
const HOST_SUPERVISOR_INTERNAL_PREFIX = "ZEROS_HOST_SUPERVISOR_";

interface HostGenerationRecord {
  readonly version: typeof HOST_LIFECYCLE_VERSION;
  readonly generation: TerritoryGeneration;
  readonly executionId: string;
  readonly ownerPid: number;
  readonly ownerStartToken: string | null;
  readonly createdAt: number;
}

interface HostDomainRecord {
  readonly version: typeof HOST_LIFECYCLE_VERSION;
  readonly kind: "supervisor";
  readonly generation: TerritoryGeneration;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

interface HostLaunchRecord {
  readonly version: typeof HOST_LIFECYCLE_VERSION;
  readonly kind: "launch";
  readonly generation: TerritoryGeneration;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

export interface HostExecutionBoundaryOptions {
  /** Repository root used to find the development supervisor source. Packaged
   * launches receive an explicit resource path from the Electron sidecar. */
  readonly projectRoot?: string;
  readonly supervisorScript?: string;
  readonly supervisorRuntime?: string;
  /** Test seam for simulating an engine that died while its child remains. */
  readonly ownerProcessId?: number;
}

function abortIfRequested(control?: AdmissionControl): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason instanceof Error
      ? control.signal.reason
      : new Error("host execution admission was cancelled");
  }
}

function processDomainExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessDomain(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (processDomainExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  }
  return true;
}

async function signalProcessDomain(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", [
        "/pid",
        String(pid),
        "/t",
        ...(signal === "SIGKILL" ? ["/f"] : []),
      ]);
    } catch (error) {
      // taskkill uses a non-zero exit when the process disappeared between the
      // liveness probe and the command. Recheck the authority domain before
      // deciding whether this is a teardown failure.
      if (processDomainExists(pid)) throw error;
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function childExit(child: ChildProcess): Promise<BoundaryProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | string | null,
    ) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once("exit", finish);
    // ENOENT/EACCES can emit `error` without an `exit` event.
    child.once("error", () => finish(null, null));
  });
}

function trackedHostProcess(
  pid: number,
  child?: ChildProcess,
): BoundaryProcess {
  let stopPromise: Promise<void> | null = null;
  const exited = child ? childExit(child) : null;
  const signal = (value: NodeJS.Signals) => signalProcessDomain(pid, value);
  return {
    pid,
    ...(child ? { child } : {}),
    stdin: child?.stdin ?? null,
    stdout: child?.stdout ?? null,
    stderr: child?.stderr ?? null,
    wait: async () => {
      if (exited) return exited;
      while (processDomainExists(pid)) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, PROCESS_POLL_MS),
        );
      }
      return { code: null, signal: null };
    },
    signal,
    stopAndProve: () => {
      if (stopPromise) return stopPromise;
      const attempt = (async () => {
        if (!processDomainExists(pid)) return;
        await signal("SIGTERM");
        if (await waitForProcessDomain(pid, GRACEFUL_STOP_MS)) return;
        await signal("SIGKILL");
        if (!(await waitForProcessDomain(pid, FORCE_STOP_MS))) {
          throw new Error(`Host process domain ${pid} survived SIGKILL`);
        }
        // Reap the direct child after proving every descendant is gone.
        await exited;
      })();
      const wrapped = attempt.catch((error) => {
        if (stopPromise === wrapped) stopPromise = null;
        throw error;
      });
      stopPromise = wrapped;
      return wrapped;
    },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let windowsCurrentProcessStartToken: Promise<string | null> | null = null;

async function processStartToken(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const [bootId, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      // Field 2 (`comm`) is parenthesized and may itself contain spaces or
      // parentheses. Everything after its final `)` starts at field 3; process
      // start time is field 22, therefore index 19 in this suffix.
      const endOfCommand = stat.lastIndexOf(")");
      const startTicks =
        endOfCommand >= 0
          ? stat
              .slice(endOfCommand + 1)
              .trim()
              .split(/\s+/)[19]
          : undefined;
      if (!startTicks || !/^[0-9]+$/.test(startTicks)) return null;
      return `linux:${bootId.trim()}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const query = async () => {
      try {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToFileTimeUtc()`,
        ]);
        const identity = stdout.trim();
        return /^[0-9]+$/.test(identity) ? `win32:${pid}:${identity}` : null;
      } catch {
        return null;
      }
    };
    if (pid !== process.pid) return query();
    windowsCurrentProcessStartToken ??= query();
    return windowsCurrentProcessStartToken;
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "uid=,lstart=",
    ]);
    const identity = stdout.trim().replace(/\s+/g, " ");
    return identity ? `${process.platform}:${identity}` : null;
  } catch {
    return null;
  }
}

async function readBoundedPhysicalJson(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const [opened, linked] = await Promise.all([handle.stat(), lstat(file)]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.size <= 0 ||
      opened.size > MAX_RECOVERY_DESCRIPTOR_BYTES ||
      (process.platform !== "win32" && (opened.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error(
        "host lifecycle descriptor is not a trusted private file",
      );
    }
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseGenerationRecord(
  value: unknown,
  expected: { generation: string; executionId: string },
): HostGenerationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid host generation recovery descriptor");
  }
  const record = value as Partial<HostGenerationRecord>;
  if (
    record.version !== HOST_LIFECYCLE_VERSION ||
    record.generation !== expected.generation ||
    record.executionId !== expected.executionId ||
    !Number.isSafeInteger(record.ownerPid) ||
    Number(record.ownerPid) <= 0 ||
    !(
      record.ownerStartToken === null ||
      (typeof record.ownerStartToken === "string" &&
        record.ownerStartToken.length > 0 &&
        record.ownerStartToken.length <= 512)
    ) ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) < 0 ||
    Object.keys(record).sort().join("\0") !==
      "createdAt\0executionId\0generation\0ownerPid\0ownerStartToken\0version"
  ) {
    throw new Error("invalid host generation recovery descriptor");
  }
  return record as HostGenerationRecord;
}

function parseDomainRecord(
  value: unknown,
  expected: { generation: string; token: string },
): HostDomainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid host process-domain recovery descriptor");
  }
  const record = value as Partial<HostDomainRecord>;
  if (
    record.version !== HOST_LIFECYCLE_VERSION ||
    record.kind !== "supervisor" ||
    record.generation !== expected.generation ||
    record.token !== expected.token ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) < 0 ||
    Object.keys(record).sort().join("\0") !==
      "createdAt\0generation\0kind\0pid\0token\0version"
  ) {
    throw new Error("invalid host process-domain recovery descriptor");
  }
  return record as HostDomainRecord;
}

function parseLaunchRecord(
  value: unknown,
  expected: { generation: string; token: string },
): HostLaunchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid host launch recovery descriptor");
  }
  const record = value as Partial<HostLaunchRecord>;
  if (
    record.version !== HOST_LIFECYCLE_VERSION ||
    record.kind !== "launch" ||
    record.generation !== expected.generation ||
    record.token !== expected.token ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) < 0 ||
    Object.keys(record).sort().join("\0") !==
      "createdAt\0generation\0kind\0pid\0token\0version"
  ) {
    throw new Error("invalid host launch recovery descriptor");
  }
  return record as HostLaunchRecord;
}

async function physicalDirectoryEntries(directory: string) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("host lifecycle path is not a physical directory");
    }
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function cancelPendingLaunches(generationRoot: string): Promise<boolean> {
  const commandsRoot = path.join(generationRoot, "commands");
  let safe = true;
  for (const entry of await physicalDirectoryEntries(commandsRoot)) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      safe = false;
      continue;
    }
    const source = path.join(commandsRoot, entry.name);
    const cancelled = path.join(generationRoot, `.cancelled-${randomUUID()}`);
    try {
      // This rename arbitrates with the supervisor's command→claim rename.
      // Exactly one side wins; if recovery wins, no provider target can start.
      await rename(source, cancelled);
      await unlink(cancelled);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") safe = false;
    }
  }
  return safe;
}

async function waitForClaimsToSettle(generationRoot: string): Promise<boolean> {
  const claimsRoot = path.join(generationRoot, "claims");
  const deadline = Date.now() + CLAIM_SETTLE_MS;
  while (true) {
    const entries = await physicalDirectoryEntries(claimsRoot);
    if (entries.length === 0) return true;
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  }
}

async function processCommandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return (await readFile(`/proc/${pid}/cmdline`))
        .toString("utf8")
        .split("\0")
        .join(" ");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function supervisorOwnsProcess(record: { pid: number; token: string }) {
  const commandLine = await processCommandLine(record.pid);
  return Boolean(
    commandLine &&
    commandLine.includes("host-process-supervisor") &&
    commandLine.includes(record.token),
  );
}

/** Retire one stale native generation. `false` means evidence was malformed or
 * ambiguous and must be preserved rather than risking an unrelated process. */
async function recoverHostGeneration(
  generationRoot: string,
  generation: TerritoryGeneration,
): Promise<boolean> {
  if (!(await cancelPendingLaunches(generationRoot))) return false;
  // A supervisor that won the atomic claim publishes its PID before starting
  // the target. Give that synchronous hand-off a short bounded settle window.
  if (!(await waitForClaimsToSettle(generationRoot))) return false;
  if (!(await cancelPendingLaunches(generationRoot))) return false;

  const launchesRoot = path.join(generationRoot, "launches");
  for (const entry of await physicalDirectoryEntries(launchesRoot)) {
    const token = entry.name.endsWith(".json")
      ? entry.name.slice(0, -".json".length)
      : "";
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^[0-9a-f-]{36}$/i.test(token)
    ) {
      return false;
    }
    const file = path.join(launchesRoot, entry.name);
    let record: HostLaunchRecord;
    try {
      record = parseLaunchRecord(await readBoundedPhysicalJson(file), {
        generation,
        token,
      });
    } catch {
      return false;
    }
    if (processDomainExists(record.pid)) {
      if (!(await supervisorOwnsProcess(record))) return false;
      await trackedHostProcess(record.pid).stopAndProve();
    }
    await unlink(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  const domainsRoot = path.join(generationRoot, "domains");
  for (const entry of await physicalDirectoryEntries(domainsRoot)) {
    const file = path.join(domainsRoot, entry.name);
    if (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.name.includes(".json.tmp-")
    ) {
      // A temp record precedes publication and target spawn. With no surviving
      // claim it cannot carry process authority.
      await unlink(file).catch(() => undefined);
      continue;
    }
    const token = entry.name.endsWith(".json")
      ? entry.name.slice(0, -".json".length)
      : "";
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^[0-9a-f-]{36}$/i.test(token)
    ) {
      return false;
    }
    let record: HostDomainRecord;
    try {
      record = parseDomainRecord(await readBoundedPhysicalJson(file), {
        generation,
        token,
      });
    } catch {
      return false;
    }
    if (processDomainExists(record.pid)) {
      // A stale PID may have been reused after the original group disappeared.
      // The unique token in the still-running supervisor argv is the ownership
      // proof; ambiguity is preserved and blocks authority instead of killing.
      if (!(await supervisorOwnsProcess(record))) return false;
      await trackedHostProcess(record.pid).stopAndProve();
    }
    await unlink(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  if (
    (await physicalDirectoryEntries(path.join(generationRoot, "commands")))
      .length
  )
    return false;
  if (
    (await physicalDirectoryEntries(path.join(generationRoot, "claims"))).length
  )
    return false;
  if ((await physicalDirectoryEntries(launchesRoot)).length) return false;
  if ((await physicalDirectoryEntries(domainsRoot)).length) return false;
  await rm(generationRoot, { recursive: true, force: true });
  return true;
}

async function recoverStaleHostGenerations(): Promise<ExecutionBoundaryRecoveryResult> {
  const result = { discovered: 0, recovered: 0, active: 0, preserved: 0 };
  let sessions: import("node:fs").Dirent[];
  try {
    sessions = await readdir(sessionsRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const session of sessions) {
    if (session.isSymbolicLink()) {
      result.preserved += 1;
      continue;
    }
    if (!session.isDirectory()) continue;
    const boundaryRoot = path.join(sessionsRoot(), session.name, "boundary");
    let generations: import("node:fs").Dirent[];
    try {
      generations = await physicalDirectoryEntries(boundaryRoot);
    } catch {
      result.preserved += 1;
      continue;
    }
    for (const entry of generations) {
      if (entry.isSymbolicLink()) {
        result.preserved += 1;
        continue;
      }
      if (!entry.isDirectory()) continue;
      const generationRoot = path.join(boundaryRoot, entry.name);
      const descriptorPath = path.join(
        generationRoot,
        HOST_PROCESS_RECOVERY_HOLD_FILE,
      );
      try {
        await lstat(descriptorPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        result.discovered += 1;
        result.preserved += 1;
        continue;
      }
      result.discovered += 1;
      let record: HostGenerationRecord;
      try {
        record = parseGenerationRecord(
          await readBoundedPhysicalJson(descriptorPath),
          { generation: entry.name, executionId: session.name },
        );
      } catch {
        result.preserved += 1;
        continue;
      }
      if (processExists(record.ownerPid)) {
        const currentStartToken = await processStartToken(record.ownerPid);
        if (
          record.ownerStartToken === null ||
          currentStartToken === null ||
          currentStartToken === record.ownerStartToken
        ) {
          result.active += 1;
          continue;
        }
      }
      try {
        if (await recoverHostGeneration(generationRoot, record.generation)) {
          result.recovered += 1;
        } else {
          result.preserved += 1;
        }
      } catch {
        result.preserved += 1;
      }
    }
  }
  return result;
}

async function ensurePrivateDirectory(directory: string, label: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory`);
  }
  await chmod(directory, 0o700);
}

async function availableTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("could not allocate a host TCP port"));
      });
    });
  });
}

const EMPTY_RECOVERY: ExecutionBoundaryRecoveryResult = {
  discovered: 0,
  recovered: 0,
  active: 0,
  preserved: 0,
};

/** Native-host execution with lifecycle ownership but no filesystem or network
 * policy. This is the normal local Code, Setup, and Run posture. It deliberately keeps
 * provider configuration, keychain access, MCP, plugins, additional folders,
 * local services, containers, and native Git untouched. */
export class HostExecutionBoundary implements ExecutionBoundary {
  readonly backend = "none" as const;

  private readonly projectRoot: string;
  private readonly supervisorScript: string;
  private readonly supervisorRuntime: string;
  private readonly ownerProcessId: number;

  constructor(options: HostExecutionBoundaryOptions = {}) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.supervisorScript =
      options.supervisorScript ??
      process.env.ZEROS_HOST_SUPERVISOR_SCRIPT ??
      path.join(
        this.projectRoot,
        "apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
      );
    this.supervisorRuntime =
      options.supervisorRuntime ??
      process.env.ZEROS_HOST_SUPERVISOR_RUNTIME ??
      process.env.ZEROS_PTY_HOST_RUNTIME ??
      process.execPath;
    this.ownerProcessId = options.ownerProcessId ?? process.pid;
    if (
      !Number.isSafeInteger(this.ownerProcessId) ||
      this.ownerProcessId <= 0
    ) {
      throw new Error("host boundary owner process id is invalid");
    }
  }

  private async resolvedSupervisor(): Promise<{
    script: string;
    runtime: string;
  }> {
    if (
      !path.isAbsolute(this.supervisorScript) ||
      !path.isAbsolute(this.supervisorRuntime)
    ) {
      throw new Error("host lifecycle supervisor paths must be absolute");
    }
    const [script, runtime] = await Promise.all([
      realpath(this.supervisorScript),
      realpath(this.supervisorRuntime),
    ]);
    const [scriptMetadata, runtimeMetadata] = await Promise.all([
      lstat(script),
      lstat(runtime),
    ]);
    if (
      !scriptMetadata.isFile() ||
      scriptMetadata.isSymbolicLink() ||
      !runtimeMetadata.isFile() ||
      runtimeMetadata.isSymbolicLink()
    ) {
      throw new Error("host lifecycle supervisor assets are invalid");
    }
    return { script, runtime };
  }

  async recoverStaleProcesses(): Promise<ExecutionBoundaryRecoveryResult> {
    // Ambiguous native evidence is retained for a later retry, but it cannot
    // safely justify killing an unproven same-user process and must not make
    // the entire application unavailable. New generations use fresh private
    // roots, so preserved bookkeeping grants no authority to a new launch.
    return recoverStaleHostGenerations();
  }

  async recoverStaleMutableState(): Promise<ExecutionBoundaryRecoveryResult> {
    return EMPTY_RECOVERY;
  }

  async probe(_request: BoundaryRequest): Promise<BoundaryProbeResult> {
    const reasons: string[] = [];
    try {
      await this.resolvedSupervisor();
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
    return {
      backend: "none",
      available: reasons.length === 0,
      secureNestedIsolation: false,
      reasons,
    };
  }

  async prepare(
    request: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary> {
    abortIfRequested(control);
    const generation = `host-${randomUUID()}` as TerritoryGeneration;
    const supervisor = await this.resolvedSupervisor();
    const ownerStartToken = await processStartToken(this.ownerProcessId);
    const ownedSession = await ensureSessionDir(request.executionId);
    await writeSessionMeta(request.executionId, {
      agentId: request.providerId ?? request.actor,
      actor: request.actor,
      cwd: request.cwd,
      pid: this.ownerProcessId,
      createdAt: Date.now(),
    });
    const boundaryRoot = path.join(ownedSession.root, "boundary");
    const generationRoot = path.join(boundaryRoot, generation);
    const commandsRoot = path.join(generationRoot, "commands");
    const claimsRoot = path.join(generationRoot, "claims");
    const domainsRoot = path.join(generationRoot, "domains");
    const launchesRoot = path.join(generationRoot, "launches");
    try {
      await ensurePrivateDirectory(boundaryRoot, "host boundary root");
      await mkdir(generationRoot, { mode: 0o700 });
      await Promise.all(
        [commandsRoot, claimsRoot, domainsRoot, launchesRoot].map((directory) =>
          ensurePrivateDirectory(directory, "host lifecycle directory"),
        ),
      );
      await writeFile(
        path.join(generationRoot, HOST_PROCESS_RECOVERY_HOLD_FILE),
        JSON.stringify({
          version: HOST_LIFECYCLE_VERSION,
          generation,
          executionId: request.executionId,
          ownerPid: this.ownerProcessId,
          ownerStartToken,
          createdAt: Date.now(),
        } satisfies HostGenerationRecord),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await chmod(
        path.join(generationRoot, HOST_PROCESS_RECOVERY_HOLD_FILE),
        0o600,
      );
    } catch (error) {
      await rm(generationRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await removeSessionDir(request.executionId).catch(() => undefined);
      throw error;
    }
    const processes = new Map<number, BoundaryProcess>();
    const pendingLaunches = new Set<string>();
    const untrackedLaunches: Array<{
      token: string;
      createdAt: number;
      pendingPath: string;
    }> = [];
    const leases = new Map<string, PortLease>();
    const ports = new Map<string, PortMapping>();
    const portObservers = new Set<(snapshot: readonly PortMapping[]) => void>();
    let revoked = false;
    let stopPromise: Promise<void> | null = null;

    const publishPorts = () => {
      const snapshot = [...ports.values()];
      for (const observer of portObservers) observer(snapshot);
    };
    const takeLaunch = (child?: ChildProcess) => {
      let index = -1;
      if (child) {
        const tokenOption = child.spawnargs.lastIndexOf("--token");
        const token =
          tokenOption >= 0 ? child.spawnargs[tokenOption + 1] : undefined;
        if (token) {
          index = untrackedLaunches.findIndex(
            (candidate) => candidate.token === token,
          );
        }
      }
      if (index < 0 && untrackedLaunches.length > 0) index = 0;
      if (index < 0) return undefined;
      return untrackedLaunches.splice(index, 1)[0];
    };
    const discardFailedLaunch = (child: ChildProcess) => {
      const launch = takeLaunch(child);
      if (!launch) return;
      pendingLaunches.delete(launch.pendingPath);
      try {
        unlinkSync(launch.pendingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    const track = (pid: number, child?: ChildProcess): BoundaryProcess => {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        throw new Error("host boundary received an invalid process-domain id");
      }
      const existing = processes.get(pid);
      if (existing) return existing;
      // Every wrapped launch is durably associated with its supervisor pid,
      // including node-pty callers that can report only a process-group id.
      // This closes the claim→domain crash interval for the native boundary.
      const launch = takeLaunch(child);
      if (launch) {
        try {
          const launchPath = path.join(launchesRoot, `${launch.token}.json`);
          writeFileSync(
            launchPath,
            JSON.stringify({
              version: HOST_LIFECYCLE_VERSION,
              kind: "launch",
              generation,
              token: launch.token,
              pid,
              createdAt: launch.createdAt,
            } satisfies HostLaunchRecord),
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
          chmodSync(launchPath, 0o600);
        } catch (error) {
          if (process.platform === "win32")
            void signalProcessDomain(pid, "SIGKILL");
          else {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // The child may already have failed before durable adoption.
            }
          }
          throw error;
        }
      }
      const tracked = trackedHostProcess(pid, child);
      processes.set(pid, tracked);
      if (revoked) void tracked.stopAndProve().catch(() => undefined);
      return tracked;
    };
    const revokeLeases = async () => {
      await Promise.all([...leases.values()].map((lease) => lease.revoke()));
    };

    const prepared: PreparedBoundary = {
      generation,
      attestation: Promise.resolve(),
      status: {
        version: EXECUTION_BOUNDARY_STATUS_VERSION,
        actor: request.actor,
        state: request.territory ? "ready" : "not-required",
        backend: "none",
        designProtection: {
          required: Boolean(request.territory),
          // Native host execution never claims a filesystem write deny. A
          // territory-bearing request is retained only for compatibility with
          // injected/older callers; current local Code requests omit it.
          enforced: false,
          protectedDirectoryCount:
            request.territory?.protectedDesignDirectories.length ?? 0,
          ...(request.territory ? { territoryGeneration: generation } : {}),
        },
        parity: { level: "full", restrictions: [] },
        git: { state: "native" },
        checkedAt: Date.now(),
      },
      providerHomePath: request.providerStateEnv?.HOME ?? homedir(),
      wrapSpawn: (spawnRequest: BoundarySpawnRequest) => {
        if (revoked) throw new Error("host execution boundary is revoked");
        const token = randomUUID();
        const pendingPath = path.join(commandsRoot, `${token}.json`);
        const claimPath = path.join(claimsRoot, `${token}.json`);
        const domainPath = path.join(domainsRoot, `${token}.json`);
        const createdAt = Date.now();
        writeFileSync(
          pendingPath,
          JSON.stringify({
            version: HOST_LIFECYCLE_VERSION,
            generation,
            token,
            // The supervisor is spawned directly by this engine even when a
            // test substitutes a dead recovery owner in the generation record.
            ownerPid: process.pid,
            createdAt,
          }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        chmodSync(pendingPath, 0o600);
        pendingLaunches.add(pendingPath);
        untrackedLaunches.push({ token, createdAt, pendingPath });
        const originalSupervisorEnvironment = Object.fromEntries(
          Object.entries(spawnRequest.env).filter(
            ([name]) =>
              name === "ELECTRON_RUN_AS_NODE" ||
              name.startsWith(HOST_SUPERVISOR_INTERNAL_PREFIX),
          ),
        );
        const env = {
          ...spawnRequest.env,
          [`${HOST_SUPERVISOR_INTERNAL_PREFIX}ORIGINAL_ENV`]: Buffer.from(
            JSON.stringify(originalSupervisorEnvironment),
          ).toString("base64url"),
          ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
            ? { ELECTRON_RUN_AS_NODE: "1" }
            : {}),
        };
        const args = [
          supervisor.script,
          "--pending",
          pendingPath,
          "--claim",
          claimPath,
          "--domain",
          domainPath,
          "--generation",
          generation,
          "--token",
          token,
          "--owner-pid",
          String(process.pid),
          "--parent-pid",
          String(process.pid),
          "--",
          spawnRequest.command,
          ...spawnRequest.args,
        ];
        return {
          command: supervisor.runtime,
          args,
          cwd: spawnRequest.cwd,
          env,
          stdio: spawnRequest.stdio ?? "pipe",
          immediateParentPidArgIndex: args.indexOf("--parent-pid") + 1,
        };
      },
      trackProcess: (child) => {
        if (!child.pid) {
          discardFailedLaunch(child);
          throw new Error("host boundary child has no pid");
        }
        return track(child.pid, child);
      },
      trackProcessGroup: (pid) => track(pid),
      spawn: async (spawnRequest) => {
        if (revoked) throw new Error("host execution boundary is revoked");
        const launch = prepared.wrapSpawn(spawnRequest);
        const child = spawn(launch.command, [...launch.args], {
          cwd: launch.cwd,
          env: { ...launch.env },
          detached: true,
          stdio:
            launch.stdio === "inherit" ? "inherit" : ["pipe", "pipe", "pipe"],
        });
        if (!child.pid) {
          child.once("error", () => undefined);
          discardFailedLaunch(child);
          throw new Error("host boundary child did not receive a process id");
        }
        return track(child.pid, child);
      },
      requestPort: async (portRequest) => {
        if (revoked) throw new Error("host execution boundary is revoked");
        if (portRequest.protocol !== "tcp") {
          throw new Error("host boundary port discovery supports TCP only");
        }
        const port = portRequest.preferredPort ?? (await availableTcpPort());
        const targetPort = portRequest.targetPort ?? port;
        const leaseId = `host-port-${randomUUID()}`;
        const lease: PortLease = {
          leaseId,
          generation,
          host: "127.0.0.1",
          port,
          targetPort,
          revoke: async () => {
            leases.delete(leaseId);
            ports.delete(leaseId);
            publishPorts();
          },
        };
        leases.set(leaseId, lease);
        ports.set(leaseId, {
          leaseId,
          generation,
          protocol: "tcp",
          host: "127.0.0.1",
          port,
          targetPort,
          displayPort: portRequest.preferredPort ?? targetPort,
          purpose: portRequest.purpose,
          source: "requested",
        });
        publishPorts();
        return lease;
      },
      activePorts: () => [...ports.values()],
      portDiscoveryStatus: () => ({
        state: revoked ? "revoked" : "idle",
      }),
      onPortsChanged: (listener) => {
        portObservers.add(listener);
        listener([...ports.values()]);
        return () => portObservers.delete(listener);
      },
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        await revokeLeases();
      },
      stopAndProve: async () => {
        if (stopPromise) return stopPromise;
        const attempt = (async () => {
          revoked = true;
          await revokeLeases();
          await Promise.all(
            [...processes.values()].map((tracked) => tracked.stopAndProve()),
          );
          for (const pendingPath of pendingLaunches) {
            await unlink(pendingPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
            });
          }
          if (!(await recoverHostGeneration(generationRoot, generation))) {
            throw new Error(
              `host process generation ${generation} could not be proven empty`,
            );
          }
          pendingLaunches.clear();
          processes.clear();
          await removeSessionDir(request.executionId);
        })();
        const wrapped = attempt.catch((error) => {
          if (stopPromise === wrapped) stopPromise = null;
          throw error;
        });
        stopPromise = wrapped;
        return wrapped;
      },
    };
    return prepared;
  }
}
