import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentOutput, ProjectsOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type { SessionNotification, TurnUsage } from "@zeros/protocol/agent-events";
import { applyUpdate, type AgentMessage, type AgentToolMessage } from "@zeros/protocol/agent-messages";
import { describe, expect, it } from "vitest";

interface Translator {
  feed(frame: unknown): boolean;
  beginProcess(): void;
  beginTurn(): void;
  readonly turnUsage: TurnUsage | undefined;
}

/** Run the same native-field assertions against each placement's translator. */
export function claudeRuntimeUpgradeContract(create: (emit: (event: SessionNotification) => void) => Translator): void {
  const setup = () => {
    const events: SessionNotification[] = [];
    const translator = create(event => events.push(event));
    translator.beginProcess();
    translator.beginTurn();
    const tools = () => events.reduce<AgentMessage[]>((messages, event) => applyUpdate(messages, event), [])
      .filter((message): message is AgentToolMessage => message.kind === "tool");
    return { translator, tools };
  };

  describe("Claude SDK 0.3.311 additive fields", () => {
    it("retains Agent toolsUsed through replay and settlement without inventing child calls", () => {
      const { translator, tools } = setup();
      translator.feed({ type: "assistant", uuid: "parent-start", message: { role: "assistant", content: [
        { type: "tool_use", id: "parent", name: "Agent", input: { description: "Inspect fixtures", prompt: "Review tests", subagent_type: "Explore" } },
      ] } });
      translator.feed({ type: "assistant", uuid: "child-start", parent_tool_use_id: "parent", message: { role: "assistant", content: [
        { type: "tool_use", id: "child", name: "Read", input: { file_path: "/fixture/test.ts" } },
      ] } });
      translator.feed({ type: "user", uuid: "child-end", parent_tool_use_id: "parent", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "child", content: "Fixture body" },
      ] } });
      const output = {
        status: "completed", agentId: "native-child", prompt: "Review tests",
        content: [{ type: "text", text: "Fixtures checked." }], toolsUsed: ["Read", "Grep"],
        totalToolUseCount: 2, totalDurationMs: 100, totalTokens: 30,
        usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null },
      } satisfies AgentOutput;
      const frame = { type: "user", uuid: "parent-end", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "parent", content: "Fixtures checked." },
      ] }, tool_use_result: output };
      translator.feed(frame);
      translator.feed(frame);
      translator.feed({ type: "system", subtype: "task_notification", uuid: "task-end", task_id: "native-child",
        tool_use_id: "parent", status: "completed", output_file: "/fixture/report.txt", summary: "Fixtures checked." });
      const rows = tools();
      expect(rows.map(row => row.nativeToolCallId)).toEqual(["parent", "child"]);
      const parent = rows[0];
      expect(parent.status).toBe("completed");
      expect(parent.rawOutput).toMatchObject({ toolsUsed: ["Read", "Grep"] });
      expect(JSON.parse(JSON.stringify(parent)).rawOutput.toolsUsed).toEqual(["Read", "Grep"]);
      expect(parent.content).toContainEqual({ type: "content", content: { type: "text", text: "Fixtures checked." } });
    });

    it.each([undefined, "/fixture/project-info.json"])("keeps Projects output readable with local_file=%s", localFile => {
      const { translator, tools } = setup();
      translator.feed({ type: "assistant", uuid: "project-start", message: { role: "assistant", content: [
        { type: "tool_use", id: "project", name: "Projects", input: { method: "project_info" } },
      ] } });
      const output = { method: "project_info", name: "Fixture project", description: "Fixture", instructions: "Review fixtures",
        docs: [], knowledge: { knowledge_size: 0, max_knowledge_size: 100 },
        ...(localFile ? { local_file: localFile } : {}),
      } satisfies ProjectsOutput;
      translator.feed({ type: "user", uuid: "project-end", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "project", content: "Project details remain visible." },
      ] }, tool_use_result: output });
      expect(tools()).toHaveLength(1);
      expect(tools()[0]).toMatchObject({ status: "completed", rawOutput: "Project details remain visible.",
        content: [{ type: "content", content: { type: "text", text: "Project details remain visible." } }] });
    });

    it.each([
      { name: "absent", first: {}, next: {} },
      { name: "complete", first: { cacheCreationEphemeral5mInputTokens: 10, cacheCreationEphemeral1hInputTokens: 20 },
        next: { cacheCreationEphemeral5mInputTokens: 20, cacheCreationEphemeral1hInputTokens: 30 } },
      { name: "partial", first: { cacheCreationEphemeral5mInputTokens: 5, cacheCreationEphemeral1hInputTokens: 10 },
        next: { cacheCreationEphemeral5mInputTokens: 7, cacheCreationEphemeral1hInputTokens: 15 } },
    ])("keeps aggregate usage and estimated cost with $name cache-lifetime counters", ({ first, next }) => {
      const { translator } = setup();
      const initial: ModelUsage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40, cacheCreationInputTokens: 30,
        costUSD: 2.5, webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 8192, ...first };
      translator.feed({ type: "result", subtype: "success", uuid: "first-result", total_cost_usd: 2.5, modelUsage: { fixture: initial } });
      expect(translator.turnUsage).toMatchObject({ inputTokens: 170, outputTokens: 10, cacheReadTokens: 40,
        cacheWriteTokens: 30, totalCostUsd: 2.5 });
      translator.beginTurn();
      const cumulative: ModelUsage = { ...initial, inputTokens: 150, outputTokens: 15, cacheReadInputTokens: 60,
        cacheCreationInputTokens: 50, costUSD: 3.75, ...next };
      const frame = { type: "result", subtype: "success", uuid: "next-result", total_cost_usd: 3.75, modelUsage: { fixture: cumulative } };
      translator.feed(frame);
      const usage = translator.turnUsage;
      expect(usage).toMatchObject({ inputTokens: 90, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 20, totalCostUsd: 1.25 });
      expect(translator.feed(frame)).toBe(false);
      expect(translator.turnUsage).toEqual(usage);
    });
  });
}
