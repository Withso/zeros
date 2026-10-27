import { describe, expect, it, vi } from "vitest";
import { sampleNativeApplicationMemory, sampleNativeMemoryPlateau, startNativeMemoryGuard, nativeApplicationProcessIdentities, waitForNativeProcessRetirement } from "../design-native-memory.mjs";
import * as nativeMemory from "../design-native-memory.mjs";

const MiB = 1024 ** 2;
const budget = { maxGpuBytes: 1536 * MiB, maxTotalBytes: 3072 * MiB };
const processes = () => [
  { pid: 101, role: "Browser", rssBytes: 100 * MiB, physicalFootprintBytes: 200 * MiB },
  { pid: 102, role: "GPU", rssBytes: 70 * MiB, physicalFootprintBytes: 300 * MiB },
];

it("samples warm and post-navigation retention after the same document grace and observation window", async () => {
  let now = 0, returnedAt = 0;
  const sample = async () => ({ appBytes: (now - returnedAt < 10_000 ? 1800 : 1200) * MiB, gpuBytes: 200 * MiB });
  const pause = async (ms: number) => { now += ms; };
  const warm = await sampleNativeMemoryPlateau({ throughCycle: 0, sample, pause });
  expect(now).toBe(20_000);
  returnedAt = now;
  expect((await sample()).appBytes).toBe(1800 * MiB);
  const next = await sampleNativeMemoryPlateau({ throughCycle: 10, sample, pause });
  expect(now).toBe(40_000);
  expect(next.samples).toEqual(warm.samples);
  expect(next.samples).toHaveLength(10);
  expect(next.samples.every((s: { appBytes: number }) => s.appBytes === 1200 * MiB)).toBe(true);
});

it("does not fill a cancelled or failed plateau with fabricated memory observations", async () => {
  const sample = vi.fn(async () => ({ appBytes: 1200 * MiB, gpuBytes: 200 * MiB }));
  const pause = vi.fn(async () => { throw new Error("cancelled"); });
  await expect(sampleNativeMemoryPlateau({ throughCycle: 10, sample, pause })).rejects.toThrow("cancelled");
  expect(sample).not.toHaveBeenCalled();
  await expect(sampleNativeMemoryPlateau({ throughCycle: 9, sample, pause })).rejects.toThrow("ten-cycle block");
});

describe("native application memory sampling", () => {
  it("includes owned engine grandchildren once and excludes unrelated applications", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    const readProcessTree = async () => [
      { pid: 101, ppid: 1 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 101 },
      { pid: 104, ppid: 103 }, { pid: 105, ppid: 104 }, { pid: 200, ppid: 1 },
    ];
    const readFootprints = async () => new Map([101, 102, 103, 104, 105, 200].map(pid => [pid, 100 * MiB]));
    const readProcess = async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 });
    const rows = await sampleNativeApplicationMemory({ app, enginePid: 103, readProcessTree, readFootprints, readProcess });
    expect(rows.map((row: { pid: number }) => row.pid)).toEqual([101, 102, 103, 104, 105]);
    expect(rows.filter((row: { role: string }) => row.role === "native-child")).toHaveLength(2);
  });

  it("keeps a discovered helper after reparenting but does not count a reused PID as owned", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    let child = { pid: 104, ppid: 103, startedAt: "first" };
    const readProcessTree = async () => [{ pid: 103, ppid: 101, startedAt: "engine" }, child];
    const readFootprints = async () => new Map([101, 102, 103, 104].map(pid => [pid, 100 * MiB]));
    const readProcess = async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 });
    const sample = () => sampleNativeApplicationMemory({ app, enginePid: 103, readProcessTree, readFootprints, readProcess });
    expect((await sample()).map((r: { pid: number }) => r.pid)).toContain(104);
    child = { ...child, ppid: 1 };
    expect((await sample()).map((r: { pid: number }) => r.pid)).toContain(104);
    child = { ...child, startedAt: "different process" };
    expect((await sample()).map((r: { pid: number }) => r.pid)).not.toContain(104);
  });

  it("joins OS footprints to Electron and the separately owned engine", async () => {
    const app = { evaluate: vi.fn(async () => processes().map(({ physicalFootprintBytes: _, ...row }) => row)) };
    const readFootprints = vi.fn(async () => new Map([[101, 200 * MiB], [102, 15 * 1024 ** 3], [103, 90 * MiB]]));
    const readProcess = vi.fn(async (pid: number) => ({ pid, rssBytes: 40 * MiB, cpuSeconds: 1, cpuSource: "ps" }));
    const rows = await sampleNativeApplicationMemory({ app, enginePid: 103, readFootprints, readProcess, readProcessTree: async () => [] });
    expect(rows).toEqual([
      processes()[0],
      { ...processes()[1], physicalFootprintBytes: 15 * 1024 ** 3 },
      { pid: 103, role: "local-engine", rssBytes: 40 * MiB, cpuSeconds: 1, cpuSource: "ps", lifetimePeakRssBytes: null, physicalFootprintBytes: 90 * MiB },
    ]);
    expect(readFootprints).toHaveBeenCalledTimes(1);
    expect(readFootprints).toHaveBeenCalledWith([101, 102, 103]);
    expect(readProcess).toHaveBeenCalledWith(103);
  });

  it("excludes only a temporary renderer confirmed retired during the OS read", async () => {
    const app = { evaluate: vi.fn(async () => [...processes(), { pid: 104, role: "Tab", rssBytes: 50 * MiB }]) };
    const readFootprints = async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]);
    const isProcessAlive = vi.fn(async () => false);
    const rows = await sampleNativeApplicationMemory({ app, readFootprints, isProcessAlive, readProcessTree: async () => [] });
    expect(rows).toEqual(processes());
    expect(isProcessAlive).toHaveBeenCalledWith(104);
  });

  it("preserves missing evidence for a live renderer, GPU, app or engine", async () => {
    const app = { evaluate: vi.fn(async () => [...processes(), { pid: 104, role: "Tab", rssBytes: 50 * MiB }]) };
    const readFootprints = async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]);
    const rows = await sampleNativeApplicationMemory({ app, readFootprints, isProcessAlive: async () => true, readProcessTree: async () => [] });
    expect(rows.find((row: { pid: number }) => row.pid === 104)).toMatchObject({ physicalFootprintBytes: null });
    const missing = await sampleNativeApplicationMemory({ app, readFootprints: async () => new Map(), isProcessAlive: async () => false,
      enginePid: 103, readProcess: async () => ({ pid: 103, rssBytes: null }), readProcessTree: async () => [] });
    expect(missing.map((row: { pid: number }) => row.pid)).toEqual([101, 102, 103]);
    expect(missing.every((row: { physicalFootprintBytes: null }) => row.physicalFootprintBytes === null)).toBe(true);
  });

  it("recognizes an OS-confirmed zombie helper after its footprint disappears without treating a live missing reading as zero", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    let reads = 0;
    const readProcessTree = async () => [{ pid: 104, ppid: 101, startedAt: "same helper", state: ++reads === 1 ? "S" : "Z" }];
    const rows = await sampleNativeApplicationMemory({ app, readProcessTree,
      readProcess: async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 }),
      readFootprints: async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]),
      // kill(pid, 0) still succeeds until the parent reaps an exited zombie.
      isProcessAlive: async () => true,
    });
    expect(rows).toEqual(processes());
    expect(nativeApplicationProcessIdentities(app)).toContainEqual({ pid: 104, role: "native-child", startedAt: "same helper" });
  });

  it("confirms a helper that exits between the first liveness check and the retirement snapshot", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    let reads = 0;
    const isProcessAlive = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const rows = await sampleNativeApplicationMemory({ app,
      readProcessTree: async () => ++reads === 1
        ? [{ pid: 104, ppid: 101, startedAt: "retiring helper", state: "R" }] : [],
      readProcess: async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 }),
      readFootprints: async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]),
      isProcessAlive,
    });
    expect(rows).toEqual(processes());
    expect(isProcessAlive).toHaveBeenCalledTimes(2);
    expect(nativeApplicationProcessIdentities(app)).toContainEqual({ pid: 104, role: "native-child", startedAt: "retiring helper" });
  });

  it("does not accept a foreign zombie or missing state as proof that an unmeasured live helper retired", async () => {
    for (const current of [{ startedAt: "another helper", state: "Z" }, { startedAt: "original helper", state: "S" },
      { startedAt: "original helper" }]) {
      const app = { evaluate: vi.fn(async () => processes()) };
      let reads = 0;
      const rows = await sampleNativeApplicationMemory({ app,
        readProcessTree: async () => [{ pid: 104, ppid: 101, ...(++reads === 1 ? { startedAt: "original helper", state: "S" } : current) }],
        readProcess: async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 }),
        readFootprints: async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]),
        isProcessAlive: async () => true,
      });
      expect(rows.find((row: { pid: number }) => row.pid === 104)).toMatchObject({ physicalFootprintBytes: null });
    }
  });

  it("recovers a transient OS read only with a measured footprint for the same live helper", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    const readFootprints = vi.fn().mockResolvedValueOnce(new Map([[101, 200 * MiB], [102, 300 * MiB]]))
      .mockResolvedValue(new Map([[104, 7 * MiB]]));
    const rows = await sampleNativeApplicationMemory({ app,
      readProcessTree: async () => [{ pid: 104, ppid: 101, startedAt: "same helper", state: "S" }],
      readProcess: async (pid: number) => ({ pid, rssBytes: 2 * MiB, cpuSeconds: 1 }),
      readFootprints, isProcessAlive: async () => true, pause: async () => {},
    });
    expect(rows.find((row: { pid: number }) => row.pid === 104)).toMatchObject({
      rssBytes: 2 * MiB, physicalFootprintBytes: 7 * MiB,
    });
    expect(readFootprints).toHaveBeenCalledWith([104]);
  });

  it("bounds recovery and retains unavailable evidence for a persistently unmeasurable live helper", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    const readFootprints = vi.fn(async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]));
    const rows = await sampleNativeApplicationMemory({ app,
      readProcessTree: async () => [{ pid: 104, ppid: 101, startedAt: "same helper", state: "S" }],
      readProcess: async (pid: number) => ({ pid, rssBytes: 2 * MiB, cpuSeconds: 1 }),
      readFootprints, isProcessAlive: async () => true, pause: async () => {},
    });
    expect(rows.find((row: { pid: number }) => row.pid === 104)).toMatchObject({ physicalFootprintBytes: null });
    expect(readFootprints.mock.calls.length).toBeGreaterThan(1);
    expect(readFootprints.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("rejects a retry counter whose process identity changed during the OS read", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    let replaced = false;
    const readFootprints = vi.fn().mockResolvedValueOnce(new Map([[101, 200 * MiB], [102, 300 * MiB]]))
      .mockImplementation(async () => { replaced = true; return new Map([[104, 7 * MiB]]); });
    const rows = await sampleNativeApplicationMemory({ app,
      readProcessTree: async () => [{ pid: 104, ppid: 101, startedAt: replaced ? "foreign helper" : "original helper", state: "S" }],
      readProcess: async (pid: number) => ({ pid, rssBytes: 2 * MiB, cpuSeconds: 1 }),
      readFootprints, isProcessAlive: async () => true, pause: async () => {},
    });
    expect(readFootprints).toHaveBeenCalledWith([104]);
    expect(rows.find((row: { pid: number }) => row.pid === 104)).toMatchObject({ physicalFootprintBytes: null });
  });

  it("confirms a short-lived helper's exit after an initially live missing-footprint observation", async () => {
    const app = { evaluate: vi.fn(async () => processes()) };
    let exited = false;
    const rows = await sampleNativeApplicationMemory({ app,
      readProcessTree: async () => [{ pid: 104, ppid: 101, startedAt: "short-lived helper", state: exited ? "Z" : "S" }],
      readProcess: async (pid: number) => ({ pid, rssBytes: 2 * MiB, cpuSeconds: 1 }),
      readFootprints: async () => new Map([[101, 200 * MiB], [102, 300 * MiB]]),
      isProcessAlive: async () => true, pause: async () => { exited = true; },
    });
    expect(rows).toEqual(processes());
    expect(nativeApplicationProcessIdentities(app)).toContainEqual({ pid: 104, role: "native-child", startedAt: "short-lived helper" });
  });
});

describe("native memory guard lifecycle", () => {
  it("records an oversized loading sample and retires the app before returning failure", async () => {
    const events: string[] = [];
    const rows = processes(); rows[1].physicalFootprintBytes = 15 * 1024 ** 3;
    await expect(startNativeMemoryGuard({
      sample: async () => rows, budget,
      onSample: async ({ processes: values }: { processes: typeof rows }) => { expect(values).toEqual(rows); events.push("record"); },
      onFailure: async () => { events.push("retire"); },
    })).rejects.toThrow("GPU physical footprint");
    expect(events).toEqual(["record", "retire"]);
  });

  it("keeps checking during interaction and preserves the failure after retirement", async () => {
    vi.useFakeTimers();
    try {
      const sample = vi.fn(async () => processes());
      const onSample = vi.fn(); const onFailure = vi.fn();
      const guard = await startNativeMemoryGuard({ sample, budget, onSample, onFailure, intervalMs: 100 });
      const rows = processes(); rows[1].physicalFootprintBytes = 1600 * MiB;
      sample.mockResolvedValue(rows);
      await vi.advanceTimersByTimeAsync(100);
      expect(onSample).toHaveBeenCalledTimes(2);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(() => guard.assertHealthy()).toThrow("GPU physical footprint");
      await expect(guard.stop()).rejects.toThrow("GPU physical footprint");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sample).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("never overlaps reads and joins a pending sample before stopping", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: ReturnType<typeof processes>) => void;
      const pending = new Promise<ReturnType<typeof processes>>(done => { resolve = done; });
      const sample = vi.fn(async () => processes());
      const onSample = vi.fn(); const onFailure = vi.fn();
      const guard = await startNativeMemoryGuard({ sample, budget, onSample, onFailure, intervalMs: 100 });
      sample.mockReturnValue(pending);
      await vi.advanceTimersByTimeAsync(500);
      expect(sample).toHaveBeenCalledTimes(2);
      let stopped = false;
      const stop = guard.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      resolve(processes()); await stop;
      await vi.advanceTimersByTimeAsync(1000);
      expect(sample).toHaveBeenCalledTimes(2);
      expect(onFailure).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("retires on missing physical evidence instead of falling back to RSS", async () => {
    const onFailure = vi.fn();
    await expect(startNativeMemoryGuard({ sample: async () => processes().map(row => ({ ...row, physicalFootprintBytes: null })),
      budget, onSample: vi.fn(), onFailure })).rejects.toThrow("physical footprint is unavailable");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("native benchmark retirement", () => {
  it("observes launch descendants before renderer readiness and waits for an early failure's helpers", async () => {
    const app = { process: () => ({ pid: 101 }), evaluate: vi.fn(() => { throw new Error("page not ready"); }) };
    const tree = [{ pid: 101, ppid: 1, startedAt: "app" }, { pid: 102, ppid: 101, startedAt: "engine" },
      { pid: 103, ppid: 102, startedAt: "helper" }];
    await nativeMemory.observeNativeApplicationProcesses(app, { readProcessTree: async () => tree });
    const identities = nativeApplicationProcessIdentities(app);
    expect(identities.map((row: { pid: number }) => row.pid)).toEqual([101, 102, 103]);
    expect(app.evaluate).not.toHaveBeenCalled();
    const remaining = await waitForNativeProcessRetirement(identities, { requiredPids: [101], timeoutMs: 0,
      readProcessTree: async () => [{ ...tree[2], ppid: 1 }], isProcessAlive: async () => false });
    expect(remaining.retired).toBe(false);
    expect(remaining.remaining.map((row: { pid: number }) => row.pid)).toEqual([103]);
  });

  it("keeps following an observed orphan's children without adopting a foreign reused app PID", async () => {
    const app = { process: () => ({ pid: 101 }) };
    await nativeMemory.observeNativeApplicationProcesses(app, { readProcessTree: async () => [
      { pid: 101, ppid: 1, startedAt: "app" }, { pid: 102, ppid: 101, startedAt: "engine" },
    ] });
    await nativeMemory.observeNativeApplicationProcesses(app, { readProcessTree: async () => [
      { pid: 101, ppid: 1, startedAt: "foreign" }, { pid: 200, ppid: 101, startedAt: "foreign helper" },
      { pid: 102, ppid: 1, startedAt: "engine" }, { pid: 103, ppid: 102, startedAt: "late helper" },
    ] });
    const identities = nativeApplicationProcessIdentities(app);
    expect(identities.map((row: { pid: number }) => row.pid)).toEqual([101, 102, 103]);
    expect(identities.find((row: { pid: number }) => row.pid === 101)?.startedAt).toBe("app");
  });

  async function observedApp() {
    const app = { evaluate: vi.fn(async () => processes()) };
    const tree = [
      { pid: 101, ppid: 1, startedAt: "app-start" },
      { pid: 102, ppid: 101, startedAt: "gpu-start" },
      { pid: 103, ppid: 101, startedAt: "engine-start" },
      { pid: 104, ppid: 103, startedAt: "helper-start" },
      { pid: 200, ppid: 1, startedAt: "unrelated" },
    ];
    await sampleNativeApplicationMemory({ app, enginePid: 103,
      readProcessTree: async () => tree,
      readFootprints: async () => new Map(tree.map(row => [row.pid, 100 * MiB])),
      readProcess: async (pid: number) => ({ pid, rssBytes: 10 * MiB, cpuSeconds: 1 }),
    });
    return { app, identities: nativeApplicationProcessIdentities(app), tree };
  }

  it("refuses retirement while a sampled engine helper outlives both roots", async () => {
    const { identities, tree } = await observedApp();
    const result = await waitForNativeProcessRetirement(identities, { requiredPids: [101, 103], timeoutMs: 0,
      readProcessTree: async () => [{ ...tree[3], ppid: 1 }, tree[4]],
      isProcessAlive: async (pid: number) => pid === 104 || pid === 200,
    });
    expect(result.retired).toBe(false);
    expect(result.remaining.map((row: { pid: number }) => row.pid)).toEqual([104]);
    expect(result.processes.map((row: { pid: number }) => row.pid)).not.toContain(200);
  });

  it("accepts actual retirement without waiting for an unrelated reused PID", async () => {
    const { identities } = await observedApp();
    const alive = vi.fn(async () => false);
    const result = await waitForNativeProcessRetirement(identities, { requiredPids: [101, 103], timeoutMs: 0,
      readProcessTree: async () => [{ pid: 104, ppid: 1, startedAt: "different-process" }], isProcessAlive: alive,
    });
    expect(result.retired).toBe(true);
    expect(alive).not.toHaveBeenCalledWith(104);
    expect(result.remaining).toEqual([]);
  });

  it("fails closed on an omitted live identity and missing required root observations", async () => {
    const { identities } = await observedApp();
    const result = await waitForNativeProcessRetirement(identities, { timeoutMs: 0,
      readProcessTree: async () => [], isProcessAlive: async (pid: number) => pid === 104,
    });
    expect(result.retired).toBe(false);
    expect(result.unknown.map((row: { pid: number }) => row.pid)).toEqual([104]);
    await expect(waitForNativeProcessRetirement(identities, { requiredPids: [999] })).rejects.toThrow("observed app and engine identities");
    await expect(waitForNativeProcessRetirement([], {})).rejects.toThrow("observed app and engine identities");
  });

  it("joins delayed descendant retirement within a bounded observation window", async () => {
    const { identities, tree } = await observedApp();
    let now = 0;
    const result = await waitForNativeProcessRetirement(identities, { timeoutMs: 500, now: () => now,
      pause: async (ms: number) => { now += ms; },
      readProcessTree: async () => now < 200 ? [tree[3]] : [], isProcessAlive: async () => false,
    });
    expect(result.retired).toBe(true); expect(now).toBe(200);
    const timeout = await waitForNativeProcessRetirement(identities, { timeoutMs: 500, now: () => now,
      pause: async (ms: number) => { now += ms; },
      readProcessTree: async () => [tree[3]], isProcessAlive: async () => false,
    });
    expect(timeout.retired).toBe(false); expect(now).toBe(700);
  });
});
