import { beforeEach, describe, expect, it, vi } from "vitest";
const workspace = vi.hoisted(() => ({
  chats: [] as Array<{ id: string; model: string | null; agentId: string }>,
  dispatch: vi.fn((action: { id: string; updates: { model: string } }) => {
    workspace.chats = workspace.chats.map((c) =>
      c.id === action.id ? { ...c, ...action.updates } : c,
    );
  }),
}));
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: { getState: () => workspace },
}));
import { BLANK, useSessionsStore } from "../sessions-store";
const note = {
  sessionId: "session",
  update: {
    sessionUpdate: "current_model_update" as const,
    model: "gpt-5.6",
    previousModel: "gpt-6",
    turnStartedAt: 100,
  },
};
describe("provider model adoption", () => {
  it("ignores the old provider while a chat is switching providers", () => {
    workspace.chats[0] = {
      ...workspace.chats[0],
      agentId: "claude",
      model: null,
    };
    useSessionsStore.getState().applyBridgeUpdate(note);
    expect(workspace.dispatch).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    workspace.chats = [
      { id: "chat", model: "gpt-6", agentId: "codex" },
      { id: "other", model: "gpt-6", agentId: "codex" },
    ];
    workspace.dispatch.mockClear();
    useSessionsStore.getState().clearAll();
    useSessionsStore.getState().setSession("chat", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session",
      appliedChatEnvKey: JSON.stringify({
        OPENAI_MODEL: "gpt-6",
        ZEROS_THINKING_EFFORT: "high",
      }),
    });
  });
  it("changes the exact chat's dropdown source and next-send stamp, once", () => {
    const store = useSessionsStore.getState();
    store.applyBridgeUpdate(note);
    store.applyBridgeUpdate(note);
    expect(workspace.chats.map((c) => c.model)).toEqual(["gpt-5.6", "gpt-6"]);
    expect(workspace.dispatch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(useSessionsStore.getState().sessions.chat.appliedChatEnvKey!),
    ).toEqual({ OPENAI_MODEL: "gpt-5.6", ZEROS_THINKING_EFFORT: "high" });
  });
  it("rejects an older execution even if the envelope points to the same chat", () => {
    useSessionsStore.getState().applyBridgeUpdate({
      ...note,
      sessionId: "old",
      chatId: "chat",
    } as typeof note);
    expect(workspace.dispatch).not.toHaveBeenCalled();
  });
  it.each([1, 9_000_000_000_000])(
    "does not undo a manual choice even with engine clock skew: %s",
    (turnStartedAt) => {
      useSessionsStore.getState().patchSession("chat", {
        modelSelectionRevision: 2,
        modelSelectionRevisionAtRequest: 1,
      });
      useSessionsStore.getState().applyBridgeUpdate({
        ...note,
        update: { ...note.update, turnStartedAt },
      });
      expect(workspace.dispatch).not.toHaveBeenCalled();
    },
  );
  it("allows a fallback after the next request adopts a manual choice", () => {
    useSessionsStore.getState().patchSession("chat", {
      modelSelectionRevision: 2,
      modelSelectionRevisionAtRequest: 2,
    });
    useSessionsStore.getState().applyBridgeUpdate(note);
    expect(workspace.chats[0].model).toBe(note.update.model);
  });
  it("updates the next-send stamp when the database snapshot won the race", () => {
    workspace.chats[0].model = note.update.model;
    useSessionsStore.getState().applyBridgeUpdate(note);
    expect(workspace.dispatch).not.toHaveBeenCalled();
    expect(
      JSON.parse(useSessionsStore.getState().sessions.chat.appliedChatEnvKey!)
        .OPENAI_MODEL,
    ).toBe(note.update.model);
  });
  it("does not overwrite a newer model from another update", () => {
    workspace.chats[0].model = "gpt-5.6-luna";
    useSessionsStore.getState().applyBridgeUpdate(note);
    expect(workspace.dispatch).not.toHaveBeenCalled();
  });
});
