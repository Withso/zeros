import { afterEach, expect, it, vi } from "vitest";
import { DESIGN_CAPTURE_TEMP_BYTES, DesignCaptureScheduler, DesignCaptureCleanupUnconfirmedError } from "../design-capture-scheduler";

afterEach(() => vi.useRealTimers());

it("reserves running work through cancellation and prioritizes an export over queued refinements", async () => {
  const scheduler = new DesignCaptureScheduler();
  const first = deferred<void>();
  const controller = new AbortController();
  const seen: string[] = [];
  const running = scheduler.schedule("one", "visible", async () => { seen.push("one"); await first.promise; }, controller.signal).catch(() => {});
  const near = scheduler.schedule("near", "nearby", async () => { seen.push("near"); });
  const explicit = scheduler.schedule("export", "explicit", async () => { seen.push("export"); });
  controller.abort();
  expect(scheduler.usage()).toEqual({ running: 1, queued: 2, cancelling: 1, reservedBytes: DESIGN_CAPTURE_TEMP_BYTES });
  expect(seen).toEqual(["one"]);
  first.resolve();
  await Promise.all([running, near, explicit]);
  expect(seen).toEqual(["one", "export", "near"]);
  expect(scheduler.usage()).toEqual({ running: 0, queued: 0, cancelling: 0, reservedBytes: 0 });
});

it("coalesces queued generations, removes cancelled work, and leaves no timer after interaction drains", async () => {
  vi.useFakeTimers();
  const scheduler = new DesignCaptureScheduler();
  const release = scheduler.pause();
  const work = vi.fn(async () => {});
  const old = scheduler.schedule("owner/frame", "visible", work).catch(() => {});
  const current = scheduler.schedule("owner/frame", "visible", work);
  const controller = new AbortController();
  const cancelled = scheduler.schedule("cancelled", "nearby", work, controller.signal).catch(() => {});
  controller.abort();
  expect(work).not.toHaveBeenCalled();
  expect(scheduler.usage().queued).toBe(1);
  release();
  await vi.advanceTimersByTimeAsync(150);
  await Promise.all([old, current, cancelled]);
  expect(work).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("allows explicit capture during input and bounds speculative backlog", async () => {
  const scheduler = new DesignCaptureScheduler();
  const release = scheduler.pause();
  const controllers = Array.from({ length: 40 }, () => new AbortController());
  const queued = controllers.map((controller, index) => scheduler.schedule(String(index), "nearby", async () => {}, controller.signal).catch(() => {}));
  expect(scheduler.usage().queued).toBe(32);
  const explicit = vi.fn(async () => {});
  await scheduler.schedule("export", "explicit", explicit);
  expect(explicit).toHaveBeenCalledOnce();
  controllers.forEach((controller) => controller.abort());
  release();
  await Promise.all(queued);
  expect(scheduler.usage().queued).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}


it("quarantines unconfirmed native cleanup without admitting another capture or retaining queued payloads", async () => {
  const scheduler = new DesignCaptureScheduler();
  const finish = deferred<void>();
  const first = scheduler.schedule("lost-host", "visible", async () => {
    await finish.promise;
    throw new DesignCaptureCleanupUnconfirmedError();
  });
  const next = vi.fn(async () => {});
  const queued = scheduler.schedule("queued", "explicit", next);
  const rejected = Promise.all([expect(first).rejects.toThrow("cleanup"), expect(queued).rejects.toThrow("cleanup")]);
  finish.resolve();
  await rejected;
  await expect(scheduler.schedule("later", "explicit", next)).rejects.toThrow("cleanup");
  expect(next).not.toHaveBeenCalled();
  expect(scheduler.usage()).toMatchObject({ running: 0, queued: 0, unconfirmed: 1, reservedBytes: DESIGN_CAPTURE_TEMP_BYTES });
});
