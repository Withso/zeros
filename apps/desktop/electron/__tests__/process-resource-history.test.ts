import { describe, expect, it } from "vitest";
import { ProcessMetricsTracker, type ProcessMetricsCaptureInput } from "../process-metrics";
import { processResourceHistory } from "../process-resource-history";

function input(at: number, children = 1): ProcessMetricsCaptureInput {
  return {
    sampledAt: at, scanDurationMs: 5, appPid: 100, enginePid: 101, samplerPid: 99999,
    logicalCpuCount: 8, systemMemoryBytes: 16 * 1024 ** 3,
    terminalPids: [], terminalRootsKnown: false, electronProcesses: [],
    rows: Array.from({ length: children + 1 }, (_, index) => ({
      pid: 100 + index, parentPid: index === 0 ? 1 : 100,
      rssBytes: 10_000 + index, cpuTimeSeconds: at / 10_000,
      startKey: index === 2 ? "new child" : "original identity",
      command: index === 0 ? "/Applications/Zeros.app/Contents/MacOS/Zeros" : "/usr/bin/node",
    })),
  };
}

describe("complete bounded resource log records", () => {
  it("marks a reset cumulative CPU counter unavailable even when Electron keeps its creation identity", () => {
    const tracker = new ProcessMetricsTracker();
    const first = input(1_000);
    first.electronProcesses = [{ pid: 100, type: "Browser", creationTime: 10 }];
    first.rows[0]!.cpuTimeSeconds = 10;
    tracker.capture(first);
    const second = input(2_000);
    second.electronProcesses = first.electronProcesses;
    second.rows[0]!.cpuTimeSeconds = 1;
    const snapshot = tracker.capture(second);
    const records = processResourceHistory(snapshot, tracker.sampledRows(), "periodic")
      .map(line => JSON.parse(line.slice("[Zeros resources] ".length)));
    expect(records[0]).toMatchObject({ cpuPercent: null, unknownCpuProcesses: 1 });
    expect(records[1].processes.find((row: { pid: number }) => row.pid === 100)).toMatchObject({ cpuPercent: null });
    const third = input(3_000);
    third.electronProcesses = first.electronProcesses;
    third.rows[0]!.cpuTimeSeconds = 1.1;
    const recovered = tracker.capture(third);
    expect(recovered.processes.find(row => row.pid === 100)).toMatchObject({ cpuPercent: 10, cpuSampled: true });
  });

  it("marks new CPU identities and resident fallbacks without inventing zeros or footprints", () => {
    const tracker = new ProcessMetricsTracker();
    tracker.capture(input(1_000));
    const snapshot = tracker.capture({ ...input(2_000, 2), footprint: {
      readAt: 1_500, bytesByPid: new Map([[100, 50_000], [101, 60_000], [102, 70_000]]),
      physMem: null, cpuUsage: null,
    } });
    const records = processResourceHistory(snapshot, tracker.sampledRows(), "periodic")
      .map(line => JSON.parse(line.slice("[Zeros resources] ".length)));
    expect(records[0]).toMatchObject({ scope: "app-and-descendants", processCount: 3,
      cpuPercent: null, unknownCpuProcesses: 1, footprintProcesses: 2, memoryBytes: 120_002 });
    expect(records[1].processes[2]).toMatchObject({ pid: 102, cpuPercent: null,
      memoryBytes: 10_002, memorySource: "resident" });
    expect(records[1].processes[1]).toMatchObject({ pid: 101, name: "Engine",
      cpuPercent: 10, memoryBytes: 60_000, memorySource: "footprint" });
  });

  it("keeps every owned process in a large tree below the app log's line cap", () => {
    const tracker = new ProcessMetricsTracker();
    tracker.capture(input(1_000, 1_000));
    const snapshot = tracker.capture(input(2_000, 1_000));
    const lines = processResourceHistory(snapshot, tracker.sampledRows(), "copy");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every(line => line.length < 10_000)).toBe(true);
    const records = lines.map(line => JSON.parse(line.slice("[Zeros resources] ".length)));
    const pids = records.filter(record => record.type === "processes").flatMap(record => record.processes.map((row: { pid: number }) => row.pid));
    expect(new Set(pids).size).toBe(1_001);
    expect(pids).toHaveLength(1_001);
    expect(records[0]).toMatchObject({ processCount: 1_001, unknownCpuProcesses: 0 });
    expect(lines.join("\n")).not.toContain("/Applications/");
    expect(lines.join("\n")).not.toContain("/usr/bin/");
  });
});
