import { expect, it, vi } from "vitest";
import { DesignPreviewJobs } from "../preview-jobs";
import { DesignCaptureCleanupUnconfirmedError } from "@zeros/protocol/design-capture";

const admission = { connectionId: "one", authority: "local-personal", authorized: () => true };
const owner = { workspaceId: "workspace", directoryId: "design_one", jobId: "first", deadline: Date.now() + 30_000 };

it("does not evict a cancel-before-start tombstone under terminal-history pressure", async () => {
  const jobs = new DesignPreviewJobs();
  await jobs.cancel(owner, admission);
  for (let index = 0; index < 140; index++) await jobs.run({ ...owner, jobId: String(index) }, admission, async () => {});
  const work = vi.fn(async () => {});
  await expect(jobs.run(owner, admission, work)).rejects.toThrow(/retired/);
  expect(work).not.toHaveBeenCalled();
});

it("does not resurrect a cancelled running job when normal completions evict terminal history", async () => {
  const jobs = new DesignPreviewJobs();
  const cleanup = deferred<void>();
  const first = jobs.run(owner, admission, async () => cleanup.promise).catch(() => {});
  const cancelled = jobs.cancel(owner, admission);
  cleanup.resolve();
  await Promise.all([first, cancelled]);
  for (let index = 0; index < 140; index++) await jobs.run({ ...owner, jobId: String(index) }, admission, async () => {});
  const work = vi.fn(async () => {});
  await expect(jobs.run(owner, admission, work)).rejects.toThrow(/retired/);
  expect(work).not.toHaveBeenCalled();
});

it("refuses new work and cancellation success after losing native cleanup proof", async () => {
  const jobs = new DesignPreviewJobs();
  await expect(jobs.run(owner, admission, async () => { throw new DesignCaptureCleanupUnconfirmedError(); })).rejects.toThrow(/cleanup/);
  const work = vi.fn(async () => {});
  await expect(jobs.run({ ...owner, jobId: "next" }, admission, work)).rejects.toThrow(/cleanup/);
  await expect(jobs.cancel(owner, admission)).rejects.toThrow(/cleanup/);
  expect(work).not.toHaveBeenCalled();
});

it("expires cancellation metadata without resurrecting an expired original request", async () => {
  const jobs = new DesignPreviewJobs();
  await jobs.cancel(owner, admission);
  const clock = vi.spyOn(Date, "now").mockReturnValue(owner.deadline + 1);
  try {
    await jobs.run({ ...owner, jobId: "fresh", deadline: owner.deadline + 20_000 }, admission, async () => {});
    expect(jobs.usage().records).toBe(1);
    const work = vi.fn(async () => {});
    await expect(jobs.run(owner, admission, work)).rejects.toThrow(/deadline/);
    expect(await jobs.cancel(owner, admission)).toEqual({ settled: true });
    expect(work).not.toHaveBeenCalled();
    expect(jobs.usage().records).toBe(1);
  } finally { clock.mockRestore(); }
});

it("holds cancellation acknowledgement and the next preview until real cleanup", async () => {
  const jobs = new DesignPreviewJobs();
  const cleanup = deferred<void>();
  let signal: AbortSignal | undefined;
  const first = jobs.run(owner, admission, async (current) => { signal = current; await cleanup.promise; }).catch(() => {});
  const next = vi.fn(async () => {});
  const second = jobs.run({ ...owner, jobId: "second" }, admission, next);
  let cancelled = false;
  const cancellation = jobs.cancel(owner, admission).then(() => { cancelled = true; });
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(false);
  expect(next).not.toHaveBeenCalled();
  cleanup.resolve();
  await Promise.all([first, second, cancellation]);
  expect(next).toHaveBeenCalledOnce();
  expect(jobs.usage()).toMatchObject({ running: 0, queued: 0 });
});

it("fences cancel-before-start, repeated cancellation and foreign owner/connection attempts", async () => {
  const jobs = new DesignPreviewJobs();
  await jobs.cancel(owner, admission);
  await jobs.cancel(owner, admission);
  const work = vi.fn(async () => {});
  await expect(jobs.run(owner, admission, work)).rejects.toThrow("retired");
  expect(work).not.toHaveBeenCalled();
  const cleanup = deferred<void>();
  let signal: AbortSignal | undefined;
  const activeOwner = { ...owner, jobId: "active" };
  const active = jobs.run(activeOwner, admission, async (current) => { signal = current; await cleanup.promise; });
  await jobs.cancel(activeOwner, { ...admission, connectionId: "other" });
  await jobs.cancel({ ...activeOwner, directoryId: "design_other" }, admission);
  expect(signal?.aborted).toBe(false);
  cleanup.resolve();
  await active;
});

it("disconnect and shutdown cancel queued work without starting it and drain current work", async () => {
  const jobs = new DesignPreviewJobs();
  const cleanup = deferred<void>();
  const first = jobs.run(owner, admission, async () => cleanup.promise).catch(() => {});
  const work = vi.fn(async () => {});
  const queued = jobs.run({ ...owner, jobId: "queued" }, admission, work).catch(() => {});
  jobs.retire(admission.connectionId);
  let stopped = false;
  const stop = jobs.stop().then(() => { stopped = true; });
  expect(stopped).toBe(false);
  expect(work).not.toHaveBeenCalled();
  cleanup.resolve();
  await Promise.all([first, queued, stop]);
  expect(work).not.toHaveBeenCalled();
  expect(jobs.usage()).toEqual({ running: 0, queued: 0, records: 0 });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
