import { describe, expect, it } from "vitest";

import type { ChatThread } from "../store";
import { canMirrorChat, reconcileChatSnapshot } from "../chat-reconciliation";

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
  const cloudFolder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  it("retains cached cloud chats without uploading them before their own history snapshot is confirmed", () => {
    const cached = { ...chat("cloud", 3), folder: cloudFolder };
    const local = chat("local", 3);
    const result = reconcileChatSnapshot([cached, local], [], []);
    expect(result.chats).toEqual([cached, local]);
    expect(result.rowsToPush).toEqual([local]);
    expect(canMirrorChat(cached, new Set())).toBe(false);
    expect(canMirrorChat(local, new Set())).toBe(true);
    expect(canMirrorChat(cached, new Set([cloudFolder]))).toBe(true);
  });
  it("allows newer cloud metadata only after confirmation of the exact workspace", () => {
    const cached = { ...chat("cloud", 3), folder: cloudFolder };
    const remote = { ...cached, updatedAt: 2 };
    expect(reconcileChatSnapshot([cached], [remote], [], []).rowsToPush).toEqual([]);
    expect(reconcileChatSnapshot([cached], [remote], [], [cloudFolder]).rowsToPush).toEqual([cached]);
    expect(reconcileChatSnapshot([cached], [], [], [cloudFolder + "-other"]).rowsToPush).toEqual([]);
  });
  it("confirms a nested cloud cwd by its workspace owner without admitting malformed paths", () => {
    const confirmed = new Set([cloudFolder]);
    expect(canMirrorChat({ folder: cloudFolder + "/packages/app" }, confirmed)).toBe(true);
    expect(canMirrorChat({ folder: cloudFolder.toUpperCase() }, confirmed)).toBe(true);
    expect(canMirrorChat({ folder: cloudFolder + "/../other" }, confirmed)).toBe(false);
    expect(canMirrorChat({ folder: "cloud://invalid" }, confirmed)).toBe(false);
  });
  it("accepts an engine mode change despite a newer local title and rejects an older mode response", () => {
    const local = { ...chat("a", 5, "new title"), composerMode: "code" as const, composerModeRevision: 0 };
    const remote = { ...chat("a", 2), composerMode: "design" as const, composerModeRevision: 1 };
    const result = reconcileChatSnapshot([local], [remote], []);
    expect(result.chats[0]).toMatchObject({ title: "new title", composerMode: "design", composerModeRevision: 1 });
    const newer = { ...result.chats[0]!, composerMode: "code" as const, composerModeRevision: 2 };
    expect(reconcileChatSnapshot([newer], [remote], []).chats[0]).toBe(newer);
    expect(reconcileChatSnapshot([newer], [{ ...remote, updatedAt: 6 }], []).chats[0]).toMatchObject({ composerMode: "code", composerModeRevision: 2 });
  });
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
