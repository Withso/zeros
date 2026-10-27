import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const native = vi.hoisted(() => ({ exec: vi.fn(), metrics: vi.fn(), holdTable: false, release: null as (() => void) | null }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: native.exec }));
vi.mock("electron", () => ({
  app: { getAppMetrics: native.metrics, getName: () => "Zeros", getVersion: () => "1.0.0" },
  powerMonitor: { getCurrentThermalState: () => "nominal", isOnBatteryPower: () => false },
}));
vi.mock("../../../sidecar", () => ({ getEnginePid: () => 300, currentPort: () => 24000 }));
vi.mock("../logs", () => ({ scrubbedRecentTail: () => "" }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const start = "Thu Jan 1 00:00:00 2026";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  native.holdTable = false; native.release = null;
  native.metrics.mockReset().mockReturnValue([
    { pid: process.pid, type: "Browser", creationTime: 1, memory: { workingSetSize: 100 }, cpu: { percentCPUUsage: 1 } },
    { pid: 200, type: "Tab", creationTime: 2, memory: { workingSetSize: 200 }, cpu: { percentCPUUsage: 2 } },
  ]);
  native.exec.mockReset().mockImplementation((file: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
    // Assertion failures must never serialize the inherited host environment.
    delete (_options as { env?: unknown }).env;
    let output = "";
    if (args[0] === "-axo") output = [
      `${process.pid} 1 100 00:01.00 ${start} /Applications/Zeros.app/Contents/MacOS/Zeros`,
      `200 ${process.pid} 200 00:01.00 ${start} Zeros Helper (Renderer)`,
      `300 ${process.pid} 300 00:01.00 ${start} zeros-engine`,
      `400 300 400 00:01.00 ${start} zsh`,
      `500 1 50 00:01.00 ${start} /bin/sh`,
    ].join("\n");
    else if (args.includes("pid=,lstart=,args=")) output = [
      `${process.pid} ${start} /Applications/Zeros.app/Contents/MacOS/Zeros`,
      `200 ${start} Zeros Helper --type=renderer`,
      `300 ${start} zeros-engine serve`,
      `400 ${start} zsh`,
      `500 ${start} /bin/sh /tmp/zeros-git-auth-fixture/git credential fill`,
    ].join("\n");
    else if (file.endsWith("sysctl")) output = "vm.swapusage: total = 0M used = 0M\nkern.memorystatus_level: 50\nkern.memorystatus_vm_pressure_level: 1\n";
    else if (file.endsWith("top")) output = `PID MEM\n${process.pid} 100K\n200 200K\n300 300K\n400 400K\n`;
    const finish = () => callback(null, output, "");
    if (args[0] === "-axo" && native.holdTable) native.release = finish;
    else void Promise.resolve().then(finish);
    return { pid: 999 };
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });

const scans = () => native.exec.mock.calls.filter(([, args]) => args[0] === "-axo");
const argReads = () => native.exec.mock.calls.filter(([, args]) => args[0] === "-ww");
const request = { detail: true, terminalPids: [400], terminalRootsKnown: true };

describe("on-demand main-process resource observations", () => {
  it("records CPU and memory for the engine and all owned children without an open inspector", async () => {
    const metrics = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = metrics.startProcessMetricsLogging();
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      const entries = log.mock.calls.map(([line]) => String(line))
        .filter(line => line.startsWith("[Zeros resources] "))
        .map(line => JSON.parse(line.slice("[Zeros resources] ".length)));
      const summary = entries.find(entry => entry.type === "summary");
      const processes = entries.filter(entry => entry.type === "processes").flatMap(entry => entry.processes);
      expect(summary?.scope).toBe("app-and-descendants");
      expect(summary?.samplingIntervalMs).toBe(1_000);
      expect(summary?.processCount).toBe(4);
      expect(processes.map(row => row.pid).sort((a, b) => a - b)).toEqual([process.pid, 200, 300, 400].sort((a, b) => a - b));
      expect(processes.find(row => row.pid === 300)).toMatchObject({ name: "Engine", cpuPercent: 0, memoryBytes: 300 * 1024, memorySource: "footprint" });
      expect(processes.find(row => row.pid === 400)).toMatchObject({ parentPid: 300, cpuPercent: 0, memoryBytes: 400 * 1024 });
      expect(processes.some(row => row.pid === 500 || row.pid === 999)).toBe(false);
      expect(JSON.stringify(entries)).not.toContain("zeros-git-auth-fixture");
      expect(scans()).toHaveLength(2);
    } finally { stop(); log.mockRestore(); }
  });

  it("uses zero child processes for four lightweight reads in a synthetic idle minute", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    let summary;
    for (let i = 0; i < 4; i += 1) {
      summary = await processMetricsSnapshot({ ...request, detail: false });
      await vi.advanceTimersByTimeAsync(15_000);
    }
    console.info("Process metrics synthetic idle minute", { spawns: native.exec.mock.calls.length, tableReads: scans().length });
    expect(native.exec.mock.calls.length).toBe(0);
    expect(native.metrics).toHaveBeenCalledTimes(4);
    expect(summary?.processes.map((row) => row.pid).sort((a, b) => a - b)).toEqual([process.pid, 200].sort((a, b) => a - b));
    expect(summary?.terminalRootsKnown).toBe(false);
    expect(summary?.totals.excludingTerminals).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps summary requests out of a pending detailed scan and its ownership key", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    native.holdTable = true;
    const detail = processMetricsSnapshot(request);
    const summary = processMetricsSnapshot({ detail: false, terminalPids: [], terminalRootsKnown: false });
    native.release?.();
    const [detailed, light] = await Promise.all([detail, summary]);
    expect(scans()).toHaveLength(1);
    expect(detailed.terminalRootsKnown).toBe(true);
    expect(detailed.processes.find((row) => row.pid === 400)?.terminal).toBe(true);
    expect(light.processes.find((row) => row.pid === 300)).toBeUndefined();
  });

  it("preserves the full-tree CPU baseline, peaks and argv cache across lightweight reads", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    const first = await processMetricsSnapshot(request);
    await vi.advanceTimersByTimeAsync(1_000);
    await processMetricsSnapshot({ detail: false });
    await vi.advanceTimersByTimeAsync(1_000);
    const next = await processMetricsSnapshot(request);
    expect(next.samplingIntervalMs).toBe(2_000);
    expect(next.cpuReady).toBe(true);
    expect(next.totals.all.peakMemoryBytes).toBeGreaterThanOrEqual(first.totals.all.peakMemoryBytes);
    expect(scans()).toHaveLength(2);
    expect(argReads()).toHaveLength(1);
  });

  it("shares detailed scans across windows and uses the latest detailed terminal ownership", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    native.holdTable = true;
    const first = processMetricsSnapshot(request);
    const second = processMetricsSnapshot({ detail: true, terminalPids: [], terminalRootsKnown: true });
    native.release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(scans()).toHaveLength(1);
    expect(b.processes.every((row) => !row.terminal)).toBe(true);
    expect(b.processes.find((row) => row.pid === 300)?.name).toBe("Engine");
  });

  it("keeps an explicit diagnostics copy complete, including descendants and detached helpers", async () => {
    const { processDiagnosticsReport } = await import("../process-metrics");
    const pending = processDiagnosticsReport(request);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await pending;
    expect(scans()).toHaveLength(2);
    expect(native.exec.mock.calls.filter(([, args]) => args[0] === "-axww")).toHaveLength(1);
    expect(report.text).toContain("Engine — zeros-engine serve");
    expect(report.text).toContain("zsh [terminal]");
    expect(report.text).toContain("PID 500 PPID 1");
    expect(report.text).toContain("zeros-git-auth-fixture");
    expect(report.text).toContain("CPU over the last 1.0 s");
  });

  it("keeps the diagnostics CPU window and terminal ownership independent of an open inspector", async () => {
    const { processDiagnosticsReport, processMetricsSnapshot } = await import("../process-metrics");
    await processMetricsSnapshot(request);
    await vi.advanceTimersByTimeAsync(1_000);
    const pending = processDiagnosticsReport(request);
    await vi.advanceTimersByTimeAsync(750);
    const inspectorRequest = { detail: true, terminalPids: [], terminalRootsKnown: true };
    const during = await processMetricsSnapshot(inspectorRequest);
    await vi.advanceTimersByTimeAsync(250);
    const report = await pending;
    expect(report.text).toContain("CPU over the last 1.0 s");
    expect(report.text).toContain("zsh [terminal]");
    expect(during.samplingIntervalMs).toBe(1_750);
    await vi.advanceTimersByTimeAsync(750);
    const after = await processMetricsSnapshot(inspectorRequest);
    expect(after.samplingIntervalMs).toBe(1_000);
    expect(after.processes.find(row => row.pid === 400)?.terminal).toBe(false);
  });

  it("carries native owner labels into the renderer snapshot and explicit diagnostics", async () => {
    const { processMetricsSnapshot, processDiagnosticsReport } = await import("../process-metrics");
    const { rendererProcessOwners } = await import("../../../renderer-process-owners");
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getOSProcessId: () => 200 });
    rendererProcessOwners.track(contents, "Browser tab");
    const snapshot = await processMetricsSnapshot(request);
    expect(snapshot.processes.find((row) => row.pid === 200)?.name).toBe("Renderer — Browser tab");
    const pending = processDiagnosticsReport(request);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).text).toContain("Renderer — Browser tab");
    contents.emit("destroyed");
    expect(rendererProcessOwners.ownersByPid().size).toBe(0);
  });

  it("performs no sampling or timers without an observer request", async () => {
    await import("../process-metrics");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(native.exec.mock.calls.length).toBe(0);
    expect(native.metrics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps full-tree history sparse and cancels future sampling on disposal", async () => {
    const metrics = await import("../process-metrics");
    native.metrics.mockReturnValue([
      { pid: process.pid, type: "Browser", memory: { workingSetSize: 100 * 1024 } },
      { pid: 200, type: "Tab", name: "Browser tab", memory: { workingSetSize: 200 * 1024 } },
      { pid: 201, type: "GPU", memory: { workingSetSize: 50 * 1024 } },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const stop = metrics.startProcessMetricsLogging();
      expect(vi.getTimerCount()).toBe(1);
      expect(native.metrics).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(native.metrics).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.filter(([line]) => String(line).includes('"type":"summary"'))).toHaveLength(1);
      expect(scans()).toHaveLength(2);
      expect(native.exec.mock.calls.filter(([file]) => file.endsWith("top"))).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(native.metrics).toHaveBeenCalledTimes(2);
      expect(scans()).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  it("keeps lightweight requests from postponing the complete history or advancing its CPU window", async () => {
    const metrics = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const stop = metrics.startProcessMetricsLogging();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await metrics.processMetricsSnapshot({ detail: false });
      expect(log).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(native.metrics).toHaveBeenCalledTimes(2);
      await metrics.processMetricsSnapshot({ detail: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(native.metrics).toHaveBeenCalledTimes(4);
      const summaries = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('"type":"summary"'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('"samplingIntervalMs":1000');
      expect(scans()).toHaveLength(2);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("keeps one history timer and retries native failures only on the next interval", async () => {
    const metrics = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const stop = metrics.startProcessMetricsLogging();
      metrics.startProcessMetricsLogging();
      native.metrics.mockImplementationOnce(() => { throw new Error("metrics unavailable"); });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(log).toHaveBeenCalledExactlyOnceWith("[Zeros resources] observation unavailable");
      expect(native.metrics).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(native.metrics).toHaveBeenCalledTimes(3);
      expect(log.mock.calls.filter(([line]) => String(line).includes('"type":"summary"'))).toHaveLength(1);
      expect(scans()).toHaveLength(3);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("cancels a pending CPU window without a late log or second process scan", async () => {
    const metrics = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const stop = metrics.startProcessMetricsLogging();
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 200);
      expect(scans()).toHaveLength(1);
      stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(scans()).toHaveLength(1);
      expect(log).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("does not let telemetry logging fail an explicitly requested observation", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementationOnce(() => { throw new Error("closed log sink"); });
    try {
      await expect(processMetricsSnapshot({ detail: false })).resolves.toMatchObject({ terminalRootsKnown: false });
    } finally { log.mockRestore(); }
  });
});
