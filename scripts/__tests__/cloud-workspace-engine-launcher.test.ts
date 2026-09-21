import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { launchCloudEngine } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

function fixture() {
  const order: string[] = [];
  const signals = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
    stdio: [] as unknown[],
  });
  const barrier = new Writable({
    write(_chunk, _encoding, done) {
      order.push("release");
      done();
    },
  });
  child.stdio[3] = barrier;
  const scope = {
    prepare: vi.fn(() => {
      order.push("scope");
    }),
    attach: vi.fn(() => {
      order.push("place");
    }),
    retire: vi.fn(async () => {
      order.push("retire");
    }),
  };
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const options = {
    prepare: () => {
      order.push("prepare");
    },
    scope,
    spawnProcess,
    signals,
    source: {},
  };
  const finish = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code);
  };
  return { order, child, barrier, scope, options, signals, finish };
}

describe("cloud engine admission and lifecycle", () => {
  it("blocks before bubblewrap can fork, so every descendant inherits the admitted scope", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    await launchCloudEngine(f.options);
    const call = f.options.spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(call[0]).toBe("/opt/zeros-runtime/cloud-engine-namespace");
    expect(call[1][0]).toBe("--await-scope");
    expect(call[1]).not.toContain("--block-fd");
  });
  it("places the blocked child before admitting execution and reaps its scope on exit", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    await expect(launchCloudEngine(f.options)).resolves.toBe(0);
    expect(f.order).toEqual(["prepare", "scope", "place", "release", "retire"]);
  });
  it("never releases execution when cgroup placement fails", async () => {
    const f = fixture();
    f.scope.attach.mockImplementation(() => {
      throw new Error("placement unconfirmed");
    });
    await expect(launchCloudEngine(f.options)).rejects.toThrow(
      /placement unconfirmed/,
    );
    expect(f.order).not.toContain("release");
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(f.scope.retire).toHaveBeenCalledOnce();
  });
  it("closes launch handles even when scope retirement fails", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    f.scope.retire.mockRejectedValue(new Error("scope still populated"));
    await expect(launchCloudEngine(f.options)).rejects.toThrow(
      /still populated/,
    );
    expect(f.barrier.destroyed).toBe(true);
    expect(f.child.unref).toHaveBeenCalledOnce();
  });
  it("bounds a child that ignores termination and removes signal listeners", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let completed = false;
    const running = launchCloudEngine(f.options).then((code) => {
      completed = true;
      return code;
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      f.signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(10001);
      expect(completed).toBe(true);
      await expect(running).resolves.toBe(125);
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(f.scope.retire).toHaveBeenCalledOnce();
      expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      f.finish();
      await running;
      vi.useRealTimers();
    }
  });
});
