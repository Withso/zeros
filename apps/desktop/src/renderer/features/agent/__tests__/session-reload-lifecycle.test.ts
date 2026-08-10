// Regression coverage for renderer reloads while an engine-owned prompt keeps
// running. The renderer loses its local send lock on reload, so engine activity
// must restore `streaming` and a follow-up must queue behind that remote turn.

import { beforeEach, describe, expect, it } from "vitest";

import {
  bumpCancelGeneration,
  cancelGeneration,
  cancelledSince,
  deferredArchiveCloseAction,
  loadedSessionStatus,
  markPrebindDirty,
  queuedSendNowAction,
  queueReleaseAction,
  recoveredSessionIdentity,
  recoveryLoadLocator,
  sendNeedsSessionRecovery,
  sessionNeedsBackgroundRetention,
  shouldQueuePrompt,
  takePrebindDirty,
} from "../session-reload-lifecycle";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

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

  it("steers a queued message into an adopted engine turn", () => {
    // A renderer reload loses sendingChatsRef, but the loaded execution remains
    // authoritative and reports status=streaming. Treating the missing local
    // lock as idle dequeues the row, calls normal sendPrompt, and then drops it
    // at sendPrompt's streaming guard without ever delivering it.
    expect(
      queuedSendNowAction({ status: "streaming", hasLocalSend: false }),
    ).toBe("steer");
  });

  it("only flushes send-now while idle and waits through preparation", () => {
    expect(
      queuedSendNowAction({ status: "ready", hasLocalSend: false }),
    ).toBe("flush");
    expect(
      queuedSendNowAction({ status: "warming", hasLocalSend: true }),
    ).toBe("wait");
    expect(
      queuedSendNowAction({ status: "ready", hasLocalSend: true }),
    ).toBe("wait");
  });

  it("retains every session resource that can still produce user-visible work", () => {
    const idle = {
      status: "ready" as const,
      hasLocalSend: false,
      hasQueuedSends: false,
      queueHeld: false,
      ensuring: false,
      pendingInteraction: false,
      hasBackgroundTasks: false,
      hasForegroundWorkflows: false,
    };
    expect(sessionNeedsBackgroundRetention(idle)).toBe(false);
    expect(
      sessionNeedsBackgroundRetention({ ...idle, status: "streaming" }),
    ).toBe(true);
    expect(
      sessionNeedsBackgroundRetention({ ...idle, hasQueuedSends: true }),
    ).toBe(true);
    expect(
      sessionNeedsBackgroundRetention({ ...idle, ensuring: true }),
    ).toBe(true);
    expect(
      sessionNeedsBackgroundRetention({ ...idle, pendingInteraction: true }),
    ).toBe(true);
    expect(
      sessionNeedsBackgroundRetention({ ...idle, hasBackgroundTasks: true }),
    ).toBe(true);
    expect(
      sessionNeedsBackgroundRetention({
        ...idle,
        hasForegroundWorkflows: true,
      }),
    ).toBe(true);
  });

  it("reaps an archived execution only after work settles and cancels on reopen", () => {
    expect(
      deferredArchiveCloseAction({
        requested: false,
        archived: true,
        hasPendingWork: false,
      }),
    ).toBe("none");
    expect(
      deferredArchiveCloseAction({
        requested: true,
        archived: true,
        hasPendingWork: true,
      }),
    ).toBe("wait");
    expect(
      deferredArchiveCloseAction({
        requested: true,
        archived: true,
        hasPendingWork: false,
      }),
    ).toBe("close");
    expect(
      deferredArchiveCloseAction({
        requested: true,
        archived: false,
        hasPendingWork: false,
      }),
    ).toBe("cancel");
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

  it("releases a queue parked behind a warm that never became ready", () => {
    // `warming` is a park reason, so every warm outcome needs a release. A warm
    // that ends unhealthy used to leave the queue parked with nothing left to
    // drain it, and the composer froze: each later send parked behind it too.
    expect(queueReleaseAction({ status: "ready", queueHeld: false })).toBe(
      "drain",
    );
    for (const status of ["failed", "auth-required", "reconnecting"] as const) {
      expect(
        queueReleaseAction({ status, queueHeld: false }),
        `for ${status}`,
      ).toBe("drop");
    }
    // A queued-message edit still owns its queue through an unhealthy settle.
    expect(queueReleaseAction({ status: "failed", queueHeld: true })).toBe(
      "hold",
    );
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

  it("a locally classified auth-required failure survives the engine's terminal turn_state", () => {
    const store = useSessionsStore.getState();
    // What sendPrompt leaves behind after AGENT_PROMPT_FAILED classifies the
    // turn. The engine's terminal turn_state for the SAME turn arrives a frame
    // later on the rAF-buffered update path, and used to wipe this clean —
    // taking the footer's Sign-in button (footerLabelForFailure reads
    // session.failure) with it.
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-1",
      status: "auth-required",
      error: "Please sign in to Claude",
      failure: {
        kind: "auth-required",
        stage: "prompt",
        message: "Please sign in to Claude",
      },
      activeTurnStartedAt: 1_234,
    });

    store.applyBridgeUpdate(turnState("session-1", "failed"));

    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "auth-required",
      error: "Please sign in to Claude",
      failure: { kind: "auth-required" },
      // Still settled: the turn is over even though its failure is preserved.
      activeTurnStartedAt: null,
    });
  });

  it("keeps a hard prompt failure visible after the turn settles", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-1",
      status: "failed",
      error: "Agent crashed",
      failure: {
        kind: "protocol-error",
        stage: "prompt",
        message: "Agent crashed",
      },
    });

    store.applyBridgeUpdate(
      turnState("session-1", "failed", { stopReason: "refusal" }),
    );

    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "failed",
      error: "Agent crashed",
      lastStopReason: "refusal",
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

  it("rejects a stale provider binding from a superseded execution", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "claude",
      executionId: "new-execution",
      sessionId: "new-execution",
      providerBinding: {
        version: 1,
        providerId: "claude",
        kind: "native",
        resumeId: "new-provider-session",
      },
    });

    store.applyBridgeUpdate({
      executionId: "old-execution",
      sessionId: "old-execution",
      chatId: "chat-1",
      update: {
        sessionUpdate: "provider_binding_update",
        providerBinding: {
          version: 1,
          providerId: "claude",
          kind: "native",
          resumeId: "old-provider-session",
        },
      },
    } as SessionNotification);

    expect(
      useSessionsStore.getState().sessions["chat-1"]?.providerBinding?.resumeId,
    ).toBe("new-provider-session");
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

// A send is not atomic: it can await a session rebuild, a settings-drift
// respawn, or a resume-and-retry before its AGENT_PROMPT reaches the engine —
// with the composer showing Stop the whole time. A Stop in that window used to
// be addressed at a session with no live turn (or no session at all), so the
// pending prompt went out anyway and the agent started working on the turn the
// user had just stopped.
describe("stopping a send that has not gone out yet", () => {
  it("marks the chat cancelled for a send captured before the stop", () => {
    const generations = new Map<string, number>();
    const sendGeneration = cancelGeneration(generations, "chat-1");

    expect(cancelledSince(generations, "chat-1", sendGeneration)).toBe(false);
    bumpCancelGeneration(generations, "chat-1");
    expect(cancelledSince(generations, "chat-1", sendGeneration)).toBe(true);
  });

  it("does not leak a stop across chats or into the next send", () => {
    const generations = new Map<string, number>();
    const firstSend = cancelGeneration(generations, "chat-1");
    bumpCancelGeneration(generations, "chat-1");
    // The NEXT send captures the post-stop generation, so the same stop must
    // not abort it too.
    const secondSend = cancelGeneration(generations, "chat-1");

    expect(cancelledSince(generations, "chat-1", firstSend)).toBe(true);
    expect(cancelledSince(generations, "chat-1", secondSend)).toBe(false);
    expect(cancelledSince(generations, "chat-2", 0)).toBe(false);
  });

  it("counts every stop, so two in a row are still both recorded", () => {
    const generations = new Map<string, number>();
    const sendGeneration = cancelGeneration(generations, "chat-1");
    bumpCancelGeneration(generations, "chat-1");
    bumpCancelGeneration(generations, "chat-1");

    expect(cancelGeneration(generations, "chat-1")).toBe(2);
    expect(cancelledSince(generations, "chat-1", sendGeneration)).toBe(true);
  });
});

// A send into a chat whose session is still spawning must not block on that
// spawn: the composer keeps the text with no bubble anywhere, so every further
// Enter re-enters and enqueues another copy of the same message (reported on
// Cursor, whose cold host boot is the slowest). shouldQueuePrompt owns that
// case — the message shows in the queued card at once and dispatches when the
// session is ready.
describe("send-time session recovery", () => {
  it("resumes through the durable provider binding and retries on the replacement execution", () => {
    const providerBinding = {
      version: 1,
      providerId: "codex",
      kind: "native",
      resumeId: "provider-thread-1",
      legacySessionId: "provider-compat-1",
    } as const;

    // The dead execution id is deliberately not an input: it must never be
    // reinterpreted as a provider resume locator after the engine restarts.
    expect(recoveryLoadLocator(providerBinding)).toEqual({
      providerBinding,
      sessionId: "provider-compat-1",
    });
    expect(recoveryLoadLocator(null)).toEqual({});

    const replacementBinding = {
      ...providerBinding,
      resumeId: "provider-thread-2",
    };
    expect(
      recoveredSessionIdentity(
        {
          executionId: "replacement-execution",
          sessionId: "replacement-execution",
          response: {
            providerBinding: replacementBinding,
            providerMetadata: { version: 1 },
          },
        },
        {
          providerBinding,
          providerMetadata: null,
        },
      ),
    ).toEqual({
      executionId: "replacement-execution",
      sessionId: "replacement-execution",
      providerBinding: replacementBinding,
      providerMetadata: { version: 1 },
    });
  });

  it("recovers only from states with nothing in flight", () => {
    expect(sendNeedsSessionRecovery("failed")).toBe(true);
    expect(sendNeedsSessionRecovery("auth-required")).toBe(true);
    expect(sendNeedsSessionRecovery("reconnecting")).toBe(true);
    expect(sendNeedsSessionRecovery("idle")).toBe(true);
    expect(sendNeedsSessionRecovery("ready")).toBe(false);
    expect(sendNeedsSessionRecovery("warming")).toBe(false);
    expect(sendNeedsSessionRecovery("streaming")).toBe(false);
  });

  it("hands a warming chat's send to the queue instead", () => {
    expect(sendNeedsSessionRecovery("warming")).toBe(false);
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
});
