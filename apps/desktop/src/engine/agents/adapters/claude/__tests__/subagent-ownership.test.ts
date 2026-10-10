import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage, type AgentToolMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "../../../types";
import { ClaudeStreamTranslator } from "../translator";

function session() {
  const updates: SessionNotification[] = [];
  let messages: AgentMessage[] = [];
  const t = new ClaudeStreamTranslator({ sessionId: "subagents", emit: (note) => {
    updates.push(note);
    messages = applyUpdate(messages, note);
  } });
  const tool = (id: string, input: Record<string, unknown> = {}) => t.feed({
    type: "assistant", message: { id: `launch-${id}`, content: [{ type: "tool_use", id, name: "Agent", input }] },
  });
  const start = (task_id: string, tool_use_id: string, extra: Record<string, unknown> = {}) => t.feed({
    type: "system", subtype: "task_started", task_id, tool_use_id, task_type: "local_agent", ...extra,
  });
  const row = (nativeToolCallId: string) => messages.find((m): m is AgentToolMessage => m.kind === "tool" && m.nativeToolCallId === nativeToolCallId)!;
  const text = (value: string) => messages.find((m) => m.kind === "text" && m.text === value)!;
  const background = () => updates.map((n) => n.update).filter((u) => u.sessionUpdate === "background_tasks_update").at(-1)!;
  t.beginTurn();
  return { t, updates, tool, start, row, text, background };
}

describe("Claude stable subagent ownership and metadata", () => {
  it("routes assistant and user messages by agent_id when resume changes the native tool parent", () => {
    const { t, tool, start, row, text, background } = session();
    tool("launch", { description: "Audit source", effort: "medium" });
    start("agent", "launch", { run_id: "run-001", is_backgrounded: true, subagent_type: "Explore" });
    t.feed({ type: "result", subtype: "success" });
    const group = row("launch");
    t.feed({ type: "assistant", agent_id: "agent", parent_tool_use_id: "resume-call", message: {
      id: "child-output", model: "claude-sonnet-5", content: [
        { type: "text", text: "Child checkpoint" },
        { type: "tool_use", id: "read", name: "Read", input: { file_path: "/tmp/source" } },
      ],
    } });
    t.feed({ type: "user", agent_id: "agent", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "Source contents" }] } });
    expect(text("Child checkpoint")).toMatchObject({ parentToolId: group.toolCallId });
    expect(row("read")).toMatchObject({ parentToolId: group.toolCallId, status: "completed", rawOutput: "Source contents" });
    expect(row("launch")).toMatchObject({ rawOutput: { subagentType: "Explore", resolvedModel: "claude-sonnet-5", effort: "medium" } });
    expect(background()).toMatchObject({ waiting: true, activity: { state: "idle" } });
  });

  it.each([false, true])("nests a child Agent beneath a known parent task, including an ended parent (%s)", (ended) => {
    const { t, tool, start, row } = session();
    tool("parent-call", { description: "Parent audit" });
    start("parent", "parent-call");
    if (ended) t.feed({ type: "system", subtype: "task_notification", task_id: "parent", status: "completed" });
    tool("child-call", { description: "Nested audit" });
    start("child", "child-call", { parent_task_id: "parent", subagent_type: "code-reviewer" });
    expect(row("child-call")).toMatchObject({ parentToolId: row("parent-call").toolCallId, rawOutput: { subagentType: "code-reviewer" } });
  });

  it("leaves an unknown parent task unparented rather than borrowing another Agent group", () => {
    const { tool, start, row } = session();
    tool("parent-call", { description: "Parent audit" });
    start("parent", "parent-call");
    tool("child-call", { description: "Nested audit" });
    start("child", "child-call", { parent_task_id: "unknown", subagent_type: "Explore" });
    expect(row("child-call").parentToolId).toBeUndefined();
  });

  it("uses membership type and ancestry changes to enrich the existing Agent and Background Task", () => {
    const { t, tool, start, row, background, updates } = session();
    tool("parent-call", { description: "Parent audit" });
    start("parent", "parent-call");
    tool("child-call", { description: "Nested audit", effort: "high" });
    start("child", "child-call", { run_id: "run-001", is_backgrounded: true });
    t.feed({ type: "system", subtype: "background_tasks_changed", tasks: [{
      task_id: "child", run_id: "run-001", task_type: "local_agent", subagent_type: "code-reviewer", parent_task_id: "parent", description: "Nested audit",
    }] });
    expect(background().tasks).toMatchObject([{ taskId: "child", subagentType: "code-reviewer" }]);
    expect(row("child-call")).toMatchObject({ parentToolId: row("parent-call").toolCallId, rawOutput: { subagentType: "code-reviewer", effort: "high" } });
    const backgroundRow = updates.map((n) => n.update).filter((u) => "kind" in u && u.kind === "background_task").at(-1)!;
    expect(backgroundRow).toMatchObject({ rawInput: { subagentType: "code-reviewer", name: "Nested audit" } });
  });

  it("attaches early child output to its exact stable task once its launch is known", () => {
    const { t, tool, start, row, text } = session();
    t.feed({ type: "assistant", agent_id: "child", subagent_type: "Explore", message: { id: "early", content: [{ type: "text", text: "Early child checkpoint" }] } });
    tool("child-call", { description: "Audit source" });
    start("child", "child-call", { subagent_type: "Explore" });
    expect(text("Early child checkpoint")).toMatchObject({ parentToolId: row("child-call").toolCallId });
  });

  it("does not use a child's agent_id error to classify a successful parent turn", () => {
    const { t, tool, start } = session();
    tool("child-call", { description: "Audit source" });
    start("child", "child-call");
    t.feed({ type: "assistant", agent_id: "child", error: "authentication_failed", message: { id: "child-error", content: [{ type: "text", text: "Please sign in" }] } });
    t.feed({ type: "result", subtype: "success" });
    expect(t.terminalFailure).toBeNull();
  });

  it("preserves Agent effort and type through launch, completion, resume, and an older notification", () => {
    const { t, tool, start, row } = session();
    tool("child-call", { description: "Audit source", effort: "xhigh" });
    start("child", "child-call", { run_id: "run-001", subagent_type: "Explore", is_backgrounded: true });
    t.feed({ type: "user", tool_use_result: { status: "async_launched", agentId: "child", resolvedModel: "claude-opus-5-5" }, message: {
      content: [{ type: "tool_result", tool_use_id: "child-call", content: "Internal launch bookkeeping" }],
    } });
    t.feed({ type: "system", subtype: "task_notification", task_id: "child", run_id: "run-001", status: "completed" });
    start("child", "child-call", { run_id: "run-002", is_backgrounded: true });
    t.feed({ type: "system", subtype: "task_notification", task_id: "child", run_id: "run-001", status: "failed" });
    expect(row("child-call")).toMatchObject({ status: "in_progress", rawOutput: { subagentType: "Explore", effort: "xhigh", resolvedModel: "claude-opus-5-5" } });
  });
});

describe("Claude Chrome setup engine presentation", () => {
  it("carries the Chrome setup reason and one actionable notice without rendering its outcome", () => {
    const { t, updates, row } = session();
    const launch = { type: "assistant", message: { id: "chrome", content: [{ type: "tool_use", id: "chrome-call", name: "OfferChromeSetup", input: { reason: "Use your signed-in browser" } }] } };
    t.feed(launch);
    t.feed(launch);
    t.feed({ type: "user", tool_use_result: { outcome: "not_now" }, message: { content: [{ type: "tool_result", tool_use_id: "chrome-call", content: "not_now" }] } });
    expect(row("chrome-call")).toMatchObject({ title: "Chrome setup", status: "completed", rawInput: { reason: "Use your signed-in browser" }, content: [] });
    expect(row("chrome-call")).not.toHaveProperty("rawOutput.outcome");
    expect(row("chrome-call")).not.toHaveProperty("rawOutput", "not_now");
    expect(updates.map((n) => n.update).filter((u) => u.sessionUpdate === "error_notice")).toMatchObject([{
      code: "claude-chrome-setup", recoverable: true,
      message: "Set up Claude in Chrome in Settings to let Claude use your browser.",
    }]);
  });
});
