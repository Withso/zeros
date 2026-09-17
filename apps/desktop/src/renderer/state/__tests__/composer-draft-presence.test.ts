import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../workspace-store";
import type { ChatThread, ComposerDraft } from "../store";
import { setLiveChatDraft } from "../../features/agent/composer-live-drafts";
import {
  useComposerDraftPresence,
  draftChatIdsByWorkspace,
} from "../composer-draft-presence";

const textDraft = (text: string): ComposerDraft => ({ text, attachments: [] });
const hasDraft = (id: string) => useComposerDraftPresence.getState().has(id);
const liveIds = new Set<string>();
function live(id: string, draft: ComposerDraft | null) {
  liveIds.add(id);
  setLiveChatDraft(id, draft);
}

beforeEach(() => {
  vi.stubGlobal("window", {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
  });
  useWorkspaceStore.setState({
    chatComposerDrafts: {},
    editComposerDrafts: {},
  });
});
afterEach(() => {
  for (const id of liveIds) setLiveChatDraft(id, null);
  liveIds.clear();
  useWorkspaceStore.setState({
    chatComposerDrafts: {},
    editComposerDrafts: {},
  });
  vi.unstubAllGlobals();
});

describe("composer draft presence", () => {
  it("restores text and attachment-only drafts, but ignores whitespace", () => {
    useWorkspaceStore.setState({
      chatComposerDrafts: {
        text: textDraft("Remember this"),
        blank: textDraft(" \n\t "),
        file: {
          text: "",
          attachments: [{ id: "file" } as ComposerDraft["attachments"][number]],
        },
      },
    });
    expect([...useComposerDraftPresence.getState()].sort()).toEqual([
      "file",
      "text",
    ]);
  });

  it("lets a live empty composer override its older persisted draft", () => {
    useWorkspaceStore.setState({
      chatComposerDrafts: { a: textDraft("Old text") },
    });
    live("a", textDraft(""));
    expect(hasDraft("a")).toBe(false);
    live("b", textDraft("New text"));
    expect(hasDraft("b")).toBe(true);
    expect(hasDraft("a")).toBe(false);
  });

  it("publishes only presence changes, not continued typing or attachment progress", () => {
    const listener = vi.fn();
    const stop = useComposerDraftPresence.subscribe(listener);
    try {
      live("a", textDraft("a"));
      const snapshot = useComposerDraftPresence.getState();
      for (let index = 0; index < 20; index++)
        live("a", textDraft(`draft ${index}`));
      useWorkspaceStore.setState({
        chatComposerDrafts: { a: textDraft("Parked copy") },
      });
      expect(useComposerDraftPresence.getState()).toBe(snapshot);
      expect(listener).toHaveBeenCalledTimes(1);
      live("a", textDraft(""));
      expect(listener).toHaveBeenCalledTimes(2);
      expect(hasDraft("a")).toBe(false);
    } finally {
      stop();
    }
  });

  it("keeps presence through parking, returning and clearing the sent draft", () => {
    live("a", textDraft("Park me"));
    const snapshot = useComposerDraftPresence.getState();
    useWorkspaceStore.setState({
      chatComposerDrafts: { a: textDraft("Park me") },
    });
    live("a", null);
    expect(useComposerDraftPresence.getState()).toBe(snapshot);
    live("b", textDraft("Other chat"));
    live("a", textDraft("Park me"));
    expect(hasDraft("a")).toBe(true);
    live("a", textDraft(""));
    useWorkspaceStore.setState({ chatComposerDrafts: {} });
    expect(hasDraft("a")).toBe(false);
    expect(hasDraft("b")).toBe(true);
  });

  it("keeps unsent message edits until their last stash is cleared", () => {
    const stash = {
      text: "Edited prompt",
      newAttachments: [],
      keptOriginals: [],
    };
    useWorkspaceStore.setState({
      editComposerDrafts: { "a:one": stash, "a:two": stash },
    });
    live("a", textDraft(""));
    expect(hasDraft("a")).toBe(true);
    useWorkspaceStore.setState({ editComposerDrafts: { "a:two": stash } });
    expect(hasDraft("a")).toBe(true);
    useWorkspaceStore.setState({ editComposerDrafts: {} });
    expect(hasDraft("a")).toBe(false);
  });
});

describe("workspace draft ownership", () => {
  it("includes closed chats and isolates nested workspaces, path aliases and terminals", () => {
    const workspaces = [
      { id: "outer", path: "/var/repo" },
      { id: "nested", path: "/var/repo/nested" },
      { id: "other", path: "/var/repo-other" },
    ];
    const chats = [
      { id: "a", folder: "/private/var/repo/src", archived: true },
      { id: "b", folder: "/private/var/repo/nested/src" },
      { id: "c", folder: "/var/repo-other/" },
      { id: "terminal", folder: "/var/repo", kind: "terminal" },
      { id: "orphan", folder: "/missing" },
    ] as ChatThread[];
    const grouped = draftChatIdsByWorkspace(chats, workspaces);
    expect(grouped.get("outer")).toEqual(["a"]);
    expect(grouped.get("nested")).toEqual(["b"]);
    expect(grouped.get("other")).toEqual(["c"]);
    expect(
      draftChatIdsByWorkspace(
        chats.filter((chat) => chat.id !== "a"),
        workspaces,
      ).get("outer"),
    ).toEqual([]);
  });
});
