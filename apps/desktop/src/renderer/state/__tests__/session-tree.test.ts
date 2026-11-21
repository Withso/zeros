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

  it("makes a child-workspace session a parent there", () => {
    const tree = buildSessionTree(chats, "/ws/b");
    expect(tree.roots.map((n) => n.chat.id)).toEqual(["x5"]);
    expect(sessionLineage(tree, "x5").map((c) => c.id)).toEqual(["x5"]);
  });

  it("returns the lineage from the parent session", () => {
    const tree = buildSessionTree(chats, "/ws/a");
    expect(sessionLineage(tree, "g4").map((c) => c.id)).toEqual(["p1", "c3", "g4"]);
    expect(sessionRootId(tree, "g4")).toBe("p1");
    expect(sessionRootId(tree, "t6")).toBeNull();
  });
});
