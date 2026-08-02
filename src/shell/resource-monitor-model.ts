// ============================================
// MODULE: Resource monitor view model
// PURPOSE: Pure filtering, tree/stack transforms, sorting, and formatting.
// USED IN: ResourceMonitor and its regression tests.
// ============================================

import type {
  ProcessMetricsSnapshot,
  ProcessResourceKind,
  ProcessResourceMetric,
  ProcessResourceTotals,
} from "../native/process-metrics";

export type ResourceSortKey = "name" | "cpu" | "memory";
export type ResourceSortDirection = "asc" | "desc";

export interface ResourceViewNode {
  id: string;
  pid: number | null;
  pids: number[];
  parentPid: number | null;
  name: string;
  kind: ProcessResourceKind | "app";
  cpuPercent: number;
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
      memoryBytes: totals.memoryBytes,
      peakCpuPercent: totals.peakCpuPercent,
      peakMemoryBytes: totals.peakMemoryBytes,
      terminal: false,
      count: 1,
      children: sortedRoots,
    },
  ];
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

export function formatCpuPercent(value: number): string {
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

function reportRows(nodes: readonly ResourceViewNode[], depth = 0): string[] {
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
      )}, memory ${formatResourceMemory(node.memoryBytes)}`,
    );
    lines.push(...reportRows(node.children, depth + 1));
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
}

/** Produce a support-ready snapshot without argv/cwd/env data. */
export function copyResourceReport({
  sampledAt,
  logicalCpuCount,
  scanDurationMs,
  includeTerminal,
  totals,
  view,
}: CopyResourceReportOptions): string {
  return [
    "Zeros resource snapshot",
    `Sampled: ${new Date(sampledAt).toISOString()}`,
    `Scope: terminal processes ${includeTerminal ? "included" : "excluded"}`,
    `CPU: ${formatCpuPercent(totals.cpuPercent)} (peak ${formatCpuPercent(
      totals.peakCpuPercent,
    )})`,
    `Memory: ${formatResourceMemory(totals.memoryBytes)} (peak ${formatResourceMemory(
      totals.peakMemoryBytes,
    )})`,
    `Processes: ${totals.processCount}`,
    `Sampling overhead: ${Math.round(scanDurationMs)} ms`,
    "Peaks: sampled since monitoring started",
    `100% CPU = one fully used core (${logicalCpuCount} logical cores)`,
    "",
    ...reportRows(view),
  ].join("\n");
}
