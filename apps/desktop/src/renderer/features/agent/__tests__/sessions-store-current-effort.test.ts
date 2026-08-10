import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  chats: [
    { id: "chat-a", effort: "medium" },
    { id: "chat-b", effort: "high" },
  ] as Array<{
    id: string;
    effort: string;
    agentId?: string;
    model?: string;
  }>,
  dispatch: vi.fn(
    (action: { type: string; id: string; updates?: { effort?: string } }) => {
      if (action.type !== "UPDATE_CHAT_SETTINGS") return;
      workspace.chats = workspace.chats.map((chat) =>
        chat.id === action.id
          ? { ...chat, effort: action.updates?.effort ?? chat.effort }
          : chat,
      );
    },
  ),
}));

vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => ({ chats: workspace.chats, dispatch: workspace.dispatch }),
  },
}));

import type { SessionNotification } from "../../../platform/bridge/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";
import {
  resolveModelConfiguration,
  setModelPreference,
} from "../model-preferences";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("sessions-store current effort updates", () => {
  beforeEach(() => {
    installLocalStorage();
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

  it("moves the applied-env stamp with the adopted effort so the next send does not respawn cold", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
      appliedChatEnvKey: JSON.stringify({
        OPENAI_MODEL: "gpt-5.5-codex",
        ZEROS_THINKING_EFFORT: "medium",
      }),
    });

    store.applyBridgeUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "ultracode" },
    } as unknown as SessionNotification);

    // Byte-identical to what sendPrompt's reconcile computes for the updated
    // chat (envForChat's key order), so the drift guard stays quiet.
    expect(
      useSessionsStore.getState().sessions["chat-a"].appliedChatEnvKey,
    ).toBe(
      JSON.stringify({
        OPENAI_MODEL: "gpt-5.5-codex",
        ZEROS_THINKING_EFFORT: "ultracode",
      }),
    );
  });

  it("re-stamps ONLY the effort, so an unapplied model change still reconciles", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
      appliedChatEnvKey: JSON.stringify({
        OPENAI_MODEL: "gpt-5.5-codex",
        ZEROS_THINKING_EFFORT: "medium",
        ZEROS_FAST_MODE: "1",
      }),
    });

    store.applyBridgeUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "high" },
    } as unknown as SessionNotification);

    const stamped =
      useSessionsStore.getState().sessions["chat-a"].appliedChatEnvKey;
    expect(JSON.parse(stamped!)).toEqual({
      OPENAI_MODEL: "gpt-5.5-codex",
      ZEROS_THINKING_EFFORT: "high",
      ZEROS_FAST_MODE: "1",
    });
  });

  it("leaves an unstamped legacy slot alone (its reconcile already skips)", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
    });
    store.applyBridgeUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "xhigh" },
    } as unknown as SessionNotification);
    expect(
      useSessionsStore.getState().sessions["chat-a"].appliedChatEnvKey,
    ).toBeUndefined();
  });

  // Codex raises its own thread to native `ultra` with no user involvement (see
  // the app-server adapter's thread/settings/updated hook). The composer must
  // follow the running session, but the model's own behavior must NOT rewrite
  // the durable default every FUTURE chat on that model opens at — nor trigger
  // the settings.toml mirror that carries it to the user's file.
  it("adopts an agent-driven effort into the chat only, never the model's durable default", () => {
    setModelPreference("codex", "gpt-5.6-sol", { effort: "medium" });
    workspace.chats = [
      {
        id: "chat-a",
        effort: "medium",
        agentId: "codex",
        model: "gpt-5.6-sol",
      },
    ];
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
    });

    store.applyBridgeUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "current_effort_update", effort: "ultracode" },
    } as unknown as SessionNotification);

    expect(workspace.chats[0].effort).toBe("ultracode");
    expect(resolveModelConfiguration("codex", "gpt-5.6-sol", null)).toEqual({
      effort: "medium",
      fast: false,
    });
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
