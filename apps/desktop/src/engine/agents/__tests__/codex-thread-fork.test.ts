import { describe, expect, it, vi } from "vitest";

import type { ChatRow } from "../../db/chats";
import { forkCodexChat } from "../codex-thread-fork";

const source: ChatRow = {
  id: "chat-source",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: "gpt-5.6-sol",
  effort: "high",
  permissionMode: "approve",
  lastModeId: "auto-edit",
  prePlanModeId: null,
  fast: false,
  additionalDirectories: [],
  title: "Investigate browser",
  createdAt: 1,
  updatedAt: 2,
  sessionId: "zeros-session-source",
  nativeSessionId: "native-source",
  pinned: true,
  archived: false,
  sourceChatId: null,
  kind: null,
};

describe("forkCodexChat", () => {
  it("persists a fresh Zeros chat bound to the native fork", async () => {
    const persist = vi.fn();
    const invoke = vi.fn(async () => ({
      thread: { id: "native-fork", forkedFromId: "native-source" },
      model: "gpt-5.6-sol",
    }));
    const ids = ["zeros-session-fork", "chat-fork"];

    const result = await forkCodexChat(
      "zeros-session-source",
      "/repo",
      { threadId: "native-source", lastTurnId: "turn-2" },
      {
        getSourceChat: () => source,
        invoke,
        persist,
        rollbackNative: vi.fn(),
        createId: () => ids.shift()!,
        now: () => 100,
      },
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "native-source",
        lastTurnId: "turn-2",
        cwd: "/repo",
        path: null,
        ephemeral: false,
      }),
    );
    expect(result.zerosChat).toMatchObject({
      id: "chat-fork",
      sessionId: "zeros-session-fork",
      nativeSessionId: "native-fork",
      title: "Investigate browser (fork)",
      pinned: false,
      archived: false,
    });
    expect(persist).toHaveBeenCalledWith(result.zerosChat);
  });

  it("rejects a thread that is not the active chat's native thread", async () => {
    const invoke = vi.fn();
    await expect(
      forkCodexChat(
        "zeros-session-source",
        "/repo",
        { threadId: "another-native-thread" },
        {
          getSourceChat: () => source,
          invoke,
          persist: vi.fn(),
          rollbackNative: vi.fn(),
          createId: () => "id",
          now: () => 100,
        },
      ),
    ).rejects.toThrow(/does not match/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deletes the native fork when durable chat persistence fails", async () => {
    const rollbackNative = vi.fn(async () => undefined);
    await expect(
      forkCodexChat(
        "zeros-session-source",
        "/repo",
        { threadId: "native-source" },
        {
          getSourceChat: () => source,
          invoke: async () => ({
            thread: { id: "native-fork", forkedFromId: "native-source" },
          }),
          persist: () => {
            throw new Error("database full");
          },
          rollbackNative,
          createId: vi
            .fn()
            .mockReturnValueOnce("zeros-session-fork")
            .mockReturnValueOnce("chat-fork"),
          now: () => 100,
        },
      ),
    ).rejects.toThrow(/database full/i);
    expect(rollbackNative).toHaveBeenCalledWith(
      "native-fork",
      "zeros-session-fork",
      "/repo",
    );
  });
});
