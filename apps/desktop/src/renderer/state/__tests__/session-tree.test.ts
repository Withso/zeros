import { describe, expect, it } from "vitest";
import type { ChatThread } from "../store";
import { buildSessionTree, sessionDescendantIds, sessionLineage, sessionRootId } from "../session-tree";

const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, folder: "/ws/a", agentId: "claude", agentName: null, model: null, effort: "high",
  permissionMode: "default" as ChatThread["permissionMode"], title: id, createdAt: Number(id.replace(/\D/g, "")) || 0, updatedAt: 0, ...extra,
});

describe("buildSessionTree", () => {
  const chats = [
    chat("p1"),
    chat("p2"),
    chat("c3", { parentChatId: "p1", rootChatId: "p1" }),
    chat("g4", { parentChatId: "c3", rootChatId: "p1" }),
    chat("x5", { parentChatId: "p1", rootChatId: "p1", folder: "/ws/b" }),
    chat("t6", { kind: "terminal" }),
    chat("a7", { archived: true }),
    chat("o8", { parentChatId: "gone", rootChatId: "gone" }),
  ];

  it("lists parents oldest first and nests children across folders", () => {
    const tree = buildSessionTree(chats, "/ws/a");
    expect(tree.roots.map((n) => n.chat.id)).toEqual(["p1", "p2", "o8"]);
    expect(tree.byId.get("p1")!.children.map((n) => n.chat.id)).toEqual(["c3", "x5"]);
    expect(sessionDescendantIds(tree.byId.get("p1")!)).toEqual(["c3", "g4", "x5"]);
  });

  it("includes closed chats only for a read-only workspace", () => {
    expect(buildSessionTree(chats, "/ws/a").byId.has("a7")).toBe(false);
    expect(buildSessionTree(chats, "/ws/a", { includeArchived: true }).roots.map((n) => n.chat.id)).toEqual(["p1", "p2", "a7", "o8"]);
  });

  it("makes a child-workspace session a parent there", () => {
    const tree = buildSessionTree(chats, "/ws/b");
    expect(tree.roots.map((n) => n.chat.id)).toEqual(["x5"]);
    expect(sessionLineage(tree, "x5").map((c) => c.id)).toEqual(["x5"]);
  });

  it("never lists a side chat: it is a Workbench tab, not a session", () => {
    const tree = buildSessionTree([
      ...chats,
      chat("s9", { kind: "side", sourceChatId: "p1" }),
      chat("s10", { kind: "side", parentChatId: "p1", rootChatId: "p1", sourceChatId: "p1" }),
    ], "/ws/a", { includeArchived: true });
    expect(tree.byId.has("s9")).toBe(false);
    expect(tree.byId.has("s10")).toBe(false);
    expect(tree.roots.map((n) => n.chat.id)).not.toContain("s9");
    expect(sessionDescendantIds(tree.byId.get("p1")!)).toEqual(["c3", "g4", "x5"]);
  });

  it("returns the lineage from the parent session", () => {
    const tree = buildSessionTree(chats, "/ws/a");
    expect(sessionLineage(tree, "g4").map((c) => c.id)).toEqual(["p1", "c3", "g4"]);
    expect(sessionRootId(tree, "g4")).toBe("p1");
    expect(sessionRootId(tree, "t6")).toBeNull();
  });
});
