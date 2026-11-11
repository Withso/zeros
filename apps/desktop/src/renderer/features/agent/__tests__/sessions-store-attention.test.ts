import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "../../../platform/bridge/agent-events";
import { BLANK, setAttentionHandler, useSessionsStore } from "../sessions-store";

const attention = { sessionUpdate: "attention", notificationId: "0f0e0d0c-0b0a-4908-8706-050403020100", kind: "review", title: "Ready", message: "Done." };
describe("NotifyUser's attention update in the sessions store", () => {
  beforeEach(() => { useSessionsStore.getState().setSession("chat-a", { ...BLANK, agentId: "codex", sessionId: "session-a", status: "ready" }); });
  afterEach(() => setAttentionHandler(null));

  it("goes to the attention handler with its chat, and never into the transcript", () => {
    const seen: Array<[string, unknown]> = [];
    setAttentionHandler((chatId, update) => { seen.push([chatId, update]); });
    const before = useSessionsStore.getState().sessions["chat-a"]!.messages;
    useSessionsStore.getState().applyBridgeUpdate({ sessionId: "session-a", chatId: "chat-a", update: attention } as unknown as SessionNotification);
    expect(seen).toEqual([["chat-a", attention]]);
    expect(useSessionsStore.getState().sessions["chat-a"]!.messages).toBe(before);
  });

  it("is inert without a handler, as in an older app", () => {
    const before = useSessionsStore.getState().sessions["chat-a"];
    useSessionsStore.getState().applyBridgeUpdate({ sessionId: "session-a", chatId: "chat-a", update: attention } as unknown as SessionNotification);
    expect(useSessionsStore.getState().sessions["chat-a"]).toBe(before);
  });
});
