// ============================================
// NATIVE FACADE: Process metrics
// PURPOSE: Typed, read-only access to the current Zeros process-tree sample.
// USED IN: The global top-bar resource monitor.
// ============================================

import { isElectron, nativeInvoke } from "./runtime";
import type {
  ProcessMetricsRequest,
  ProcessMetricsSnapshot,
} from "./process-metrics-types";

export type {
  ProcessMetricsRequest,
  ProcessMetricsSnapshot,
  ProcessResourceKind,
  ProcessResourceMetric,
  ProcessResourceTotals,
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
  });
}
