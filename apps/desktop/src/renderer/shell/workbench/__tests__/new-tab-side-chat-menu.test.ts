import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";
import { resetSideChatSeedsForTesting, setSideChatSeed } from "../../../features/agent/side-chat-seeds";
import { workbenchScopeForFolder } from "../../../state/workspace-store";
import { sideChatEntries, sideChatListLabel } from "../new-tab-side-chat-menu";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, folder: "/repo", agentId: "claude", agentName: null, model: null, effort: "high",
  permissionMode: "auto", title: id, createdAt: 1, updatedAt: 1, ...extra,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  resetSideChatSeedsForTesting();
});

describe("sideChatEntries", () => {
  it("lists this workspace's side chats, newest first, with where each came from", () => {
    const chats = [
      chat("source", { title: "Fix login redirect" }),
      chat("older", { kind: "side", title: "Side chat", sourceChatId: "source", updatedAt: 5 }),
      chat("newer", { kind: "side", title: "Token lifetime", sourceChatId: "source", updatedAt: 9, archived: true }),
      chat("elsewhere", { kind: "side", folder: "/other", sourceChatId: "x" }),
      chat("session"),
    ];
    const entries = sideChatEntries(chats, workbenchScopeForFolder("/repo"), new Set(["older"]));
    expect(entries.map((e) => e.chat.id)).toEqual(["newer", "older"]);
    expect(entries[0]).toMatchObject({ from: "Fix login redirect", open: false });
    expect(entries[1]).toMatchObject({ from: "Fix login redirect", open: true });
  });

  it("falls back to the seed's title when the source chat is gone", () => {
    setSideChatSeed("legacy", { sourceChatId: "gone", sourceTitle: "Old chat", messageId: "m", promptId: null, role: "agent", quote: "q", pending: false, createdAt: 1, sourceUpdatedAt: 1 });
    const entries = sideChatEntries([chat("legacy")], workbenchScopeForFolder("/repo"), new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.from).toBe("Old chat");
  });
});

describe("sideChatListLabel", () => {
  it("never calls a list empty while the workspace's chats are still loading", () => {
    expect(sideChatListLabel(0, true)).toBe("Loading side chats…");
    expect(sideChatListLabel(0, false)).toBe("No side chats yet");
    expect(sideChatListLabel(2, true)).toBe("In this workspace · 2");
  });
});
