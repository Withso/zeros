// Shared, runtime-free process-metrics wire types. Kept separate from the
// renderer facade so Electron's DOM-free typecheck never pulls in window APIs.

export type ProcessResourceKind =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "sandbox"
  | "sidecar"
  /** An agent runtime Zeros launched (Codex, Claude Code, Cursor). */
  | "agent"
  /** A Zeros helper host: agent supervisor, terminal host. */
  | "helper"
  | "process";

/** One live OS process. Names are executable/service labels or a role/tool
 * name derived in Electron main (for example "Codex" or "vitest run"); the
 * native boundary never sends argv, paths, environment values, or cwd data
 * into the renderer. */
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
  /** Physical footprint (Activity Monitor's Memory) when the snapshot's
   * footprint read covers this process, otherwise resident/working-set bytes. */
  memoryBytes: number;
  /** Highest value observed for this live process identity during sampling. */
  peakCpuPercent: number;
  /** Highest memory value observed for this live identity. */
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

/** Whole-Mac context for reading app usage. Every field is nullable: a value
 * the platform does not expose stays unknown rather than reading as zero. */
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

/** Another Zeros release-channel app running beside this one. */
export interface OtherAppResourceUsage {
  /** Bundle name, e.g. "Zeros Alpha". */
  name: string;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
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
  /** How memoryBytes was measured: the physical footprint read, or resident
   * size while no recent footprint read covers the app. */
  memorySource: "footprint" | "resident";
  /** Age of the footprint read applied to this sample, when one was used. */
  footprintAgeMs: number | null;
  /** Null when the platform read failed or is unavailable. */
  system: SystemResourceState | null;
  /** Other Zeros channel apps (for example Alpha) competing for this Mac. */
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

/** User-initiated diagnostics copy: the snapshot plus Mac context, scrubbed
 * command lines, and the scrubbed recent app-log tail, as plain text. */
export interface ProcessDiagnosticsReport {
  text: string;
  /** Size of the included log tail, in characters. */
  logCharacters: number;
}
