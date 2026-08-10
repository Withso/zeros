import { describe, expect, it } from "vitest";

import type { ChatThread } from "../../../state/store";
import { mergeNativeThreadMetadata } from "../native-thread-metadata";

const chat = (): ChatThread => ({
  id: "chat-1",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: null,
  effort: "high",
  permissionMode: "tool-approval",
  additionalDirectories: [],
  title: "Local title",
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
});

describe("native Codex thread metadata hydration", () => {
  it("atomically reconciles name, pin, and Git metadata", () => {
    expect(mergeNativeThreadMetadata(chat(), {
      name: "Native title",
      isPinned: true,
      gitInfo: { sha: "abc", branch: "santhosh", originUrl: null },
    }, 100)).toEqual(expect.objectContaining({
      title: "Native title",
      pinned: true,
      nativeGitInfo: { sha: "abc", branch: "santhosh", originUrl: null },
      updatedAt: 100,
    }));
  });

  it("preserves reference identity when the exact metadata is unchanged", () => {
    const current = chat();
    current.title = "Native title";
    current.pinned = true;
    current.nativeGitInfo = { sha: "abc", branch: "santhosh", originUrl: null };
    expect(mergeNativeThreadMetadata(current, {
      name: "Native title",
      isPinned: true,
      gitInfo: { sha: "abc", branch: "santhosh", originUrl: null },
    }, 100)).toBe(current);
  });

  it("does not replace a useful title with a null native title", () => {
    expect(mergeNativeThreadMetadata(chat(), {
      name: null,
      isPinned: false,
      gitInfo: null,
    }, 100).title).toBe("Local title");
  });
});
