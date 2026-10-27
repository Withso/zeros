import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { dispatchNativeDesignGesture } = createRequire(import.meta.url)("../design-native-view.mjs");
const { dispatchMacDesignGesture, macDesignGesturePlan } = createRequire(import.meta.url)("../design-native-input.mjs");
const options = { name: "zoom", startZoom: 0.05, x: 200, y: 300, steps: 12, rateHz: 100, maxPending: 4 };
const clock = { now: () => performance.now(), pause: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
afterEach(() => vi.useRealTimers());

it("keeps native input continuous while acknowledgements are delayed, and drains the bounded transport", async () => {
  vi.useFakeTimers();
  const delivered: Array<{ at: number; input: any }> = [];
  let pending = 0, peak = 0;
  const cdp = { send: vi.fn(async (_method: string, input: any) => {
    pending++; peak = Math.max(peak, pending);
    delivered.push({ at: performance.now(), input });
    await clock.pause(35); pending--;
  }) };
  const complete = dispatchNativeDesignGesture(cdp, options, clock);
  await vi.advanceTimersByTimeAsync(21);
  // A serial await sends only one event here and measures its own idle gaps.
  expect(delivered).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await complete).toMatchObject({ dispatched: 12, maxPending: 4, rateHz: 100 });
  expect(peak).toBe(4); expect(pending).toBe(0);
  expect(cdp.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseWheel", modifiers: 2, x: 200, y: 300 }));
});

it("applies backpressure without unbounded requests or catch-up bursts", async () => {
  vi.useFakeTimers();
  const times: number[] = []; let pending = 0, peak = 0;
  const complete = dispatchNativeDesignGesture({ send: async () => {
    pending++; peak = Math.max(peak, pending); times.push(performance.now());
    await clock.pause(50); pending--;
  } }, { ...options, maxPending: 2 }, clock);
  await vi.advanceTimersByTimeAsync(1000);
  const result = await complete;
  expect(result.dispatched).toBe(12); expect(result.backpressure).toBeGreaterThan(0);
  expect(peak).toBe(2); expect(pending).toBe(0);
  expect(times.slice(1).every((at, index) => at - times[index] >= 10)).toBe(true);
});

it("stops on a native transport failure and waits for already submitted input", async () => {
  vi.useFakeTimers();
  let submitted = 0, completed = 0;
  const complete = dispatchNativeDesignGesture({ send: async () => {
    const index = submitted++;
    await clock.pause(index === 0 ? 15 : 40);
    completed++;
    if (index === 0) throw new Error("native input disconnected");
  } }, options, clock).then(() => null, (error: Error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await complete).toMatchObject({ message: "native input disconnected" });
  expect(submitted).toBe(2); expect(completed).toBe(submitted);
});

it("drains submitted input if the native memory guard cancels pacing", async () => {
  vi.useFakeTimers();
  let completed = false, waits = 0;
  const complete = dispatchNativeDesignGesture({ send: async () => {
    await clock.pause(50); completed = true;
  } }, options, { ...clock, pause: async (ms: number) => {
    if (++waits === 2) throw new Error("native memory guard");
    await clock.pause(ms);
  } }).then(() => null, (error: Error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await complete).toMatchObject({ message: "native memory guard" });
  expect(completed).toBe(true);
});

it.each(["pan", "zoom"])("sends one continuous native %s gesture and a separate empty end phase", name => {
  const plan = macDesignGesturePlan({ ...options, name, pid: 42 });
  expect(plan.events).toHaveLength(13);
  expect(plan.events.map((event: any) => event.phase)).toEqual([1, ...Array(11).fill(2), 4]);
  expect(plan.events.at(-1)).toEqual({ deltaX: 0, deltaY: 0, modifiers: name === "zoom" ? 2 : 0, phase: 4 });
  expect(plan.events.slice(0, -1).every((event: any) => event.deltaY !== 0)).toBe(true);
  expect(plan.events.reduce((sum: number, event: any) => sum + event.deltaY, 0)).toBeCloseTo(0);
  expect(plan.events.reduce((sum: number, event: any) => sum + event.deltaX, 0)).toBeCloseTo(0);
});

it("binds native delivery to the app, verifies its receipt and gives the child a cancellation owner", async () => {
  const controller = new AbortController();
  const receipt = { backend: "CoreGraphics", pid: 42, windowId: 123, dispatched: 12, ended: true, rateHz: 100, durationMs: 120 };
  const run = vi.fn(async () => ({ stdout: JSON.stringify(receipt) }));
  expect(await dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "darwin", run, signal: controller.signal })).toEqual(receipt);
  const call = run.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
  expect(call[0]).toBe("/usr/bin/python3");
  expect(call[1][0]).toMatch(/\/scripts\/design-native-input\.py$/);
  expect(JSON.parse(call[1][1])).toMatchObject({ pid: 42, x: 200, y: 300, rateHz: 100 });
  expect(call[2]).toMatchObject({ signal: controller.signal, timeout: 10130, maxBuffer: 16 * 1024 });
});

it.each([
  { pid: 0 }, { x: NaN }, { steps: 0 }, { steps: 2404 }, { steps: 13 },
  { rateHz: 0 }, { rateHz: 241 }, { startZoom: 8 }, { name: "other" },
])("rejects an invalid native target or workload before posting input: %o", invalid => {
  expect(() => macDesignGesturePlan({ ...options, pid: 42, ...invalid })).toThrow();
});

it.each([
  { ended: false }, { dispatched: 11 }, { pid: 43 }, { windowId: 0 },
  { backend: "CDP" }, { durationMs: -1 }, { rateHz: 30 },
])("rejects incomplete or foreign native delivery receipts: %o", async invalid => {
  const run = vi.fn(async () => ({ stdout: JSON.stringify({ backend: "CoreGraphics", pid: 42, windowId: 123,
    dispatched: 12, ended: true, rateHz: 100, durationMs: 120, ...invalid }) }));
  await expect(dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "darwin", run })).rejects.toThrow("complete delivery");
  expect(run).toHaveBeenCalledTimes(1);
});

it("never retries a failed native input process or substitutes another platform", async () => {
  const run = vi.fn(async () => { throw Object.assign(new Error("Command failed"), {
    stderr: "RuntimeError: The isolated app lost foreground ownership; native input stopped.\n",
  }); });
  await expect(dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "linux", run })).rejects.toThrow("macOS");
  expect(run).not.toHaveBeenCalled();
  await expect(dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "darwin", run })).rejects.toThrow("foreground ownership");
  expect(run).toHaveBeenCalledTimes(1);
});

it("keeps native failure readback bounded without including the serialized input plan", async () => {
  const plan = "unbounded-input-plan".repeat(4000);
  const run = vi.fn(async () => { throw Object.assign(new Error(`Command failed: python input.py ${plan}`), {
    stderr: "Traceback (most recent call last):\n  File \"input.py\", line 90\n" +
      "RuntimeError: The isolated app lost foreground ownership; native input stopped.\n",
  }); });
  const failure = await dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "darwin", run })
    .then(() => null, (error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure?.message).toContain("foreground ownership");
  expect(failure?.stack?.length).toBeLessThan(4096);
  expect(failure?.stack).not.toContain(plan);
  expect(failure?.cause).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(1);
});

it("reports an unavailable native child without exposing its command or captured output", async () => {
  const run = vi.fn(async () => { throw Object.assign(new Error("Command failed: private-driver-arguments"), {
    code: "ENOENT", stdout: "private-child-output",
  }); });
  const failure = await dispatchMacDesignGesture({ ...options, pid: 42 }, { platform: "darwin", run })
    .then(() => null, (error: Error) => error);
  expect(failure?.message).toMatch(/native gesture.*failed/i);
  expect(failure?.stack).not.toMatch(/private-driver-arguments|private-child-output/);
});
