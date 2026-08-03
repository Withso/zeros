import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  chats: [
    { id: "chat-a", effort: "medium" },
    { id: "chat-b", effort: "high" },
  ] as Array<{ id: string; effort: string }>,
  dispatch: vi.fn((action: {
    type: string;
    id: string;
    updates?: { effort?: string };
  }) => {
    if (action.type !== "UPDATE_CHAT_SETTINGS") return;
    workspace.chats = workspace.chats.map((chat) =>
      chat.id === action.id
        ? { ...chat, effort: action.updates?.effort ?? chat.effort }
        : chat,
    );
  }),
}));

vi.mock("../../store/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => ({ chats: workspace.chats, dispatch: workspace.dispatch }),
  },
}));

import type { SessionNotification } from "../../bridge/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";

describe("sessions-store current effort updates", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
    workspace.chats = [
      { id: "chat-a", effort: "medium" },
      { id: "chat-b", effort: "high" },
    ];
    workspace.dispatch.mockClear();
  });

  it("updates only the exact owning chat and dedupes identical notifications", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
    });
    store.setSession("chat-b", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-b",
    });
    const note = {
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "ultracode" },
    } as unknown as SessionNotification;

    store.applyBridgeUpdate(note);
    expect(workspace.dispatch).toHaveBeenCalledWith({
      type: "UPDATE_CHAT_SETTINGS",
      id: "chat-a",
      updates: { effort: "ultracode" },
    });
    expect(workspace.chats.find((chat) => chat.id === "chat-b")?.effort).toBe(
      "high",
    );

    store.applyBridgeUpdate(note);
    expect(workspace.dispatch).toHaveBeenCalledTimes(1);
  });

  it("ignores an invalid provider effort instead of corrupting chat settings", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
    });
    store.applyBridgeUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "turbo" },
    } as unknown as SessionNotification);
    expect(workspace.dispatch).not.toHaveBeenCalled();
  });
});
