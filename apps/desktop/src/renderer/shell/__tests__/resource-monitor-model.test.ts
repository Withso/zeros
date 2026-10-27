import { describe, expect, it } from "vitest";

import type {
  ProcessResourceMetric,
  ProcessResourceTotals,
} from "../../platform/process-metrics";
import {
  buildOtherAppNodes,
  buildResourceView,
  collectResourceNodeIds,
  copyResourceReport,
  flattenResourceView,
  formatCpuPercent,
  formatResourceMemory,
  resolveResourceScope,
  selectResourceSnapshot,
  systemSummaryParts,
} from "../resource-monitor-model";

function metric(
  partial: Partial<ProcessResourceMetric> &
    Pick<ProcessResourceMetric, "id" | "pid" | "name" | "kind">,
): ProcessResourceMetric {
  return {
    parentPid: null,
    cpuPercent: 0,
    memoryBytes: 0,
    peakCpuPercent: 0,
    peakMemoryBytes: 0,
    terminal: false,
    ...partial,
  };
}

const processes: ProcessResourceMetric[] = [
  metric({
    id: "main",
    pid: 100,
    name: "Main",
    kind: "main",
    cpuPercent: 5,
    memoryBytes: 100,
  }),
  metric({
    id: "renderer",
    pid: 200,
    name: "Renderer",
    kind: "renderer",
    cpuPercent: 10,
    memoryBytes: 500,
  }),
  metric({
    id: "sidecar",
    pid: 300,
    parentPid: 100,
    name: "Sidecar",
    kind: "sidecar",
    cpuPercent: 3,
    memoryBytes: 300,
  }),
  metric({
    id: "node-a",
    pid: 310,
    parentPid: 300,
    name: "node",
    kind: "process",
    cpuPercent: 2,
    memoryBytes: 40,
  }),
  metric({
    id: "node-b",
    pid: 311,
    parentPid: 300,
    name: "node",
    kind: "process",
    cpuPercent: 4,
    memoryBytes: 60,
  }),
  metric({
    id: "terminal",
    pid: 400,
    parentPid: 300,
    name: "zsh",
    kind: "process",
    cpuPercent: 20,
    memoryBytes: 200,
    terminal: true,
  }),
  metric({
    id: "terminal-child",
    pid: 401,
    parentPid: 400,
    name: "vite",
    kind: "process",
    cpuPercent: 30,
    memoryBytes: 400,
    terminal: true,
  }),
  // A live child whose parent vanished between the OS scan and render is kept
  // visible at the app root instead of being silently dropped.
  metric({
    id: "orphan",
    pid: 500,
    parentPid: 499,
    name: "orphan tool",
    kind: "process",
    cpuPercent: 1,
    memoryBytes: 10,
  }),
];

const allTotals: ProcessResourceTotals = {
  cpuPercent: 75,
  memoryBytes: 1_610,
  peakCpuPercent: 90,
  peakCpuAt: 1_000,
  peakMemoryBytes: 1_700,
  peakMemoryAt: 2_000,
  processCount: 8,
};

function snapshot(
  sampledAt: number,
  excludingTerminals: ProcessResourceTotals | null,
) {
  return {
    sampledAt,
    samplingIntervalMs: 1_000,
    scanDurationMs: 8,
    cpuReady: true,
    logicalCpuCount: 8,
    systemMemoryBytes: 16 * 1024 ** 3,
    terminalRootsKnown: excludingTerminals != null,
    memorySource: "resident" as const,
    footprintAgeMs: null,
    system: null,
    otherApps: [],
    totals: { all: allTotals, excludingTerminals },
    processes,
  };
}

describe("resource monitor view model", () => {
  it("preserves unknown CPU coverage through stacks and the exact visible scope", () => {
    const pending = processes.map((process) => ({
      ...process,
      cpuSampled: process.id !== "node-b" && process.id !== "terminal",
    }));
    const options = {
      processes: pending,
      totals: allTotals,
      tree: true,
      stack: true,
      includeTerminal: true,
      sortKey: "memory" as const,
      sortDirection: "desc" as const,
    };
    const view = buildResourceView(options);
    const rows = flattenResourceView(view, new Set());
    expect(view[0]).toMatchObject({ cpuSampled: false });
    expect(rows.find(({ node }) => node.name === "node")?.node).toMatchObject({
      cpuSampled: false,
      count: 2,
    });
    expect(rows.find(({ node }) => node.id === "renderer")?.node).toMatchObject({
      cpuSampled: true,
    });

    // A new terminal cannot make the terminal-excluded scope incomplete.
    const terminalOnly = pending.map((process) => ({
      ...process,
      cpuSampled: process.id !== "terminal",
    }));
    expect(buildResourceView({ ...options, processes: terminalOnly, includeTerminal: false })[0])
      .toMatchObject({ cpuSampled: true });
    // Older native snapshots omitted the field; keep their measured values.
    expect(buildResourceView({ ...options, processes })[0])
      .toMatchObject({ cpuSampled: true });
  });

  it("builds the logical app tree, hoists missing parents, and removes exact terminal subtrees", () => {
    const view = buildResourceView({
      processes,
      totals: { ...allTotals, cpuPercent: 25, memoryBytes: 1_010 },
      tree: true,
      stack: false,
      includeTerminal: false,
      sortKey: "memory",
      sortDirection: "desc",
    });

    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: "app", name: "App", count: 1 });
    expect(view[0].children.map((node) => node.name)).toEqual([
      "Renderer",
      "Main",
      "orphan tool",
    ]);
    const main = view[0].children.find((node) => node.name === "Main");
    expect(main?.children.map((node) => node.name)).toEqual(["Sidecar"]);
    expect(main?.children[0].children.map((node) => node.name)).toEqual([
      "node",
      "node",
    ]);
    expect(JSON.stringify(view)).not.toContain("vite");
    expect(JSON.stringify(view)).not.toContain("zsh");
  });

  it("stacks matching siblings without mutating or double-counting their values", () => {
    const view = buildResourceView({
      processes,
      totals: allTotals,
      tree: true,
      stack: true,
      includeTerminal: true,
      sortKey: "cpu",
      sortDirection: "desc",
    });
    const main = view[0].children.find((node) => node.name === "Main")!;
    const sidecar = main.children[0];
    const nodeStack = sidecar.children.find((node) => node.name === "node");

    expect(nodeStack).toMatchObject({
      count: 2,
      pids: [310, 311],
      cpuPercent: 6,
      memoryBytes: 100,
    });
    expect(
      processes.find((process) => process.id === "node-a")?.cpuPercent,
    ).toBe(2);
  });

  it("supports a sorted flat view and per-node collapse without hiding siblings", () => {
    const flat = buildResourceView({
      processes,
      totals: allTotals,
      tree: false,
      stack: false,
      includeTerminal: true,
      sortKey: "cpu",
      sortDirection: "desc",
    });
    expect(flat.slice(0, 3).map((node) => node.name)).toEqual([
      "vite",
      "zsh",
      "Renderer",
    ]);
    expect(flat.every((node) => node.children.length === 0)).toBe(true);

    const tree = buildResourceView({
      processes,
      totals: allTotals,
      tree: true,
      stack: false,
      includeTerminal: true,
      sortKey: "name",
      sortDirection: "asc",
    });
    const rows = flattenResourceView(tree, new Set(["main"]));
    expect(rows.find((row) => row.node.id === "sidecar")).toBeUndefined();
    expect(rows.find((row) => row.node.id === "renderer")).toBeDefined();
    expect(flattenResourceView(tree, new Set(), 2)).toHaveLength(2);
  });
});

describe("resource monitor presentation", () => {
  it("never labels all-process totals as terminal-excluded while ownership is unavailable", () => {
    const unavailable = resolveResourceScope(false, {
      all: allTotals,
      excludingTerminals: null,
    });
    expect(unavailable).toMatchObject({
      totals: allTotals,
      includesTerminal: true,
      terminalFilterAvailable: false,
    });

    const exactExcluding = { ...allTotals, processCount: 6 };
    const available = resolveResourceScope(false, {
      all: allTotals,
      excludingTerminals: exactExcluding,
    });
    expect(available).toMatchObject({
      totals: exactExcluding,
      includesTerminal: false,
      terminalFilterAvailable: true,
    });
  });

  it("retains the last exact excluded snapshot while its key revalidates", () => {
    const retained = snapshot(1_000, { ...allTotals, processCount: 6 });
    const current = snapshot(2_000, null);

    expect(selectResourceSnapshot(false, current, retained)).toEqual({
      snapshot: retained,
      usingRetainedTerminalSnapshot: true,
    });
    expect(selectResourceSnapshot(true, current, retained)).toEqual({
      snapshot: current,
      usingRetainedTerminalSnapshot: false,
    });
  });

  it("keeps ids hidden under a collapsed ancestor in the live disclosure set", () => {
    const view = buildResourceView({
      processes,
      totals: allTotals,
      tree: true,
      stack: false,
      includeTerminal: true,
      sortKey: "memory",
      sortDirection: "desc",
    });
    // The user folds a nested branch, then folds the ancestor above it.
    const collapsed = new Set(["terminal", "sidecar"]);
    const visibleIds = new Set(
      flattenResourceView(view, collapsed).map(({ node }) => node.id),
    );
    const liveIds = collectResourceNodeIds(view);

    // Pruning against rendered rows is what silently re-expanded the branch.
    expect(visibleIds.has("terminal")).toBe(false);
    expect(liveIds.has("terminal")).toBe(true);
    expect([...collapsed].filter((id) => liveIds.has(id))).toEqual([
      "terminal",
      "sidecar",
    ]);
  });

  it("collects every id past the render cap, and only ids still present", () => {
    const view = buildResourceView({
      processes,
      totals: allTotals,
      tree: true,
      stack: false,
      includeTerminal: true,
      sortKey: "memory",
      sortDirection: "desc",
    });
    const liveIds = collectResourceNodeIds(view);

    // Every process plus the synthetic App root, regardless of the row limit.
    expect(flattenResourceView(view, new Set(), 2)).toHaveLength(2);
    expect(liveIds.size).toBe(processes.length + 1);
    // An exited process is still pruned — that is the point of the sweep.
    expect(liveIds.has("exited")).toBe(false);
  });

  it("formats CPU and memory at compact, stable precision", () => {
    expect(formatCpuPercent(0, false)).toBe("—");
    expect(formatCpuPercent(2, false)).toBe("—");
    expect(formatCpuPercent(0)).toBe("0.0%");
    expect(formatCpuPercent(0.04)).toBe("<0.1%");
    expect(formatCpuPercent(125.49)).toBe("125.5%");
    expect(formatResourceMemory(512)).toBe("512 B");
    expect(formatResourceMemory(10 * 1024)).toBe("10.0 KB");
    expect(formatResourceMemory(1.24 * 1024 ** 3)).toBe("1.24 GB");
  });

  it("does not copy an incomplete CPU total as a measured zero", () => {
    const view = buildResourceView({
      processes: [metric({ id: "new", pid: 610, name: "New helper", kind: "helper", cpuSampled: false })],
      totals: { ...allTotals, cpuPercent: 0, processCount: 1 },
      tree: true,
      stack: true,
      includeTerminal: true,
      sortKey: "memory",
      sortDirection: "desc",
    });
    const text = copyResourceReport({
      sampledAt: 2_000,
      logicalCpuCount: 8,
      scanDurationMs: 9,
      includeTerminal: true,
      totals: { ...allTotals, cpuPercent: 0, processCount: 1 },
      view,
    });
    expect(text).toContain("CPU: —");
    expect(text).toContain("New helper [PID 610] — CPU —");
    expect(text).not.toContain("CPU 0.0%");
  });

  it("creates a copyable, scope-labelled tree report without command lines", () => {
    const view = buildResourceView({
      processes,
      totals: allTotals,
      tree: true,
      stack: true,
      includeTerminal: false,
      sortKey: "memory",
      sortDirection: "desc",
    });
    const report = copyResourceReport({
      sampledAt: Date.UTC(2026, 7, 1, 21, 30),
      logicalCpuCount: 8,
      scanDurationMs: 9,
      includeTerminal: false,
      totals: allTotals,
      view,
    });

    expect(report).toContain("Scope: terminal processes excluded");
    expect(report).toContain(
      "100% CPU = one fully used core (8 logical cores)",
    );
    expect(report).toContain("node ×2 [PIDs 310, 311]");
    expect(report).not.toContain("vite");
    expect(report).not.toContain("/Applications/");
  });
});

describe("Mac context and other Zeros apps", () => {
  const GB = 1024 ** 3;
  it("summarizes pressure, free memory, swap, load and abnormal thermal state with words", () => {
    expect(
      systemSummaryParts(
        {
          sampledAt: 1,
          memoryPressure: "warning",
          memoryFreePercent: 11.4,
          swapUsedBytes: 6 * GB,
          swapTotalBytes: 7 * GB,
          loadAverage: [17.5, 14.3, 11.9],
          thermalState: "serious",
        },
        10,
      ),
    ).toEqual([
      { id: "pressure", label: "Memory pressure", value: "Warning", tone: "warning" },
      { id: "free", label: "", value: "11% free", tone: "default" },
      { id: "swap", label: "Swap", value: "6.0 of 7.0 GB", tone: "warning" },
      { id: "load", label: "Load", value: "17.5 / 10 cores", tone: "critical" },
      { id: "thermal", label: "Thermal", value: "Serious", tone: "critical" },
    ]);
  });

  it("omits unknown values instead of reporting zero, and stays quiet when healthy", () => {
    expect(systemSummaryParts(null, 8)).toEqual([]);
    expect(
      systemSummaryParts(
        {
          sampledAt: 1,
          memoryPressure: "normal",
          memoryFreePercent: null,
          swapUsedBytes: 0,
          swapTotalBytes: 0,
          loadAverage: [2, 2, 2],
          thermalState: "nominal",
        },
        8,
      ),
    ).toEqual([
      { id: "pressure", label: "Memory pressure", value: "Normal", tone: "default" },
      { id: "swap", label: "Swap", value: "None", tone: "default" },
      { id: "load", label: "Load", value: "2.0 / 8 cores", tone: "default" },
    ]);
  });

  it("sorts other Zeros apps like the process tree and reports them in the fallback copy", () => {
    const nodes = buildOtherAppNodes(
      [
        { name: "Zeros Beta", processCount: 2, cpuPercent: 1, memoryBytes: 900 },
        { name: "Zeros Alpha", processCount: 4, cpuPercent: 6.4, memoryBytes: 350 },
      ],
      "cpu",
      "desc",
    );
    expect(nodes.map((node) => [node.name, node.kind, node.count])).toEqual([
      ["Zeros Alpha", "other-app", 4],
      ["Zeros Beta", "other-app", 2],
    ]);
    const report = copyResourceReport({
      sampledAt: 1,
      logicalCpuCount: 8,
      scanDurationMs: 1,
      includeTerminal: true,
      totals: allTotals,
      view: [],
      otherApps: nodes,
      memorySource: "footprint",
      system: {
        sampledAt: 1,
        memoryPressure: "critical",
        memoryFreePercent: 4,
        swapUsedBytes: null,
        swapTotalBytes: null,
        loadAverage: null,
        thermalState: null,
      },
    });
    expect(report).toContain("Memory: physical footprint");
    expect(report).toContain("Mac: Memory pressure Critical · 4% free");
    expect(report).toContain("Other Zeros apps\n  Zeros Alpha ×4");
  });
});
