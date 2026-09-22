import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcherChat } from "../dispatcher-chat";
import type { DispatcherCreatePayload } from "../dispatcher-composer";
import {
  useWorkspaceStore,
  selectActiveFolder,
} from "../../../state/workspace-store";
import type { Action } from "../../../state/store";

const folder = "/projects/Plain folder";
const payload: DispatcherCreatePayload = {
  selection: {
    agentId: "claude",
    agentName: "Claude Code",
    model: "claude-opus-4-6",
  },
  effort: "low",
  fast: true,
  permissionMode: "auto",
  lastModeId: "accept-edits",
  additionalDirectories: ["/projects/assets"],
  serialized: null,
};

describe("dispatcher chat destination", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: () => {},
    });
    useWorkspaceStore.setState({
      activePage: "create",
      chats: [],
      activeChatId: null,
      chatComposerDrafts: {},
      pendingAutoSend: {},
      pendingWorkspaceValidationFolder: null,
    });
  });

  it("opens empty chats in the existing folder with the exact selected configuration", () => {
    const dispatch = useWorkspaceStore.getState().dispatch;
    const first = createDispatcherChat({
      dispatch,
      repoRoot: folder,
      folder,
      payload,
    });
    const second = createDispatcherChat({
      dispatch,
      repoRoot: folder,
      folder,
      payload,
    });
    const state = useWorkspaceStore.getState();
    expect(first).not.toBe(second);
    expect(state.chats).toHaveLength(2);
    expect(state.chats[1]).toMatchObject({
      id: second,
      folder,
      ...payload.selection,
      effort: "low",
      fast: true,
      permissionMode: "auto",
      lastModeId: "accept-edits",
      additionalDirectories: ["/projects/assets"],
    });
    expect(state.activePage).toBe("workspace");
    expect(state.activeChatId).toBe(second);
    expect(selectActiveFolder(state)).toBe(folder);
    expect(state.pendingWorkspaceValidationFolder).toBeNull();
    expect(state.pendingAutoSend).toEqual({});
    expect(state.chatComposerDrafts).toEqual({});
  });

  it("seeds text and rich draft before publishing the chat, then queues one send for its exact id", () => {
    const actions: Action[] = [];
    const serialized: NonNullable<DispatcherCreatePayload["serialized"]> = {
      isEmpty: false,
      segments: [{ type: "text", text: "Create a page" }],
      displayText: "Create a page",
      attachments: [],
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Create a page" }],
          },
        ],
      },
    };
    const id = createDispatcherChat({
      dispatch: (action) => {
        actions.push(action);
        useWorkspaceStore.getState().dispatch(action);
      },
      repoRoot: folder,
      folder,
      payload: { ...payload, serialized },
    });
    expect(actions.map((action) => action.type)).toEqual([
      "SET_CHAT_DRAFT",
      "ADD_CHAT",
      "REQUEST_AUTO_SEND",
    ]);
    const state = useWorkspaceStore.getState();
    expect(state.chatComposerDrafts[id]).toEqual({
      text: serialized.displayText,
      attachments: serialized.attachments,
      json: serialized.json,
    });
    expect(Object.keys(state.pendingAutoSend)).toEqual([id]);
    expect(state.chats[0].folder).toBe(folder);
  });

  it("keeps prepared Git worktrees pending at their reserved path", () => {
    const path = `${folder}/.worktrees/task`;
    createDispatcherChat({
      dispatch: useWorkspaceStore.getState().dispatch,
      repoRoot: folder,
      folder: path,
      payload,
      validationPending: true,
    });
    const state = useWorkspaceStore.getState();
    expect(selectActiveFolder(state)).toBe(path);
    expect(state.pendingWorkspaceValidationFolder).toBe(path);
    expect(state.lastWorkspaceByRepoRoot[folder]).toBe(path);
  });
});
