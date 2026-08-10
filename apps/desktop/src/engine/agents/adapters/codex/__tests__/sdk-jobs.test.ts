import { describe, expect, it, vi } from "vitest";

import { CodexSdkJobManager } from "../sdk-jobs";

describe("Codex SDK headless jobs", () => {
  it("runs a bounded job and retains a serializable result", async () => {
    const run = vi.fn(async () => ({
      finalResponse: "All checks passed",
      items: [{ id: "answer", type: "agent_message" as const, text: "done" }],
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        output_tokens: 4,
        reasoning_output_tokens: 1,
      },
    }));
    const manager = new CodexSdkJobManager({
      createThread: () => ({ id: "thread-1", run }),
      maxConcurrent: 1,
    });

    const started = manager.start({ cwd: process.cwd(), prompt: "Run checks" });
    expect(started.status).toBe("queued");
    await manager.wait(started.id);

    expect(manager.get(started.id)).toMatchObject({
      status: "completed",
      threadId: "thread-1",
      result: { finalResponse: "All checks passed" },
    });
    expect(run).toHaveBeenCalledWith("Run checks", expect.any(Object));
  });

  it("enforces concurrency and cancels a queued job without running it", async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstRun;
        return { finalResponse: "first", items: [], usage: null };
      })
      .mockResolvedValue({ finalResponse: "second", items: [], usage: null });
    const manager = new CodexSdkJobManager({
      createThread: () => ({ id: null, run }),
      maxConcurrent: 1,
    });

    const first = manager.start({ cwd: process.cwd(), prompt: "first" });
    const second = manager.start({ cwd: process.cwd(), prompt: "second" });
    await vi.waitFor(() =>
      expect(manager.get(first.id)?.status).toBe("running"),
    );
    expect(manager.cancel(second.id)).toBe(true);
    release();
    await manager.wait(first.id);
    await manager.wait(second.id);

    expect(manager.get(second.id)?.status).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects non-absolute cwd and oversized prompts before queueing", () => {
    const manager = new CodexSdkJobManager({
      createThread: () => ({
        id: null,
        run: vi.fn(async () => ({ finalResponse: "", items: [], usage: null })),
      }),
    });

    expect(() => manager.start({ cwd: "relative", prompt: "test" })).toThrow(
      /absolute/i,
    );
    expect(() =>
      manager.start({ cwd: process.cwd(), prompt: "x".repeat(100_001) }),
    ).toThrow(/100000/i);
  });

  it("cancels every queued job when the owning engine shuts down", async () => {
    const manager = new CodexSdkJobManager({
      createThread: () => ({
        id: null,
        run: vi.fn(async () => ({ finalResponse: "", items: [], usage: null })),
      }),
      maxConcurrent: 1,
    });
    const first = manager.start({ cwd: process.cwd(), prompt: "first" });
    const second = manager.start({ cwd: process.cwd(), prompt: "second" });

    expect(manager.cancelAll()).toBe(2);
    await manager.wait(first.id);
    await manager.wait(second.id);

    expect(manager.get(first.id)?.status).toBe("cancelled");
    expect(manager.get(second.id)?.status).toBe("cancelled");
  });
});
