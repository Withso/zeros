import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolMessage } from "@zeros/protocol/agent-messages";
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
});
