import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatThread } from "../../../state/store";
import type { TranscriptSnapshot } from "../chat-transcript-attach";
import { transcriptMessagesThroughMessage } from "../chat-transcript-attach";
import { hasParentContext } from "../add-child-session";
import { formatMessageTime } from "../message-hover-actions";
import {
  boundSeeds,
  createSideChat,
  getSideChatSeed,
  markSideChatSeedSent,
  openSideChat,
  resetSideChatSeedsForTesting,
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
    createChild: vi.fn().mockResolvedValue({ parentChatId: "source", rootChatId: "source" }),
    warm: vi.fn(),
    chatExists: () => true,
    onError: vi.fn(),
    now: 100,
  };
}

describe("createSideChat", () => {
  it("nests a Local side chat under its source and keeps model and harness", () => {
    const chat = createSideChat(local, true, 5);
    expect(chat).toMatchObject({ parentChatId: "source", rootChatId: "source", sourceChatId: "source", agentId: "codex", model: "gpt-5", title: "Side chat" });
    expect(chat.sessionId).toBeUndefined();
    expect(chat.providerBinding).toBeUndefined();
  });

  it("does not claim parent context for a blank Local side chat", () => {
    const chat = createSideChat(local, false, 5);
    expect(chat.parentChatId).toBe("source");
    expect(chat.sourceChatId).toBeUndefined();
    expect(hasParentContext(chat)).toBe(false);
  });

  it("keeps cloud side chats as source-linked forks without a child link", () => {
    const chat = createSideChat(cloud, true, 5);
    expect(chat.parentChatId).toBeUndefined();
    expect(chat.sourceChatId).toBe("source");
    expect(chat.folder).toBe(cloud.folder);
  });
});

describe("openSideChat", () => {
  it("publishes the chat, records a pending seed and links Local children", () => {
    const d = deps();
    const chat = openSideChat(local, { messageId: "m2", promptId: "m1", role: "agent", text: "  The answer\n\n\n\nmore " }, d)!;
    expect(d.publishChat).toHaveBeenCalledWith(chat);
    expect(d.createChild).toHaveBeenCalledWith(expect.objectContaining({ id: chat.id }), "source");
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
    expect(d.createChild).not.toHaveBeenCalled();
    expect(getSideChatSeed(chat.id)?.pending).toBe(true);
  });

  it("refuses terminals and archived chats", () => {
    expect(openSideChat({ ...local, kind: "terminal" }, null, deps())).toBeNull();
    expect(openSideChat({ ...local, archived: true }, null, deps())).toBeNull();
  });
});

describe("side chat handoff", () => {
  it("cuts at the exact message, then falls back to its turn", async () => {
    const d = deps();
    const chat = openSideChat(local, { messageId: "m2", promptId: "m1", role: "agent", text: "answer" }, d)!;
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("outside"))
      .mockResolvedValueOnce(snapshot());
    const prefix = await sideChatHandoffFor(chat.id, "/repo", { load });
    expect(load.mock.calls[0][0]).toMatchObject({ chatId: "source", mode: "handoff", throughMessageId: "m2", cut: "message", lastMessageAt: 2 });
    expect(load.mock.calls[1][0]).toMatchObject({ throughMessageId: "m1" });
    expect(load.mock.calls[1][0].cut).toBeUndefined();
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
});
