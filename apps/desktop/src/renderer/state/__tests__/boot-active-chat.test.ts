// Boot active-chat restore policy — regression guard for the "app restarts
// into a dead, no-chat-selected Conversation pane" bug (2026-07-06). The old policy
// honored a persisted `"null"` active-chat-id as "user explicitly cleared →
// land on the EmptyComposer"; that surface was deleted 2026-06-18, so any
// restart that had persisted a null (mid workspace-swap, after a tab close,
// after an archive) booted into a black pane. Boot now ALWAYS restores a chat
// when one exists, preferring the chat the user was last VIEWING in the
// workspace they left.
import { describe, it, expect } from "vitest";

import { resolveBootActiveChatId } from "../boot-active-chat";
import type { ChatThread } from "../store";

function chat(
  id: string,
  folder: string,
  updatedAt: number,
  archived = false,
): ChatThread {
  return { id, folder, updatedAt, archived } as ChatThread;
}

const A = "/repo/wt-a";
const B = "/repo/wt-b";

const chats = [
  chat("a-old", A, 100),
  chat("a-new", A, 300),
  chat("b1", B, 200),
  chat("a-archived", A, 900, true),
];

describe("resolveBootActiveChatId", () => {
  it("restores the persisted id when that chat is still live", () => {
    expect(
      resolveBootActiveChatId(chats, "a-old", {
        lastWorkspaceFolder: B,
        activeChatByFolder: {},
      }),
    ).toBe("a-old");
  });

  it("never restores an archived chat, even when persisted", () => {
    expect(
      resolveBootActiveChatId(chats, "a-archived", {
        lastWorkspaceFolder: A,
        activeChatByFolder: {},
      }),
    ).toBe("a-new");
  });

  it("a legacy persisted null restores the last-VIEWED chat — the screenshot bug", () => {
    // The user was viewing a-old in workspace A when the app persisted a
    // null active id (e.g. mid workspace-swap) and then restarted. The old
    // policy honored the null → dead pane. Now: land back on a-old.
    expect(
      resolveBootActiveChatId(chats, null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: { [A]: "a-old" },
      }),
    ).toBe("a-old");
  });

  it("falls back to the most-recent live chat in the last workspace", () => {
    expect(
      resolveBootActiveChatId(chats, null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: {},
      }),
    ).toBe("a-new");
  });

  it("ignores a remembered chat that moved out of the folder", () => {
    expect(
      resolveBootActiveChatId(chats, null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: { [A]: "b1" },
      }),
    ).toBe("a-new");
  });

  it("ignores a remembered chat that was archived", () => {
    expect(
      resolveBootActiveChatId(chats, null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: { [A]: "a-archived" },
      }),
    ).toBe("a-new");
  });

  it("falls back to the most-recent live chat anywhere when the last workspace has none", () => {
    expect(
      resolveBootActiveChatId([chat("b1", B, 200)], null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: {},
      }),
    ).toBe("b1");
  });

  it("falls back globally when no workspace was remembered", () => {
    expect(
      resolveBootActiveChatId(chats, null, {
        lastWorkspaceFolder: null,
        activeChatByFolder: {},
      }),
    ).toBe("a-new");
  });

  it("returns null only when there are no live chats at all", () => {
    expect(
      resolveBootActiveChatId([chat("x", A, 1, true)], null, {
        lastWorkspaceFolder: A,
        activeChatByFolder: {},
      }),
    ).toBeNull();
    expect(
      resolveBootActiveChatId([], "gone", {
        lastWorkspaceFolder: null,
        activeChatByFolder: {},
      }),
    ).toBeNull();
  });
});
