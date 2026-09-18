import { describe, expect, it, vi } from "vitest";
import {
  createEngineWatchdogTick,
  type EngineWatchdogTarget,
} from "../engine-watchdog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  let now = 0;
  let target: EngineWatchdogTarget | null = {
    root: "/project",
    port: 24293,
    instance: "first",
  };
  const probe = vi.fn(async () => false);
  const restart = vi.fn(async (): Promise<EngineWatchdogTarget | null> => null);
  const describeListeners = vi.fn(async () => "listeners");
  const tick = createEngineWatchdogTick({
    current: () => target,
    probe,
    restart,
    describeListeners,
    log: vi.fn(),
    now: () => now,
  });
  return {
    tick,
    probe,
    restart,
    describeListeners,
    advance: (ms: number) => {
      now += ms;
    },
    setTarget: (next: typeof target) => {
      target = next;
    },
  };
}

describe("engine watchdog ownership", () => {
  it("retains backoff across its own replacements and resets it on healthy contact", async () => {
    const app = harness();
    let generation = 0;
    app.restart.mockImplementation(async () => {
      const next = {
        root: "/project",
        port: 24293,
        instance: `boot-${++generation}`,
      };
      app.setTarget(next);
      return next;
    });
    for (let i = 0; i < 10; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(2);
    app.advance(30_000);
    await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(3);
    app.probe.mockResolvedValueOnce(true);
    await app.tick();
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(4);
  });

  it("does not transfer old backoff to an external replacement that won the spawn queue", async () => {
    const app = harness();
    for (let i = 0; i < 5; i++) await app.tick();
    app.restart.mockImplementationOnce(async () => {
      app.setTarget({ root: "/other", port: 24294, instance: "external" });
      return null;
    });
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(3);
  });

  it.each(["replacement", "shutdown"])(
    "ignores an old probe after %s",
    async (change) => {
      const app = harness();
      for (let i = 0; i < 4; i++) await app.tick();
      const result = deferred<boolean>();
      app.probe.mockImplementationOnce(() => result.promise);
      const pending = app.tick();
      app.setTarget(
        change === "shutdown"
          ? null
          : { root: "/project", port: 24293, instance: "second" },
      );
      result.resolve(false);
      await pending;
      expect(app.restart).not.toHaveBeenCalled();
      if (change === "replacement") {
        for (let i = 0; i < 4; i++) await app.tick();
        expect(app.restart).not.toHaveBeenCalled();
        await app.tick();
        expect(app.restart).toHaveBeenCalledWith(
          expect.objectContaining({ instance: "second" }),
        );
      }
    },
  );

  it("has only one pending probe even when timer ticks overlap", async () => {
    const app = harness();
    const result = deferred<boolean>();
    app.probe.mockImplementation(() => result.promise);
    const polls = Array.from({ length: 6 }, () => app.tick());
    result.resolve(false);
    await Promise.all(polls);
    expect(app.probe).toHaveBeenCalledOnce();
    expect(app.restart).not.toHaveBeenCalled();
  });

  it("rechecks ownership after slow diagnostics", async () => {
    const app = harness();
    for (let i = 0; i < 5; i++) await app.tick();
    const result = deferred<string>();
    app.describeListeners.mockImplementationOnce(() => result.promise);
    for (let i = 0; i < 4; i++) await app.tick();
    const pending = app.tick();
    await vi.waitFor(() =>
      expect(app.describeListeners).toHaveBeenCalledOnce(),
    );
    app.setTarget({ root: "/other", port: 24294, instance: "replacement" });
    result.resolve("old listeners");
    await pending;
    expect(app.restart).toHaveBeenCalledTimes(1);
  });
});
