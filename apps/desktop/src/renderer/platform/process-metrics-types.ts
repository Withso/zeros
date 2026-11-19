// Keep these shared types DOM-free for the Electron typecheck.

export type ProcessResourceKind =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "sandbox"
  | "sidecar"
  | "agent"
  | "helper"
  | "process";

/** Live metrics send normalized process labels, never argv, paths, environment values or cwd. */
export interface ProcessResourceMetric {
  id: string;
  pid: number;
  /** Display Chromium children under the synthetic App root; engine descendants keep their OS parents. */
  parentPid: number | null;
  name: string;
  kind: ProcessResourceKind;
  /** 100 means one fully occupied logical core; an app total may exceed 100. */
  cpuPercent: number;
  /** False for a new identity without a complete CPU observation window. */
  cpuSampled?: boolean;
  /** Use physical footprint when measured for this process, otherwise resident bytes. */
  memoryBytes: number;
  /** Per-process provenance: a newly started child can lack a footprint even
   * when the app's earlier processes have one. */
  memorySource?: "footprint" | "resident";
  peakCpuPercent: number;
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

/** macOS memory-pressure states from kern.memorystatus_vm_pressure_level. */
export type SystemMemoryPressure = "normal" | "warning" | "critical";
export type SystemThermalState = "nominal" | "fair" | "serious" | "critical";

/** Unavailable system measurements stay unknown, not zero. */
export interface SystemResourceState {
  sampledAt: number;
  memoryPressure: SystemMemoryPressure | null;
  /** Kernel estimate of available memory, as a percentage of RAM. */
  memoryFreePercent: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  /** 1, 5 and 15 minute load averages. */
  loadAverage: [number, number, number] | null;
  thermalState: SystemThermalState | null;
}

/** A different release-channel app on this Mac. */
export interface OtherAppResourceUsage {
  name: string;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
}

export interface ProcessMetricsSnapshot {
  sampledAt: number;
  /** Null until a second, sufficiently-near sample establishes a CPU delta. */
  samplingIntervalMs: number | null;
  scanDurationMs: number;
  cpuReady: boolean;
  logicalCpuCount: number;
  systemMemoryBytes: number;
  terminalRootsKnown: boolean;
  /** The app summary falls back to resident bytes without a recent footprint read. */
  memorySource: "footprint" | "resident";
  footprintAgeMs: number | null;
  system: SystemResourceState | null;
  otherApps: OtherAppResourceUsage[];
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
  /** The inspection popover is open: keep the physical-footprint read fresh. */
  detail?: boolean;
}

/** Build the user-requested report with scrubbed commands and scrubbed recent logs. */
export interface ProcessDiagnosticsReport {
  text: string;
  /** Size of the included log tail, in characters. */
  logCharacters: number;
}
