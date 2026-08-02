// ============================================
// COMMAND: process_metrics_snapshot
// PURPOSE: Read one privacy-safe, whole-app CPU/memory process snapshot.
// USED IN: The renderer's global resource monitor.
// ============================================

import os from "node:os";

import { app } from "electron";

import type { ProcessMetricsSnapshot } from "../../../src/native/process-metrics-types";
import { getEnginePid } from "../../sidecar";
import {
  ProcessMetricsTracker,
  ProcessMetricsScanCoordinator,
  normalizeTerminalRoots,
  readProcessTable,
  type ElectronProcessDescriptor,
} from "../../process-metrics";

interface MetricsRequest {
  terminalPids: number[];
  terminalRootsKnown: boolean;
}

const tracker = new ProcessMetricsTracker();

function parseRequest(args: Record<string, unknown>): MetricsRequest {
  return normalizeTerminalRoots(args.terminalPids, args.terminalRootsKnown);
}

function electronDescriptors(): ElectronProcessDescriptor[] {
  return app.getAppMetrics().map((metric) => {
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
}

async function sample(
  latestRequest: () => MetricsRequest,
): Promise<ProcessMetricsSnapshot> {
  const table = await readProcessTable();
  const sampledAt = Date.now();
  const request = latestRequest();
  let systemMemoryBytes = 0;
  try {
    systemMemoryBytes = process.getSystemMemoryInfo().total * 1024;
  } catch {
    systemMemoryBytes = os.totalmem();
  }
  return tracker.capture({
    sampledAt,
    scanDurationMs: table.durationMs,
    appPid: process.pid,
    enginePid: getEnginePid(),
    samplerPid: table.samplerPid,
    logicalCpuCount:
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length,
    systemMemoryBytes,
    terminalPids: request.terminalPids,
    terminalRootsKnown: request.terminalRootsKnown,
    rows: table.rows,
    electronProcesses: electronDescriptors(),
  });
}

// One app-global key has one in-flight OS scan. A second window/request updates
// the ownership input consumed when that scan settles instead of spawning a
// competing ps process or advancing the CPU baseline twice.
const coordinator = new ProcessMetricsScanCoordinator<
  MetricsRequest,
  ProcessMetricsSnapshot
>({ terminalPids: [], terminalRootsKnown: false }, sample);

export function processMetricsSnapshot(
  args: Record<string, unknown>,
): Promise<ProcessMetricsSnapshot> {
  return coordinator.request(parseRequest(args));
}
