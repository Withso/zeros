// Stop must stop the turn the user was looking at, and it must stay stopped
// across a reload.
//
// Three engine-side holes made a Stop lie:
//
//   1. AGENT_PROMPT cleared the session's cancel intent immediately before
//      dispatching (it could not tell a stale intent from one meant for the turn
//      it was about to run), and every adapter clears its own cancel flag as it
//      enters prompt(). A Stop clicked during the pre-dispatch window — persist
//      the user message, take the pre-snapshot, wait on the workspace barrier,
//      seconds on a large repo — was therefore dropped by BOTH: the provider ran
//      the whole turn behind a "STOPPED BY USER" pill. (Clicking Stop a second
//      time worked, which is exactly how it was reported.)
//   2. Nothing bounded how long the engine would wait for an adapter to
//      acknowledge a cancel, so a wedged run kept the accepted prompt as the
//      session's live turn for the full 45-minute staleness window.
//   3. AGENT_LOAD_SESSION re-adopted on the mere EXISTENCE of an active-prompt
//      record, answering promptActive:true with the original startedAt — so a
//      reload (or a tab switch, which reloads the session) brought the running
//      shimmer back with a timer counting from the stopped prompt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadSessionResponse } from "@zeros/protocol/agent-events";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { MessageRouter } from "../transport/router";
import type { TransportClient } from "../transport/types";

interface ActivePromptRecord {
  sessionId: string;
  agentId: string;
  chatId: string | null;
  turnId: string;
  promptId: string;
  startedAt: number;
  lastActivityAt: number;
  cancelledByUser?: boolean;
  adapterSettled?: boolean;
  turnSnapshot?: TurnSnapshotRecord | null;
  turnRowSettled?: boolean;
  terminalPublished?: boolean;
}

/** Only the field the watchdog's old id comparison read — the rest of a real
 *  TurnSnapshotContext is inert here, since finishTurn is stubbed. */
interface TurnSnapshotRecord {
  turnId: string;
}

interface TestEngineInternals {
  router: MessageRouter;
  agents: {
    ensureAgent: (...args: unknown[]) => Promise<unknown>;
    newSession: (...args: unknown[]) => Promise<unknown>;
    prompt: (...args: unknown[]) => Promise<unknown>;
    cancel: (...args: unknown[]) => Promise<void>;
    endSession: (...args: unknown[]) => Promise<void>;
    loadSession: (...args: unknown[]) => Promise<unknown>;
    retirePooledUtilityBoundaries: (...args: unknown[]) => Promise<void>;
    reopenPooledUtilityBoundaries: () => void;
  };
  setup: { stopAllAndProve: () => Promise<void> };
  runs: { stopAllAndProve: () => Promise<void> };
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
  sessionWorkspace: Map<string, string>;
  conversationExecution: Map<string, string>;
  conversationBindTokens: Map<string, number>;
  promptSessions: Set<string>;
  activePromptContexts: Map<string, ActivePromptRecord>;
  activeTurnSnapshots: Map<string, TurnSnapshotRecord>;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  agentSpawnOpts: (...args: unknown[]) => Promise<unknown>;
  finishTurn(
    ctx: TurnSnapshotRecord,
    status: string,
    stopReason: string | null,
  ): Promise<void>;
  activePromptIsLive(prompt: ActivePromptRecord): boolean;
  cancelLiveAgentSessions(sessionIds: Iterable<string>): Promise<boolean>;
  retireAllCodeAgentSessionsForTerritoryChange(): Promise<void>;
  withGlobalDesignTerritoryTransition<T>(
    mutation: () => Promise<T>,
  ): Promise<T>;
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
}

const roots: string[] = [];

function testEngine(port: number): {
  engine: ZerosEngine;
  state: TestEngineInternals;
} {
  // Own root per engine: an accepted prompt writes a busy marker under it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cancel-"));
  roots.push(root);
  const engine = new ZerosEngine({ root, port });
  return { engine, state: engine as unknown as TestEngineInternals };
}

function testClient(id = "renderer-1", kind: "local" | "cloud" = "local") {
  const messages: EngineMessage[] = [];
  const client: TransportClient = {
    id,
    kind,
    send: (message) => messages.push(message),
    close: vi.fn(),
  };
  return { client, messages };
}

function promptMessage(overrides: Partial<EngineMessage> = {}): EngineMessage {
  return {
    type: "AGENT_PROMPT",
    id: "prompt-req-1",
    source: "browser",
    timestamp: 1,
    agentId: "cursor",
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hi" }],
    userMessageId: "user-1",
    ...overrides,
  } as EngineMessage;
}

function cancelMessage(): EngineMessage {
  return {
    type: "AGENT_CANCEL",
    id: "cancel-req-1",
    source: "browser",
    timestamp: 2,
    agentId: "cursor",
    sessionId: "session-1",
  } as EngineMessage;
}

function closeMessage(agentId = "claude"): EngineMessage {
  return {
    type: "AGENT_CLOSE_SESSION",
    id: "close-req-1",
    source: "browser",
    timestamp: 3,
    agentId,
    executionId: "session-1",
    sessionId: "session-1",
    chatId: "chat-1",
  } as EngineMessage;
}

function closeConversationMessage(agentId: string): EngineMessage {
  return {
    type: "AGENT_CLOSE_SESSION",
    id: "close-conversation-1",
    source: "browser",
    timestamp: 3,
    agentId,
    chatId: "chat-1",
  } as EngineMessage;
}

function newSessionMessage(agentId: string): EngineMessage {
  return {
    type: "AGENT_NEW_SESSION",
    id: "new-session-1",
    source: "browser",
    timestamp: 1,
    agentId,
    chatId: "chat-1",
    cwd: process.cwd(),
  } as EngineMessage;
}

function turnStates(messages: EngineMessage[]): Array<{
  state?: string;
  stopReason?: string;
}> {
  return messages
    .filter((m) => m.type === "AGENT_SESSION_UPDATE")
    .map(
      (m) =>
        (m as { notification?: { update?: { sessionUpdate?: string } } })
          .notification?.update as
          | { sessionUpdate?: string; state?: string; stopReason?: string }
          | undefined,
    )
    .filter((update) => update?.sessionUpdate === "turn_state")
    .map((update) => ({
      state: update?.state,
      stopReason: update?.stopReason,
    }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prompt start time continuity", () => {
  it("publishes the original renderer send time after delayed admission", async () => {
    const { state } = testEngine(29_940);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    vi.spyOn(state.agents, "prompt").mockResolvedValue({
      stopReason: "end_turn",
    });
    const sentAt = Date.now() - 4_000;

    await state.handleMessage(
      {
        ...promptMessage(),
        startedAt: sentAt,
      } as EngineMessage,
      client,
    );

    const running = messages.find((message) => {
      if (message.type !== "AGENT_SESSION_UPDATE") return false;
      const update = (
        message as {
          notification?: {
            update?: { sessionUpdate?: string; state?: string };
          };
        }
      ).notification?.update;
      return (
        update?.sessionUpdate === "turn_state" && update.state === "running"
      );
    }) as
      | {
          notification?: {
            update?: {
              sessionUpdate?: string;
              state?: string;
              startedAt?: number;
            };
          };
        }
      | undefined;

    expect(running?.notification?.update?.startedAt).toBe(sentAt);
  });
});

describe("a Stop during the pre-dispatch window", () => {
  it("never hands the prompt to the adapter and settles the turn cancelled", async () => {
    const { state } = testEngine(29_891);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    const prompt = vi.spyOn(state.agents, "prompt");
    const cancel = vi
      .spyOn(state.agents, "cancel")
      .mockResolvedValue(undefined);

    // Do NOT await: the prompt handler is now suspended inside its preparation
    // phase (the pre-snapshot), which is where the Stop used to be swallowed.
    const inFlight = state.handleMessage(promptMessage(), client);
    expect(state.activePromptContexts.has("session-1")).toBe(true);
    await state.handleMessage(cancelMessage(), client);
    await inFlight;

    expect(prompt).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("cursor", "session-1");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_PROMPT_COMPLETE",
          stopReason: "cancelled",
        }),
      ]),
    );
    expect(turnStates(messages)).toContainEqual({
      state: "cancelled",
      stopReason: "cancelled",
    });
    // …and never announced as running, which would have dragged the shimmer +
    // elapsed timer back onto a chat the user had already stopped.
    expect(turnStates(messages)).not.toContainEqual(
      expect.objectContaining({ state: "running" }),
    );
    // Nothing left behind for a reload to re-adopt as a running turn.
    expect(state.activePromptContexts.has("session-1")).toBe(false);
    expect(state.promptSessions.has("session-1")).toBe(false);
  });

  // The dispatch this drops would have REJECTED (a cancel that tears the
  // provider down surfaces that way), and the old code recorded the resulting
  // turn as `failed` — the chat then read AGENT STOPPED for something the user
  // did deliberately, because the session-wide cancel intent had been cleared
  // one line before the dispatch.
  it("records the stop, not a failure, for the dispatch it dropped", async () => {
    const { state } = testEngine(29_892);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "claude");
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);
    // A cancel that tears the provider down surfaces as a prompt REJECTION.
    vi.spyOn(state.agents, "prompt").mockRejectedValue(
      new Error("stream closed"),
    );

    const inFlight = state.handleMessage(
      promptMessage({ agentId: "claude" }),
      client,
    );
    await state.handleMessage(cancelMessage(), client);
    await inFlight;

    // Cancelled, not failed: the user stopped it, so the durable turn row and
    // the live pill must both read STOPPED BY USER.
    expect(turnStates(messages)).toContainEqual({
      state: "cancelled",
      stopReason: "cancelled",
    });
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AGENT_PROMPT_FAILED" }),
      ]),
    );
  });

  it("keeps a Stop that lands after the adapter took the turn", async () => {
    const { state } = testEngine(29_893);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "codex");
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const prompt = vi
      .spyOn(state.agents, "prompt")
      .mockImplementation(async () => {
        await promptGate;
        // The adapter reports its own clean cancel.
        return { stopReason: "cancelled" };
      });
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);

    const inFlight = state.handleMessage(
      promptMessage({ agentId: "codex" }),
      client,
    );
    // Let the preparation phase finish so the prompt genuinely reaches the
    // adapter before the Stop — the case that already worked, kept honest.
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await state.handleMessage(cancelMessage(), client);
    releasePrompt();
    await inFlight;

    expect(turnStates(messages)).toContainEqual({
      state: "cancelled",
      stopReason: "cancelled",
    });
  });
});

describe("an adapter that never acknowledges the cancel", () => {
  it("publishes the cancelled turn itself and stops looking live", async () => {
    vi.useFakeTimers();
    const { state } = testEngine(29_894);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    // A wedged run: cancelled by the adapter's own account, but its prompt
    // promise never settles, so the engine is never told the turn ended.
    vi.spyOn(state.agents, "prompt").mockReturnValue(new Promise(() => {}));
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);

    void state.handleMessage(promptMessage(), client);
    await vi.waitFor(() =>
      expect(state.promptSessions.has("session-1")).toBe(true),
    );
    await state.handleMessage(cancelMessage(), client);
    const record = state.activePromptContexts.get("session-1")!;
    expect(record.cancelledByUser).toBe(true);
    // Before the deadline the turn is still the adapter's to finish.
    expect(state.activePromptIsLive(record)).toBe(true);

    await vi.advanceTimersByTimeAsync(15_001); // CANCEL_SETTLE_DEADLINE_MS

    expect(turnStates(messages)).toContainEqual({
      state: "cancelled",
      stopReason: "cancelled",
    });
    expect(record.terminalPublished).toBe(true);
    // …which is what keeps a reload from re-adopting it as a running turn.
    expect(state.activePromptIsLive(record)).toBe(false);
    // Nothing was recorded here (this session has no chat folder, so there is
    // no turn row), so the watchdog must NOT claim the durable half — that
    // claim is what suppresses the prompt handler's own finishTurn.
    expect(record.turnRowSettled).toBeFalsy();
  });

  // The record's turn id and the recorded snapshot's are derived SEPARATELY —
  // `turn-${msg.id}` here, the persisted user message's id there — so they
  // disagree for any client that omits userMessageId. The watchdog compared
  // them, found no match, wrote no ending, and then suppressed the prompt
  // handler's finishTurn anyway: the row stayed `running` with no endedAt, for
  // good, which is the exact symptom the deadline exists to prevent.
  it("finalizes the recorded row even when the two turn ids disagree", async () => {
    vi.useFakeTimers();
    const { state } = testEngine(29_897);
    const { client } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    vi.spyOn(state.agents, "prompt").mockReturnValue(new Promise(() => {}));
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);
    const finishTurn = vi
      .spyOn(state, "finishTurn")
      .mockResolvedValue(undefined);

    void state.handleMessage(
      promptMessage({ userMessageId: undefined }),
      client,
    );
    await vi.waitFor(() =>
      expect(state.promptSessions.has("session-1")).toBe(true),
    );
    const record = state.activePromptContexts.get("session-1")!;
    // What beginTurn records for a prompt with no userMessageId: the id of the
    // user message the engine just persisted, which is not `turn-${msg.id}`.
    const snapshot: TurnSnapshotRecord = { turnId: "user-persisted-1" };
    expect(record.turnId).not.toBe(snapshot.turnId);
    state.activeTurnSnapshots.set("session-1", snapshot);
    record.turnSnapshot = snapshot;

    await state.handleMessage(cancelMessage(), client);
    await vi.advanceTimersByTimeAsync(15_001); // CANCEL_SETTLE_DEADLINE_MS

    expect(finishTurn).toHaveBeenCalledWith(snapshot, "cancelled", "cancelled");
    expect(record.turnRowSettled).toBe(true);
    expect(state.activeTurnSnapshots.has("session-1")).toBe(false);
  });
});

describe("explicit session close during a live turn", () => {
  it.each(["claude", "codex", "cursor"])(
    "cancels a %s prompt accepted in the pre-dispatch window",
    async (agentId) => {
      const port =
        29_898 + (["claude", "codex", "cursor"].indexOf(agentId) + 1) * 10;
      const { state } = testEngine(port);
      const { client, messages } = testClient();
      state.router.register(client);
      state.sessionAgent.set("session-1", agentId);
      state.sessionChat.set("session-1", "chat-1");
      const prompt = vi.spyOn(state.agents, "prompt");
      const cancel = vi
        .spyOn(state.agents, "cancel")
        .mockResolvedValue(undefined);
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue(undefined);

      const promptFlight = state.handleMessage(
        promptMessage({ agentId }),
        client,
      );
      expect(state.activePromptContexts.has("session-1")).toBe(true);
      const closeFlight = state.handleMessage(closeMessage(agentId), client);
      await Promise.all([promptFlight, closeFlight]);

      expect(prompt).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledWith(agentId, "session-1");
      expect(endSession).toHaveBeenCalledWith(agentId, "session-1");
      expect(turnStates(messages)).toContainEqual({
        state: "cancelled",
        stopReason: "cancelled",
      });
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_CLOSED",
            requestId: "close-req-1",
            chatId: "chat-1",
          }),
        ]),
      );
    },
  );

  it.each(["claude", "codex", "cursor"])(
    "cancels and settles a %s turn before disposing its execution",
    async (agentId) => {
      const port =
        29_899 + (["claude", "codex", "cursor"].indexOf(agentId) + 1) * 10;
      const { state } = testEngine(port);
      const { client, messages } = testClient();
      state.router.register(client);
      state.sessionAgent.set("session-1", agentId);
      state.sessionChat.set("session-1", "chat-1");

      let releasePrompt!: () => void;
      const promptGate = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      const prompt = vi
        .spyOn(state.agents, "prompt")
        .mockImplementation(async () => {
          await promptGate;
          return { stopReason: "cancelled" };
        });
      const cancel = vi
        .spyOn(state.agents, "cancel")
        .mockResolvedValue(undefined);
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue(undefined);

      const promptFlight = state.handleMessage(
        promptMessage({ agentId }),
        client,
      );
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const closeFlight = state.handleMessage(closeMessage(agentId), client);

      try {
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      } finally {
        releasePrompt();
        await Promise.all([promptFlight, closeFlight]);
      }

      expect(cancel).toHaveBeenCalledWith(agentId, "session-1");
      expect(endSession).toHaveBeenCalledWith(agentId, "session-1");
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
        endSession.mock.invocationCallOrder[0],
      );
      expect(turnStates(messages)).toContainEqual({
        state: "cancelled",
        stopReason: "cancelled",
      });
      expect(state.activePromptContexts.has("session-1")).toBe(false);
      expect(state.promptSessions.has("session-1")).toBe(false);
    },
  );

  it("publishes a durable stop before disposing an unresponsive execution", async () => {
    vi.useFakeTimers();
    const { state } = testEngine(29_939);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "claude");
    state.sessionChat.set("session-1", "chat-1");
    state.conversationExecution.set("chat-1", "session-1");
    state.promptSessions.add("session-1");
    state.activePromptContexts.set("session-1", {
      sessionId: "session-1",
      agentId: "claude",
      chatId: "chat-1",
      turnId: "user-1",
      promptId: "prompt-1",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);

    const closeFlight = state.handleMessage(closeMessage("claude"), client);
    await vi.waitFor(() =>
      expect(state.agents.cancel).toHaveBeenCalledTimes(1),
    );
    // The adapter never removes its active-prompt record. The lifecycle's
    // bounded settle window must still make the stopped outcome authoritative
    // before provider disposal and before a restored chat is allowed to bind.
    await vi.advanceTimersByTimeAsync(3_100);
    await closeFlight;

    expect(turnStates(messages)).toContainEqual({
      state: "cancelled",
      stopReason: "cancelled",
    });
    expect(state.activePromptContexts.get("session-1")?.terminalPublished).toBe(
      true,
    );
    expect(endSession).toHaveBeenCalledWith("claude", "session-1");
  });

  it("retries disposal for an explicit local route after routing maps were lost", async () => {
    const { state } = testEngine(29_938);
    const { client, messages } = testClient();
    state.router.register(client);
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);

    await state.handleMessage(closeMessage("codex"), client);

    expect(endSession).toHaveBeenCalledWith("codex", "session-1");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_CLOSED",
          requestId: "close-req-1",
        }),
      ]),
    );
  });
});

describe("tab close while a provider session is still binding", () => {
  it.each(["codex", "claude", "cursor"])(
    "aborts %s admission and lets the next prompt start a fresh bind immediately",
    async (agentId) => {
      const port = 30_031 + ["codex", "claude", "cursor"].indexOf(agentId);
      const { state } = testEngine(port);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstAdmissionSignal: AbortSignal | undefined;
      const newSession = vi
        .spyOn(state.agents, "newSession")
        .mockImplementationOnce(async (_requestedAgentId, options) => {
          firstAdmissionSignal = (options as { admissionSignal?: AbortSignal })
            .admissionSignal;
          await firstGate;
          return {
            executionId: `${agentId}-cancelled-late-execution`,
            sessionId: `${agentId}-cancelled-late-execution`,
          };
        })
        .mockResolvedValueOnce({
          executionId: `${agentId}-retry-execution`,
          sessionId: `${agentId}-retry-execution`,
        });
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue(undefined);

      const first = state.handleMessage(newSessionMessage(agentId), client);
      await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));

      await state.handleMessage(closeConversationMessage(agentId), client);
      expect(firstAdmissionSignal?.aborted).toBe(true);
      const retry = state.handleMessage(
        {
          ...newSessionMessage(agentId),
          id: `new-session-retry-${agentId}`,
        } as EngineMessage,
        client,
      );

      // The second bind must enter the gateway while the cancelled provider
      // startup is still unresolved. Waiting for `firstGate` here would put
      // the user's next prompt back behind the ZSR/provider work they stopped.
      await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));
      await retry;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_CREATED",
            requestId: `new-session-retry-${agentId}`,
            session: expect.objectContaining({
              executionId: `${agentId}-retry-execution`,
            }),
          }),
        ]),
      );

      releaseFirst();
      await first;
      expect(endSession).toHaveBeenCalledWith(
        agentId,
        `${agentId}-cancelled-late-execution`,
      );
      expect(
        messages.filter(
          (message) =>
            message.type === "AGENT_SESSION_CREATED" &&
            message.session.executionId ===
              `${agentId}-cancelled-late-execution`,
        ),
      ).toEqual([]);
    },
  );

  it.each(["codex", "claude", "cursor"])(
    "does not queue native %s creation behind a registered Design territory update",
    async (agentId) => {
      const { state } = testEngine(30_025);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
      const newSession = vi
        .spyOn(state.agents, "newSession")
        .mockResolvedValue({
          executionId: `queued-${agentId}-execution`,
          sessionId: `queued-${agentId}-execution`,
        });
      vi.spyOn(
        state.agents,
        "retirePooledUtilityBoundaries",
      ).mockResolvedValue();
      vi.spyOn(
        state.agents,
        "reopenPooledUtilityBoundaries",
      ).mockImplementation(() => {});
      vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(
        state,
        "retireAllCodeAgentSessionsForTerritoryChange",
      ).mockResolvedValue();
      let releaseTransition!: () => void;
      let transitionEntered!: () => void;
      const transitionReady = new Promise<void>((resolve) => {
        transitionEntered = resolve;
      });
      const transitionBlocked = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      const transition = state.withGlobalDesignTerritoryTransition(async () => {
        transitionEntered();
        await transitionBlocked;
      });
      await transitionReady;

      const start = state.handleMessage(newSessionMessage(agentId), client);
      await vi.waitFor(() => expect(newSession).toHaveBeenCalledOnce());
      await start;
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_ERROR",
            message: expect.stringMatching(/registered Design territory/i),
          }),
        ]),
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_CREATED",
            session: expect.objectContaining({
              executionId: `queued-${agentId}-execution`,
            }),
          }),
        ]),
      );
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_ERROR" }),
        ]),
      );
      releaseTransition();
      await transition;
    },
  );

  it.each(["codex", "claude", "cursor"])(
    "does not queue native %s resume behind a registered Design territory update",
    async (agentId) => {
      const { state } = testEngine(30_027);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      const providerBinding = {
        version: 1 as const,
        providerId: agentId,
        kind: "native" as const,
        resumeId: `${agentId}-thread-queued`,
      };
      const loadSession = vi
        .spyOn(state.agents, "loadSession")
        .mockResolvedValue({
          executionId: `queued-${agentId}-resume`,
          providerBinding,
        });
      vi.spyOn(
        state.agents,
        "retirePooledUtilityBoundaries",
      ).mockResolvedValue();
      vi.spyOn(
        state.agents,
        "reopenPooledUtilityBoundaries",
      ).mockImplementation(() => {});
      vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(
        state,
        "retireAllCodeAgentSessionsForTerritoryChange",
      ).mockResolvedValue();
      let releaseTransition!: () => void;
      let transitionEntered!: () => void;
      const transitionReady = new Promise<void>((resolve) => {
        transitionEntered = resolve;
      });
      const transitionBlocked = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      const transition = state.withGlobalDesignTerritoryTransition(async () => {
        transitionEntered();
        await transitionBlocked;
      });
      await transitionReady;

      const resume = state.handleMessage(
        {
          type: "AGENT_LOAD_SESSION",
          id: `load-queued-${agentId}`,
          source: "browser",
          timestamp: 1,
          agentId,
          chatId: "chat-1",
          providerBinding,
        } as EngineMessage,
        client,
      );
      await vi.waitFor(() => expect(loadSession).toHaveBeenCalledOnce());
      await resume;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_LOADED",
            executionId: `queued-${agentId}-resume`,
          }),
        ]),
      );
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_ERROR" }),
        ]),
      );
      releaseTransition();
      await transition;
    },
  );

  it.each(["codex", "claude", "cursor"])(
    "keeps native %s creation alive when a Design territory update overlaps admission",
    async (agentId) => {
      const { state } = testEngine(30_026);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const newSession = vi
        .spyOn(state.agents, "newSession")
        .mockImplementation(async () => {
          await firstBlocked;
          return {
            executionId: `native-${agentId}-execution`,
            sessionId: `native-${agentId}-execution`,
          };
        });
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue();
      vi.spyOn(
        state.agents,
        "retirePooledUtilityBoundaries",
      ).mockResolvedValue();
      vi.spyOn(
        state.agents,
        "reopenPooledUtilityBoundaries",
      ).mockImplementation(() => {});
      vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(
        state,
        "retireAllCodeAgentSessionsForTerritoryChange",
      ).mockResolvedValue();

      const start = state.handleMessage(newSessionMessage(agentId), client);
      await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
      const transition = state.withGlobalDesignTerritoryTransition(
        async () => {},
      );
      releaseFirst();
      await Promise.all([transition, start]);

      expect(newSession).toHaveBeenCalledOnce();
      expect(endSession).not.toHaveBeenCalled();
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_CREATED",
            session: expect.objectContaining({
              executionId: `native-${agentId}-execution`,
            }),
          }),
        ]),
      );
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_ERROR" }),
        ]),
      );
    },
  );

  it.each(["codex", "claude", "cursor"])(
    "keeps native %s prompts running while Design territory is changing",
    async (agentId) => {
      const { state } = testEngine(30_028);
      const { client, messages } = testClient();
      state.router.register(client);
      state.sessionAgent.set("session-1", agentId);
      state.sessionChat.set("session-1", "chat-1");
      const prompt = vi.spyOn(state.agents, "prompt").mockResolvedValue({});
      vi.spyOn(
        state.agents,
        "retirePooledUtilityBoundaries",
      ).mockResolvedValue();
      vi.spyOn(
        state.agents,
        "reopenPooledUtilityBoundaries",
      ).mockImplementation(() => {});
      vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(
        state,
        "retireAllCodeAgentSessionsForTerritoryChange",
      ).mockResolvedValue();
      let releaseTransition!: () => void;
      let transitionEntered!: () => void;
      const transitionReady = new Promise<void>((resolve) => {
        transitionEntered = resolve;
      });
      const transitionBlocked = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      const transition = state.withGlobalDesignTerritoryTransition(async () => {
        transitionEntered();
        await transitionBlocked;
      });
      await transitionReady;

      await state.handleMessage(
        promptMessage({ agentId, sessionId: "session-1" }),
        client,
      );

      expect(prompt).toHaveBeenCalledWith(
        agentId,
        "session-1",
        [{ type: "text", text: "hi" }],
        "user-1",
      );
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_PROMPT_FAILED" }),
        ]),
      );
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_ERROR" }),
        ]),
      );

      releaseTransition();
      await transition;
    },
  );

  it.each(["codex", "claude", "cursor"])(
    "never resurrects a revoked %s execution from a stale renderer prompt",
    async (agentId) => {
      const { state } = testEngine(30_029);
      const { client, messages } = testClient();
      state.router.register(client);
      // This is the partial map left by the old territory-retirement path in
      // the attached logs: the chat still named an execution, but the gateway
      // had already revoked its live route.
      state.sessionChat.set("session-1", "chat-1");
      state.conversationExecution.set("chat-1", "session-1");
      const prompt = vi.spyOn(state.agents, "prompt").mockResolvedValue({});

      await state.handleMessage(
        promptMessage({ agentId, sessionId: "session-1" }),
        client,
      );

      expect(prompt).not.toHaveBeenCalled();
      expect(state.sessionAgent.has("session-1")).toBe(false);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_PROMPT_FAILED",
            failure: expect.objectContaining({
              kind: "session-expired",
              stage: "prompt",
            }),
          }),
        ]),
      );
    },
  );

  it("preserves a deleted-workspace tombstone when refusing its stale prompt", async () => {
    const { state } = testEngine(30_030);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionChat.set("session-1", "chat-1");
    // Workspace cleanup deliberately keeps this managed-owner tombstone after
    // disposing the provider. It is what makes a late execution-only message
    // fail closed even after the workspace row itself is gone.
    state.sessionWorkspace.set("session-1", "ws_deleted");
    const prompt = vi.spyOn(state.agents, "prompt").mockResolvedValue({});

    await state.handleMessage(
      promptMessage({ agentId: "claude", sessionId: "session-1" }),
      client,
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(state.sessionWorkspace.get("session-1")).toBe("ws_deleted");
    expect(state.sessionChat.get("session-1")).toBe("chat-1");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_ERROR",
          message: expect.stringMatching(/workspace no longer exists/i),
        }),
      ]),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AGENT_PROMPT_FAILED" }),
      ]),
    );
  });

  it("refuses a conversation-only close from a remote-restricted workspace", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-close-auth-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    try {
      const db = openZerosDb();
      db.prepare(
        `INSERT INTO chats (id, folder, agent_id, title, workspace_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("chat-1", process.cwd(), "claude", "Private chat", "private-ws");
      db.prepare(
        `INSERT INTO remote_restricted_workspaces (workspace_id) VALUES (?)`,
      ).run("private-ws");

      const { state } = testEngine(30_023);
      const { client, messages } = testClient("relay-1", "cloud");
      state.router.register(client);
      // This models create/load awaiting the provider: there is a conversation
      // bind token, but no execution route for the ordinary session guard yet.
      state.conversationBindTokens.set("chat-1", 41);

      await state.handleMessage(closeConversationMessage("claude"), client);

      expect(messages).toEqual([
        expect.objectContaining({
          type: "AGENT_ERROR",
          code: "SESSION_RESTRICTED",
        }),
      ]);
      expect(state.conversationBindTokens.get("chat-1")).toBe(41);
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it.each(["claude", "codex", "cursor"])(
    "disposes a late %s execution instead of publishing an orphan route",
    async (agentId) => {
      const port =
        29_940 + (["claude", "codex", "cursor"].indexOf(agentId) + 1) * 10;
      const { state } = testEngine(port);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
      let releaseSession!: () => void;
      const sessionGate = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      const newSession = vi
        .spyOn(state.agents, "newSession")
        .mockImplementation(async () => {
          await sessionGate;
          return {
            executionId: "late-execution-1",
            sessionId: "late-execution-1",
            providerBinding: {
              version: 1,
              providerId: agentId,
              kind: "native",
              resumeId: `${agentId}-provider-session-1`,
            },
          };
        });
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue(undefined);

      const startFlight = state.handleMessage(
        newSessionMessage(agentId),
        client,
      );
      await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));

      await state.handleMessage(closeConversationMessage(agentId), client);
      releaseSession();
      await startFlight;

      expect(endSession).toHaveBeenCalledWith(agentId, "late-execution-1");
      expect(state.sessionAgent.has("late-execution-1")).toBe(false);
      expect(state.sessionChat.has("late-execution-1")).toBe(false);
      expect(state.conversationExecution.has("chat-1")).toBe(false);
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_SESSION_CREATED" }),
        ]),
      );
    },
  );

  it.each(["claude", "codex", "cursor"])(
    "disposes a late %s resume instead of repopulating a closed chat",
    async (agentId) => {
      const port =
        29_980 + (["claude", "codex", "cursor"].indexOf(agentId) + 1) * 10;
      const { state } = testEngine(port);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
      let releaseLoad!: () => void;
      const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const loadSession = vi
        .spyOn(state.agents, "loadSession")
        .mockImplementation(async () => {
          await loadGate;
          return {
            executionId: "late-resume-1",
            providerBinding: {
              version: 1,
              providerId: agentId,
              kind: "native",
              resumeId: `${agentId}-provider-session-1`,
            },
          };
        });
      const endSession = vi
        .spyOn(state.agents, "endSession")
        .mockResolvedValue(undefined);

      const loadFlight = state.handleMessage(
        {
          type: "AGENT_LOAD_SESSION",
          id: "load-late-1",
          source: "browser",
          timestamp: 1,
          agentId,
          chatId: "chat-1",
          providerBinding: {
            version: 1,
            providerId: agentId,
            kind: "native",
            resumeId: `${agentId}-provider-session-1`,
          },
        } as EngineMessage,
        client,
      );
      await vi.waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));

      await state.handleMessage(closeConversationMessage(agentId), client);
      releaseLoad();
      await loadFlight;

      expect(endSession).toHaveBeenCalledWith(agentId, "late-resume-1");
      expect(state.sessionAgent.has("late-resume-1")).toBe(false);
      expect(state.conversationExecution.has("chat-1")).toBe(false);
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_SESSION_LOADED" }),
        ]),
      );
    },
  );

  it("lets only the newest create attempt publish for a conversation", async () => {
    const { state } = testEngine(30_020);
    const { client, messages } = testClient();
    state.router.register(client);
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
    vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const newSession = vi
      .spyOn(state.agents, "newSession")
      .mockImplementationOnce(async () => {
        await firstGate;
        return {
          executionId: "superseded-execution",
          sessionId: "superseded-execution",
        };
      })
      .mockImplementationOnce(async () => {
        await secondGate;
        return {
          executionId: "current-execution",
          sessionId: "current-execution",
        };
      });
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);

    const first = state.handleMessage(newSessionMessage("codex"), client);
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    const second = state.handleMessage(
      {
        ...newSessionMessage("codex"),
        id: "new-session-2",
      } as EngineMessage,
      client,
    );
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));

    releaseFirst();
    await first;
    releaseSecond();
    await second;

    expect(endSession).toHaveBeenCalledWith("codex", "superseded-execution");
    expect(state.conversationExecution.get("chat-1")).toBe("current-execution");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_ERROR",
          requestId: "new-session-1",
          code: "AGENT_LIFECYCLE_SUPERSEDED",
          failure: expect.objectContaining({
            kind: "lifecycle-superseded",
            stage: "newSession",
          }),
        }),
      ]),
    );
    expect(
      messages.filter((message) => message.type === "AGENT_SESSION_CREATED"),
    ).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          executionId: "current-execution",
        }),
      }),
    ]);
  });

  it("does not report a superseded resume as provider-session expiry", async () => {
    const { state } = testEngine(30_024);
    const { client, messages } = testClient();
    state.router.register(client);
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    vi.spyOn(state.agents, "loadSession")
      .mockImplementationOnce(async () => {
        await firstGate;
        return { executionId: "superseded-resume" };
      })
      .mockImplementationOnce(async () => {
        await secondGate;
        return { executionId: "current-resume" };
      });
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);
    const loadMessage = (id: string) =>
      ({
        type: "AGENT_LOAD_SESSION",
        id,
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        chatId: "chat-1",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "provider-thread-1",
        },
      }) as EngineMessage;

    const first = state.handleMessage(loadMessage("load-session-1"), client);
    await vi.waitFor(() =>
      expect(state.agents.loadSession).toHaveBeenCalledTimes(1),
    );
    const second = state.handleMessage(loadMessage("load-session-2"), client);
    await vi.waitFor(() =>
      expect(state.agents.loadSession).toHaveBeenCalledTimes(2),
    );

    releaseFirst();
    await first;
    releaseSecond();
    await second;

    expect(endSession).toHaveBeenCalledWith("codex", "superseded-resume");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_ERROR",
          requestId: "load-session-1",
          code: "AGENT_LIFECYCLE_SUPERSEDED",
          failure: expect.objectContaining({
            kind: "lifecycle-superseded",
            stage: "loadSession",
          }),
        }),
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          requestId: "load-session-2",
          executionId: "current-resume",
        }),
      ]),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "load-session-1",
          failure: expect.objectContaining({ kind: "session-expired" }),
        }),
      ]),
    );
  });

  it("does not erase a replacement route opened while the old close settles", async () => {
    const { state } = testEngine(30_021);
    const { client } = testClient();
    state.router.register(client);
    state.sessionAgent.set("old-execution", "claude");
    state.sessionChat.set("old-execution", "chat-1");
    state.conversationExecution.set("chat-1", "old-execution");
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const cancelLive = vi
      .spyOn(state, "cancelLiveAgentSessions")
      .mockImplementation(async () => {
        await closeGate;
        return true;
      });
    vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);

    const closeFlight = state.handleMessage(closeMessage("claude"), client);
    await vi.waitFor(() => expect(cancelLive).toHaveBeenCalledTimes(1));

    // History was restored while cancellation of the old provider turn was
    // settling. The replacement is a different execution for the same durable
    // conversation and must survive the old close handler's cleanup tail.
    state.sessionAgent.set("new-execution", "claude");
    state.sessionChat.set("new-execution", "chat-1");
    state.conversationExecution.set("chat-1", "new-execution");
    releaseClose();
    await closeFlight;

    expect(state.conversationExecution.get("chat-1")).toBe("new-execution");
    expect(state.sessionAgent.get("new-execution")).toBe("claude");
    expect(state.sessionChat.get("new-execution")).toBe("chat-1");
  });

  it("waits for close disposal before resuming the durable provider session", async () => {
    const { state } = testEngine(30_022);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("old-execution", "codex");
    state.sessionChat.set("old-execution", "chat-1");
    state.conversationExecution.set("chat-1", "old-execution");
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const cancelLive = vi
      .spyOn(state, "cancelLiveAgentSessions")
      .mockImplementation(async () => {
        await closeGate;
        return true;
      });
    vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);
    const loadSession = vi
      .spyOn(state.agents, "loadSession")
      .mockResolvedValue({
        executionId: "resumed-execution",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "codex-provider-session-1",
        },
      });

    const closeFlight = state.handleMessage(
      {
        ...closeMessage("codex"),
        executionId: "old-execution",
        sessionId: "old-execution",
      } as EngineMessage,
      client,
    );
    await vi.waitFor(() => expect(cancelLive).toHaveBeenCalledTimes(1));

    const loadFlight = state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-after-close-1",
        source: "browser",
        timestamp: 4,
        agentId: "codex",
        chatId: "chat-1",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "codex-provider-session-1",
        },
      } as EngineMessage,
      client,
    );

    // Reopening from History is allowed immediately, but provider resume must
    // not overlap cancel/dispose for the old execution of the same chat.
    await Promise.resolve();
    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AGENT_SESSION_LOADED" }),
      ]),
    );

    releaseClose();
    await Promise.all([closeFlight, loadFlight]);

    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(state.conversationExecution.get("chat-1")).toBe("resumed-execution");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          executionId: "resumed-execution",
        }),
      ]),
    );
  });
});

describe("session load after a stop", () => {
  it("does not re-adopt a settled turn as a live prompt", async () => {
    const { state } = testEngine(29_895);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    state.promptSessions.add("session-1");
    state.activePromptContexts.set("session-1", {
      sessionId: "session-1",
      agentId: "cursor",
      chatId: "chat-1",
      turnId: "user-1",
      promptId: "prompt-1",
      startedAt: Date.now() - 29 * 60_000,
      lastActivityAt: Date.now(),
      cancelledByUser: true,
      terminalPublished: true,
    });
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({});
    const loadSession = vi
      .spyOn(state.agents, "loadSession")
      .mockResolvedValue({});

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "cursor",
        sessionId: "session-1",
        chatId: "chat-1",
      } as EngineMessage,
      client,
    );

    // The execution remains reusable, but the settled prompt itself is gone:
    // renderer reload must not replace the idle provider session or resurrect
    // a phantom live turn/ticking timer.
    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          promptActive: false,
        }),
      ]),
    );
    expect(turnStates(messages)).not.toContainEqual(
      expect.objectContaining({ state: "running" }),
    );
    expect(state.activePromptContexts.has("session-1")).toBe(false);
    expect(state.promptSessions.has("session-1")).toBe(false);
  });

  it("still re-adopts a genuinely live turn", async () => {
    const { state } = testEngine(29_896);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "cursor");
    state.activePromptContexts.set("session-1", {
      sessionId: "session-1",
      agentId: "cursor",
      chatId: "chat-1",
      turnId: "user-1",
      promptId: "prompt-1",
      startedAt: 4_242,
      lastActivityAt: Date.now(),
    });
    state.sessionLoadResponses.set("session-1", {});
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "cursor",
        sessionId: "session-1",
        chatId: "chat-1",
      } as EngineMessage,
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          promptActive: true,
          activeTurnStartedAt: 4_242,
        }),
      ]),
    );
  });
});
