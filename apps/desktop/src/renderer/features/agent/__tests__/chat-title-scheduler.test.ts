import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_TITLE_IDLE_GRACE_MS,
  noteInteractiveAgentActivity,
  resetChatTitleSchedulerForTests,
  scheduleChatTitleWork,
} from "../chat-title-scheduler";

describe("chat-title background scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetChatTitleSchedulerForTests();
  });

  afterEach(() => {
    resetChatTitleSchedulerForTests();
    vi.useRealTimers();
  });

  it("keeps cosmetic provider work out of the post-turn interaction window", async () => {
    const work = vi.fn(async () => {});
    scheduleChatTitleWork("chat-1", work);

    await vi.advanceTimersByTimeAsync(CHAT_TITLE_IDLE_GRACE_MS - 1);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledOnce();
  });

  it("restarts the quiet window when the user starts another agent action", async () => {
    const work = vi.fn(async () => {});
    scheduleChatTitleWork("chat-1", work);
    await vi.advanceTimersByTimeAsync(CHAT_TITLE_IDLE_GRACE_MS - 1);

    noteInteractiveAgentActivity();
    await vi.advanceTimersByTimeAsync(CHAT_TITLE_IDLE_GRACE_MS - 1);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledOnce();
  });

  it("serializes titles from several chats instead of booting providers together", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    scheduleChatTitleWork("chat-1", async () => {
      calls.push("first:start");
      await firstGate;
      calls.push("first:end");
    });
    scheduleChatTitleWork("chat-2", async () => {
      calls.push("second");
    });

    await vi.advanceTimersByTimeAsync(CHAT_TITLE_IDLE_GRACE_MS);
    expect(calls).toEqual(["first:start"]);
    releaseFirst();
    await vi.runAllTimersAsync();
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("keeps one scheduler across a Vite-style module replacement", async () => {
    const staleWork = vi.fn(async () => {});
    const replacementWork = vi.fn(async () => {});
    scheduleChatTitleWork("chat-1", staleWork);

    vi.resetModules();
    const replacement = await import("../chat-title-scheduler");
    replacement.scheduleChatTitleWork("chat-1", replacementWork);

    await vi.advanceTimersByTimeAsync(CHAT_TITLE_IDLE_GRACE_MS);
    expect(staleWork).not.toHaveBeenCalled();
    expect(replacementWork).toHaveBeenCalledOnce();
  });
});
