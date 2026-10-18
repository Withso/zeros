import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("performs no sampling or timers without an observer request", async () => {
    await import("../process-metrics");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(native.exec.mock.calls.length).toBe(0);
    expect(native.metrics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let telemetry logging fail an explicitly requested observation", async () => {
    const { processMetricsSnapshot } = await import("../process-metrics");
    const log = vi.spyOn(console, "log").mockImplementationOnce(() => { throw new Error("closed log sink"); });
    try {
      await expect(processMetricsSnapshot({ detail: false })).resolves.toMatchObject({ terminalRootsKnown: false });
    } finally { log.mockRestore(); }
  });
});
