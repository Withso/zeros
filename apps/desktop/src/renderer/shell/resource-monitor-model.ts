// ============================================
// MODULE: Resource monitor view model
// PURPOSE: Pure filtering, tree/stack transforms, sorting, and formatting.
// USED IN: ResourceMonitor and its regression tests.
// ============================================

import type {
  OtherAppResourceUsage,
  ProcessMetricsSnapshot,
  ProcessResourceKind,
  ProcessResourceMetric,
  ProcessResourceTotals,
  SystemResourceState,
} from "../platform/process-metrics";

export type ResourceSortKey = "name" | "cpu" | "memory";
export type ResourceSortDirection = "asc" | "desc";

export interface ResourceViewNode {
  id: string;
  pid: number | null;
  pids: number[];
  parentPid: number | null;
  name: string;
  /** "app" is the synthetic root for this app; "other-app" rows total another
   * Zeros channel app (for example Alpha) running on the same Mac. */
  kind: ProcessResourceKind | "app" | "other-app";
  cpuPercent: number;
  /** False while any process represented by this row lacks a CPU delta. */
  cpuSampled?: boolean;
  memoryBytes: number;
  peakCpuPercent: number;
  peakMemoryBytes: number;
  terminal: boolean;
  count: number;
  children: ResourceViewNode[];
}

export interface BuildResourceViewOptions {
  processes: readonly ProcessResourceMetric[];
  totals: ProcessResourceTotals;
  tree: boolean;
  stack: boolean;
  includeTerminal: boolean;
  sortKey: ResourceSortKey;
  sortDirection: ResourceSortDirection;
}

export interface VisibleResourceRow {
  node: ResourceViewNode;
  depth: number;
}

export interface ResolvedResourceScope {
  totals: ProcessResourceTotals;
  /** The scope actually represented by totals, which may temporarily fall back
   * to all processes while exact terminal ownership is unavailable. */
  includesTerminal: boolean;
  terminalFilterAvailable: boolean;
}

export interface SelectedResourceSnapshot {
  snapshot: ProcessMetricsSnapshot | null;
  usingRetainedTerminalSnapshot: boolean;
}

/** Select the exact snapshot for the requested scope. All-process data can use
 * the newest scan without PTY ownership; an excluded scope retains its last
 * confirmed process/key pair while the PID census revalidates. */
export function selectResourceSnapshot(
  requestedIncludeTerminal: boolean,
  current: ProcessMetricsSnapshot | null,
  retainedTerminal: ProcessMetricsSnapshot | null,
): SelectedResourceSnapshot {
  const currentHasTerminalScope = current?.totals.excludingTerminals != null;
  if (
    !requestedIncludeTerminal &&
    !currentHasTerminalScope &&
    retainedTerminal?.totals.excludingTerminals != null
  ) {
    return {
      snapshot: retainedTerminal,
      usingRetainedTerminalSnapshot: true,
    };
  }
  return { snapshot: current, usingRetainedTerminalSnapshot: false };
}

/** Resolve the requested terminal preference into an honest exact-key scope.
 * Never claim terminals are excluded when the native snapshot cannot prove the
 * PTY subtree; show all-process totals until ownership becomes authoritative. */
export function resolveResourceScope(
  requestedIncludeTerminal: boolean,
  totals: {
    all: ProcessResourceTotals;
    excludingTerminals: ProcessResourceTotals | null;
  },
): ResolvedResourceScope {
  const terminalFilterAvailable = totals.excludingTerminals != null;
  const includesTerminal = requestedIncludeTerminal || !terminalFilterAvailable;
  return {
    totals: includesTerminal ? totals.all : totals.excludingTerminals!,
    includesTerminal,
    terminalFilterAvailable,
  };
}

function nodeFromMetric(metric: ProcessResourceMetric): ResourceViewNode {
  return {
    ...metric,
    pid: metric.pid,
    pids: [metric.pid],
    count: 1,
    children: [],
  };
}

function stackSiblings(nodes: readonly ResourceViewNode[]): ResourceViewNode[] {
  const groups = new Map<string, ResourceViewNode[]>();
  for (const node of nodes) {
    const key = `${node.kind}\u0000${node.name}\u0000${node.terminal ? "1" : "0"}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) {
      const node = group[0];
      return { ...node, children: stackSiblings(node.children) };
    }
    const pids = group.flatMap((node) => node.pids).sort((a, b) => a - b);
    return {
      id: `stack:${group
        .flatMap((node) => node.id)
        .sort()
        .join("|")}`,
      pid: null,
      pids,
      parentPid: group[0].parentPid,
      name: group[0].name,
      kind: group[0].kind,
      cpuPercent: group.reduce((sum, node) => sum + node.cpuPercent, 0),
      cpuSampled: group.every((node) => node.cpuSampled !== false),
      memoryBytes: group.reduce((sum, node) => sum + node.memoryBytes, 0),
      peakCpuPercent: group.reduce((sum, node) => sum + node.peakCpuPercent, 0),
      peakMemoryBytes: group.reduce(
        (sum, node) => sum + node.peakMemoryBytes,
        0,
      ),
      terminal: group.every((node) => node.terminal),
      count: group.reduce((sum, node) => sum + node.count, 0),
      children: stackSiblings(group.flatMap((node) => node.children)),
    };
  });
}

function compareNodes(
  left: ResourceViewNode,
  right: ResourceViewNode,
  key: ResourceSortKey,
  direction: ResourceSortDirection,
): number {
  let comparison = 0;
  if (key === "name") {
    comparison = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  } else {
    const leftValue = key === "cpu" ? left.cpuPercent : left.memoryBytes;
    const rightValue = key === "cpu" ? right.cpuPercent : right.memoryBytes;
    comparison = leftValue - rightValue;
  }
  if (comparison !== 0) return direction === "asc" ? comparison : -comparison;
  const nameComparison = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  if (nameComparison !== 0) return nameComparison;
  return (left.pid ?? left.pids[0] ?? 0) - (right.pid ?? right.pids[0] ?? 0);
}

function sortTree(
  nodes: readonly ResourceViewNode[],
  key: ResourceSortKey,
  direction: ResourceSortDirection,
): ResourceViewNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortTree(node.children, key, direction),
    }))
    .sort((left, right) => compareNodes(left, right, key, direction));
}

/** Build either the logical process tree (under one synthetic App row) or a
 * completely flat process list. Every transform clones input rows so a hot
 * refresh cannot mutate the retained snapshot. */
export function buildResourceView({
  processes,
  totals,
  tree,
  stack,
  includeTerminal,
  sortKey,
  sortDirection,
}: BuildResourceViewOptions): ResourceViewNode[] {
  const visible = processes
    .filter((process) => includeTerminal || !process.terminal)
    .map(nodeFromMetric);

  if (!tree) {
    const flat = stack ? stackSiblings(visible) : visible;
    return sortTree(
      flat.map((node) => ({ ...node, parentPid: null, children: [] })),
      sortKey,
      sortDirection,
    );
  }

  const byPid = new Map<number, ResourceViewNode>();
  for (const node of visible) {
    if (node.pid != null) byPid.set(node.pid, node);
  }
  const roots: ResourceViewNode[] = [];
  for (const node of visible) {
    const parent = node.parentPid == null ? null : byPid.get(node.parentPid);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const groupedRoots = stack ? stackSiblings(roots) : roots;
  const sortedRoots = sortTree(groupedRoots, sortKey, sortDirection);
  return [
    {
      id: "app",
      pid: null,
      pids: [],
      parentPid: null,
      name: "App",
      kind: "app",
      cpuPercent: totals.cpuPercent,
      cpuSampled: visible.every((node) => node.cpuSampled !== false),
      memoryBytes: totals.memoryBytes,
      peakCpuPercent: totals.peakCpuPercent,
      peakMemoryBytes: totals.peakMemoryBytes,
      terminal: false,
      count: 1,
      children: sortedRoots,
    },
  ];
}

/** Every node id in the view, ignoring both collapse state and the render cap.
 * Disclosure pruning must use this rather than the flattened rows: a node
 * hidden inside a collapsed ancestor — or past the row limit — is still live,
 * and dropping its id would silently re-expand a branch the user folded. */
export function collectResourceNodeIds(
  roots: readonly ResourceViewNode[],
): Set<string> {
  const ids = new Set<string>();
  const visit = (nodes: readonly ResourceViewNode[]): void => {
    for (const node of nodes) {
      ids.add(node.id);
      visit(node.children);
    }
  };
  visit(roots);
  return ids;
}

/** Flatten expanded tree rows for rendering. Collapse state belongs to the
 * popover and is intentionally ephemeral. */
export function flattenResourceView(
  roots: readonly ResourceViewNode[],
  collapsedIds: ReadonlySet<string>,
  maxRows = Number.POSITIVE_INFINITY,
): VisibleResourceRow[] {
  const rows: VisibleResourceRow[] = [];
  const visit = (
    nodes: readonly ResourceViewNode[],
    depth: number,
  ): boolean => {
    for (const node of nodes) {
      if (rows.length >= maxRows) return false;
      rows.push({ node, depth });
      if (!collapsedIds.has(node.id) && !visit(node.children, depth + 1)) {
        return false;
      }
    }
    return true;
  };
  visit(roots, 0);
  return rows;
}

export function formatCpuPercent(value: number, sampled = true): string {
  if (!sampled) return "—";
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  if (safe > 0 && safe < 0.1) return "<0.1%";
  return `${safe.toFixed(1)}%`;
}

export function formatResourceMemory(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 ** 2) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 ** 3) return `${(safe / 1024 ** 2).toFixed(1)} MB`;
  return `${(safe / 1024 ** 3).toFixed(2)} GB`;
}

/** One row per other Zeros channel app, sorted like the process tree. */
export function buildOtherAppNodes(
  otherApps: readonly OtherAppResourceUsage[],
  sortKey: ResourceSortKey,
  sortDirection: ResourceSortDirection,
): ResourceViewNode[] {
  return sortTree(
    otherApps.map((other) => ({
      id: `other-app:${other.name}`,
      pid: null,
      pids: [],
      parentPid: null,
      name: other.name,
      kind: "other-app" as const,
      cpuPercent: other.cpuPercent,
      memoryBytes: other.memoryBytes,
      peakCpuPercent: other.cpuPercent,
      peakMemoryBytes: other.memoryBytes,
      terminal: false,
      count: other.processCount,
      children: [],
    })),
    sortKey,
    sortDirection,
  );
}

export type SystemSummaryTone = "default" | "warning" | "critical";

/** "6.0 of 7.0 GB" for gigabyte totals; otherwise both values in full. */
function formatUsedOfTotal(used: number, total: number): string {
  const GB = 1024 ** 3;
  if (total >= GB) return `${(used / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB`;
  return `${formatResourceMemory(used)} of ${formatResourceMemory(total)}`;
}

export interface SystemSummaryPart {
  id: "pressure" | "free" | "swap" | "load" | "thermal";
  label: string;
  value: string;
  tone: SystemSummaryTone;
}

const PRESSURE_LABELS = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
} as const;

const THERMAL_LABELS = {
  nominal: "Nominal",
  fair: "Fair",
  serious: "Serious",
  critical: "Critical",
} as const;

/** Compact Mac context. Unknown values are omitted rather than shown as zero;
 * tone always accompanies a word, never color alone. */
export function systemSummaryParts(
  system: SystemResourceState | null,
  logicalCpuCount: number,
): SystemSummaryPart[] {
  if (!system) return [];
  const parts: SystemSummaryPart[] = [];
  if (system.memoryPressure) {
    parts.push({
      id: "pressure",
      label: "Memory pressure",
      value: PRESSURE_LABELS[system.memoryPressure],
      tone:
        system.memoryPressure === "critical"
          ? "critical"
          : system.memoryPressure === "warning"
            ? "warning"
            : "default",
    });
  }
  if (system.memoryFreePercent != null) {
    parts.push({
      id: "free",
      label: "",
      value: `${Math.round(system.memoryFreePercent)}% free`,
      tone: "default",
    });
  }
  if (system.swapUsedBytes != null && system.swapTotalBytes != null) {
    parts.push({
      id: "swap",
      label: "Swap",
      value:
        system.swapTotalBytes > 0
          ? formatUsedOfTotal(system.swapUsedBytes, system.swapTotalBytes)
          : "None",
      tone:
        system.swapTotalBytes > 0 &&
        system.swapUsedBytes / system.swapTotalBytes >= 0.8
          ? "warning"
          : "default",
    });
  }
  if (system.loadAverage) {
    const load = system.loadAverage[0];
    const cores = Math.max(1, logicalCpuCount);
    parts.push({
      id: "load",
      label: "Load",
      value: `${load.toFixed(1)} / ${cores} cores`,
      tone: load > cores * 1.5 ? "critical" : load > cores ? "warning" : "default",
    });
  }
  if (system.thermalState && system.thermalState !== "nominal") {
    parts.push({
      id: "thermal",
      label: "Thermal",
      value: THERMAL_LABELS[system.thermalState],
      tone: system.thermalState === "fair" ? "warning" : "critical",
    });
  }
  return parts;
}

function reportRows(nodes: readonly ResourceViewNode[], depth = 0, cpuReady = true): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const count = node.count > 1 ? ` ×${node.count}` : "";
    const pids =
      node.pids.length === 0
        ? ""
        : ` [PID${node.pids.length === 1 ? "" : "s"} ${node.pids.join(", ")}]`;
    lines.push(
      `${"  ".repeat(depth)}${node.name}${count}${pids} — CPU ${formatCpuPercent(
        node.cpuPercent,
        cpuReady && node.cpuSampled !== false,
      )}, memory ${formatResourceMemory(node.memoryBytes)}`,
    );
    lines.push(...reportRows(node.children, depth + 1, cpuReady));
  }
  return lines;
}

export interface CopyResourceReportOptions {
  sampledAt: number;
  logicalCpuCount: number;
  scanDurationMs: number;
  includeTerminal: boolean;
  totals: ProcessResourceTotals;
  view: readonly ResourceViewNode[];
  system?: SystemResourceState | null;
  otherApps?: readonly ResourceViewNode[];
  memorySource?: ProcessMetricsSnapshot["memorySource"];
  cpuReady?: boolean;
}

/** Produce a support-ready snapshot without argv/cwd/env data. This is the
 * fallback when the native diagnostics report is unavailable. */
export function copyResourceReport({
  sampledAt,
  logicalCpuCount,
  scanDurationMs,
  includeTerminal,
  totals,
  view,
  system = null,
  otherApps = [],
  memorySource = "resident",
  cpuReady = true,
}: CopyResourceReportOptions): string {
  const mac = systemSummaryParts(system, logicalCpuCount)
    .map((part) => (part.label ? `${part.label} ${part.value}` : part.value))
    .join(" · ");
  return [
    "Zeros resource snapshot",
    `Sampled: ${new Date(sampledAt).toISOString()}`,
    `Scope: terminal processes ${includeTerminal ? "included" : "excluded"}`,
    `CPU: ${formatCpuPercent(totals.cpuPercent, cpuReady && view.every((node) => node.cpuSampled !== false))} (peak ${formatCpuPercent(
      totals.peakCpuPercent,
    )})`,
    `Memory: ${formatResourceMemory(totals.memoryBytes)} (peak ${formatResourceMemory(
      totals.peakMemoryBytes,
    )})`,
    `Processes: ${totals.processCount}`,
    `Sampling overhead: ${Math.round(scanDurationMs)} ms`,
    "Peaks: sampled since monitoring started",
    `100% CPU = one fully used core (${logicalCpuCount} logical cores)`,
    `Memory: ${memorySource === "footprint" ? "physical footprint" : "resident size"}`,
    ...(mac ? [`Mac: ${mac}`] : []),
    "",
    ...reportRows(view, 0, cpuReady),
    ...(otherApps.length > 0
      ? ["", "Other Zeros apps", ...reportRows(otherApps, 1, cpuReady)]
      : []),
  ].join("\n");
}
