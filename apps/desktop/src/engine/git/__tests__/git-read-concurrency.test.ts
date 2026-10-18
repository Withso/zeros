import { afterEach, describe, expect, it, vi } from "vitest";
import { runGitRead } from "../git-exec";

afterEach(() => { vi.unstubAllGlobals(); });

describe("Git read concurrency", () => {
  it.each(["local", "cloud"])("bounds Local process pressure and preserves %s scheduling", async (placement) => {
    let active = 0;
    let peak = 0;
    const batch: Array<() => void> = [];
    const spawn = vi.fn((command: string[]) => {
      const observation = command.includes("--no-pager");
      const exited = observation ? new Promise<number>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        batch.push(() => { active -= 1; resolve(0); });
        if (batch.length === 4) {
          const completed = batch.splice(0);
          queueMicrotask(() => completed.forEach((finish) => finish()));
        }
      }) : Promise.resolve(0);
      return { stdout: new Response("").body, stderr: new Response("").body, exited, signalCode: null, killed: false, kill: vi.fn() };
    });
    vi.stubGlobal("Bun", { spawn });
    const options = placement === "cloud" ? { identity: { uid: process.getuid!(), gid: process.getgid!() } } : {};
    await Promise.all(Array.from({ length: 12 }, (_, index) => runGitRead(`/fixture/${placement}-concurrency-${index}`, ["status", "--porcelain"], options)));
    expect(spawn.mock.calls.filter(([command]) => command.includes("--no-pager"))).toHaveLength(12);
    expect(active).toBe(0);
    expect(peak).toBe(placement === "local" ? 4 : 12);
  });

  it("removes an aborted queued read without launching its Git process", async () => {
    const finish: Array<() => void> = [];
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const spawn = vi.fn((command: string[]) => ({
      stdout: new Response("").body, stderr: new Response("").body, signalCode: null, killed: false, kill: vi.fn(),
      exited: command.includes("--no-pager") ? new Promise<number>((resolve) => {
        finish.push(() => resolve(0));
        if (finish.length === 4) started();
      }) : Promise.resolve(0),
    }));
    vi.stubGlobal("Bun", { spawn });
    const running = Array.from({ length: 4 }, (_, index) => runGitRead(`/fixture/held-read-${index}`, ["status"]));
    await ready;
    const controller = new AbortController();
    const cancelled = runGitRead("/fixture/cancelled-read", ["status"], { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    finish.forEach((resolve) => resolve());
    await Promise.all(running);
    expect(spawn.mock.calls.filter(([command]) => command.includes("--no-pager"))).toHaveLength(4);
  });
});
