// Shared, runtime-free process-metrics wire types. Kept separate from the
// renderer facade so Electron's DOM-free typecheck never pulls in window APIs.

export type ProcessResourceKind =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "sandbox"
  | "sidecar"
  | "process";

/** One live OS process. Names are executable/service labels only; the native
 * boundary deliberately never sends argv, environment values, or cwd data into
 * the renderer. */
export interface ProcessResourceMetric {
  id: string;
  pid: number;
  /** Logical display parent. Electron's Chromium children are hoisted to the
   * synthetic App root; engine descendants retain their real OS parent. */
  parentPid: number | null;
  name: string;
  kind: ProcessResourceKind;
  /** 100 means one fully occupied logical core; an app total may exceed 100. */
  cpuPercent: number;
  /** Current resident/working-set memory in bytes. */
  memoryBytes: number;
  /** Highest value observed for this live process identity during sampling. */
  peakCpuPercent: number;
  /** Highest resident/working-set value observed for this live identity. */
  peakMemoryBytes: number;
  /** True for a live PTY shell root or any of its descendants. */
  terminal: boolean;
}

export interface ProcessResourceTotals {
  cpuPercent: number;
  memoryBytes: number;
  peakCpuPercent: number;
  peakCpuAt: number | null;
  peakMemoryBytes: number;
  peakMemoryAt: number | null;
  processCount: number;
}

export interface ProcessMetricsSnapshot {
  sampledAt: number;
  /** Null until a second, sufficiently-near sample establishes a CPU delta. */
  samplingIntervalMs: number | null;
  /** Wall time spent collecting and reducing this sample. */
  scanDurationMs: number;
  cpuReady: boolean;
  logicalCpuCount: number;
  systemMemoryBytes: number;
  terminalRootsKnown: boolean;
  totals: {
    all: ProcessResourceTotals;
    /** Null until the engine has supplied an authoritative PTY-root snapshot. */
    excludingTerminals: ProcessResourceTotals | null;
  };
  processes: ProcessResourceMetric[];
}

export interface ProcessMetricsRequest {
  terminalPids: readonly number[];
  terminalRootsKnown: boolean;
}
