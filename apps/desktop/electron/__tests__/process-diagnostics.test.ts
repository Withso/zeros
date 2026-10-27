import { describe, expect, it } from "vitest";

import { buildDiagnosticsReport } from "../process-diagnostics";
import type { SampledProcessRow } from "../process-metrics";
import type { ProcessMetricsSnapshot } from "../../src/renderer/platform/process-metrics-types";

const MB = 1024 ** 2;
const APP = "/Applications/Zeros.app/Contents/MacOS/Zeros";

function row(
  pid: number,
  parentPid: number,
  command: string,
  extra: Partial<SampledProcessRow> = {},
): SampledProcessRow {
  return {
    pid,
    parentPid,
    command,
    startKey: `Thu Oct 16 10:00:${String(pid % 60).padStart(2, "0")} 2026`,
    cpuTimeSeconds: 4_666.9,
    cpuPercent: 0,
    rssBytes: 10 * MB,
    footprintBytes: null,
    owned: false,
    ...extra,
  };
}

const snapshot: ProcessMetricsSnapshot = {
  sampledAt: 2_000,
  samplingIntervalMs: 1_000,
  scanDurationMs: 9,
  cpuReady: true,
  logicalCpuCount: 10,
  systemMemoryBytes: 16 * 1024 * MB,
  terminalRootsKnown: true,
  memorySource: "footprint",
  footprintAgeMs: 400,
  system: {
    sampledAt: 2_000,
    memoryPressure: "warning",
    memoryFreePercent: 11,
    swapUsedBytes: 3 * 1024 * MB,
    swapTotalBytes: 4 * 1024 * MB,
    loadAverage: [8.55, 7.62, 8.92],
    thermalState: "nominal",
  },
  otherApps: [
    { name: "Zeros Alpha", processCount: 1, cpuPercent: 6.4, memoryBytes: 195 * MB },
  ],
  totals: {
    all: {
      cpuPercent: 151,
      memoryBytes: 4_400 * MB,
      peakCpuPercent: 210,
      peakCpuAt: 1_000,
      peakMemoryBytes: 4_500 * MB,
      peakMemoryAt: 1_500,
      processCount: 3,
    },
    excludingTerminals: null,
  },
  processes: [
    { id: "a", pid: 100, parentPid: null, name: "Main", kind: "main", cpuPercent: 1, memoryBytes: 397 * MB, peakCpuPercent: 1, peakMemoryBytes: 397 * MB, terminal: false },
    { id: "b", pid: 300, parentPid: 100, name: "Engine", kind: "sidecar", cpuPercent: 25, memoryBytes: 430 * MB, peakCpuPercent: 25, peakMemoryBytes: 430 * MB, terminal: false },
    { id: "c", pid: 330, parentPid: 300, name: "tsc", kind: "process", cpuPercent: 125, memoryBytes: 3_573 * MB, peakCpuPercent: 125, peakMemoryBytes: 3_573 * MB, terminal: false },
  ],
};

const rows: SampledProcessRow[] = [
  row(100, 1, APP, { owned: true }),
  row(300, 100, "/Applications/Zeros.app/Contents/Resources/zeros-engine", { owned: true }),
  row(330, 300, "node", { owned: true, rssBytes: 4_000 * MB }),
  row(901, 1, "/Applications/Zeros Alpha.app/Contents/Resources/zeros-engine", { cpuPercent: 6.4, footprintBytes: 195 * MB }),
  row(44400, 1, "/bin/sh"),
  row(0, 0, "kernel_task", { cpuPercent: 142.3, rssBytes: 11 * MB }),
  row(70617, 1, "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent", { cpuPercent: 19.4, footprintBytes: 3_126 * MB }),
];

function report(logs = '{"id":1,"origin":"engine","level":"warn","text":"x"}\n', currentSnapshot = snapshot) {
  return buildDiagnosticsReport({
    generatedAt: Date.UTC(2026, 9, 16, 5, 40),
    app: { name: "Zeros", version: "0.1.25", channel: "prod", electron: "41.0.0", chrome: "146.0", node: "24.1.0", uptimeSeconds: 80_000, enginePid: 300, enginePort: 24193 },
    host: { osName: "macOS", osVersion: "26.3.1", arch: "arm64", cpuModel: "Apple M4", logicalCpus: 10, memoryBytes: 16 * 1024 * MB, uptimeSeconds: 147_600, onBattery: false },
    snapshot: currentSnapshot,
    rows,
    argsFor: (pid) =>
      pid === 330
        ? "node /Users/alice/zeros/workspaces/Zeros/Cerulean/node_modules/.bin/../typescript/bin/tsc --noEmit --token supersecret"
        : null,
    allArgs: [
      {
        pid: 44400,
        startKey: rows[4].startKey,
        args: "/bin/sh /var/folders/ql/T/zeros-git-auth-lsooiT/git credential fill",
      },
    ],
    physMem: "PhysMem: 15G used (12G wired, 1305M compressor), 159M unused.",
    cpuUsage: "CPU usage: 42.28% user, 33.42% sys, 24.28% idle",
    homeDirectory: "/Users/alice",
    appExecutable: APP,
    logs,
  });
}

describe("buildDiagnosticsReport", () => {
  it("labels incomplete CPU coverage instead of presenting an unknown process as idle", () => {
    const text = report("", {
      ...snapshot,
      totals: { ...snapshot.totals, all: { ...snapshot.totals.all, cpuPercent: 26 } },
      processes: snapshot.processes.map((process) => process.pid === 330
        ? { ...process, cpuPercent: 0, cpuSampled: false }
        : process),
    });
    expect(text).toContain("Totals: CPU incomplete (observed 26.0%; 2/3 processes sampled)");
    expect(text).toMatch(/\n330 +300 +- +/);
    expect(report("", { ...snapshot, cpuReady: false })).toContain("Totals: CPU unknown");
    expect(report()).toContain("Totals: CPU 151.0%");
  });

  it("captures Mac pressure, the Zeros tree, other Zeros apps, detached helpers and logs", () => {
    const text = report();
    expect(text).toContain("App: Zeros 0.1.25 (prod channel)");
    expect(text).toContain("Engine: PID 300 · port 24193");
    expect(text).toContain("Memory pressure: warning · 11% free · swap 3.00 GB of 4.00 GB used");
    expect(text).toContain("PhysMem: 15G used (12G wired, 1305M compressor)");
    expect(text).toContain("Load average: 8.55, 7.62, 8.92 (10 logical cores)");
    // Tree order with indentation and the 77-minute CPU clock intact.
    expect(text).toMatch(/Main — \/Applications\/Zeros\.app/);
    expect(text).toMatch(/\n300 +100 +25\.0 +430\.0 MB.* {2}Engine — /);
    expect(text).toMatch(/ {4}tsc — node ~\/zeros\/workspaces\/Zeros\/Cerulean\/node_modules/);
    expect(text).toContain("77:46.90");
    expect(text).toContain("Zeros Alpha: 1 process · CPU 6.4% · memory 195.0 MB");
    expect(text).toContain("PID 44400 PPID 1");
    expect(text).toContain("zeros-git-auth-lsooiT/git credential fill");
    expect(text).toContain("By CPU: kernel_task 142.3%");
    expect(text).toContain("com.apple.WebKit.WebContent 3.05 GB");
    expect(text).toContain('```jsonl\n{"id":1,"origin":"engine","level":"warn","text":"x"}\n```');
  });

  it("scrubs credentials and the home directory from command lines", () => {
    const text = report();
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("/Users/alice");
  });

  it("states an empty log store instead of an empty block", () => {
    expect(report("")).toContain("No app logs recorded yet.");
  });
});
