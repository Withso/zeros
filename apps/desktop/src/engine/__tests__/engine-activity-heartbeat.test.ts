import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineActivityHeartbeat } from "../engine-activity-heartbeat";

afterEach(() => vi.useRealTimers());

describe("private engine activity heartbeat", () => {
  it("publishes only boot identity and bounded activity metadata", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    let activeTurns = 0;
    const heartbeat = new EngineActivityHeartbeat({
      instance: "boot-a",
      publish,
      activeTurns: () => activeTurns,
    });
    heartbeat.start();
    heartbeat.start();
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      type: "engine.heartbeat",
      instance: "boot-a",
      sequence: 1,
      activeRequests: 0,
      activeTurns: 0,
    });
    activeTurns = 2;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(publish).toHaveBeenLastCalledWith({
      type: "engine.heartbeat",
      instance: "boot-a",
      sequence: 2,
      activeRequests: 0,
      activeTurns: 2,
    });
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("retains overlapping requests until each operation has settled", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const heartbeat = new EngineActivityHeartbeat({
      instance: "boot-a",
      publish,
      activeTurns: () => 1,
    });
    heartbeat.start();
    let finishA!: () => void;
    let failB!: (error: Error) => void;
    const a = heartbeat.track(
      () =>
        new Promise<void>((resolve) => {
          finishA = resolve;
        }),
    );
    const b = heartbeat.track(
      () =>
        new Promise<void>((_resolve, reject) => {
          failB = reject;
        }),
    );
    const bFailed = expect(b).rejects.toThrow("request failed");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRequests: 2, activeTurns: 1 }),
    );
    finishA();
    await a;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRequests: 1 }),
    );
    failB(new Error("request failed"));
    await bFailed;
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRequests: 0 }),
    );
    heartbeat.stop();
  });

  it("does not revive host activity when an operation finishes after stop", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const heartbeat = new EngineActivityHeartbeat({
      instance: "boot-a",
      publish,
      activeTurns: () => 0,
    });
    heartbeat.start();
    let finish!: () => void;
    const operation = heartbeat.track(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    heartbeat.stop();
    const count = publish.mock.calls.length;
    finish();
    await operation;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(publish).toHaveBeenCalledTimes(count);
    heartbeat.start();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 3, activeRequests: 0 }),
    );
    heartbeat.stop();
  });

  it("cannot fail agent work when the private control writer is unavailable", async () => {
    vi.useFakeTimers();
    const heartbeat = new EngineActivityHeartbeat({
      instance: "boot-a",
      activeTurns: () => 0,
      publish: () => {
        throw new Error("host pipe closed");
      },
    });
    heartbeat.start();
    await expect(heartbeat.track(async () => "done")).resolves.toBe("done");
    await expect(
      heartbeat.track(() => {
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");
    heartbeat.stop();
  });
});
