import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage, type AgentToolMessage } from "@zeros/protocol/agent-messages";
import { ClaudeStreamTranslator } from "../../../../engine/agents/adapters/claude/translator";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { partitionTurnSequence } from "../turn-partition";
import { formatTranscript } from "../transcript-format";

const agent: AgentToolMessage = {
  id: "agent", kind: "tool", toolKind: "subagent", title: "Agent", toolCallId: "launch",
  status: "in_progress", createdAt: 2, updatedAt: 2,
  rawInput: { description: "Inspect source", subagent_type: "Explore" },
  rawOutput: { agentId: "native-child", status: "async_launched" },
};
const background: AgentToolMessage = {
  id: "background", kind: "tool", toolKind: "background_task", title: "Background Task", toolCallId: "background",
  status: "in_progress", createdAt: 3, updatedAt: 3,
  rawInput: { taskId: "native-child", taskType: "local_agent", subagentType: "Explore", name: "Inspect source" },
};
const prompt: AgentMessage = { id: "prompt", kind: "text", role: "user", text: "Inspect source", createdAt: 1 };

describe("Agent background lifecycle presentation", () => {
  it.each(["in_progress", "completed", "failed"] as const)("shows one Agent group for native %s work, including saved history", status => {
    const messages: AgentMessage[] = JSON.parse(JSON.stringify([prompt, { ...agent, status }, { ...background, status }]));
    expect(groupMessagesIntoTurns(messages)[0].events.map(event => event.id)).toEqual(["agent"]);
    expect(partitionTurnSequence(messages.slice(1), { live: true }).flatMap(segment => segment.events).map(event => event.id)).toEqual(["agent"]);
    expect(formatTranscript(messages, "full").text).not.toContain("Background Task");
    expect(messages).toHaveLength(3);
  });

  it("keeps standalone tasks, unmatched identities and unrepresented failures inspectable", () => {
    const unrelated = { ...background, id: "unrelated", rawInput: { ...background.rawInput as object, taskId: "other-child" } };
    const failed = { ...background, id: "unrepresented-failure", status: "failed" as const, rawOutput: { error: "Agent connection lost" } };
    expect(groupMessagesIntoTurns([prompt, agent, unrelated, failed])[0].events.map(event => event.id)).toEqual(["agent", "unrelated", "unrepresented-failure"]);
    expect(groupMessagesIntoTurns([prompt, background])[0].events).toEqual([background]);
  });

  it.each([undefined, "An earlier failure"])("keeps a saved task explanation missing from its failed Agent (%s)", message => {
    const explanation = "The child could not read its required input file.";
    const messages: AgentMessage[] = JSON.parse(JSON.stringify([
      prompt,
      { ...agent, status: "failed", rawOutput: { agentId: "native-child", status: "failed", message } },
      { ...background, status: "failed", rawOutput: { status: "failed", summary: explanation, error: explanation } },
    ]));
    const visible = groupMessagesIntoTurns(messages)[0].events;
    expect(visible.map(event => event.id)).toEqual(["agent", "background"]);
    expect(partitionTurnSequence(messages.slice(1), { live: true }).flatMap(segment => segment.events)).toEqual(visible);
    expect(formatTranscript(messages, "full").text).toContain(explanation);
  });

  it.each(["message", "content"])("hides a failed lifecycle row when the Agent displays the explanation in %s", source => {
    const explanation = "The child could not read its required input file.";
    const failedAgent: AgentToolMessage = {
      ...agent, status: "failed",
      rawOutput: { agentId: "native-child", status: "failed", ...(source === "message" ? { message: explanation } : {}) },
      ...(source === "content" ? { content: [{ type: "content", content: { type: "text", text: explanation } }] } : {}),
    };
    const messages = [prompt, failedAgent, { ...background, status: "failed" as const, rawOutput: { error: explanation, summary: explanation } }];
    expect(groupMessagesIntoTurns(messages)[0].events).toEqual([failedAgent]);
    expect(formatTranscript(messages, "full").text).not.toContain("Background Task");
    expect(formatTranscript(messages, "full").text).toContain(explanation);
  });

  it.each(["/local/personal", "/local/organization", "cloud://organization/workspace"])(
    "preserves a failure summary delivered after the failed status in %s",
    sessionId => {
      const explanation = "The child could not read its required input file.";
      let messages: AgentMessage[] = [prompt];
      const translator = new ClaudeStreamTranslator({ sessionId, emit: notification => {
        messages = applyUpdate(messages, notification);
      } });
      translator.beginTurn();
      translator.feed({ type: "assistant", message: { id: "launch", content: [{
        type: "tool_use", id: "agent-call", name: "Agent", input: agent.rawInput,
      }] } });
      translator.feed({ type: "system", subtype: "task_started", task_id: "native-child",
        task_type: "local_agent", tool_use_id: "agent-call", is_backgrounded: true });
      translator.feed({ type: "system", subtype: "task_updated", task_id: "native-child", patch: { status: "failed" } });
      translator.feed({ type: "system", subtype: "task_notification", task_id: "native-child", status: "failed", summary: explanation });

      for (const history of [messages, JSON.parse(JSON.stringify(messages)) as AgentMessage[]]) {
        expect(JSON.stringify(groupMessagesIntoTurns(history)[0].events)).toContain(explanation);
        expect(formatTranscript(history, "full").text).toContain(explanation);
      }
    },
  );
});
