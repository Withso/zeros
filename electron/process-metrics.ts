// ============================================
// MODULE: Process metrics sampler
// PURPOSE: Convert one OS process-table read into safe, sampled app metrics.
// USED IN: electron/ipc/commands/process-metrics.ts and pure regression tests.
// ============================================

import { execFile } from "node:child_process";
import path from "node:path";

import type {
  ProcessMetricsSnapshot,
  ProcessResourceKind,
  ProcessResourceMetric,
  ProcessResourceTotals,
} from "../src/native/process-metrics-types";

const MAX_CPU_BASELINE_MS = 10_000;
const MAX_PROCESS_NAME_LENGTH = 80;
const MAX_TERMINAL_ROOTS = 256;

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
}

export interface ProcessTableRead {
  rows: RawProcessSample[];
  samplerPid: number | null;
  durationMs: number;
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
 * [[days-]hours:]minutes:seconds[.fraction]. */
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
  if (minutes >= 60 || seconds >= 60) return null;
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

/** One bounded, argv-free process-table read. The child PID is returned so the
 * reducer can remove the sampler from its own snapshot. */
export function readProcessTable(): Promise<ProcessTableRead> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let samplerPid: number | null = null;
    const child = execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="],
      {
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          rows: parseProcessTable(stdout),
          samplerPid,
          durationMs: performance.now() - startedAt,
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

function processName(command: string): string {
  const cleaned = command
    .replace(/\s+<defunct>\s*$/, "")
    .replace(/\p{Cc}/gu, " ")
    .trim();
  const base = path.basename(cleaned) || "Process";
  return base.slice(0, MAX_PROCESS_NAME_LENGTH);
}

function electronPresentation(descriptor: ElectronProcessDescriptor): {
  name: string;
  kind: ProcessResourceKind;
} {
  switch (descriptor.type) {
    case "Browser":
      return { name: "Main", kind: "main" };
    case "Tab":
      return { name: "Renderer", kind: "renderer" };
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

/** Stateful delta reducer. One instance serves the app lifetime so CPU and peak
 * values survive popover closes while dead process identities are pruned on
 * every sample. */
export class ProcessMetricsTracker {
  private previousCaptureAt: number | null = null;
  private previous = new Map<number, PreviousProcess>();
  private processPeaks = new Map<string, ProcessPeak>();
  private identitySequence = 0;
  private allPeak = emptyPeak();
  private excludingTerminalsPeak: TotalsPeak | null = null;

  capture(input: ProcessMetricsCaptureInput): ProcessMetricsSnapshot {
    const intervalMs =
      this.previousCaptureAt == null
        ? null
        : Math.max(0, input.sampledAt - this.previousCaptureAt);
    const cpuReady =
      intervalMs != null && intervalMs > 0 && intervalMs <= MAX_CPU_BASELINE_MS;

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
    // Chromium can report a just-created process before ps observes it. Seed
    // every authoritative Electron PID, then walk OS children from all seeds.
    const owned = descendantsOf(
      [input.appPid, ...electronByPid.keys()],
      childrenByParent,
    );
    for (const pid of electronByPid.keys()) owned.add(pid);

    const terminal = input.terminalRootsKnown
      ? descendantsOf(
          input.terminalPids.filter((pid) => owned.has(pid)),
          childrenByParent,
        )
      : new Set<number>();

    const nextPrevious = new Map<number, PreviousProcess>();
    const livePeakIds = new Set<string>();
    const processes: ProcessResourceMetric[] = [];

    for (const pid of [...owned].sort((a, b) => a - b)) {
      const row = rowsByPid.get(pid);
      const descriptor = electronByPid.get(pid);
      if (!row && !descriptor) continue;

      const command =
        row?.command ?? descriptor?.name ?? descriptor?.type ?? "Process";
      const previous = this.previous.get(pid);
      const sameIdentity =
        !!previous &&
        !!row &&
        previous.startKey === row.startKey &&
        row.cpuTimeSeconds >= previous.cpuTimeSeconds;
      const identity =
        descriptor?.creationTime != null
          ? `${pid}:${descriptor.creationTime}`
          : sameIdentity
            ? previous.identity
            : `${pid}:${input.sampledAt}:${++this.identitySequence}`;

      let cpuPercent = 0;
      if (cpuReady) {
        if (descriptor?.cpuPercent != null) {
          // app.getAppMetrics() exposes an interval CPU value for Chromium's
          // own processes and is more precise than the portable ps clock. The
          // OS delta remains the source for sidecar/agent/PTY descendants.
          cpuPercent = finiteNonNegative(descriptor.cpuPercent);
        } else if (sameIdentity && row && previous && intervalMs != null) {
          cpuPercent =
            ((row.cpuTimeSeconds - previous.cpuTimeSeconds) * 100_000) /
            intervalMs;
        }
      }
      cpuPercent = roundMetric(
        Math.min(cpuPercent, Math.max(1, input.logicalCpuCount) * 100),
      );

      const electronMemory = descriptor?.workingSetBytes;
      const memoryBytes = Math.round(
        finiteNonNegative(electronMemory, finiteNonNegative(row?.rssBytes)),
      );
      const presentation = descriptor
        ? electronPresentation(descriptor)
        : pid === input.enginePid
          ? { name: "Sidecar", kind: "sidecar" as const }
          : { name: processName(command), kind: "process" as const };
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

      if (row) {
        nextPrevious.set(pid, {
          startKey: row.startKey,
          cpuTimeSeconds: row.cpuTimeSeconds,
          identity,
        });
      }
    }

    for (const identity of this.processPeaks.keys()) {
      if (!livePeakIds.has(identity)) this.processPeaks.delete(identity);
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
      totals: {
        all: totals(processes, this.allPeak),
        excludingTerminals,
      },
      processes,
    };
  }
}
