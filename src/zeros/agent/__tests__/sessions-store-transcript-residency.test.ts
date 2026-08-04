import { beforeEach, describe, expect, it } from "vitest";

import type { SessionNotification } from "../../bridge/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentMessage } from "../use-agent-session";

const message = (id: string, queued = false): AgentMessage => ({
  id,
  kind: "text",
  role: "user",
  text: id,
  createdAt: 1,
  ...(queued ? { queued: true } : {}),
});

const chunk = (sessionId: string, text: string): SessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId: "agent-message",
  },
});

describe("sessions-store transcript residency", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("evicts only the heavyweight transcript while preserving live runtime state", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      cwd: "/repo",
      status: "streaming",
      messages: [message("user-1"), message("agent-1")],
      historyExpanded: true,
      stderrLog: ["large diagnostic"],
      activeTurnStartedAt: 123,
      pendingQuestions: [
        {
          questionId: "question-1",
          agentId: "claude",
          request: { sessionId: "session-a" } as never,
        },
      ],
      backgroundTasks: [
        {
          taskId: "task-1",
          name: "Watch build",
          taskType: "shell",
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    });

    store.evictTranscript("chat-a");

    const state = useSessionsStore.getState();
    const slot = state.sessions["chat-a"];
    expect(slot).toMatchObject({
      agentId: "claude",
      sessionId: "session-a",
      cwd: "/repo",
      status: "streaming",
      activeTurnStartedAt: 123,
      transcriptState: "cold",
      transcriptDirty: false,
      hasTranscript: true,
      historyExpanded: false,
      messages: [],
      stderrLog: [],
    });
    expect(slot.pendingQuestions).toHaveLength(1);
    expect(slot.backgroundTasks).toHaveLength(1);
    expect(state.sessionToChatId["session-a"]).toBe("chat-a");
  });

  it("does not fold live chunks into a cold transcript and marks it for exact rehydration", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      messages: [message("existing")],
    });
    store.setSession("chat-b", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-b",
      messages: [message("chat-b-message")],
    });
    store.evictTranscript("chat-a");

    store.applyBridgeUpdate(chunk("session-a", "new output"));

    expect(useSessionsStore.getState().sessions["chat-a"]).toMatchObject({
      transcriptState: "cold",
      transcriptDirty: true,
      hasTranscript: true,
      messages: [],
    });
    expect(useSessionsStore.getState().sessions["chat-b"]).toMatchObject({
      transcriptState: "resident",
      transcriptDirty: false,
      messages: [expect.objectContaining({ id: "chat-b-message" })],
    });
  });

  it("parks chunks that race an exact disk hydrate instead of building a partial tail", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      transcriptState: "loading",
    });

    store.applyBridgeUpdate(chunk("session-a", "arrived during read"));

    expect(useSessionsStore.getState().sessions["chat-a"]).toMatchObject({
      transcriptState: "loading",
      transcriptDirty: true,
      hasTranscript: true,
      messages: [],
    });
  });

  it("does not mistake an ephemeral queued placeholder for a durable transcript", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      messages: [message("queued", true)],
    });

    store.evictTranscript("chat-a");

    expect(useSessionsStore.getState().sessions["chat-a"]).toMatchObject({
      hasTranscript: false,
      messages: [],
      transcriptState: "cold",
    });
  });
});
