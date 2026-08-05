// Active-workspace folder resolution — the fallback chain that restores the
// last workspace on boot (fixes the "No workspace selected" flash on restart).
import { describe, it, expect } from "vitest";

import { selectActiveFolder, selectLiveFolder } from "../workspace-store";
import type { WorkspaceState } from "../store";

// Minimal state factory — the selectors only read these four fields.
function state(partial: {
  activeChatId?: string | null;
  chats?: { id: string; folder: string }[];
  newAgentFolder?: string | null;
  lastWorkspaceFolder?: string | null;
}): WorkspaceState {
  return {
    activeChatId: partial.activeChatId ?? null,
    chats: (partial.chats ?? []) as WorkspaceState["chats"],
    newAgentFolder: partial.newAgentFolder ?? null,
    lastWorkspaceFolder: partial.lastWorkspaceFolder ?? null,
  } as WorkspaceState;
}

describe("selectLiveFolder", () => {
  it("prefers the active chat's folder", () => {
    const s = state({
      activeChatId: "c1",
      chats: [{ id: "c1", folder: "/repo/wt-a" }],
      newAgentFolder: "/repo/wt-b",
      lastWorkspaceFolder: "/repo/wt-c",
    });
    expect(selectLiveFolder(s)).toBe("/repo/wt-a");
  });

  it("falls back to newAgentFolder when no chat is active", () => {
    const s = state({ newAgentFolder: "/repo/wt-b", lastWorkspaceFolder: "/repo/wt-c" });
    expect(selectLiveFolder(s)).toBe("/repo/wt-b");
  });

  it("returns null when there's no live context (never the persisted fallback)", () => {
    const s = state({ lastWorkspaceFolder: "/repo/wt-c" });
    expect(selectLiveFolder(s)).toBeNull();
  });

  it("treats an empty-string chat folder as unset and falls through", () => {
    const s = state({
      activeChatId: "c1",
      chats: [{ id: "c1", folder: "" }],
      newAgentFolder: "/repo/wt-b",
    });
    expect(selectLiveFolder(s)).toBe("/repo/wt-b");
  });
});

describe("selectActiveFolder", () => {
  it("uses the live folder when present", () => {
    const s = state({
      activeChatId: "c1",
      chats: [{ id: "c1", folder: "/repo/wt-a" }],
      lastWorkspaceFolder: "/repo/wt-c",
    });
    expect(selectActiveFolder(s)).toBe("/repo/wt-a");
  });

  it("falls back to the persisted lastWorkspaceFolder on a fresh boot (no chat, no scope)", () => {
    const s = state({ lastWorkspaceFolder: "/repo/wt-c" });
    expect(selectActiveFolder(s)).toBe("/repo/wt-c");
  });

  it("falls back to lastWorkspaceFolder when the active chat has an empty folder", () => {
    const s = state({
      activeChatId: "c1",
      chats: [{ id: "c1", folder: "" }],
      lastWorkspaceFolder: "/repo/wt-c",
    });
    expect(selectActiveFolder(s)).toBe("/repo/wt-c");
  });

  it("returns null only when nothing is known (genuinely empty app)", () => {
    expect(selectActiveFolder(state({}))).toBeNull();
  });
});
