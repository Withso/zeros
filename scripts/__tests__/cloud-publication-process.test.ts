import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPublicationCommand } from "../cloud-workspace-validation/lib/publication-process";
afterEach(() => vi.useRealTimers());

describe("publication process cancellation", () => {
  it.skipIf(process.platform === "win32")(
    "escalates termination and waits for the child rather than accepting an abort error as cleanup",
    async () => {
      const controller = new AbortController();
      let child!: ChildProcess;
      let kill!: ReturnType<typeof vi.spyOn>;
      const task = runPublicationCommand(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        {
          signal: controller.signal,
          timeoutMs: 5_000,
          terminationGraceMs: 50,
          spawnProcess: ((command, args, options) => {
            child = spawn(command, args, {
              ...options,
              stdio: ["ignore", "pipe", "ignore"],
            });
            kill = vi.spyOn(child, "kill");
            return child;
          }) as typeof spawn,
        },
      );
      const assertion = expect(task).rejects.toThrow();
      try {
        await once(child.stdout!, "data");
        controller.abort();
        await assertion;
        expect(kill).toHaveBeenCalledWith("SIGTERM");
        expect(kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

  it("does not start a process for an already cancelled publication", async () => {
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    await expect(
      runPublicationCommand("docker", [], {
        signal: AbortSignal.abort(),
        spawnProcess,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects a timed-out command even when its termination handler exits successfully, and cancels escalation", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: vi.fn(),
      kill: vi.fn((_signal: string) => {
        child.emit("close", 0, null);
        return true;
      }),
    });
    const task = runPublicationCommand("docker", [], {
      signal: new AbortController().signal,
      timeoutMs: 50,
      terminationGraceMs: 25,
      spawnProcess: (() => child) as unknown as typeof spawn,
    });
    const assertion = expect(task).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("releases cleanup even if forced termination raises an error", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: vi.fn(),
      kill: vi.fn((signal: string) => {
        if (signal === "SIGKILL") throw new Error("process disappeared");
        return true;
      }),
    });
    const task = runPublicationCommand("docker", [], {
      signal: controller.signal,
      timeoutMs: 500,
      terminationGraceMs: 25,
      spawnProcess: (() => child) as unknown as typeof spawn,
    });
    const assertion = expect(task).rejects.toThrow(/cancelled/);
    controller.abort();
    await vi.advanceTimersByTimeAsync(26);
    await assertion;
    expect(child.unref).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("clears cancellation and timeout handlers after successful close", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    const task = runPublicationCommand("docker", [], {
      signal: controller.signal,
      timeoutMs: 50,
      spawnProcess: (() => child) as unknown as typeof spawn,
    });
    child.emit("close", 0, null);
    await expect(task).resolves.toBeUndefined();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
