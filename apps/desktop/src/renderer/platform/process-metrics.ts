// ============================================
// NATIVE FACADE: Process metrics
// PURPOSE: Typed, read-only access to the current Zeros process-tree sample.
// USED IN: The app sidebar's resource monitor.
// ============================================

import { isElectron, nativeInvoke } from "./runtime";
import type {
  ProcessDiagnosticsReport,
  ProcessMetricsRequest,
  ProcessMetricsSnapshot,
} from "./process-metrics-types";

export type {
  OtherAppResourceUsage,
  ProcessDiagnosticsReport,
  ProcessMetricsRequest,
  ProcessMetricsSnapshot,
  ProcessResourceKind,
  ProcessResourceMetric,
  ProcessResourceTotals,
  SystemMemoryPressure,
  SystemResourceState,
} from "./process-metrics-types";

/** Read the next process sample. Browser-only UI harnesses return null; the
 * resource pill is desktop chrome and simply stays absent there. */
export async function processMetricsSnapshot(
  request: ProcessMetricsRequest,
): Promise<ProcessMetricsSnapshot | null> {
  if (!isElectron()) return null;
  return nativeInvoke<ProcessMetricsSnapshot>("process_metrics_snapshot", {
    terminalPids: [...request.terminalPids],
    terminalRootsKnown: request.terminalRootsKnown,
    ...(request.detail ? { detail: true } : {}),
  });
}

/** Build the copyable diagnostics report in Electron main: the process tree
 * with scrubbed command lines, Mac memory context and the scrubbed recent log
 * tail. Null outside Electron. */
export async function processDiagnosticsReport(
  request: ProcessMetricsRequest,
): Promise<ProcessDiagnosticsReport | null> {
  if (!isElectron()) return null;
  return nativeInvoke<ProcessDiagnosticsReport>("process_diagnostics_report", {
    terminalPids: [...request.terminalPids],
    terminalRootsKnown: request.terminalRootsKnown,
  });
}
