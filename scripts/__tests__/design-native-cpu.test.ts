import { expect, it, vi } from "vitest";
import { measureNativeIdleCpu } from "../design-native-cpu.mjs";

const rows = (cpuSeconds: number, tab = true) => [
  { pid: 10, role: "Browser", cpuSeconds },
  { pid: 20, role: "GPU", cpuSeconds },
  { pid: 30, role: "local-engine", cpuSeconds },
  ...(tab ? [{ pid: 40, role: "Tab", cpuSeconds }] : []),
];

function clock() {
  let time = 0;
  return { now: () => time, pause: async (ms: number) => { time += ms; } };
}

it("preserves a renderer retirement as invalid evidence, then measures a full stable idle window", async () => {
  const sample = vi.fn().mockResolvedValueOnce(rows(1)).mockResolvedValueOnce(rows(2, false))
    .mockResolvedValueOnce(rows(3, false)).mockResolvedValueOnce(rows(4, false));
  const onObservation = vi.fn();
  const result = await measureNativeIdleCpu({ sample, ...clock(), onObservation });
  expect(onObservation).toHaveBeenCalledTimes(2);
  expect(onObservation.mock.calls[0][0]).toMatchObject({ valid: false, reason: "process-ownership-changed", attempt: 1 });
  expect(onObservation.mock.calls[0][0].percent).toBeUndefined();
  expect(result).toMatchObject({ valid: true, attempt: 2, seconds: 60.5 });
  expect(result.percent).toBeCloseTo(300 / 60.5);
});

it("never retries a high but valid CPU observation to find a lower number", async () => {
  const sample = vi.fn().mockResolvedValueOnce(rows(1)).mockResolvedValueOnce(rows(100));
  const onObservation = vi.fn();
  const result = await measureNativeIdleCpu({ sample, ...clock(), onObservation });
  expect(result.percent).toBeGreaterThan(100);
  expect(sample).toHaveBeenCalledTimes(2);
  expect(onObservation).toHaveBeenCalledTimes(1);
});

it("detects temporary child work even when endpoint process sets match", async () => {
  const history: ReturnType<typeof rows>[] = [];
  let windows = 0;
  const sample = vi.fn().mockResolvedValueOnce(rows(1, false)).mockResolvedValueOnce(rows(2, false))
    .mockResolvedValueOnce(rows(3, false)).mockResolvedValueOnce(rows(4, false));
  const timer = clock(), onObservation = vi.fn();
  const result = await measureNativeIdleCpu({ sample, now: timer.now, sampleHistory: () => history,
    pause: async (ms: number) => { await timer.pause(ms); history.push(rows(++windows === 1 ? 2 : 4, windows === 1)); }, onObservation });
  expect(result.attempt).toBe(2);
  expect(onObservation.mock.calls[0][0]).toMatchObject({ valid: false, reason: "process-ownership-changed" });
});

it("fails with both invalid attempts retained when process ownership keeps changing", async () => {
  const sample = vi.fn().mockResolvedValueOnce(rows(1)).mockResolvedValueOnce(rows(2, false))
    .mockResolvedValueOnce(rows(3, false)).mockResolvedValueOnce(rows(4));
  const onObservation = vi.fn();
  await expect(measureNativeIdleCpu({ sample, ...clock(), onObservation })).rejects.toThrow("stable idle");
  expect(sample).toHaveBeenCalledTimes(4);
  expect(onObservation.mock.calls.map(([observation]) => observation.valid)).toEqual([false, false]);
});

it("fails immediately when a root process changes or a cumulative counter resets", async () => {
  const sample = vi.fn().mockResolvedValueOnce(rows(1)).mockResolvedValueOnce(rows(2).filter(row => row.role !== "GPU"));
  await expect(measureNativeIdleCpu({ sample, ...clock(), onObservation: vi.fn() })).rejects.toThrow("root process");
  expect(sample).toHaveBeenCalledTimes(2);
  const reset = vi.fn().mockResolvedValueOnce(rows(10)).mockResolvedValueOnce(rows(2));
  await expect(measureNativeIdleCpu({ sample: reset, ...clock(), onObservation: vi.fn() })).rejects.toThrow("CPU counter");
  expect(reset).toHaveBeenCalledTimes(2);
});

it("does not publish a sample after cancellation or fabricate counters", async () => {
  const onObservation = vi.fn();
  await expect(measureNativeIdleCpu({ sample: async () => rows(1), pause: async () => { throw new Error("cancelled"); },
    onObservation })).rejects.toThrow("cancelled");
  expect(onObservation).not.toHaveBeenCalled();
});
