import { describe, expect, it } from "vitest";

import type { ChatRow } from "../../db/chats";
import { nativeThreadActionsForChatMutation } from "../native-thread-actions";

const chat = (over: Partial<ChatRow> = {}): ChatRow => ({
  id: "chat-1",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: null,
  effort: "high",
  permissionMode: "auto",
  lastModeId: null,
  prePlanModeId: null,
  fast: false,
  additionalDirectories: [],
  title: "Old title",
  createdAt: 1,
  updatedAt: 10,
  sessionId: "zeros-session-1",
  nativeSessionId: "codex-thread-1",
  pinned: false,
  archived: false,
  sourceChatId: null,
  kind: "chat",
  ...over,
});

describe("nativeThreadActionsForChatMutation", () => {
  it("maps archive, pin, and rename changes to native Codex actions", () => {
    expect(
      nativeThreadActionsForChatMutation(
        chat(),
        chat({ archived: true, pinned: true, title: "New title" }),
      ),
    ).toEqual([
      {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        cwd: "/repo",
        action: "archive",
      },
      {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        cwd: "/repo",
        action: "pin",
      },
      {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        cwd: "/repo",
        action: "rename",
        name: "New title",
      },
    ]);
  });

  it("maps restore and permanent deletion", () => {
    expect(
      nativeThreadActionsForChatMutation(
        chat({ archived: true }),
        chat({ archived: false }),
      ).map((action) => action.action),
    ).toEqual(["unarchive"]);
    expect(
      nativeThreadActionsForChatMutation(chat(), null).map(
        (action) => action.action,
      ),
    ).toEqual(["delete"]);
    expect(
      nativeThreadActionsForChatMutation(
        chat({ pinned: true }),
        chat({ pinned: false }),
      ).map((action) => action.action),
    ).toEqual(["unpin"]);
  });

  it("ignores unchanged, non-Codex, and unbound chats", () => {
    expect(nativeThreadActionsForChatMutation(chat(), chat())).toEqual([]);
    expect(
      nativeThreadActionsForChatMutation(
        chat({ agentId: "claude" }),
        chat({ agentId: "claude", archived: true }),
      ),
    ).toEqual([]);
    expect(
      nativeThreadActionsForChatMutation(
        chat({ nativeSessionId: null, sessionId: null }),
        null,
      ),
    ).toEqual([]);
  });
});
