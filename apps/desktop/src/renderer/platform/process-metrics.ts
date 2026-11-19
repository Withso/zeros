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

export async function processDiagnosticsReport(
  request: ProcessMetricsRequest,
): Promise<ProcessDiagnosticsReport | null> {
  if (!isElectron()) return null;
  return nativeInvoke<ProcessDiagnosticsReport>("process_diagnostics_report", {
    terminalPids: [...request.terminalPids],
    terminalRootsKnown: request.terminalRootsKnown,
  });
}
