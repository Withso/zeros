// Regression coverage for renderer reloads while an engine-owned prompt keeps
// running. The renderer loses its local send lock on reload, so engine activity
// must restore `streaming` and a follow-up must queue behind that remote turn.

import { beforeEach, describe, expect, it } from "vitest";

import {
  admissionRouteWithoutFlight,
  bindFailureWasSuperseded,
  bindStillOwnsSessionSlot,
  agentUpdateFlushMode,
  admissionCancellationAction,
  bumpCancelGeneration,
  cancelledQueuedMessageAction,
  cancelGeneration,
  cancelledSince,
  clearPrebindGoalSnapshotsForChat,
  composerShowsStopControl,
  detachAdmissionFlight,
  executionActorForRecovery,
  loadedSessionStatus,
  markPrebindGoalSnapshot,
  markPrebindDirty,
  promptFailureShouldRecover,
  promptFailureShouldResumeProvider,
  queuedPromptPresentation,
  providerCapabilityRefreshCanRun,
  providerCapabilityRefreshNeeded,
  providerCapabilityRefreshExecution,
  providerCapabilityRefreshStillTargetsFamily,
  queuedSendNowAction,
  queueReleaseAction,
  recoveredSessionIdentity,
  recoveryLoadLocator,
  resumeFailureInvalidatesBinding,
  sendAdmissionPark,
  shouldPreserveAdmissionPromptOnFailure,
  sendNeedsSessionRecovery,
  sendSessionRecoveryMode,
  sharedAdmissionFlightAction,
  shouldQueuePrompt,
  takePrebindGoalSnapshot,
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

describe("executionActorForRecovery", () => {
  it("retains a Design actor and exact document across every session rebuild", () => {
    expect(
      executionActorForRecovery({
        agentRole: "design",
        designDocumentId: "frame:checkout.html",
      }),
    ).toEqual({
      agentRole: "design",
      designDocumentId: "frame:checkout.html",
    });
  });

  it("lets an explicit admission replace stale actor fields", () => {
    expect(
      executionActorForRecovery(
        {
          agentRole: "design",
          designDocumentId: "frame:old.html",
        },
        { agentRole: "code" },
      ),
    ).toEqual({ agentRole: "code" });
  });
});

describe("queuedPromptPresentation", () => {
  it("presents the first admission-waiting send as an active turn", () => {
    expect(
      queuedPromptPresentation({
        reason: "admission",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe("active-turn");
  });

  it("retains the active prompt when Design protection stops admission", () => {
    expect(
      shouldPreserveAdmissionPromptOnFailure(
        "design-protection-failed",
        "active-turn",
      ),
    ).toBe(true);
    expect(
      shouldPreserveAdmissionPromptOnFailure(
        "provider-unavailable",
        "active-turn",
      ),
    ).toBe(false);
    expect(
      shouldPreserveAdmissionPromptOnFailure(
        "design-protection-failed",
        "queued-card",
      ),
    ).toBe(false);
  });

  it("keeps follow-ups and held sends in the queued card", () => {
    expect(
      queuedPromptPresentation({
        reason: "admission",
        hasLocalSend: true,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe("queued-card");
    expect(
      queuedPromptPresentation({
        reason: "busy-turn",
        hasLocalSend: false,
        hasQueuedSends: false,
        queueHeld: false,
        flushing: false,
      }),
    ).toBe("queued-card");
  });
});

describe("session reload lifecycle", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("restores an engine-active prompt as streaming instead of ready", () => {
    expect(loadedSessionStatus(true)).toBe("streaming");
    expect(loadedSessionStatus(false)).toBe("ready");
  });

  it("flushes the terminal turn boundary with all preceding content", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(agentUpdateFlushMode({ sessionUpdate: "turn_state", state })).toBe(
        "turn-boundary",
      );
    }
    expect(
      agentUpdateFlushMode({
        sessionUpdate: "turn_state",
        state: "running",
      }),
    ).toBe("frame");
    expect(agentUpdateFlushMode({ sessionUpdate: "agent_message_chunk" })).toBe(
      "frame",
    );
  });

  it("reloads only an idle native Codex or Claude execution for a boot-scoped capability", () => {
    const nativeBinding = {
      version: 1 as const,
      providerId: "codex-app-server",
      kind: "native" as const,
      resumeId: "thread-durable",
    };
    const candidate = {
      providerFamily: "codex",
      agentId: "codex-app-server",
      executionId: "execution-current",
      sessionId: "execution-current",
      providerBinding: nativeBinding,
    };

    expect(providerCapabilityRefreshExecution(candidate)).toBe(
      "execution-current",
    );
    expect(
      providerCapabilityRefreshExecution({
        providerFamily: "claude",
        agentId: "claude-agent-sdk",
        executionId: "execution-claude",
        sessionId: "execution-claude",
        providerBinding: {
          ...nativeBinding,
          providerId: "claude-agent-sdk",
        },
      }),
    ).toBe("execution-claude");
    expect(
      providerCapabilityRefreshExecution({
        ...candidate,
        providerFamily: "cursor",
      }),
    ).toBeNull();
    expect(
      providerCapabilityRefreshExecution({
        ...candidate,
        providerBinding: { ...nativeBinding, kind: "legacy" },
      }),
    ).toBeNull();
    expect(
      providerCapabilityRefreshExecution({
        ...candidate,
        providerBinding: {
          ...nativeBinding,
          providerId: "different-codex-adapter",
        },
      }),
    ).toBeNull();

    expect(
      providerCapabilityRefreshCanRun({
        status: "ready",
        running: false,
        queuedCount: 0,
      }),
    ).toBe(true);
    expect(
      providerCapabilityRefreshCanRun({
        status: "streaming",
        running: true,
        queuedCount: 0,
      }),
    ).toBe(false);
    expect(
      providerCapabilityRefreshCanRun({
        status: "ready",
        running: false,
        queuedCount: 1,
      }),
    ).toBe(false);
  });

  it("refreshes Claude for either Browser toggle edge and Codex only when enabling", () => {
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "claude",
        previousEnabled: false,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "claude",
        previousEnabled: true,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "codex",
        previousEnabled: false,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "codex",
        previousEnabled: true,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "cursor",
        previousEnabled: false,
        enabled: true,
      }),
    ).toBe(false);
    expect(
      providerCapabilityRefreshNeeded({
        providerFamily: "claude",
        previousEnabled: null,
        enabled: true,
      }),
    ).toBe(false);
  });

  it("drops a queued browser refresh after the chat switches provider families", () => {
    expect(
      providerCapabilityRefreshStillTargetsFamily({
        requestedFamily: "claude",
        currentFamily: "claude",
      }),
    ).toBe(true);
    expect(
      providerCapabilityRefreshStillTargetsFamily({
        requestedFamily: "claude",
        currentFamily: "codex",
      }),
    ).toBe(false);
    expect(
      providerCapabilityRefreshStillTargetsFamily({
        requestedFamily: "codex",
        currentFamily: "cursor",
      }),
    ).toBe(false);
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

  it("upgrades a real admission that shared an adopt-only probe which missed", () => {
    expect(
      sharedAdmissionFlightAction({
        activeAdoptOnly: true,
        requestedAdoptOnly: false,
        hasLiveSession: false,
      }),
    ).toBe("retry");
    expect(
      sharedAdmissionFlightAction({
        activeAdoptOnly: true,
        requestedAdoptOnly: false,
        hasLiveSession: true,
      }),
    ).toBe("reuse");
    expect(
      sharedAdmissionFlightAction({
        activeAdoptOnly: true,
        requestedAdoptOnly: true,
        hasLiveSession: false,
      }),
    ).toBe("reuse");
  });

  it("rejects stale bind callbacks after close or a replacement execution", () => {
    expect(
      bindStillOwnsSessionSlot({
        cancelled: true,
        expectedExecutionId: "old-execution",
        slotExecutionId: "old-execution",
      }),
    ).toBe(false);
    expect(
      bindStillOwnsSessionSlot({
        cancelled: false,
        expectedExecutionId: "old-execution",
        slotExecutionId: "new-execution",
      }),
    ).toBe(false);
    expect(
      bindStillOwnsSessionSlot({
        cancelled: false,
        expectedExecutionId: "current-execution",
        slotExecutionId: "current-execution",
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
    expect(queuedSendNowAction({ status: "ready", hasLocalSend: false })).toBe(
      "flush",
    );
    expect(queuedSendNowAction({ status: "warming", hasLocalSend: true })).toBe(
      "wait",
    );
    expect(queuedSendNowAction({ status: "ready", hasLocalSend: true })).toBe(
      "wait",
    );
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

  it("keeps the original send time when a later running acknowledgement arrives", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "cursor",
      sessionId: "session-1",
      status: "streaming",
      // The optimistic user bubble starts the timer immediately on Send.
      activeTurnStartedAt: 1_000,
    });

    // Cursor can take several seconds to create its provider session. The
    // engine's later acknowledgement must not restart the already-visible
    // timer from this newer timestamp.
    store.applyBridgeUpdate(
      turnState("session-1", "running", { startedAt: 5_000 }),
    );

    expect(
      useSessionsStore.getState().sessions["chat-1"]?.activeTurnStartedAt,
    ).toBe(1_000);
  });

  it("adopts the engine start time when no local send timestamp survived", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "cursor",
      sessionId: "session-1",
      status: "streaming",
      activeTurnStartedAt: null,
    });

    store.applyBridgeUpdate(
      turnState("session-1", "running", { startedAt: 5_000 }),
    );

    expect(
      useSessionsStore.getState().sessions["chat-1"]?.activeTurnStartedAt,
    ).toBe(5_000);
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

  it("detaches only the exact current provider binding", () => {
    const store = useSessionsStore.getState();
    const currentBinding = {
      version: 1 as const,
      providerId: "codex",
      kind: "native" as const,
      resumeId: "thread-current",
      scopeId: "session-tree",
    };
    store.setSession("chat-1", {
      ...BLANK,
      agentId: "codex",
      executionId: "execution-current",
      sessionId: "execution-current",
      providerBinding: currentBinding,
      providerMetadata: {
        version: 1,
        git: { sha: "legacy", branch: "legacy", originUrl: null },
      },
    });

    store.applyBridgeUpdate({
      executionId: "execution-current",
      sessionId: "execution-current",
      chatId: "chat-1",
      update: {
        sessionUpdate: "provider_binding_detached",
        providerBinding: { ...currentBinding, resumeId: "thread-stale" },
        reason: "provider_deleted",
      },
    } as SessionNotification);
    expect(
      useSessionsStore.getState().sessions["chat-1"]?.providerBinding,
    ).toEqual(currentBinding);

    store.applyBridgeUpdate({
      executionId: "execution-current",
      sessionId: "execution-current",
      chatId: "chat-1",
      update: {
        sessionUpdate: "provider_binding_detached",
        providerBinding: currentBinding,
        reason: "provider_deleted",
      },
    } as SessionNotification);
    expect(
      useSessionsStore.getState().sessions["chat-1"]?.providerBinding,
    ).toBeNull();
    expect(
      useSessionsStore.getState().sessions["chat-1"]?.providerMetadata,
    ).toBeNull();
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

  it("replays an early goal snapshot only into its exact execution", () => {
    const goals = new Map();
    const goal = {
      objective: "Ship the renderer fix",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 4,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    markPrebindGoalSnapshot(goals, "chat-1", "old-session", goal);

    expect(
      takePrebindGoalSnapshot(goals, "chat-1", "new-session"),
    ).toBeUndefined();
    expect(takePrebindGoalSnapshot(goals, "chat-1", "old-session")).toEqual(
      goal,
    );
  });

  it("retains null goal clears and bounds pre-bind goal snapshots", () => {
    const goals = new Map();
    markPrebindGoalSnapshot(goals, "chat-1", "session-1", null, 2);
    markPrebindGoalSnapshot(goals, "chat-2", "session-2", null, 2);
    markPrebindGoalSnapshot(goals, "chat-3", "session-3", null, 2);

    expect(goals.size).toBe(2);
    expect(
      takePrebindGoalSnapshot(goals, "chat-1", "session-1"),
    ).toBeUndefined();
    expect(takePrebindGoalSnapshot(goals, "chat-2", "session-2")).toBeNull();

    clearPrebindGoalSnapshotsForChat(goals, "chat-3");
    expect(goals.size).toBe(0);
  });
});

// A send is not atomic: it can await a session rebuild, a settings-drift
// respawn, or a resume-and-retry before its AGENT_PROMPT reaches the engine —
// with the composer showing Stop the whole time. A Stop in that window used to
// be addressed at a session with no live turn (or no session at all), so the
// pending prompt went out anyway and the agent started working on the turn the
// user had just stopped.
describe("stopping a send that has not gone out yet", () => {
  it("shows Stop while the first prompt waits for ZSR admission", () => {
    expect(
      composerShowsStopControl({
        status: "warming",
        hasPendingLocalTurn: true,
        planReview: false,
      }),
    ).toBe(true);
    expect(
      composerShowsStopControl({
        status: "warming",
        hasPendingLocalTurn: false,
        planReview: false,
      }),
    ).toBe(false);
    expect(
      composerShowsStopControl({
        status: "streaming",
        hasPendingLocalTurn: false,
        planReview: false,
      }),
    ).toBe(true);
    expect(
      composerShowsStopControl({
        status: "warming",
        hasPendingLocalTurn: true,
        planReview: true,
      }),
    ).toBe(false);
  });

  it("aborts chat-scoped preparation before a provider session exists", () => {
    expect(
      admissionCancellationAction({
        hasAgent: true,
        hasSession: false,
        status: "warming",
        admissionInFlight: true,
      }),
    ).toBe("abort-admission");
    expect(
      admissionCancellationAction({
        hasAgent: true,
        hasSession: true,
        status: "warming",
        admissionInFlight: true,
      }),
    ).toBe("cancel-session");
    expect(
      admissionCancellationAction({
        hasAgent: false,
        hasSession: false,
        status: "idle",
        admissionInFlight: false,
      }),
    ).toBe("local-only");
  });

  it("detaches a cancelled preparation so the next prompt owns a fresh flight", () => {
    const oldFlight = Promise.resolve();
    const nextFlight = Promise.resolve();
    const flights = new Map<string, Promise<void>>([["chat-1", oldFlight]]);
    const keys = new Map([["chat-1", "resume:old"]]);
    const adoptOnly = new Map([["chat-1", true]]);

    expect(detachAdmissionFlight("chat-1", flights, keys, adoptOnly)).toBe(
      true,
    );
    expect(flights.has("chat-1")).toBe(false);
    expect(keys.has("chat-1")).toBe(false);
    expect(adoptOnly.has("chat-1")).toBe(false);
    expect(
      admissionRouteWithoutFlight({
        force: false,
        replaceProviderConversation: false,
        hasProviderBinding: true,
        canLoad: true,
      }),
    ).toBe("resume");

    flights.set("chat-1", nextFlight);
    // The old flight's identity-checked finalizer cannot erase the retry.
    if (flights.get("chat-1") === oldFlight) flights.delete("chat-1");
    expect(flights.get("chat-1")).toBe(nextFlight);
  });

  it("restarts through a durable provider binding during forced configuration recovery", () => {
    expect(
      admissionRouteWithoutFlight({
        force: true,
        replaceProviderConversation: false,
        hasProviderBinding: true,
        canLoad: true,
      }),
    ).toBe("restart");
    expect(
      admissionRouteWithoutFlight({
        force: true,
        replaceProviderConversation: false,
        hasProviderBinding: false,
        canLoad: true,
      }),
    ).toBe("create");
    expect(
      admissionRouteWithoutFlight({
        force: true,
        replaceProviderConversation: false,
        hasProviderBinding: true,
        canLoad: false,
      }),
    ).toBe("create");
    expect(
      admissionRouteWithoutFlight({
        force: true,
        replaceProviderConversation: true,
        hasProviderBinding: true,
        canLoad: true,
      }),
    ).toBe("create");
  });

  it("keeps the visible admission prompt as the stopped turn and drops only follow-ups", () => {
    expect(cancelledQueuedMessageAction("active-turn")).toBe(
      "preserve-as-turn",
    );
    expect(cancelledQueuedMessageAction("queued-card")).toBe("drop");
    expect(cancelledQueuedMessageAction(undefined)).toBe("drop");
  });

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
      boundary: null,
      boundaryPorts: null,
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

  it("blocks a send only for a chat whose last spawn ended badly", () => {
    // Nothing in flight and nothing broken: the message is accepted instantly
    // and the session builds behind it (§5.0).
    expect(sendSessionRecoveryMode("idle")).toBe("park");
    expect(sendSessionRecoveryMode("reconnecting")).toBe("park");
    // An explicit retry after fixing something: the failure belongs on the send.
    expect(sendSessionRecoveryMode("failed")).toBe("await");
    expect(sendSessionRecoveryMode("auth-required")).toBe("await");
    // Already live or already warming: shouldQueuePrompt owns these.
    expect(sendSessionRecoveryMode("ready")).toBe("none");
    expect(sendSessionRecoveryMode("warming")).toBe("none");
    expect(sendSessionRecoveryMode("streaming")).toBe("none");
  });

  it("parks a send behind a session that is only just starting", () => {
    // The pairing that makes §5.0 work: ensureSession publishes `warming`
    // synchronously, and a warming chat queues rather than blocking.
    expect(sendSessionRecoveryMode("idle")).toBe("park");
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

  it("parks any send that still needs an admission before it can dispatch", () => {
    // The invisible-first-send bug: a send into a chat whose session hadn't
    // been minted yet fell into the turn body and awaited the FULL admission
    // with the composer already cleared and no bubble anywhere — while the
    // SECOND send (queued behind the first's local lock) rendered instantly.
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: false,
        status: "idle",
        appliedChatEnvKey: undefined,
        expectedEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
      }),
    ).toBe("session-build");
    // Ready-but-sessionless (a razor-thin exit race) parks the same way.
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: false,
        status: "ready",
        appliedChatEnvKey: undefined,
        expectedEnvKey: undefined,
      }),
    ).toBe("session-build");
    // A live session whose recorded env stamp no longer matches the pills
    // needs a force-respawn — also an admission, also parked.
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: true,
        status: "ready",
        appliedChatEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
        expectedEnvKey: '{"OPENAI_MODEL":"gpt-5.6-sol"}',
      }),
    ).toBe("drift-respawn");
    // Matching stamp, unstamped legacy slot, or no thread env: dispatch now.
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: true,
        status: "ready",
        appliedChatEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
        expectedEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
      }),
    ).toBeNull();
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: true,
        status: "ready",
        appliedChatEnvKey: undefined,
        expectedEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
      }),
    ).toBeNull();
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: true,
        status: "ready",
        appliedChatEnvKey: '{"OPENAI_MODEL":"gpt-5.6-luna"}',
        expectedEnvKey: undefined,
      }),
    ).toBeNull();
    // A streaming turn or an agentless chat is never parked here — the queue
    // branch and the turn body's own guards own those.
    expect(
      sendAdmissionPark({
        hasAgent: true,
        hasSession: false,
        status: "streaming",
        appliedChatEnvKey: undefined,
        expectedEnvKey: undefined,
      }),
    ).toBeNull();
    expect(
      sendAdmissionPark({
        hasAgent: false,
        hasSession: false,
        status: "idle",
        appliedChatEnvKey: undefined,
        expectedEnvKey: undefined,
      }),
    ).toBeNull();
  });

  it("forgets a binding only when the provider confirms it expired", () => {
    expect(
      resumeFailureInvalidatesBinding({
        kind: "session-expired",
        message: "thread not found",
        stage: "loadSession",
      }),
    ).toBe(true);
    expect(
      resumeFailureInvalidatesBinding({
        kind: "auth-required",
        message: "sign in",
        stage: "loadSession",
      }),
    ).toBe(false);
    expect(
      resumeFailureInvalidatesBinding({
        kind: "transport-closed",
        message: "engine restarted",
        stage: "loadSession",
      }),
    ).toBe(false);
  });

  it("treats a superseded bind as a harmless lifecycle race", () => {
    const failure = {
      kind: "lifecycle-superseded" as const,
      message: "A newer bind owns this conversation.",
      stage: "loadSession" as const,
    };

    expect(bindFailureWasSuperseded(failure)).toBe(true);
    expect(resumeFailureInvalidatesBinding(failure)).toBe(false);

    const legacyEngineFailure = {
      kind: "session-expired" as const,
      message:
        "The conversation was closed or superseded while its agent session was starting.",
      stage: "loadSession" as const,
    };
    expect(bindFailureWasSuperseded(legacyEngineFailure)).toBe(true);
    expect(resumeFailureInvalidatesBinding(legacyEngineFailure)).toBe(false);
  });

  it("silently rebinds a prompt interrupted by a territory restart without treating binds as retryable", () => {
    const promptFailure = {
      kind: "lifecycle-superseded" as const,
      message: "Design territory changed while the prompt was starting.",
      stage: "prompt" as const,
    };
    const bindFailure = { ...promptFailure, stage: "loadSession" as const };

    expect(promptFailureShouldRecover(promptFailure)).toBe(true);
    expect(promptFailureShouldResumeProvider(promptFailure)).toBe(true);
    expect(promptFailureShouldRecover(bindFailure)).toBe(false);
    expect(promptFailureShouldResumeProvider(bindFailure)).toBe(false);
    expect(
      promptFailureShouldResumeProvider({
        kind: "session-expired",
        message: "thread not found",
        stage: "prompt",
      }),
    ).toBe(true);
    expect(
      promptFailureShouldResumeProvider({
        kind: "transport-closed",
        message: "connection reset",
        stage: "prompt",
      }),
    ).toBe(false);
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
