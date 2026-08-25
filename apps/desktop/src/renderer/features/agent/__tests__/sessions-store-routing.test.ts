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
import type { SessionNotification } from "../../../platform/bridge/agent-events";

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
    s.setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "new-sid",
    });
    s.applyBridgeUpdate(
      note({
        sessionId: "stale-sid",
        chatId: "chatA",
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      }),
    );
    // Routed despite the stale index → the update landed.
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe(
      "plan",
    );
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
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe(
      "default",
    );
  });

  it("still routes by the local index when no chatId is stamped (back-compat)", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "live-sid",
    });
    s.applyBridgeUpdate(
      note({
        sessionId: "live-sid",
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      }),
    );
    expect(useSessionsStore.getState().sessions["chatA"]?.currentModeId).toBe(
      "plan",
    );
  });

  it("keeps goal snapshots scoped to the exact live execution", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "codex",
      executionId: "live-sid",
      sessionId: "live-sid",
    });
    const goal = {
      objective: "Finish Phase 3",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    s.applyBridgeUpdate(
      note({
        executionId: "stale-sid",
        sessionId: "stale-sid",
        chatId: "chatA",
        update: { sessionUpdate: "goal_update", goal },
      }),
    );
    expect(useSessionsStore.getState().sessions.chatA?.goal).toBeNull();

    s.applyBridgeUpdate(
      note({
        executionId: "live-sid",
        sessionId: "live-sid",
        chatId: "chatA",
        update: { sessionUpdate: "goal_update", goal },
      }),
    );
    expect(useSessionsStore.getState().sessions.chatA?.goal).toEqual(goal);
  });

  it("rejects a goal RPC snapshot after its execution is replaced", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "codex",
      executionId: "old-execution",
      sessionId: "old-execution",
    });
    const goal = {
      objective: "Belongs to the old execution",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    s.setSession("chatA", {
      ...BLANK,
      agentId: "codex",
      executionId: "new-execution",
      sessionId: "new-execution",
    });

    expect(s.applyGoalSnapshot("chatA", "old-execution", goal)).toBe(false);
    expect(useSessionsStore.getState().sessions.chatA?.goal).toBeNull();
    expect(s.applyGoalSnapshot("chatA", "new-execution", goal)).toBe(true);
    expect(useSessionsStore.getState().sessions.chatA?.goal).toEqual(goal);
  });

  it("keeps safety retry ids ephemeral and scoped to the exact execution", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "codex",
      executionId: "live-sid",
      sessionId: "live-sid",
      transcriptState: "resident",
      messages: [
        {
          id: "tool-review",
          kind: "tool",
          toolCallId: "review-tool-call",
          title: "Safety review",
          toolKind: "other",
          status: "completed",
          rawOutput: {
            zerosSafetyReview: { status: "denied", actionType: "command" },
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const retryUpdate = {
      sessionUpdate: "safety_review_retry_available",
      toolCallId: "review-tool-call",
      retryId: "opaque-retry",
    };
    s.applyBridgeUpdate(
      note({
        executionId: "stale-sid",
        sessionId: "stale-sid",
        chatId: "chatA",
        update: retryUpdate,
      }),
    );
    expect(
      useSessionsStore.getState().sessions.chatA?.safetyReviewRetries,
    ).toEqual({});

    s.applyBridgeUpdate(
      note({
        executionId: "live-sid",
        sessionId: "live-sid",
        chatId: "chatA",
        update: retryUpdate,
      }),
    );
    expect(
      useSessionsStore.getState().sessions.chatA?.safetyReviewRetries,
    ).toEqual({ "review-tool-call": "opaque-retry" });
    expect(
      JSON.stringify(useSessionsStore.getState().sessions.chatA?.messages),
    ).not.toContain("opaque-retry");

    s.applyBridgeUpdate(
      note({
        executionId: "live-sid",
        sessionId: "live-sid",
        chatId: "chatA",
        update: { ...retryUpdate, retryId: null },
      }),
    );
    expect(
      useSessionsStore.getState().sessions.chatA?.safetyReviewRetries,
    ).toEqual({});
  });
});
