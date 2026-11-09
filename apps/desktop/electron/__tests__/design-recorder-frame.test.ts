import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { designRecorderFrameGuard } from "../design-recorder-frame";

const never = () => new Promise<never>(() => {});

describe("recorder frame guard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("passes a frame's steps through while the frame progresses", async () => {
    const guard = designRecorderFrameGuard({ gone: never(), signal: new AbortController().signal, timeoutMs: 1_000 });
    await expect(guard.run(Promise.resolve("picture"))).resolves.toBe("picture");
    await expect(guard.run(Promise.reject(new Error("step failed")))).rejects.toThrow("step failed");
    guard.dispose();
    expect(guard.signal.aborted).toBe(false);
  });

  it("fails a frame whose page stops producing within its deadline", async () => {
    const guard = designRecorderFrameGuard({ gone: never(), signal: new AbortController().signal, timeoutMs: 10_000 });
    const step = guard.run(never());
    vi.advanceTimersByTime(10_000);
    await expect(step).rejects.toThrow("This frame did not finish rendering within 10 s.");
    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it("fails a frame at once when its page crashes", async () => {
    let crash!: (reason: string) => void;
    const guard = designRecorderFrameGuard({ gone: new Promise((resolve) => { crash = resolve; }), signal: new AbortController().signal });
    const step = guard.run(never());
    crash("The recorder's page stopped (crashed) while recording this frame.");
    await expect(step).rejects.toThrow("The recorder's page stopped (crashed) while recording this frame.");
    // A later step of the same frame stops too.
    await expect(guard.run(never())).rejects.toThrow(/crashed/);
    guard.dispose();
  });

  it("stops a frame in progress when its batch is aborted", async () => {
    const batch = new AbortController();
    const guard = designRecorderFrameGuard({ gone: never(), signal: batch.signal });
    const step = guard.run(never());
    batch.abort(new Error("Design recording timed out."));
    await expect(step).rejects.toThrow("Design recording timed out.");
    guard.dispose();
    const late = designRecorderFrameGuard({ gone: never(), signal: batch.signal });
    await expect(late.run(never())).rejects.toThrow("Design recording timed out.");
    late.dispose();
  });

  it("leaves no timer behind once disposed", () => {
    const guard = designRecorderFrameGuard({ gone: never(), signal: new AbortController().signal, timeoutMs: 1_000 });
    guard.dispose();
    vi.advanceTimersByTime(5_000);
    expect(guard.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
