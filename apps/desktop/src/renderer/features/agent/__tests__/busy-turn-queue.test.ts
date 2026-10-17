// An agent's message (Zeros Local CLI) started a turn at the same moment the
// user sent "hi". The engine refused "hi" as busy, and the chat showed a
// failure banner under the agent turn's output (2026-10-17). A refused,
// undelivered send belongs in the follow-up queue behind the running turn.

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { queueBehindRunningTurn } from "../busy-turn-queue";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

const agentMessage: AgentMessage = {
  id: "cli-turn", kind: "text", role: "user", text: "What do we do next?", createdAt: 1,
};
const userHi: AgentMessage = { id: "user-hi", kind: "text", role: "user", text: "hi", createdAt: 2 };
const reply: AgentMessage = { id: "reply", kind: "text", role: "agent", text: "Reply for the coordinating chat", createdAt: 3 };

describe("queueBehindRunningTurn", () => {
  beforeEach(() => useSessionsStore.getState().clearAll());

  it("moves the refused send into the queue and adopts the running turn", () => {
    const queued = queueBehindRunningTurn({
      messages: [agentMessage, userHi],
      bubbleId: "user-hi",
      editable: true,
      activeTurn: { turnId: "cli-turn", startedAt: 1 },
    });
    expect(queued).toMatchObject({
      status: "streaming", error: null, failure: null,
      foregroundTurnId: "cli-turn", activeTurnStartedAt: 1,
    });
    expect(queued?.messages[1]).toMatchObject({ id: "user-hi", text: "hi", queued: true, queuedEditable: true });
  });

  it("keeps the running turn's output in that turn, with no failure under it", () => {
    const queued = queueBehindRunningTurn({
      messages: [agentMessage, userHi],
      bubbleId: "user-hi",
      editable: true,
      activeTurn: { turnId: "cli-turn", startedAt: 1 },
    })!;
    // The transcript renders without queued rows (the composer's queued card
    // shows them), so the agent turn's reply stays under its own prompt.
    const visible = [...queued.messages, reply].filter((m) => !(m.kind === "text" && m.queued));
    const turns = groupMessagesIntoTurns(visible);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ userPrompt: { id: "cli-turn" }, events: [reply] });
  });

  it("settles when the adopted turn ends, so the queue can send the message next", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-1", {
      ...BLANK, agentId: "cursor", sessionId: "exec-1", status: "streaming",
      foregroundTurnId: "user-hi", messages: [agentMessage, userHi],
    });
    store.setPendingLocalTurn("chat-1", null);
    const queued = queueBehindRunningTurn({
      messages: [agentMessage, userHi],
      bubbleId: "user-hi",
      editable: true,
      activeTurn: { turnId: "cli-turn", startedAt: 1 },
    })!;
    store.patchSession("chat-1", queued);
    store.applyBridgeUpdate({
      sessionId: "exec-1",
      chatId: "chat-1",
      update: { sessionUpdate: "turn_state", turnId: "cli-turn", state: "completed", startedAt: 1, stopReason: "end_turn" },
    } as SessionNotification);
    expect(useSessionsStore.getState().sessions["chat-1"]).toMatchObject({
      status: "ready", failure: null, foregroundTurnId: "cli-turn",
    });
  });

  it("leaves a bubble that Stop or an edit already removed", () => {
    expect(queueBehindRunningTurn({
      messages: [agentMessage],
      bubbleId: "user-hi",
      editable: true,
      activeTurn: { turnId: "cli-turn", startedAt: 1 },
    })).toBeNull();
  });
});
