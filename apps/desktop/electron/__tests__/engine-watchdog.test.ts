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
    generation: 1,
  };
  const observation = {
    childExited: false,
    lastOutputAt: null as number | null,
    lastHeartbeatAt: null as number | null,
    activeWork: false,
  };
  const probe = vi.fn<
    (port: number, instance: string, timeoutMs?: number) => Promise<boolean>
  >(async () => false);
  const restart = vi.fn<
    (
      target: EngineWatchdogTarget,
      shouldRestart: () => boolean,
    ) => Promise<EngineWatchdogTarget | null>
  >(async (previous) => {
    const next = { ...previous, generation: previous.generation + 1 };
    target = next;
    Object.assign(observation, {
      childExited: false,
      lastOutputAt: null,
      lastHeartbeatAt: null,
      activeWork: false,
    });
    return next;
  });
  const describeListeners = vi.fn(async () => "listeners");
  const tick = createEngineWatchdogTick({
    current: () => target,
    observe: () => ({ ...observation }),
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
    setObservation: (next: Partial<typeof observation>) => {
      Object.assign(observation, next);
    },
    heartbeat: (activeWork = true) => {
      observation.lastHeartbeatAt = now;
      observation.activeWork = activeWork;
    },
    output: () => {
      observation.lastOutputAt = now;
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
        generation: generation + 1,
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
      app.setTarget({
        root: "/other",
        port: 24294,
        instance: "external",
        generation: 2,
      });
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
          : {
              root: "/project",
              port: 24293,
              instance: "second",
              generation: 2,
            },
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
          expect.any(Function),
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
    app.setTarget({
      root: "/other",
      port: 24294,
      instance: "replacement",
      generation: 2,
    });
    result.resolve("old listeners");
    await pending;
    expect(app.restart).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale probe when the owned child changes even on the same endpoint", async () => {
    const app = harness();
    for (let i = 0; i < 4; i++) await app.tick();
    const result = deferred<boolean>();
    app.probe.mockImplementationOnce(() => result.promise);
    const pending = app.tick();
    app.setTarget({
      root: "/project",
      port: 24293,
      instance: "first",
      generation: 2,
    });
    result.resolve(false);
    await pending;
    expect(app.restart).not.toHaveBeenCalled();
  });
});

describe("engine watchdog recovery evidence", () => {
  it("confirms a slow application-level probe before replacing a living child", async () => {
    const app = harness();
    for (let i = 0; i < 4; i++) await app.tick();
    const confirmation = deferred<boolean>();
    app.probe
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => confirmation.promise);
    const pending = app.tick();
    await vi.waitFor(() => expect(app.probe).toHaveBeenCalledTimes(6));
    expect(app.probe.mock.lastCall?.[2]).toBe(15_000);
    expect(app.restart).not.toHaveBeenCalled();
    confirmation.resolve(true);
    await pending;
    expect(app.restart).not.toHaveBeenCalled();
  });

  it("gives an output-producing child a bounded overload confirmation", async () => {
    const app = harness();
    for (let i = 0; i < 4; i++) {
      app.advance(3000);
      app.output();
      await app.tick();
    }
    app.advance(3000);
    app.output();
    const confirmation = deferred<boolean>();
    app.probe
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => confirmation.promise);
    const pending = app.tick();
    await vi.waitFor(() => expect(app.probe).toHaveBeenCalledTimes(6));
    expect(app.probe.mock.lastCall?.[2]).toBe(60_000);
    app.advance(56_000);
    confirmation.resolve(true);
    await pending;
    expect(app.restart).not.toHaveBeenCalled();
  });

  it("protects outstanding child work while exact heartbeats keep advancing", async () => {
    const app = harness();
    for (let i = 0; i < 120; i++) {
      app.advance(10_000);
      app.heartbeat();
      await app.tick();
    }
    expect(app.probe).toHaveBeenCalledTimes(120);
    expect(app.restart).not.toHaveBeenCalled();
  });

  it("expires abandoned work evidence and recovers a wedged event loop", async () => {
    const app = harness();
    app.heartbeat();
    for (let i = 0; i < 5; i++) {
      app.advance(3000);
      await app.tick();
    }
    expect(app.restart).not.toHaveBeenCalled();
    app.advance(5 * 60_000);
    await app.tick();
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("does not let unrelated output suppress hung-listener recovery forever", async () => {
    const app = harness();
    for (let i = 0; i < 5; i++) {
      app.advance(3000);
      app.output();
      await app.tick();
    }
    expect(app.probe).toHaveBeenCalledTimes(6);
    expect(app.probe.mock.lastCall?.[2]).toBe(60_000);
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("does not let an idle heartbeat mask an unreachable listener", async () => {
    const app = harness();
    for (let i = 0; i < 5; i++) {
      app.advance(3000);
      app.heartbeat(false);
      await app.tick();
    }
    expect(app.probe).toHaveBeenCalledTimes(6);
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("recovers a known dead child without probing or trusting stale active work", async () => {
    const app = harness();
    app.heartbeat();
    app.setObservation({ childExited: true });
    app.probe.mockResolvedValue(true);
    await app.tick();
    expect(app.probe).not.toHaveBeenCalled();
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("recovers when the child exits during a pending probe", async () => {
    const app = harness();
    const result = deferred<boolean>();
    app.probe.mockImplementationOnce(() => result.promise);
    const pending = app.tick();
    app.setObservation({ childExited: true });
    result.resolve(false);
    await pending;
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("does not count a host event-loop delay as the fifth engine failure", async () => {
    const app = harness();
    for (let i = 0; i < 4; i++) await app.tick();
    const result = deferred<boolean>();
    app.probe.mockImplementationOnce(() => result.promise);
    const pending = app.tick();
    app.advance(60_000);
    result.resolve(false);
    await pending;
    expect(app.restart).not.toHaveBeenCalled();
  });

  it("rechecks active work when queued recovery reaches the spawn boundary", async () => {
    const app = harness();
    app.restart.mockImplementationOnce(async (_target, shouldRestart) => {
      app.heartbeat();
      expect(shouldRestart()).toBe(false);
      return null;
    });
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledOnce();
  });

  it("does not consume respawn backoff when queued recovery was cancelled", async () => {
    const app = harness();
    app.restart.mockImplementationOnce(async (target) => {
      const next = { ...target, generation: target.generation + 1 };
      app.setTarget(next);
      return next;
    });
    for (let i = 0; i < 5; i++) await app.tick();
    app.restart.mockImplementationOnce(async (_target, shouldRestart) => {
      app.heartbeat();
      expect(shouldRestart()).toBe(false);
      return null;
    });
    for (let i = 0; i < 5; i++) await app.tick();
    app.heartbeat(false);
    for (let i = 0; i < 5; i++) await app.tick();
    expect(app.restart).toHaveBeenCalledTimes(3);
  });
});
