// Regression coverage for renderer reloads while an engine-owned prompt keeps
// running. The renderer loses its local send lock on reload, so engine activity
// must restore `streaming` and a follow-up must queue behind that remote turn.

import { beforeEach, describe, expect, it } from "vitest";

import {
  loadedSessionStatus,
  markPrebindDirty,
  shouldQueuePrompt,
  takePrebindDirty,
} from "../session-reload-lifecycle";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { SessionNotification } from "../../bridge/agent-events";

const turnState = (
  sessionId: string,
  state: "running" | "completed" | "failed" | "cancelled",
  extras: Record<string, unknown> = {},
): SessionNotification =>
  ({
    sessionId,
    chatId: "chat-1",
    update: {
      sessionUpdate: "turn_state",
      turnId: "turn-1",
      state,
      startedAt: 1_234,
      ...extras,
    },
  }) as SessionNotification;

describe("session reload lifecycle", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("restores an engine-active prompt as streaming instead of ready", () => {
    expect(loadedSessionStatus(true)).toBe("streaming");
    expect(loadedSessionStatus(false)).toBe("ready");
  });

  it("queues behind an adopted prompt even though the renderer send lock was reset", () => {
    expect(
      shouldQueuePrompt({
        status: "streaming",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe(true);
  });

  it("queues a send while session loading is still resolving", () => {
    expect(
      shouldQueuePrompt({
        status: "warming",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe(true);
  });

  it("does not re-queue the flush itself or block an explicit failed-state retry", () => {
    expect(
      shouldQueuePrompt({
        status: "streaming",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: true,
      }),
    ).toBe(false);
    expect(
      shouldQueuePrompt({
        status: "failed",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe(false);
  });

  it("clears a stale failure when the engine confirms the turn is running", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-1",
      status: "failed",
      error: "Agent response failure",
      failure: {
        kind: "protocol-error",
        stage: "prompt",
        message: "Agent response failure",
      },
      lastStopReason: "end_turn",
    });

    store.applyBridgeUpdate(turnState("session-1", "running"));

    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "streaming",
      error: null,
      failure: null,
      lastStopReason: null,
    });
  });

  it("settles a re-adopted successful turn and preserves its stop reason", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-1",
      status: "streaming",
    });

    store.applyBridgeUpdate(
      turnState("session-1", "completed", { stopReason: "end_turn" }),
    );

    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "ready",
      error: null,
      failure: null,
      lastStopReason: "end_turn",
    });
  });

  it("settles an adopted failed turn without inventing a live response failure", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-1",
      status: "streaming",
    });

    store.applyBridgeUpdate(turnState("session-1", "failed"));

    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "ready",
      error: null,
      failure: null,
    });
  });

  it("rejects a stale turn-state event from a superseded session", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "new-session",
      status: "streaming",
    });

    store.applyBridgeUpdate(
      turnState("old-session", "completed", { stopReason: "end_turn" }),
    );

    expect(useSessionsStore.getState().sessions["chat-1"]?.status).toBe(
      "streaming",
    );
  });

  it("reconciles missed pre-bind output only for the exact adopted session", () => {
    const dirty = new Map<string, string>();
    markPrebindDirty(dirty, "chat-1", "old-session");

    expect(takePrebindDirty(dirty, "chat-1", "new-session")).toBe(false);
    expect(takePrebindDirty(dirty, "chat-1", "old-session")).toBe(true);
    expect(dirty.size).toBe(0);
  });

  it("bounds missed pre-bind owners and refreshes their recency", () => {
    const dirty = new Map<string, string>();
    markPrebindDirty(dirty, "chat-1", "session-1", 2);
    markPrebindDirty(dirty, "chat-2", "session-2", 2);
    markPrebindDirty(dirty, "chat-1", "session-1b", 2);
    markPrebindDirty(dirty, "chat-3", "session-3", 2);

    expect([...dirty.entries()]).toEqual([
      ["chat-1", "session-1b"],
      ["chat-3", "session-3"],
    ]);
  });
});
