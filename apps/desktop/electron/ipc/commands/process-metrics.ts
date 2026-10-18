// ============================================
// COMMAND: process_metrics_snapshot, process_diagnostics_report
// PURPOSE: Read cheap Electron metrics or a full process tree on demand, and
//          build the user-initiated diagnostics copy.
// USED IN: The renderer's global resource monitor.
// ============================================

import os from "node:os";

import { app, powerMonitor } from "electron";

import type {
  ProcessDiagnosticsReport,
  ProcessMetricsSnapshot,
  SystemResourceState,
  SystemThermalState,
} from "../../../src/renderer/platform/process-metrics-types";
import { channel } from "../../../src/engine/runtime";
import { currentPort, getEnginePid } from "../../sidecar";
import {
  ProcessMetricsTracker,
  ProcessMetricsScanCoordinator,
  normalizeTerminalRoots,
  readAllProcessArgs,
  readFootprint,
  readProcessArgs,
  readProcessTable,
  readSystemSysctl,
  type ElectronProcessDescriptor,
  type FootprintRead,
  type ProcessArgsRow,
} from "../../process-metrics";
import { buildDiagnosticsReport } from "../../process-diagnostics";
import { scrubbedRecentTail } from "./logs";

interface MetricsRequest {
  terminalPids: number[];
  terminalRootsKnown: boolean;
  detail: boolean;
}

/** `top -l 1` costs ~0.4 s of CPU, so the footprint refreshes at most this
 * often, and only while the inspector is open. */
const FOOTPRINT_REFRESH_MS = 10_000;
const SYSTEM_REFRESH_MS = 5_000;
/** CPU in the diagnostics report is measured over this window. */
const REPORT_CPU_WINDOW_MS = 1_000;
const METRICS_LOG_INTERVAL_MS = 10 * 60_000;

const tracker = new ProcessMetricsTracker();
// A lightweight caller cannot advance a detailed scan's CPU baseline, evict
// its argv identities, or change the terminal-ownership key of its flight.
const electronTracker = new ProcessMetricsTracker();
let lastMetricsLogAt: number | null = null;
let footprint: FootprintRead | null = null;
let footprintRead: Promise<void> | null = null;
let system: SystemResourceState | null = null;
let systemRead: Promise<void> | null = null;

function parseRequest(args: Record<string, unknown>): MetricsRequest {
  return {
    ...normalizeTerminalRoots(args.terminalPids, args.terminalRootsKnown),
    detail: args.detail === true,
  };
}

function electronDescriptors(): ElectronProcessDescriptor[] {
  const descriptors = app.getAppMetrics().map((metric) => {
    const workingSetKb = metric.memory?.workingSetSize;
    return {
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      serviceName: metric.serviceName,
      creationTime: metric.creationTime,
      ...(typeof workingSetKb === "number"
        ? { workingSetBytes: workingSetKb * 1024 }
        : {}),
      ...(typeof metric.cpu?.percentCPUUsage === "number"
        ? { cpuPercent: metric.cpu.percentCPUUsage }
        : {}),
    };
  });
  // Reuse an explicitly requested observation for log attribution. There is
  // no idle telemetry timer and no additional native/process-table sample.
  const now = Date.now();
  if (lastMetricsLogAt == null || now - lastMetricsLogAt >= METRICS_LOG_INTERVAL_MS) {
    lastMetricsLogAt = now;
    const groups = new Map<string, { count: number; bytes: number }>();
    let total = 0;
    for (const descriptor of descriptors) {
      const bytes = descriptor.workingSetBytes ?? 0;
      total += bytes;
      const group = groups.get(descriptor.type) ?? { count: 0, bytes: 0 };
      group.count += 1; group.bytes += bytes;
      groups.set(descriptor.type, group);
    }
    const parts = [...groups].sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([type, group]) => `${type}=${group.count}/${(group.bytes / 1024 ** 2).toFixed(0)}MB`).join(" ");
    try {
      console.log(`[Zeros procmem] total=${(total / 1024 ** 2).toFixed(0)}MB ${parts}`);
    } catch {
      // A closed log sink cannot turn a usable observation into an IPC error.
    }
  }
  return descriptors;
}

function thermalState(): SystemThermalState | null {
  try {
    const state = powerMonitor.getCurrentThermalState?.();
    return state === "nominal" ||
      state === "fair" ||
      state === "serious" ||
      state === "critical"
      ? state
      : null;
  } catch {
    return null;
  }
}

function refreshFootprint(): Promise<void> {
  footprintRead ??= readFootprint()
    .then((read) => {
      if (read) footprint = read;
    })
    .catch(() => {
      // Keep the previous read; the snapshot falls back to resident size once
      // it ages out.
    })
    .finally(() => {
      footprintRead = null;
    });
  return footprintRead;
}

function refreshSystem(): Promise<void> {
  systemRead ??= readSystemSysctl()
    .catch(() => null)
    .then((memory) => {
      const load = os.loadavg();
      system = {
        sampledAt: Date.now(),
        memoryPressure: memory?.memoryPressure ?? null,
        memoryFreePercent: memory?.memoryFreePercent ?? null,
        swapUsedBytes: memory?.swapUsedBytes ?? null,
        swapTotalBytes: memory?.swapTotalBytes ?? null,
        loadAverage:
          load.length === 3 && load.every(Number.isFinite)
            ? [load[0], load[1], load[2]]
            : null,
        thermalState: thermalState(),
      };
    })
    .finally(() => {
      systemRead = null;
    });
  return systemRead;
}

function logicalCpuCount(): number {
  return typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
}

function systemMemoryBytes(): number {
  try {
    return process.getSystemMemoryInfo().total * 1024;
  } catch {
    return os.totalmem();
  }
}

/** Summary callers only need the Electron-owned processes. Full descendant
 * accounting, terminal exclusion and OS context require an explicit detail
 * request; never imply that the lightweight sample proves terminal ownership. */
function sampleElectron(): ProcessMetricsSnapshot {
  return electronTracker.capture({
    sampledAt: Date.now(), scanDurationMs: 0,
    appPid: process.pid, enginePid: null, samplerPid: null,
    logicalCpuCount: logicalCpuCount(), systemMemoryBytes: systemMemoryBytes(),
    terminalPids: [], terminalRootsKnown: false,
    rows: [], electronProcesses: electronDescriptors(), appExecutable: process.execPath,
  });
}

async function sample(
  latestRequest: () => MetricsRequest,
): Promise<ProcessMetricsSnapshot> {
  const table = await readProcessTable();
  const sampledAt = Date.now();
  const request = latestRequest();
  const electronProcesses = electronDescriptors();
  const base = {
    rows: table.rows,
    appPid: process.pid,
    electronProcesses,
    samplerPid: table.samplerPid,
  };
  // argv is read only for Zeros-tree identities that have none yet, so a
  // steady tree costs no extra process after the first sample.
  const missing = tracker.missingArgPids(base);
  if (missing.length > 0) {
    let read: ProcessArgsRow[] = [];
    try {
      read = await readProcessArgs(missing);
    } catch {
      // Labels fall back to executable names for this sample.
    }
    const wanted = new Set(missing);
    const returned = new Set(
      read.map((row) => `${row.pid}\u0000${row.startKey}`),
    );
    // A process ps did not describe (it exited, or its PID was reused between
    // the two reads) keeps its executable label rather than being re-read on
    // every sample; the tracker prunes the entry once that identity is gone.
    const placeholders = table.rows
      .filter(
        (row) =>
          wanted.has(row.pid) &&
          !returned.has(`${row.pid}\u0000${row.startKey}`),
      )
      .map((row) => ({ pid: row.pid, startKey: row.startKey, args: "" }));
    tracker.recordArgs([...read, ...placeholders]);
  }
  if (!system || sampledAt - system.sampledAt >= SYSTEM_REFRESH_MS) {
    if (system) void refreshSystem();
    else await refreshSystem();
  }
  if (
    request.detail &&
    (!footprint || sampledAt - footprint.readAt >= FOOTPRINT_REFRESH_MS)
  )
    void refreshFootprint();

  return tracker.capture({
    sampledAt,
    scanDurationMs: table.durationMs,
    appPid: process.pid,
    enginePid: getEnginePid(),
    samplerPid: table.samplerPid,
    logicalCpuCount: logicalCpuCount(),
    systemMemoryBytes: systemMemoryBytes(),
    terminalPids: request.terminalPids,
    terminalRootsKnown: request.terminalRootsKnown,
    rows: table.rows,
    electronProcesses,
    appExecutable: process.execPath,
    footprint,
    system,
  });
}

// One app-global key has one in-flight OS scan. A second window/request updates
// the ownership input consumed when that scan settles instead of spawning a
// competing ps process or advancing the CPU baseline twice.
const coordinator = new ProcessMetricsScanCoordinator<
  MetricsRequest,
  ProcessMetricsSnapshot
>({ terminalPids: [], terminalRootsKnown: false, detail: true }, sample);

export async function processMetricsSnapshot(
  args: Record<string, unknown>,
): Promise<ProcessMetricsSnapshot> {
  const request = parseRequest(args);
  return request.detail ? coordinator.request(request) : sampleElectron();
}

/** The Resources popover's Copy: a fresh footprint read and sample, Mac
 * context, scrubbed command lines and the scrubbed recent log tail. */
export async function processDiagnosticsReport(
  args: Record<string, unknown>,
): Promise<ProcessDiagnosticsReport> {
  const request = { ...parseRequest(args), detail: true };
  // Measure CPU over a full report window rather than whatever gap remains
  // since the popover's last sample (under 250 ms reports no CPU at all). The
  // footprint and Mac reads overlap the baseline.
  await Promise.all([
    refreshFootprint(),
    refreshSystem(),
    coordinator.request(request),
  ]);
  await new Promise((resolve) => setTimeout(resolve, REPORT_CPU_WINDOW_MS));
  const snapshot = await coordinator.request(request);
  let allArgs: ProcessArgsRow[] = [];
  try {
    allArgs = await readAllProcessArgs();
  } catch {
    // Detached-process detection falls back to executable paths.
  }
  const logs = scrubbedRecentTail();
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
    chrome?: string;
  };
  let osVersion = os.release();
  try {
    osVersion = process.getSystemVersion();
  } catch {
    // Older runtimes only expose the kernel release.
  }
  let onBattery: boolean | null = null;
  try {
    onBattery = powerMonitor.isOnBatteryPower();
  } catch {
    onBattery = null;
  }
  const text = buildDiagnosticsReport({
    generatedAt: Date.now(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      channel: channel(),
      electron: versions.electron ?? null,
      chrome: versions.chrome ?? null,
      node: versions.node ?? null,
      uptimeSeconds: process.uptime(),
      enginePid: getEnginePid(),
      enginePort: currentPort(),
    },
    host: {
      osName: process.platform === "darwin" ? "macOS" : os.type(),
      osVersion,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model?.trim() || null,
      logicalCpus: logicalCpuCount(),
      memoryBytes: os.totalmem(),
      uptimeSeconds: os.uptime(),
      onBattery,
    },
    snapshot,
    rows: tracker.sampledRows(),
    argsFor: (pid, startKey) => tracker.argsFor(pid, startKey),
    allArgs,
    physMem: footprint?.physMem ?? null,
    cpuUsage: footprint?.cpuUsage ?? null,
    homeDirectory: os.homedir(),
    appExecutable: process.execPath,
    logs,
  });
  return { text, logCharacters: logs.length };
}
