// ============================================
// MODULE: Process diagnostics report
// PURPOSE: Turn one process sample, Mac context, and the scrubbed log tail into
//          the plain-text report the Resources popover copies.
// USED IN: apps/desktop/electron/ipc/commands/process-metrics.ts and tests.
// ============================================
//
// Copying is user-initiated and stays local, but the text is meant to be
// pasted into a chat or issue. It therefore follows the app-log export policy:
// credentials are removed (command lines also lose header/env values and URL
// userinfo, and the home directory becomes ~), while the PIDs, tool names and
// workspace-relative paths needed to debug load remain. Other apps' processes
// appear by executable name only.

import path from "node:path";

import type {
  ProcessMetricsSnapshot,
  ProcessResourceMetric,
  SystemResourceState,
} from "../src/renderer/platform/process-metrics-types";
import { appBundleName, isZerosBundle, sanitizeCommandLine } from "./process-labels";
import type { ProcessArgsRow, SampledProcessRow } from "./process-metrics";

const TOP_OTHER_PROCESSES = 12;
const MAX_DETACHED_PROCESSES = 40;
/** Detached processes worth reporting: Zeros helpers that outlived their
 * parent (for example a credential prompt) or anything still running a Zeros
 * bundle executable outside this app's tree. */
const ZEROS_COMMAND_MARKERS = [
  /\/Zeros(?: [A-Za-z]+)?\.app\/Contents\//,
  /\bzeros-git-auth-/,
  /\bzeros-engine\b/,
  /\bhost-process-supervisor\.mjs\b/,
];

export interface DiagnosticsAppInfo {
  name: string;
  version: string;
  channel: string;
  electron: string | null;
  chrome: string | null;
  node: string | null;
  uptimeSeconds: number;
  enginePid: number | null;
  enginePort: number | null;
}

export interface DiagnosticsHostInfo {
  osName: string;
  osVersion: string;
  arch: string;
  cpuModel: string | null;
  logicalCpus: number;
  memoryBytes: number;
  uptimeSeconds: number;
  onBattery: boolean | null;
}

export interface DiagnosticsReportInput {
  generatedAt: number;
  app: DiagnosticsAppInfo;
  host: DiagnosticsHostInfo;
  snapshot: ProcessMetricsSnapshot;
  /** Every sampled process with rates, from the same capture. */
  rows: readonly SampledProcessRow[];
  /** argv for owned identities. */
  argsFor: (pid: number, startKey: string) => string | null;
  /** argv for every process, when the one-shot read succeeded. */
  allArgs: readonly ProcessArgsRow[];
  /** top's PhysMem / CPU usage summary lines. */
  physMem: string | null;
  cpuUsage: string | null;
  homeDirectory: string | null;
  /** This app's executable, which identifies its bundle. */
  appExecutable: string | null;
  /** Already-scrubbed JSONL log tail. */
  logs: string;
}

export function formatBytes(bytes: number | null | undefined): string {
  const safe =
    typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 ** 2) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 ** 3) return `${(safe / 1024 ** 2).toFixed(1)} MB`;
  return `${(safe / 1024 ** 3).toFixed(2)} GB`;
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : "n/a";
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatCpuClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

function systemLines(
  system: SystemResourceState | null,
  logicalCpus: number,
  physMem: string | null,
  cpuUsage: string | null,
): string[] {
  const lines: string[] = [];
  if (system) {
    const swap =
      system.swapUsedBytes != null && system.swapTotalBytes != null
        ? `swap ${formatBytes(system.swapUsedBytes)} of ${formatBytes(system.swapTotalBytes)} used`
        : "swap unknown";
    lines.push(
      `Memory pressure: ${system.memoryPressure ?? "unknown"} · ${
        system.memoryFreePercent != null ? `${system.memoryFreePercent}% free` : "free unknown"
      } · ${swap}`,
    );
    if (system.loadAverage)
      lines.push(
        `Load average: ${system.loadAverage.map((value) => value.toFixed(2)).join(", ")} (${logicalCpus} logical cores)`,
      );
    lines.push(`Thermal state: ${system.thermalState ?? "unknown"}`);
  } else {
    lines.push("Memory pressure, swap and load: unavailable on this platform.");
  }
  if (physMem) lines.push(physMem);
  if (cpuUsage) lines.push(cpuUsage);
  return lines;
}

interface TreeEntry {
  process: ProcessResourceMetric;
  depth: number;
}

function processTree(processes: readonly ProcessResourceMetric[]): TreeEntry[] {
  const byParent = new Map<number | null, ProcessResourceMetric[]>();
  const pids = new Set(processes.map((process) => process.pid));
  for (const process of processes) {
    const parent =
      process.parentPid != null && pids.has(process.parentPid)
        ? process.parentPid
        : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(process);
    byParent.set(parent, siblings);
  }
  const ordered: TreeEntry[] = [];
  const seen = new Set<number>();
  const visit = (parent: number | null, depth: number) => {
    const children = [...(byParent.get(parent) ?? [])].sort(
      (left, right) => right.memoryBytes - left.memoryBytes || left.pid - right.pid,
    );
    for (const child of children) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      ordered.push({ process: child, depth });
      visit(child.pid, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

function otherName(row: SampledProcessRow): string {
  const base = path.basename(row.command.replace(/\s+<defunct>\s*$/, "").trim());
  return (base || "process").replace(/\p{Cc}/gu, " ").slice(0, 60);
}

/** Build the copyable diagnostics text. Pure; every input is already sampled. */
export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const { snapshot, app, host } = input;
  const rowsByPid = new Map(input.rows.map((row) => [row.pid, row]));
  const ownBundle = input.appExecutable
    ? appBundleName(input.appExecutable)
    : null;
  const lines: string[] = [];
  const memoryLabel =
    snapshot.memorySource === "footprint"
      ? "physical footprint (Activity Monitor's Memory)"
      : "resident size";

  lines.push("# Zeros diagnostics report");
  lines.push(`Generated: ${new Date(input.generatedAt).toISOString()}`);
  lines.push(
    `App: ${app.name} ${app.version} (${app.channel} channel) · Electron ${app.electron ?? "?"} · Chromium ${app.chrome ?? "?"} · Node ${app.node ?? "?"} · running ${formatDuration(app.uptimeSeconds)}`,
  );
  lines.push(
    `Engine: ${app.enginePid != null ? `PID ${app.enginePid}` : "not running"}${app.enginePort != null ? ` · port ${app.enginePort}` : ""}`,
  );
  lines.push(
    `Mac: ${host.osName} ${host.osVersion} (${host.arch}) · ${host.cpuModel ?? "unknown CPU"} · ${host.logicalCpus} logical cores · ${formatBytes(host.memoryBytes)} RAM · up ${formatDuration(host.uptimeSeconds)}${
      host.onBattery == null ? "" : host.onBattery ? " · on battery" : " · on power adapter"
    }`,
  );
  lines.push("");

  lines.push("## Mac memory and CPU");
  lines.push(
    ...systemLines(snapshot.system, snapshot.logicalCpuCount, input.physMem, input.cpuUsage),
  );
  lines.push("");

  const totals = snapshot.totals.all;
  lines.push("## Zeros processes");
  lines.push(
    `CPU over the last ${
      snapshot.samplingIntervalMs != null ? `${(snapshot.samplingIntervalMs / 1_000).toFixed(1)} s` : "sample"
    } (100% = one core${snapshot.cpuReady ? "" : "; not ready yet"}) · memory = ${memoryLabel}`,
  );
  lines.push(
    `Totals: CPU ${formatPercent(totals.cpuPercent)} · memory ${formatBytes(totals.memoryBytes)} · ${totals.processCount} ${totals.processCount === 1 ? "process" : "processes"} · peak CPU ${formatPercent(totals.peakCpuPercent)}${
      totals.peakCpuAt != null ? ` at ${new Date(totals.peakCpuAt).toISOString()}` : ""
    } · peak memory ${formatBytes(totals.peakMemoryBytes)}${
      totals.peakMemoryAt != null ? ` at ${new Date(totals.peakMemoryAt).toISOString()}` : ""
    }`,
  );
  lines.push("```");
  lines.push(
    `${pad("PID", 8)}${pad("PPID", 8)}${pad("CPU%", 8)}${pad("MEMORY", 11)}${pad("RESIDENT", 11)}${pad("CPU TIME", 11)}${pad("STARTED", 26)}NAME — COMMAND`,
  );
  for (const { process, depth } of processTree(snapshot.processes)) {
    const row = rowsByPid.get(process.pid);
    const args = row ? input.argsFor(process.pid, row.startKey) : null;
    const command = args
      ? sanitizeCommandLine(args, input.homeDirectory)
      : row
        ? sanitizeCommandLine(row.command, input.homeDirectory)
        : "";
    lines.push(
      `${pad(String(process.pid), 8)}${pad(String(row?.parentPid ?? "-"), 8)}${pad(
        snapshot.cpuReady ? process.cpuPercent.toFixed(1) : "-",
        8,
      )}${pad(formatBytes(process.memoryBytes), 11)}${pad(
        row ? formatBytes(row.rssBytes) : "-",
        11,
      )}${pad(row ? formatCpuClock(row.cpuTimeSeconds) : "-", 11)}${pad(
        row?.startKey ?? "-",
        26,
      )}${"  ".repeat(depth)}${process.name}${process.terminal ? " [terminal]" : ""}${
        command ? ` — ${command}` : ""
      }`,
    );
  }
  lines.push("```");
  lines.push("");

  lines.push("## Other Zeros apps on this Mac");
  if (snapshot.otherApps.length === 0) {
    lines.push("None running.");
  } else {
    for (const other of snapshot.otherApps) {
      lines.push(
        `${other.name}: ${other.processCount} ${other.processCount === 1 ? "process" : "processes"} · CPU ${formatPercent(other.cpuPercent)} · memory ${formatBytes(other.memoryBytes)}`,
      );
      const members = input.rows
        .filter((row) => !row.owned && appBundleName(row.command) === other.name)
        .sort((left, right) => (right.footprintBytes ?? right.rssBytes) - (left.footprintBytes ?? left.rssBytes))
        .slice(0, 12);
      for (const row of members)
        lines.push(
          `  PID ${row.pid}: ${otherName(row)} · CPU ${formatPercent(row.cpuPercent)} · memory ${formatBytes(row.footprintBytes ?? row.rssBytes)}`,
        );
    }
  }
  lines.push("");

  // Detached: outside this app's tree, but running Zeros code or a Zeros
  // helper (for example an orphaned credential prompt or agent host).
  const argsByPid = new Map(input.allArgs.map((row) => [row.pid, row]));
  const detached = input.rows
    .filter((row) => {
      if (row.owned) return false;
      const bundle = appBundleName(row.command);
      if (isZerosBundle(bundle) && bundle !== ownBundle) return false;
      const args = argsByPid.get(row.pid);
      const text = args && args.startKey === row.startKey ? args.args : row.command;
      return (
        (bundle != null && bundle === ownBundle) ||
        ZEROS_COMMAND_MARKERS.some((marker) => marker.test(text))
      );
    })
    .slice(0, MAX_DETACHED_PROCESSES);
  lines.push("## Detached Zeros processes (outside this app's process tree)");
  if (detached.length === 0) {
    lines.push("None found.");
  } else {
    lines.push("```");
    for (const row of detached) {
      const args = argsByPid.get(row.pid);
      const text = args && args.startKey === row.startKey ? args.args : row.command;
      lines.push(
        `PID ${row.pid} PPID ${row.parentPid} · CPU ${formatPercent(row.cpuPercent)} · memory ${formatBytes(row.footprintBytes ?? row.rssBytes)} · started ${row.startKey} — ${sanitizeCommandLine(text, input.homeDirectory)}`,
      );
    }
    lines.push("```");
  }
  lines.push("");

  const detachedPids = new Set(detached.map((row) => row.pid));
  const others = input.rows.filter((row) => {
    if (row.owned || detachedPids.has(row.pid)) return false;
    const bundle = appBundleName(row.command);
    return !(isZerosBundle(bundle));
  });
  const byCpu = [...others]
    .sort((left, right) => right.cpuPercent - left.cpuPercent)
    .slice(0, TOP_OTHER_PROCESSES)
    .filter((row) => row.cpuPercent > 0);
  const byMemory = [...others]
    .sort(
      (left, right) =>
        (right.footprintBytes ?? right.rssBytes) - (left.footprintBytes ?? left.rssBytes),
    )
    .slice(0, TOP_OTHER_PROCESSES);
  lines.push("## Busiest other processes on this Mac (executable names only)");
  lines.push(
    `By CPU: ${
      snapshot.cpuReady && byCpu.length > 0
        ? byCpu.map((row) => `${otherName(row)} ${formatPercent(row.cpuPercent)}`).join(" · ")
        : "not sampled yet"
    }`,
  );
  lines.push(
    `By memory: ${byMemory
      .map((row) => `${otherName(row)} ${formatBytes(row.footprintBytes ?? row.rssBytes)}`)
      .join(" · ")}`,
  );
  lines.push("");

  lines.push("## Recent app logs (secret-scrubbed JSONL, newest last)");
  if (input.logs.trim()) {
    lines.push("```jsonl");
    lines.push(input.logs.replace(/\n+$/, ""));
    lines.push("```");
  } else {
    lines.push("No app logs recorded yet.");
  }
  return `${lines.join("\n")}\n`;
}
