import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { reconcileHistoryMessages } from "../history-message-identity";
import { formatTranscript } from "../transcript-format";
import { partitionTurn } from "../turn-partition";

describe("fallback transcript persistence", () => {
  it("withdraws late-attributed child content without affecting siblings", () => {
    const send = (
      messages: AgentMessage[],
      update: import("@zeros/protocol/agent-events").SessionUpdate,
    ) => applyUpdate(messages, { sessionId: "s", update });
    let messages = send([], {
      sessionUpdate: "tool_call",
      toolCallId: "owner",
      title: "Agent",
      status: "in_progress",
    });
    messages = send(messages, {
      sessionUpdate: "message_retraction",
      messageIds: ["owner"],
    });
    messages = send(messages, {
      sessionUpdate: "agent_message_chunk",
      messageId: "child",
      content: { type: "text", text: "Withdrawn child" },
    });
    messages = send(messages, {
      sessionUpdate: "agent_message_chunk",
      messageId: "sibling",
      content: { type: "text", text: "Keep sibling" },
    });
    messages = send(messages, {
      sessionUpdate: "message_parent_update",
      parentToolId: "owner",
      messageIds: ["child"],
    });
    messages = send(messages, {
      sessionUpdate: "agent_message_chunk",
      parentToolId: "owner",
      messageId: "child-2",
      content: { type: "text", text: "Late withdrawn child" },
    });
    expect(formatTranscript(messages, "full").text).toContain("Keep sibling");
    expect(formatTranscript(messages, "full").text).not.toContain("Withdrawn");
    expect(formatTranscript(messages, "full").text).not.toContain(
      "Late withdrawn",
    );
  });
  it("uses the requested Codex safety fallback wording", () => {
    const messages = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "model_fallback",
        noticeId: "codex",
        provider: "codex",
        scope: "session",
        reason: "cybersecurity",
        fromModel: "gpt-6-astra",
        toModel: "gpt-5.6-sol",
      },
    });
    expect(formatTranscript(messages, "full").text).toContain(
      "Model fallback to Sol 5.6 because of a cybersecurity-related safety check",
    );
  });
  it("keeps a withdrawn tool tombstone over stale history in either order", () => {
    const old = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Withdrawn tool",
        status: "failed",
      },
    });
    const retired = applyUpdate(old, {
      sessionId: "s",
      update: { sessionUpdate: "message_retraction", messageIds: ["t"] },
    });
    for (const merged of [
      [...old, ...retired],
      [...retired, ...old],
    ]) {
      const history = reconcileHistoryMessages(
        JSON.parse(JSON.stringify(merged)) as AgentMessage[],
      );
      expect(history).toHaveLength(1);
      expect(partitionTurn(history)).toEqual({ working: [], finalOutput: [] });
      expect(formatTranscript(history, "full").text).not.toContain(
        "Withdrawn tool",
      );
    }
  });
  it("keeps a retracted result over stale completed history, including equal timestamps", () => {
    const old = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Read",
        status: "failed",
        rawOutput: "Withdrawn failure",
      },
    });
    const retired = applyUpdate(old, {
      sessionId: "s",
      update: { sessionUpdate: "tool_result_retraction", toolCallIds: ["t"] },
    });
    const stale = {
      ...old[0],
      updatedAt: retired[0].kind === "tool" ? retired[0].updatedAt : 0,
    } as AgentMessage;
    const history = reconcileHistoryMessages([...retired, stale]);
    expect(history[0]).toMatchObject({
      status: "pending",
      resultRetracted: true,
    });
    expect(formatTranscript(history, "full").text).not.toContain(
      "Withdrawn failure",
    );
  });
  it("exports fallback narration using curated model names and keeps it in the working feed", () => {
    const messages = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "model_fallback",
        noticeId: "n",
        provider: "claude",
        scope: "local",
        reason: "refusal",
        fromModel: "claude-sonnet-5",
        toModel: "claude-opus-5",
      },
    });
    expect(partitionTurn(messages).finalOutput).toHaveLength(0);
    expect(formatTranscript(messages, "full").text).toContain(
      "Model fallback used Opus 5",
    );
  });
});
