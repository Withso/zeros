import { describe, expect, it } from "vitest";

import type { ChatThread } from "../store";
import { reconcileChatSnapshot } from "../chat-reconciliation";

function chat(id: string, updatedAt: number, title = id): ChatThread {
  return {
    id,
    folder: "/repo/worktree",
    kind: "chat",
    agentId: "claude",
    agentName: null,
    model: null,
    effort: "high",
    fast: false,
    additionalDirectories: [],
    permissionMode: "auto",
    title,
    createdAt: 1,
    updatedAt,
    pinned: false,
    archived: false,
  };
}

describe("chat snapshot reconciliation", () => {
  it("retains the exact array and objects for an unchanged engine snapshot", () => {
    const local = [chat("a", 2), chat("b", 1)];
    const remote = local.map((row) => ({ ...row }));

    const result = reconcileChatSnapshot(local, remote, []);

    expect(result.chats).toBe(local);
    expect(result.rowsToPush).toEqual([]);
    expect(result.removedIds).toEqual([]);
  });

  it("accepts a newer engine row without echoing it back", () => {
    const local = [chat("a", 1, "old")];
    const remote = [chat("a", 2, "new")];

    const result = reconcileChatSnapshot(local, remote, []);

    expect(result.chats).toEqual(remote);
    expect(result.rowsToPush).toEqual([]);
  });

  it("keeps and writes only genuinely newer local rows", () => {
    const newer = chat("a", 3, "local");
    const unchanged = chat("b", 1);
    const localOnly = chat("c", 4);

    const result = reconcileChatSnapshot(
      [newer, unchanged, localOnly],
      [chat("a", 2, "remote"), { ...unchanged }],
      [],
    );

    expect(result.chats).toEqual([newer, unchanged, localOnly]);
    expect(result.rowsToPush).toEqual([newer, localOnly]);
  });

  it("lets the engine win timestamp ties when persisted fields differ", () => {
    const remote = chat("a", 2, "authoritative");
    const result = reconcileChatSnapshot(
      [chat("a", 2, "stale cache")],
      [remote],
      [],
    );

    expect(result.chats).toEqual([remote]);
    expect(result.rowsToPush).toEqual([]);
  });

  it("treats provider bindings and metadata as authoritative persisted fields", () => {
    const local = {
      ...chat("a", 2),
      providerBinding: {
        version: 1 as const,
        providerId: "codex",
        kind: "native" as const,
        resumeId: "thread-old",
      },
    };
    const remote = {
      ...chat("a", 2),
      providerBinding: {
        version: 1 as const,
        providerId: "codex",
        kind: "native" as const,
        resumeId: "thread-new",
      },
      providerMetadata: {
        version: 1 as const,
        git: { sha: "abc", branch: "main", originUrl: null },
      },
    };

    const result = reconcileChatSnapshot([local], [remote], []);

    expect(result.chats).toEqual([remote]);
    expect(result.rowsToPush).toEqual([]);
  });

  it("drops tombstoned cache rows but favors a recreated live row", () => {
    const recreated = chat("live", 5);
    const result = reconcileChatSnapshot(
      [chat("deleted", 3), chat("live", 1)],
      [recreated],
      ["deleted", "live"],
    );

    expect(result.chats).toEqual([recreated]);
    expect(result.removedIds).toEqual(["deleted"]);
    expect(result.rowsToPush).toEqual([]);
  });
});
