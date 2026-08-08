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
  terminalPublished?: boolean;
}

interface TestEngineInternals {
  router: MessageRouter;
  agents: {
    prompt: (...args: unknown[]) => Promise<unknown>;
    cancel: (...args: unknown[]) => Promise<void>;
    loadSession: (...args: unknown[]) => Promise<unknown>;
  };
  sessionAgent: Map<string, string>;
  promptSessions: Set<string>;
  activePromptContexts: Map<string, ActivePromptRecord>;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  agentSpawnOpts: (...args: unknown[]) => Promise<unknown>;
  activePromptIsLive(prompt: ActivePromptRecord): boolean;
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

    // An ordinary resume — no phantom live turn, no ticking timer.
    expect(loadSession).toHaveBeenCalled();
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
