import { beforeEach, expect, it } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

/** Team sharing slice C: the running turn's person, as its worker named it; nobody once it ends. */
const store = () => useSessionsStore.getState();
const ALEX = "44444444-4444-4444-8444-444444444444";
beforeEach(() => { store().clearAll(); });
const turn = (state: "running" | "completed", extra: Record<string, unknown> = {}) => store().applyBridgeUpdate({ sessionId: "conversation:chat-a",
  update: { sessionUpdate: "turn_state", turnId: "user-1", state, startedAt: 1_000, ...extra } } as SessionNotification);

it("keeps the running turn's person and clears it when the turn ends", () => {
  store().setSession("chat-a", { ...BLANK, agentId: "claude", sessionId: "conversation:chat-a", status: "ready" });
  turn("running", { actingUserId: ALEX });
  expect(store().sessions["chat-a"]).toMatchObject({ status: "streaming", actingUserId: ALEX });
  turn("completed");
  expect(store().sessions["chat-a"]!.actingUserId).toBeNull();
});

it("names nobody for a running turn without a person", () => {
  store().setSession("chat-a", { ...BLANK, agentId: "claude", sessionId: "conversation:chat-a", status: "ready", actingUserId: ALEX });
  turn("running");
  expect(store().sessions["chat-a"]!.actingUserId).toBeNull();
});
