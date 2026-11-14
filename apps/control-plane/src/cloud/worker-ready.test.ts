import { afterEach, expect, it, vi } from "vitest";
import { WorkerReadySignals } from "./worker-ready.js";

afterEach(() => vi.useRealTimers());

it("waits for the applied hint of the current boot, ignoring legacy and older-boot hints", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const ready = new WorkerReadySignals(), abort = new AbortController();
  ready.hello("workspace", "boot-1", true);
  ready.hello("workspace", "boot-2", true);
  let done = false;
  const wait = ready.wait("workspace", 1000, true, abort.signal, 10_000).then(() => { done = true; });
  ready.ready("workspace"); ready.applied("workspace", "boot-1");
  await vi.advanceTimersByTimeAsync(500);
  expect(done).toBe(false);
  ready.applied("workspace", "boot-2"); await wait;
  expect(done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains a preceding applied hint, but a new wake cannot consume an older boot's hint", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const ready = new WorkerReadySignals(), abort = new AbortController();
  ready.applied("workspace", "boot-1");
  await ready.wait("workspace", 1000, true, abort.signal, 10_000);
  vi.setSystemTime(2000);
  let done = false;
  const wait = ready.wait("workspace", 2000, true, abort.signal, 10_000).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(1); expect(done).toBe(false);
  abort.abort(); await wait;
  expect(vi.getTimerCount()).toBe(0);
});

it("lets a legacy ready hint or the bounded fallback release a wake without polling", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const ready = new WorkerReadySignals(), abort = new AbortController();
  const legacy = ready.wait("legacy", 1000, true, abort.signal, 10_000);
  ready.ready("legacy"); await legacy;
  let done = false;
  const lost = ready.wait("lost", 1000, true, abort.signal, 10_000).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(9999); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await lost;
  expect(done).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
