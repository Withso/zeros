// ============================================
// MODULE: Process metrics sampler
// PURPOSE: Convert one OS process-table read into safe, sampled app metrics.
// USED IN: apps/desktop/electron/ipc/commands/process-metrics.ts and pure regression tests.
// ============================================

import { execFile } from "node:child_process";

import type {
  OtherAppResourceUsage,
  ProcessMetricsSnapshot,
  ProcessResourceMetric,
  ProcessResourceTotals,
  SystemMemoryPressure,
  SystemResourceState,
} from "../src/renderer/platform/process-metrics-types";
import {
  appBundleName,
  describeProcess,
  isZerosBundle,
  type ProcessRole,
} from "./process-labels";

// Below this gap the ps TIME clock (centisecond resolution) has too few ticks
// to divide into a meaningful rate, so a delta would read as a wild spike or a
// flat zero. Well under the 1 s open cadence, so steady sampling never trips it
// — only a burst, such as the immediate re-sample on a visibility change.
const MIN_CPU_BASELINE_MS = 250;
const MAX_CPU_BASELINE_MS = 10_000;
const MAX_TERMINAL_ROOTS = 256;
/** A footprint read older than this no longer describes the live tree. */
export const FOOTPRINT_MAX_AGE_MS = 30_000;
const MAX_ARG_PIDS_PER_READ = 512;

export interface RawProcessSample {
  pid: number;
  parentPid: number;
  rssBytes: number;
  cpuTimeSeconds: number;
  /** Locale-normalized `ps lstart` value, stable for a process lifetime. */
  startKey: string;
  command: string;
}

/** The Electron-only facts used to label Chromium processes. Kept as a small
 * structural interface so this pure module never imports the Electron runtime. */
export interface ElectronProcessDescriptor {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  creationTime?: number;
  workingSetBytes?: number;
  cpuPercent?: number;
  /** Closed native owner labels, resolved from live WebContents. */
  rendererOwner?: string;
}

export interface ProcessMetricsCaptureInput {
  sampledAt: number;
  scanDurationMs: number;
  appPid: number;
  enginePid: number | null;
  samplerPid: number | null;
  logicalCpuCount: number;
  systemMemoryBytes: number;
  terminalPids: readonly number[];
  terminalRootsKnown: boolean;
  rows: readonly RawProcessSample[];
  electronProcesses: readonly ElectronProcessDescriptor[];
  /** This app's executable; Zeros re-runs it as Node for host scripts. */
  appExecutable?: string | null;
  /** Most recent physical-footprint read, applied only to processes that
   * already existed when it started. */
  footprint?: FootprintRead | null;
  system?: SystemResourceState | null;
}

/** One `top -l 1 -stats pid,mem` read. `readAt` is when the read STARTED. */
export interface FootprintRead {
  readAt: number;
  bytesByPid: ReadonlyMap<number, number>;
  /** top's "PhysMem: …" summary line, kept for the diagnostics report. */
  physMem: string | null;
  /** top's "CPU usage: …" summary line, kept for the diagnostics report. */
  cpuUsage: string | null;
}

/** argv for one process identity, read with its start key so a reused PID
 * can never inherit another process's command line. */
export interface ProcessArgsRow {
  pid: number;
  startKey: string;
  args: string;
}

/** Every process in the last capture, for the diagnostics report only. */
export interface SampledProcessRow {
  pid: number;
  parentPid: number;
  command: string;
  startKey: string;
  cpuTimeSeconds: number;
  cpuPercent: number;
  rssBytes: number;
  footprintBytes: number | null;
  owned: boolean;
}

export interface ProcessTableRead {
  rows: RawProcessSample[];
  samplerPid: number | null;
  durationMs: number;
}

type ProcessTableFailureReason = "timeout" | "output-limit" | "exit" | "signal" | "spawn" | "invalid-output";
const PROCESS_TABLE_ERROR_CODES = new Set([
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "EIO", "ENOMEM", "EAGAIN",
]);

/** Only closed OS metadata leaves the sampler on failure. execFile's default
 * error can retain process output and does not distinguish a busy-host timeout
 * from an output limit in the caller's log. */
export class ProcessTableReadError extends Error {
  constructor(
    readonly reason: ProcessTableFailureReason,
    readonly durationMs: number,
    readonly stdoutBytes: number,
    readonly stderrBytes: number,
    readonly code: number | string | null = null,
    readonly signal: string | null = null,
  ) {
    super(`Process table sample failed (${reason}; code=${code ?? "none"}; signal=${signal ?? "none"}; elapsed=${Math.round(durationMs)}ms; stdout=${stdoutBytes}B; stderr=${stderrBytes}B)`);
    this.name = "ProcessTableReadError";
  }
}

/** One scan coordinator for the app-global metrics key. Concurrent callers
 * share the same scan; the newest ownership request is read only after the OS
 * table settles, closing the stale-terminal-filter race. */
export class ProcessMetricsScanCoordinator<Request, Result> {
  private latestRequest: Request;
  private inFlight: Promise<Result> | null = null;

  constructor(
    initialRequest: Request,
    private readonly scan: (latest: () => Request) => Promise<Result>,
  ) {
    this.latestRequest = initialRequest;
  }

  request(request: Request): Promise<Result> {
    this.latestRequest = request;
    if (this.inFlight) return this.inFlight;
    const settled = this.scan(() => this.latestRequest).finally(() => {
      if (this.inFlight === settled) this.inFlight = null;
    });
    this.inFlight = settled;
    return settled;
  }
}

interface PreviousProcess {
  startKey: string;
  cpuTimeSeconds: number;
  identity: string;
}

interface ProcessPeak {
  cpuPercent: number;
  memoryBytes: number;
}

interface TotalsPeak {
  cpuPercent: number;
  cpuAt: number | null;
  memoryBytes: number;
  memoryAt: number | null;
}

/** Parse cumulative process CPU time in the BSD/GNU ps forms
 * [[days-]hours:]minutes:seconds[.fraction]. BSD (macOS) ps prints
 * minutes:seconds with minutes unbounded ("83:27.80"), so only the
 * three-field GNU clock bounds minutes below 60. */
export function parseCpuTime(value: string): number | null {
  const input = value.trim();
  if (!input) return null;

  let days = 0;
  let clock = input;
  const dash = input.indexOf("-");
  if (dash !== -1) {
    days = Number(input.slice(0, dash));
    clock = input.slice(dash + 1);
    if (!Number.isFinite(days) || days < 0) return null;
  }

  const fields = clock.split(":").map(Number);
  if (
    fields.length < 2 ||
    fields.length > 3 ||
    fields.some((field) => !Number.isFinite(field) || field < 0)
  ) {
    return null;
  }

  const [hours, minutes, seconds] =
    fields.length === 3 ? fields : [0, fields[0], fields[1]];
  if ((fields.length === 3 && minutes >= 60) || seconds >= 60) return null;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Validate the renderer's terminal ownership key. Any truncation or malformed
 * member makes exclusion non-authoritative; silently dropping a root while
 * keeping `known=true` would undercount terminal usage. */
export function normalizeTerminalRoots(
  values: unknown,
  claimedKnown: unknown,
): { terminalPids: number[]; terminalRootsKnown: boolean } {
  const raw = Array.isArray(values) ? values : [];
  let complete = Array.isArray(values) && raw.length <= MAX_TERMINAL_ROOTS;
  const pids = new Set<number>();
  for (const value of raw.slice(0, MAX_TERMINAL_ROOTS)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > 2_147_483_647
    ) {
      complete = false;
      continue;
    }
    pids.add(value);
  }
  return {
    terminalPids: [...pids],
    terminalRootsKnown: claimedKnown === true && complete,
  };
}

/** Parse `/bin/ps -axo pid=,ppid=,rss=,time=,lstart=,comm=` under the C locale.
 * The stable start key detects PID reuse even when the new process has the same
 * executable and a higher CPU clock. The final command field intentionally
 * consumes the rest of the line because macOS labels may contain spaces. argv
 * is never requested. */
export function parseProcessTable(stdout: string): RawProcessSample[] {
  const rows: RawProcessSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.+?)\s*$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuTimeSeconds = parseCpuTime(match[4]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isFinite(rssKb) ||
      rssKb < 0 ||
      cpuTimeSeconds == null
    ) {
      continue;
    }
    rows.push({
      pid,
      parentPid,
      rssBytes: rssKb * 1024,
      cpuTimeSeconds,
      startKey: `${match[5]} ${match[6]} ${Number(match[7])} ${match[8]} ${match[9]}`,
      command: match[10],
    });
  }
  return rows;
}

const LSTART_PREFIX =
  /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})(?:\s(.*))?$/;

/** Parse `ps -ww -o pid=,lstart=,args=` under the C locale. */
export function parseProcessArgs(stdout: string): ProcessArgsRow[] {
  const rows: ProcessArgsRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LSTART_PREFIX.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      startKey: `${match[2]} ${match[3]} ${Number(match[4])} ${match[5]} ${match[6]}`,
      args: (match[7] ?? "").trim(),
    });
  }
  return rows;
}

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Parse `top -l 1 -stats pid,mem` (macOS). MEM is the physical footprint
 * Activity Monitor shows, which counts compressed pages that resident size
 * omits. */
export function parseFootprint(
  stdout: string,
  readAt: number,
): FootprintRead {
  const bytesByPid = new Map<number, number>();
  let physMem: string | null = null;
  let cpuUsage: string | null = null;
  let inTable = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!inTable) {
      if (line.startsWith("PhysMem:")) physMem = line.trim().slice(0, 200);
      else if (line.startsWith("CPU usage:")) cpuUsage = line.trim().slice(0, 200);
      else if (/^\s*PID\s+MEM\b/.test(line)) inTable = true;
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])?[+-]?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const bytes = Math.round(Number(match[2]) * UNIT_BYTES[match[3] ?? "B"]);
    if (Number.isSafeInteger(pid) && pid >= 0 && Number.isFinite(bytes))
      bytesByPid.set(pid, bytes);
  }
  return { readAt, bytesByPid, physMem, cpuUsage };
}

const PRESSURE_LEVELS: Record<string, SystemMemoryPressure> = {
  "1": "normal",
  "2": "warning",
  "4": "critical",
};

function parseSwapBytes(text: string, field: string): number | null {
  const match = new RegExp(`${field}\\s*=\\s*([\\d.]+)([KMG])`).exec(text);
  if (!match) return null;
  const value = Number(match[1]) * UNIT_BYTES[match[2]];
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** Parse named `sysctl vm.swapusage kern.memorystatus_level
 * kern.memorystatus_vm_pressure_level` output. A missing key stays null. */
export function parseSystemSysctl(stdout: string): Pick<
  SystemResourceState,
  "memoryPressure" | "memoryFreePercent" | "swapUsedBytes" | "swapTotalBytes"
> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const swap = values.get("vm.swapusage") ?? "";
  const freeText = values.get("kern.memorystatus_level") ?? "";
  const free = /^\d+$/.test(freeText) ? Number(freeText) : Number.NaN;
  return {
    memoryPressure:
      PRESSURE_LEVELS[values.get("kern.memorystatus_vm_pressure_level") ?? ""] ??
      null,
    memoryFreePercent:
      Number.isFinite(free) && free >= 0 && free <= 100 ? free : null,
    swapUsedBytes: parseSwapBytes(swap, "used"),
    swapTotalBytes: parseSwapBytes(swap, "total"),
  };
}

function execText(
  file: string,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        // sysctl exits non-zero when one requested key is unknown but still
        // prints the others; callers parse whatever arrived.
        if (error && !stdout) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** argv for specific Zeros-tree PIDs. Never called for the whole system on the
 * sampling path. */
export async function readProcessArgs(
  pids: readonly number[],
): Promise<ProcessArgsRow[]> {
  const unique = [...new Set(pids)]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .slice(0, MAX_ARG_PIDS_PER_READ);
  if (unique.length === 0) return [];
  return parseProcessArgs(
    await execText(
      "/bin/ps",
      ["-ww", "-o", "pid=,lstart=,args=", "-p", unique.join(",")],
      2_000,
    ),
  );
}

/** argv for every process. Only the user-initiated diagnostics copy uses it,
 * to find detached processes that belong to Zeros. */
export async function readAllProcessArgs(): Promise<ProcessArgsRow[]> {
  return parseProcessArgs(
    await execText("/bin/ps", ["-axww", "-o", "pid=,lstart=,args="], 3_000),
  );
}

/** One physical-footprint read. Costs ~0.4 s of CPU on macOS, so callers
 * throttle it to the open inspector and the diagnostics copy. */
export async function readFootprint(): Promise<FootprintRead | null> {
  if (process.platform !== "darwin") return null;
  const readAt = Date.now();
  return parseFootprint(
    await execText("/usr/bin/top", ["-l", "1", "-stats", "pid,mem"], 5_000),
    readAt,
  );
}

/** macOS memory pressure, free percentage and swap. Cheap: one sysctl exec. */
export async function readSystemSysctl(): Promise<
  ReturnType<typeof parseSystemSysctl> | null
> {
  if (process.platform !== "darwin") return null;
  return parseSystemSysctl(
    await execText(
      "/usr/sbin/sysctl",
      [
        "vm.swapusage",
        "kern.memorystatus_level",
        "kern.memorystatus_vm_pressure_level",
      ],
      1_000,
    ),
  );
}

/** One bounded, argv-free process-table read for an open inspector or explicit
 * diagnostics copy. Allow a busy host five seconds; concurrent requests share
 * this read rather than starting another process. */
export function readProcessTable(): Promise<ProcessTableRead> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let samplerPid: number | null = null;
    const child = execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="],
      {
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        const durationMs = performance.now() - startedAt;
        const stdoutBytes = Buffer.byteLength(stdout ?? "");
        const stderrBytes = Buffer.byteLength(stderr ?? "");
        if (error) {
          const code = typeof error.code === "number" || (typeof error.code === "string" && PROCESS_TABLE_ERROR_CODES.has(error.code)) ? error.code : null;
          const signal = typeof error.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(error.signal) ? error.signal : null;
          const reason = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
            : error.killed || code === "ETIMEDOUT" ? "timeout"
            : typeof code === "number" ? "exit"
            : signal ? "signal" : "spawn";
          reject(new ProcessTableReadError(reason, durationMs, stdoutBytes, stderrBytes, code, signal));
          return;
        }
        const rows = parseProcessTable(stdout);
        if (rows.length === 0) {
          reject(new ProcessTableReadError("invalid-output", durationMs, stdoutBytes, stderrBytes));
          return;
        }
        resolve({
          rows,
          samplerPid,
          durationMs,
        });
      },
    );
    samplerPid = child.pid ?? null;
  });
}

function finiteNonNegative(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function roundMetric(value: number): number {
  return Math.round(finiteNonNegative(value) * 1_000) / 1_000;
}

function electronPresentation(descriptor: ElectronProcessDescriptor): ProcessRole {
  switch (descriptor.type) {
    case "Browser":
      return { name: "Main", kind: "main" };
    case "Tab":
      return { name: descriptor.rendererOwner ? `Renderer — ${descriptor.rendererOwner}` : "Renderer", kind: "renderer" };
    case "GPU":
      return { name: "GPU", kind: "gpu" };
    case "Utility":
      return {
        name: descriptor.name || descriptor.serviceName || "Utility",
        kind: "utility",
      };
    case "Sandbox helper":
    case "Zygote":
      return { name: descriptor.type, kind: "sandbox" };
    default:
      return {
        name:
          descriptor.name ||
          descriptor.serviceName ||
          descriptor.type ||
          "Process",
        kind: "process",
      };
  }
}

function descendantsOf(
  roots: readonly number[],
  childrenByParent: ReadonlyMap<number, readonly number[]>,
): Set<number> {
  const found = new Set<number>();
  const queue = roots.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    if (found.has(pid)) continue;
    found.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) queue.push(child);
  }
  return found;
}

function emptyPeak(): TotalsPeak {
  return { cpuPercent: 0, cpuAt: null, memoryBytes: 0, memoryAt: null };
}

function updateTotalsPeak(
  prior: TotalsPeak,
  cpuPercent: number,
  memoryBytes: number,
  sampledAt: number,
  cpuReady: boolean,
): TotalsPeak {
  const next = { ...prior };
  if (cpuReady && (next.cpuAt == null || cpuPercent > next.cpuPercent)) {
    next.cpuPercent = cpuPercent;
    next.cpuAt = sampledAt;
  }
  if (next.memoryAt == null || memoryBytes > next.memoryBytes) {
    next.memoryBytes = memoryBytes;
    next.memoryAt = sampledAt;
  }
  return next;
}

function totals(
  processes: readonly ProcessResourceMetric[],
  peak: TotalsPeak,
): ProcessResourceTotals {
  return {
    cpuPercent: roundMetric(
      processes.reduce((sum, process) => sum + process.cpuPercent, 0),
    ),
    memoryBytes: processes.reduce(
      (sum, process) => sum + process.memoryBytes,
      0,
    ),
    peakCpuPercent: peak.cpuPercent,
    peakCpuAt: peak.cpuAt,
    peakMemoryBytes: peak.memoryBytes,
    peakMemoryAt: peak.memoryAt,
    processCount: processes.length,
  };
}

/** Every PID owned by this app: Electron's own processes plus every OS
 * descendant of main or any Chromium child. Chromium can report a just-created
 * process before ps observes it, so every authoritative Electron PID seeds the
 * walk. */
export function ownedProcessIds(
  rows: readonly RawProcessSample[],
  appPid: number,
  electronPids: readonly number[],
  samplerPid: number | null,
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === samplerPid) continue;
    const children = childrenByParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.parentPid, children);
  }
  const owned = descendantsOf([appPid, ...electronPids], childrenByParent);
  for (const pid of electronPids) owned.add(pid);
  return owned;
}

function argsKey(pid: number, startKey: string): string {
  return `${pid}\u0000${startKey}`;
}

/** Stateful delta reducer. One instance serves the app lifetime so CPU and peak
 * values survive popover closes while dead process identities are pruned on
 * every sample. */
export class ProcessMetricsTracker {
  private previousCaptureAt: number | null = null;
  /** CPU clock of every sampled process, so other Zeros apps and the
   * diagnostics report get rates as well as this app's tree. */
  private previous = new Map<number, PreviousProcess>();
  private processPeaks = new Map<string, ProcessPeak>();
  private identitySequence = 0;
  private allPeak = emptyPeak();
  private excludingTerminalsPeak: TotalsPeak | null = null;
  /** argv of live owned identities, held in main only. */
  private argsByIdentity = new Map<string, string>();
  /** When each live identity was first sampled; a footprint read applies only
   * to processes that already existed when it started. */
  private firstSeenAt = new Map<string, number>();
  private lastRows: SampledProcessRow[] = [];

  /** Owned PIDs whose current identity has no argv yet. */
  missingArgPids(input: Pick<
    ProcessMetricsCaptureInput,
    "rows" | "appPid" | "electronProcesses" | "samplerPid"
  >): number[] {
    const owned = ownedProcessIds(
      input.rows,
      input.appPid,
      input.electronProcesses.map((process) => process.pid),
      input.samplerPid,
    );
    const missing: number[] = [];
    for (const row of input.rows) {
      if (owned.has(row.pid) && !this.argsByIdentity.has(argsKey(row.pid, row.startKey)))
        missing.push(row.pid);
    }
    return missing;
  }

  /** Remember argv read for exact process identities. */
  recordArgs(rows: readonly ProcessArgsRow[]): void {
    for (const row of rows) this.argsByIdentity.set(argsKey(row.pid, row.startKey), row.args);
  }

  /** argv for one live identity, for the diagnostics report. */
  argsFor(pid: number, startKey: string): string | null {
    return this.argsByIdentity.get(argsKey(pid, startKey)) ?? null;
  }

  /** Every process in the last capture, with rates. Report use only. */
  sampledRows(): readonly SampledProcessRow[] {
    return this.lastRows;
  }

  capture(input: ProcessMetricsCaptureInput): ProcessMetricsSnapshot {
    const intervalMs =
      this.previousCaptureAt == null
        ? null
        : Math.max(0, input.sampledAt - this.previousCaptureAt);
    const cpuReady =
      intervalMs != null &&
      intervalMs >= MIN_CPU_BASELINE_MS &&
      intervalMs <= MAX_CPU_BASELINE_MS;
    const maxCpu = Math.max(1, input.logicalCpuCount) * 100;

    const rowsByPid = new Map<number, RawProcessSample>();
    const childrenByParent = new Map<number, number[]>();
    for (const row of input.rows) {
      if (row.pid === input.samplerPid) continue;
      rowsByPid.set(row.pid, row);
      const children = childrenByParent.get(row.parentPid) ?? [];
      children.push(row.pid);
      childrenByParent.set(row.parentPid, children);
    }

    const electronByPid = new Map(
      input.electronProcesses.map((process) => [process.pid, process]),
    );
    const owned = ownedProcessIds(
      input.rows,
      input.appPid,
      [...electronByPid.keys()],
      input.samplerPid,
    );

    const terminal = input.terminalRootsKnown
      ? descendantsOf(
          input.terminalPids.filter((pid) => owned.has(pid)),
          childrenByParent,
        )
      : new Set<number>();

    const footprint =
      input.footprint &&
      input.sampledAt - input.footprint.readAt <= FOOTPRINT_MAX_AGE_MS
        ? input.footprint
        : null;
    const ownBundle = input.appExecutable
      ? appBundleName(input.appExecutable)
      : null;

    const nextPrevious = new Map<number, PreviousProcess>();
    const nextFirstSeen = new Map<string, number>();
    const liveArgKeys = new Set<string>();
    const livePeakIds = new Set<string>();
    const processes: ProcessResourceMetric[] = [];
    const sampledRows: SampledProcessRow[] = [];
    const otherApps = new Map<string, OtherAppResourceUsage>();
    let footprintApplied = false;

    const footprintFor = (pid: number, identity: string): number | null => {
      if (!footprint) return null;
      const bytes = footprint.bytesByPid.get(pid);
      const firstSeen = this.firstSeenAt.get(identity) ?? input.sampledAt;
      return bytes != null && firstSeen <= footprint.readAt ? bytes : null;
    };

    // Rates and identities for every row, then this app's tree in PID order.
    const identities = new Map<number, string>();
    const osCpu = new Map<number, number>();
    for (const row of rowsByPid.values()) {
      const previous = this.previous.get(row.pid);
      const sameIdentity =
        !!previous &&
        previous.startKey === row.startKey &&
        row.cpuTimeSeconds >= previous.cpuTimeSeconds;
      const descriptor = electronByPid.get(row.pid);
      const identity =
        descriptor?.creationTime != null
          ? `${row.pid}:${descriptor.creationTime}`
          : sameIdentity
            ? previous.identity
            : `${row.pid}:${input.sampledAt}:${++this.identitySequence}`;
      identities.set(row.pid, identity);
      nextFirstSeen.set(identity, this.firstSeenAt.get(identity) ?? input.sampledAt);
      let cpu = 0;
      if (cpuReady && sameIdentity && previous && intervalMs != null)
        cpu = ((row.cpuTimeSeconds - previous.cpuTimeSeconds) * 100_000) / intervalMs;
      osCpu.set(row.pid, roundMetric(Math.min(cpu, maxCpu)));
      nextPrevious.set(row.pid, {
        startKey: row.startKey,
        cpuTimeSeconds: row.cpuTimeSeconds,
        identity,
      });
    }
    this.firstSeenAt = nextFirstSeen;

    for (const pid of [...owned].sort((a, b) => a - b)) {
      const row = rowsByPid.get(pid);
      const descriptor = electronByPid.get(pid);
      if (!row && !descriptor) continue;

      const command =
        row?.command ?? descriptor?.name ?? descriptor?.type ?? "Process";
      const identity =
        identities.get(pid) ??
        (descriptor?.creationTime != null
          ? `${pid}:${descriptor.creationTime}`
          : `${pid}:${input.sampledAt}:${++this.identitySequence}`);

      let cpuPercent = 0;
      if (cpuReady) {
        // app.getAppMetrics() exposes an interval CPU value for Chromium's
        // own processes and is more precise than the portable ps clock. The
        // OS delta remains the source for sidecar/agent/PTY descendants.
        cpuPercent =
          descriptor?.cpuPercent != null
            ? finiteNonNegative(descriptor.cpuPercent)
            : (osCpu.get(pid) ?? 0);
      }
      cpuPercent = roundMetric(Math.min(cpuPercent, maxCpu));

      const footprintBytes = footprintFor(pid, identity);
      if (footprintBytes != null && pid === input.appPid) footprintApplied = true;
      const memoryBytes = Math.round(
        footprintBytes ??
          finiteNonNegative(
            descriptor?.workingSetBytes,
            finiteNonNegative(row?.rssBytes),
          ),
      );
      let args: string | null = null;
      if (row) {
        const key = argsKey(pid, row.startKey);
        args = this.argsByIdentity.get(key) ?? null;
        if (args != null) liveArgKeys.add(key);
      }
      const presentation: ProcessRole = descriptor
        ? electronPresentation(descriptor)
        : describeProcess({
            command,
            args,
            isEngine: pid === input.enginePid,
            appExecutable: input.appExecutable ?? null,
          });
      const parentPid = descriptor
        ? null
        : row && owned.has(row.parentPid)
          ? row.parentPid
          : null;

      const priorPeak = this.processPeaks.get(identity);
      const peak = {
        cpuPercent: Math.max(priorPeak?.cpuPercent ?? 0, cpuPercent),
        memoryBytes: Math.max(priorPeak?.memoryBytes ?? 0, memoryBytes),
      };
      this.processPeaks.set(identity, peak);
      livePeakIds.add(identity);

      processes.push({
        id: identity,
        pid,
        parentPid,
        name: presentation.name,
        kind: presentation.kind,
        cpuPercent,
        memoryBytes,
        peakCpuPercent: peak.cpuPercent,
        peakMemoryBytes: peak.memoryBytes,
        terminal: terminal.has(pid),
      });
    }

    const ownedCpu = new Map(
      processes.map((process) => [process.pid, process.cpuPercent]),
    );
    for (const row of rowsByPid.values()) {
      const identity = identities.get(row.pid)!;
      const isOwned = owned.has(row.pid);
      const footprintBytes = footprintFor(row.pid, identity);
      const cpuPercent = isOwned
        ? (ownedCpu.get(row.pid) ?? osCpu.get(row.pid) ?? 0)
        : (osCpu.get(row.pid) ?? 0);
      sampledRows.push({
        pid: row.pid,
        parentPid: row.parentPid,
        command: row.command,
        startKey: row.startKey,
        cpuTimeSeconds: row.cpuTimeSeconds,
        cpuPercent,
        rssBytes: row.rssBytes,
        footprintBytes,
        owned: isOwned,
      });
      if (isOwned) continue;
      const bundle = appBundleName(row.command);
      if (!isZerosBundle(bundle) || bundle === ownBundle) continue;
      const app = otherApps.get(bundle) ?? {
        name: bundle,
        processCount: 0,
        cpuPercent: 0,
        memoryBytes: 0,
      };
      app.processCount += 1;
      app.cpuPercent = roundMetric(app.cpuPercent + cpuPercent);
      app.memoryBytes += Math.round(footprintBytes ?? row.rssBytes);
      otherApps.set(bundle, app);
    }
    this.lastRows = sampledRows;

    for (const identity of this.processPeaks.keys()) {
      if (!livePeakIds.has(identity)) this.processPeaks.delete(identity);
    }
    for (const key of this.argsByIdentity.keys()) {
      if (!liveArgKeys.has(key)) {
        const [pidText, startKey] = key.split("\u0000");
        const row = rowsByPid.get(Number(pidText));
        if (!row || row.startKey !== startKey || !owned.has(row.pid))
          this.argsByIdentity.delete(key);
      }
    }

    const allCpu = roundMetric(
      processes.reduce((sum, process) => sum + process.cpuPercent, 0),
    );
    const allMemory = processes.reduce(
      (sum, process) => sum + process.memoryBytes,
      0,
    );
    this.allPeak = updateTotalsPeak(
      this.allPeak,
      allCpu,
      allMemory,
      input.sampledAt,
      cpuReady,
    );

    let excludingTerminals: ProcessResourceTotals | null = null;
    if (input.terminalRootsKnown) {
      const included = processes.filter((process) => !process.terminal);
      const cpu = roundMetric(
        included.reduce((sum, process) => sum + process.cpuPercent, 0),
      );
      const memory = included.reduce(
        (sum, process) => sum + process.memoryBytes,
        0,
      );
      this.excludingTerminalsPeak = updateTotalsPeak(
        this.excludingTerminalsPeak ?? emptyPeak(),
        cpu,
        memory,
        input.sampledAt,
        cpuReady,
      );
      excludingTerminals = totals(included, this.excludingTerminalsPeak);
    }

    this.previousCaptureAt = input.sampledAt;
    this.previous = nextPrevious;

    return {
      sampledAt: input.sampledAt,
      samplingIntervalMs: intervalMs,
      scanDurationMs: finiteNonNegative(input.scanDurationMs),
      cpuReady,
      logicalCpuCount: Math.max(1, Math.floor(input.logicalCpuCount)),
      systemMemoryBytes: Math.max(0, Math.round(input.systemMemoryBytes)),
      terminalRootsKnown: input.terminalRootsKnown,
      memorySource: footprintApplied ? "footprint" : "resident",
      footprintAgeMs:
        footprintApplied && footprint
          ? Math.max(0, input.sampledAt - footprint.readAt)
          : null,
      system: input.system ?? null,
      otherApps: [...otherApps.values()].sort(
        (left, right) => right.memoryBytes - left.memoryBytes,
      ),
      totals: {
        all: totals(processes, this.allPeak),
        excludingTerminals,
      },
      processes,
    };
  }
}
