import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatThread } from "../../../state/store";
import type { TranscriptSnapshot } from "../chat-transcript-attach";
import { transcriptMessagesThroughMessage } from "../chat-transcript-attach";
import { canAddChildSession, hasParentContext } from "../add-child-session";
import { formatMessageTime } from "../message-hover-actions";
import { createForkedChat } from "../fork-chat";
import {
  boundSeeds,
  columnChatIdForSideChat,
  createSideChat,
  forgetSideChatSeed,
  getSideChatSeed,
  isSideChat,
  markSideChatSeedSent,
  openSideChat,
  publishReplacementChat,
  rememberColumnChat,
  resetSideChatSeedsForTesting,
  sessionViewChatId,
  setSideChatSeed,
  sideChatContextPrefix,
  sideChatHandoffFor,
  sideChatQuote,
  type SideChatSeed,
} from "../side-chat";
import type { AgentMessage } from "../use-agent-session";

const local: ChatThread = {
  id: "source",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: "gpt-5",
  effort: "high",
  permissionMode: "tool-approval",
  title: "Fix the parser",
  createdAt: 1,
  updatedAt: 2,
  sessionId: "execution",
  providerBinding: { version: 1, providerId: "codex", kind: "native", resumeId: "thread" },
};
const cloud: ChatThread = { ...local, folder: "cloud://org-1/ws-1" };

const snapshot = (over: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot => ({
  text: "# handoff\nUser: hi\n", count: 2, truncated: false, complete: true, ...over,
});

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  resetSideChatSeedsForTesting();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function deps() {
  return {
    publishChat: vi.fn(),
    warm: vi.fn(),
    now: 100,
  };
}

describe("createSideChat", () => {
  it("marks a Local side chat as a side chat, never a child session, and keeps model and harness", () => {
    const chat = createSideChat(local, true, 5);
    expect(chat).toMatchObject({ kind: "side", sourceChatId: "source", agentId: "codex", model: "gpt-5", title: "Side chat" });
    expect(chat.parentChatId).toBeUndefined();
    expect(chat.rootChatId).toBeUndefined();
    expect(chat.sessionId).toBeUndefined();
    expect(chat.providerBinding).toBeUndefined();
    expect(isSideChat(chat)).toBe(true);
  });

  it("does not claim parent context for a blank Local side chat", () => {
    const chat = createSideChat(local, false, 5);
    expect(chat.kind).toBe("side");
    expect(chat.parentChatId).toBeUndefined();
    expect(hasParentContext(chat)).toBe(false);
  });

  it("marks cloud side chats the same way, with no child link", () => {
    const chat = createSideChat(cloud, true, 5);
    expect(chat.kind).toBe("side");
    expect(chat.parentChatId).toBeUndefined();
    expect(chat.sourceChatId).toBe("source");
    expect(chat.folder).toBe(cloud.folder);
  });

  it("forks of a side chat are ordinary chats", () => {
    expect(createForkedChat({ ...local, kind: "side" }).kind).toBeUndefined();
    expect(createForkedChat({ ...local, kind: "terminal" }).kind).toBe("terminal");
  });

  it("still recognizes side chats branched before the marker existed", () => {
    setSideChatSeed("legacy", { sourceChatId: "source", sourceTitle: "Fix the parser", messageId: "m1", promptId: null, role: "agent", quote: "q", pending: false, createdAt: 1, sourceUpdatedAt: 1 });
    expect(isSideChat({ ...local, id: "legacy" })).toBe(true);
    expect(isSideChat(local)).toBe(false);
  });
});

describe("sessionViewChatId", () => {
  it("keeps the chat column's session while a side chat has focus", () => {
    const side = { ...local, id: "side", kind: "side" as const, sourceChatId: "source" };
    const chats = [local, side];
    expect(sessionViewChatId(chats, "side", "/repo")).toBe("source");
    rememberColumnChat("/repo", "other");
    expect(sessionViewChatId([...chats, { ...local, id: "other" }], "side", "/repo")).toBe("other");
    expect(sessionViewChatId(chats, "source", "/repo")).toBe("source");
    expect(sessionViewChatId(chats, null, "/repo")).toBeNull();
  });

  it("follows a side chat opened from another side chat back to its session, with no column yet", () => {
    const first = { ...local, id: "first", kind: "side" as const, sourceChatId: "source" };
    const nested = { ...local, id: "nested", kind: "side" as const, sourceChatId: "first" };
    expect(sessionViewChatId([local, first, nested], "nested", "/fresh-after-relaunch")).toBe("source");
    const loopA = { ...local, id: "loop-a", kind: "side" as const, sourceChatId: "loop-b" };
    const loopB = { ...local, id: "loop-b", kind: "side" as const, sourceChatId: "loop-a" };
    expect(sessionViewChatId([loopA, loopB], "loop-a", "/nowhere")).toBeNull();
  });

  it("targets the chat the column falls back to when its chat and the source are closed", () => {
    rememberColumnChat("/repo", "a");
    const a = { ...local, id: "a", archived: true, createdAt: 3 };
    const b = { ...local, id: "b", createdAt: 2 };
    const older = { ...local, id: "older", createdAt: 1 };
    const side = { ...local, id: "s", kind: "side" as const, sourceChatId: "a", createdAt: 9 };
    const chats = [{ ...local, archived: true }, a, b, older, side];
    expect(sessionViewChatId(chats, "s", "/repo")).toBe("b");
    // The pane resolves the same chat from the chats it can show.
    expect(columnChatIdForSideChat(chats, side, "a", (chat) => ["b", "older"].includes(chat.id))).toBe("b");
  });
});

describe("a terminal in the chat column", () => {
  it("stays the target while a side chat has focus, so ⌥⌘T and the menu don't act on another chat", () => {
    const term = { ...local, id: "term", kind: "terminal" as const };
    const side = { ...local, id: "side-t", kind: "side" as const, sourceChatId: "source" };
    rememberColumnChat("/repo", "term");
    const chats = [local, term, side];
    expect(sessionViewChatId(chats, "side-t", "/repo")).toBe("term");
    expect(canAddChildSession(chats.find((chat) => chat.id === sessionViewChatId(chats, "side-t", "/repo")))).toBe(false);
  });
});

describe("publishReplacementChat", () => {
  it("keeps a side chat's /clear or model switch a side chat, in the same tab", () => {
    const dispatch = vi.fn();
    const side = { ...local, id: "side", kind: "side" as const, sourceChatId: "source" };
    publishReplacementChat(dispatch, side, { ...local, id: "fresh", kind: "side", title: "Untitled" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_SIDE_CHAT",
      chat: expect.objectContaining({ id: "fresh", kind: "side", title: "Side chat", sourceChatId: "source" }),
      replaceChatId: "side",
      recordWorkspaceActivity: true,
    });
  });

  it("adds an ordinary chat's replacement to the chat column", () => {
    const dispatch = vi.fn();
    const fresh = { ...local, id: "fresh" };
    publishReplacementChat(dispatch, local, fresh);
    expect(dispatch).toHaveBeenCalledWith({ type: "ADD_CHAT", chat: fresh, recordWorkspaceActivity: true });
  });
});

describe("openSideChat", () => {
  it("publishes the chat and records a pending seed, without linking a child", () => {
    const d = deps();
    const chat = openSideChat(local, { messageId: "m2", promptId: "m1", role: "agent", text: "  The answer\n\n\n\nmore " }, d)!;
    expect(d.publishChat).toHaveBeenCalledWith(chat);
    expect(chat.kind).toBe("side");
    expect(chat.parentChatId).toBeUndefined();
    const seed = getSideChatSeed(chat.id)!;
    expect(seed).toMatchObject({ sourceChatId: "source", messageId: "m2", promptId: "m1", role: "agent", quote: "The answer\n\nmore", pending: true, sourceUpdatedAt: 2 });
    expect(d.warm).toHaveBeenCalledWith(seed, "/repo");
  });

  it("opens a blank side chat with no seed", () => {
    const d = deps();
    const chat = openSideChat(local, null, d)!;
    expect(getSideChatSeed(chat.id)).toBeNull();
    expect(d.warm).not.toHaveBeenCalled();
  });

  it("opens cloud side chats without a child link", () => {
    const d = deps();
    const chat = openSideChat(cloud, { messageId: "m1", promptId: "m1", role: "user", text: "hi" }, d)!;
    expect(chat.parentChatId).toBeUndefined();
    expect(getSideChatSeed(chat.id)?.pending).toBe(true);
  });

  it("refuses terminals and archived chats", () => {
    expect(openSideChat({ ...local, kind: "terminal" }, null, deps())).toBeNull();
    expect(openSideChat({ ...local, archived: true }, null, deps())).toBeNull();
  });
});

describe("side chat handoff", () => {
  it("cuts at the exact message, then at its prompt, never the whole turn", async () => {
    const d = deps();
    const chat = openSideChat(local, { messageId: "m2", promptId: "m1", role: "agent", text: "answer" }, d)!;
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("outside"))
      .mockResolvedValueOnce(snapshot());
    const prefix = await sideChatHandoffFor(chat.id, "/repo", { load });
    expect(load.mock.calls[0][0]).toMatchObject({ chatId: "source", mode: "handoff", throughMessageId: "m2", cut: "message", lastMessageAt: 2 });
    expect(load.mock.calls[1][0]).toMatchObject({ throughMessageId: "m1", cut: "message" });
    expect(prefix).toMatch(/^<context_handoff from="Fix the parser" kind="side_chat">/);
    expect(prefix).toContain("> answer");
    expect(prefix).toContain("# handoff");
    expect(prefix.endsWith("User message:\n")).toBe(true);
  });

  it("stops carrying context once the first prompt is accepted", async () => {
    const chat = openSideChat(local, { messageId: "m1", promptId: "m1", role: "user", text: "hi" }, deps())!;
    markSideChatSeedSent(chat.id);
    const load = vi.fn().mockResolvedValue(snapshot());
    expect(await sideChatHandoffFor(chat.id, "/repo", { load })).toBe("");
    expect(load).not.toHaveBeenCalled();
    expect(getSideChatSeed(chat.id)?.quote).toBe("hi");
  });

  it("notes an incomplete transcript", () => {
    const prefix = sideChatContextPrefix({ sourceTitle: 'a "b"', quote: "q", text: "t", complete: false });
    expect(prefix).toContain(`from="a 'b'"`);
    expect(prefix).toContain("Earlier messages were omitted");
  });

  it("persists seeds and restores them after a reload", () => {
    const chat = openSideChat(local, { messageId: "m1", promptId: "m1", role: "user", text: "hi" }, deps())!;
    const raw = localStorage.getItem("zeros.side-chats.v1");
    resetSideChatSeedsForTesting();
    expect(raw).toBeTruthy();
    expect(getSideChatSeed(chat.id)?.messageId).toBe("m1");
  });

  it("forgets a deleted side chat's seed", () => {
    const chat = openSideChat(local, { messageId: "m1", promptId: "m1", role: "user", text: "hi" }, deps())!;
    forgetSideChatSeed(chat.id);
    expect(getSideChatSeed(chat.id)).toBeNull();
    resetSideChatSeedsForTesting();
    expect(getSideChatSeed(chat.id)).toBeNull();
  });
});

describe("helpers", () => {
  it("bounds seeds to the newest entries", () => {
    const seed = (createdAt: number): SideChatSeed => ({
      sourceChatId: "s", sourceTitle: "", messageId: "m", promptId: null, role: "user", quote: "", pending: false, createdAt, sourceUpdatedAt: 0,
    });
    const bounded = boundSeeds({ a: seed(1), b: seed(3), c: seed(2) }, 2);
    expect(Object.keys(bounded).sort()).toEqual(["b", "c"]);
  });

  it("clips long quotes", () => {
    expect(sideChatQuote("x".repeat(1000)).length).toBe(600);
  });

  it("formats the popup time with a date for earlier days", () => {
    const now = new Date(2026, 10, 22, 12, 0).getTime();
    const today = formatMessageTime(new Date(2026, 10, 22, 11, 30).getTime(), now);
    const earlier = formatMessageTime(new Date(2026, 10, 20, 11, 30).getTime(), now);
    expect(today).toMatch(/11:30/);
    expect(earlier).toMatch(/11:30/);
    expect(earlier.length).toBeGreaterThan(today.length);
    expect(formatMessageTime(0)).toBe("");
  });

  it("cuts a transcript through one exact message and fails closed", () => {
    const messages = [
      { id: "u1", kind: "text", role: "user", text: "q", createdAt: 1 },
      { id: "a1", kind: "text", role: "agent", text: "in between", createdAt: 2 },
      { id: "a2", kind: "text", role: "agent", text: "final", createdAt: 3 },
    ] as AgentMessage[];
    expect(transcriptMessagesThroughMessage(messages, "a1").map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(() => transcriptMessagesThroughMessage(messages, "missing")).toThrow(/outside the loaded history/);
  });

  it("matches streamed agent text by its engine message id", () => {
    const messages = [
      { id: "u1", kind: "text", role: "user", text: "go", createdAt: 1 },
      { id: "thought-1", kind: "text", role: "thought", text: "t", messageId: "e1", createdAt: 2 },
      { id: "agent-engine-1", kind: "text", role: "agent", text: "Generating.", messageId: "e1", createdAt: 3 },
      { id: "tool-1", kind: "tool", toolCallId: "1", title: "uuidgen", status: "completed" },
      { id: "agent-engine-2", kind: "text", role: "agent", text: "UUID", messageId: "e2", createdAt: 4 },
    ] as AgentMessage[];
    expect(transcriptMessagesThroughMessage(messages, "e1").map((m) => m.id)).toEqual(["u1", "thought-1", "agent-engine-1"]);
  });
});
