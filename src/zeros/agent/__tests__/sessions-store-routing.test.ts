// Regression coverage for the "messages / tool calls disappear, only
// Switched-mode banners survive" bug. Root cause: applyBridgeUpdate routed a
// SessionNotification to a chat ONLY via the local sessionId→chatId index, so
// any event arriving on a sessionId the index didn't (yet) know was silently
// dropped — e.g. during a force-respawn (the old sessionId is de-indexed
// before the new one binds) or an ACP agent emitting before its sessionId is
// stored. Mode-switch banners survived because they're synthesized locally
// with the live sessionId. Fix: the engine stamps the authoritative chatId on
// the update and the renderer routes by it first.

import { beforeEach, describe, expect, it } from "vitest";

import { useSessionsStore, BLANK } from "../sessions-store";
import type { SessionNotification } from "../../bridge/agent-events";

// Build a notification with arbitrary extra fields (chatId) the way the bridge
// listener stamps it.
const note = (o: Record<string, unknown>): SessionNotification =>
  o as unknown as SessionNotification;

describe("applyBridgeUpdate routing — engine-authoritative chatId", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("routes by the engine-stamped chatId when the sessionId index is stale", () => {
    const s = useSessionsStore.getState();
    // Slot is bound to a NEW sessionId (index: new-sid → chatA). The engine
    // emits under a stale/old sessionId that isn't indexed — the force-respawn
    // window — but stamps the authoritative chatId.
    s.setSession("chatA", { ...BLANK, agentId: "claude", sessionId: "new-sid" });
    s.applyBridgeUpdate(
      note({
        sessionId: "stale-sid",
        chatId: "chatA",
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      }),
    );
    // Routed despite the stale index → the update landed.
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe("plan");
  });

  it("drops an update with neither a stamped chatId nor an indexed sessionId", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "new-sid",
      currentModeId: "default",
    });
    s.applyBridgeUpdate(
      note({
        sessionId: "stale-sid",
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      }),
    );
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe("default");
  });

  it("still routes by the local index when no chatId is stamped (back-compat)", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", { ...BLANK, agentId: "claude", sessionId: "live-sid" });
    s.applyBridgeUpdate(
      note({
        sessionId: "live-sid",
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      }),
    );
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe("plan");
  });
});
