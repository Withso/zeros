import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "../../../types";
import { ClaudeStreamTranslator } from "../translator";

function session(sessionId = "monitor-activity") {
  const updates: SessionNotification[] = [];
  let messages: AgentMessage[] = [];
  const translator = new ClaudeStreamTranslator({
    sessionId,
    emit: (note) => {
      updates.push(note);
      messages = applyUpdate(messages, note);
    },
  });
  const system = (subtype: string, fields: Record<string, unknown> = {}) =>
    translator.feed({ type: "system", subtype, ...fields });
  const membership = (tasks: Array<{ task_id: string; ambient?: boolean }>) =>
    system("background_tasks_changed", {
      tasks: tasks.map((task) => ({ task_type: "local_bash", ...task })),
    });
  const start = (taskId: string, fields: Record<string, unknown> = {}) =>
    system("task_started", {
      task_id: taskId,
      task_type: "local_bash",
      is_backgrounded: true,
      description: "Check completion",
      ...fields,
    });
  const call = (name = "Monitor", id = "monitor-call") =>
    translator.feed({
      type: "assistant",
      message: { content: [{
        type: "tool_use", id, name,
        input: { description: "Watch checks finish", command: "watch-checks", timeout_ms: 300_000 },
      }] },
    });
  const launch = (fields: Record<string, unknown> = {}) =>
    translator.feed({
      type: "user",
      tool_use_result: { taskId: "watch", timeoutMs: 300_000 },
      message: { content: [{ type: "tool_result", tool_use_id: "monitor-call", content: "Monitor started" }] },
      ...fields,
    });
  const result = () => translator.feed({ type: "result", subtype: "success" });
  const snapshot = () => updates.map((note) => note.update)
    .filter((update) => update.sessionUpdate === "background_tasks_update").at(-1)!;
  const rows = () => updates.map((note) => note.update)
    .filter((update) => update.sessionUpdate === "tool_call" && update.kind === "background_task");
  translator.beginTurn();
  return { translator, updates, system, membership, start, call, launch, result, snapshot, rows, messages: () => messages };
}

describe("Claude Monitor activity", () => {
  it.each(["start-first", "membership-first"])(
    "counts only real jobs while retaining a native Monitor (%s)",
    (order) => {
      const s = session();
      s.call();
      s.start("checks");
      s.start("baseline");
      const tasks = [{ task_id: "checks" }, { task_id: "baseline" }, { task_id: "watch" }];
      if (order === "membership-first") s.membership(tasks);
      s.start("watch", { tool_use_id: "monitor-call" });
      if (order === "start-first") s.membership(tasks);
      s.launch();
      s.result();
      expect(s.snapshot()).toMatchObject({
        tasks: [{ taskId: "checks" }, { taskId: "baseline" }], waiting: true,
      });
      expect(s.rows()).toHaveLength(2);

      // Repeated init and membership do not lose the native Monitor identity.
      s.system("init");
      s.membership(tasks);
      expect(s.snapshot().tasks).toHaveLength(2);
      s.system("task_notification", { task_id: "checks", status: "completed" });
      s.membership(tasks.slice(1));
      expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "baseline" }], waiting: true });
      s.system("task_notification", { task_id: "baseline", status: "completed" });
      s.membership([{ task_id: "watch" }]);
      expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
      expect(s.translator.hasActiveWork).toBe(false);
      expect(s.translator.hasProcessWork).toBe(true);

      s.system("task_notification", { task_id: "watch", status: "completed" });
      expect(s.translator.hasProcessWork).toBe(false);
      s.membership([{ task_id: "watch" }]);
      expect(s.translator.hasProcessWork).toBe(false);
      expect(s.rows()).toHaveLength(2);
    },
  );

  it("retains a Monitor backgrounded by an update when its start was missed", () => {
    const s = session();
    s.call();
    s.launch();
    s.system("task_updated", { task_id: "watch", patch: { is_backgrounded: true } });
    s.result();
    expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
    expect(s.translator.hasProcessWork).toBe(true);
    s.system("task_updated", { task_id: "watch", patch: { status: "killed" } });
    expect(s.translator.hasProcessWork).toBe(false);
    expect(s.rows()).toEqual([]);
  });

  it("parks a finished parent reply when only its Monitor remains and Result is delayed", () => {
    const s = session();
    s.call();
    s.start("watch", { tool_use_id: "monitor-call" });
    s.launch();
    s.translator.feed({ type: "assistant", message: {
      content: [{ type: "text", text: "The watcher is ready." }], stop_reason: "end_turn",
    } });
    expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false, activity: { state: "idle" } });
    expect(s.translator.hasProcessWork).toBe(true);
    s.translator.feed({ type: "assistant", message: { content: [{ type: "text", text: "A check finished." }] } });
    expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false, activity: { state: "running" } });
  });

  it("settles an already visible task's error after a late Monitor result identifies it", () => {
    const s = session();
    s.call();
    s.start("watch");
    s.membership([{ task_id: "watch" }]);
    expect(s.rows()).toHaveLength(1);
    s.launch();
    s.result();
    expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
    s.system("task_updated", { task_id: "watch", patch: { status: "failed", error: "Watch source disconnected" } });
    s.system("task_notification", { task_id: "watch", status: "failed", summary: "Monitor ended", output_file: "/tmp/monitor.output" });
    expect(s.messages().find((message) => message.kind === "tool" && message.toolKind === "background_task"))
      .toMatchObject({ status: "failed", rawOutput: { error: "Watch source disconnected", summary: "Monitor ended", outputFile: "/tmp/monitor.output" } });
    expect(s.translator.hasProcessWork).toBe(false);
  });

  it.each(["result-first", "membership-first"])(
    "joins an unambiguous Monitor result when the start has no tool ID (%s)",
    (order) => {
      const s = session();
      s.call();
      if (order === "membership-first") s.membership([{ task_id: "watch" }]);
      s.launch();
      if (order === "result-first") s.membership([{ task_id: "watch" }]);
      s.start("watch");
      s.result();
      expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
      expect(s.rows()).toEqual([]);
      expect(s.translator.hasProcessWork).toBe(true);
      s.system("task_updated", { task_id: "watch", patch: { status: "completed" } });
      expect(s.translator.hasProcessWork).toBe(false);
    },
  );

  it.each(["start-first", "membership-first"])(
    "honors an explicit non-ambient membership over Monitor provenance (%s)",
    (order) => {
      const s = session();
      s.call();
      if (order === "membership-first") s.membership([{ task_id: "watch", ambient: false }]);
      s.start("watch", { tool_use_id: "monitor-call" });
      if (order === "start-first") s.membership([{ task_id: "watch", ambient: false }]);
      s.launch();
      s.result();
      expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
      s.membership([{ task_id: "watch", ambient: true }]);
      expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
      s.membership([{ task_id: "watch", ambient: false }]);
      expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
    },
  );

  it.each(["Bash", "mcp__tools__Monitor", "MonitorStatus"])(
    "keeps %s tasks visible even when their description and output mention a watcher",
    (name) => {
      const s = session();
      s.call(name);
      s.start("watch", { tool_use_id: "monitor-call" });
      s.launch();
      s.membership([{ task_id: "watch" }]);
      s.result();
      expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
      expect(s.rows()).toHaveLength(1);
    },
  );

  it.each([true, false])("honors an explicit start flag without membership snapshots (ambient=%s)", (ambient) => {
    const s = session();
    s.call();
    s.start("watch", { tool_use_id: "monitor-call", ambient });
    s.launch();
    s.result();
    expect(s.snapshot().tasks).toHaveLength(ambient ? 0 : 1);
    expect(s.translator.hasProcessWork).toBe(true);
    s.system("task_notification", { task_id: "watch", status: "completed" });
    expect(s.translator.hasProcessWork).toBe(false);
  });

  it.each(["true", "false", 1, {}])("does not hide ordinary work for a malformed ambient flag (%j)", (ambient) => {
    const s = session();
    s.start("checks", { ambient });
    s.system("background_tasks_changed", { tasks: [{ task_id: "checks", ambient }] });
    s.result();
    expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "checks" }], waiting: true });
  });

  it.each([
    { reason: "failed", message: { content: [{ type: "tool_result", tool_use_id: "monitor-call", is_error: true, content: "Launch failed" }] } },
    { reason: "batched", message: { content: [
      { type: "tool_result", tool_use_id: "monitor-call", content: "Monitor started" },
      { type: "tool_result", tool_use_id: "other-call", content: "Other output" },
    ] } },
    { reason: "unstructured", tool_use_result: undefined },
  ])("does not classify a task from a $reason Monitor result", ({ reason: _reason, ...fields }) => {
    const s = session();
    s.call();
    s.launch(fields);
    s.start("watch");
    s.membership([{ task_id: "watch" }]);
    s.result();
    expect(s.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
  });

  it.each(["membership", "completion", "stop"])(
    "does not revive ownership when a Monitor launch arrives after %s removed it",
    (removal) => {
      const s = session();
      s.call();
      s.start("watch");
      if (removal === "membership") s.membership([]);
      if (removal === "completion") s.system("task_notification", { task_id: "watch", status: "completed" });
      if (removal === "stop") s.translator.endActivity();
      s.launch();
      s.result();
      expect(s.translator.hasProcessWork).toBe(false);
      expect(s.snapshot()).toMatchObject({ tasks: [], waiting: false });
    },
  );

  it("keeps Monitor classification isolated by session and clears it on process replacement", () => {
    const first = session("first");
    const other = session("other");
    first.call();
    first.launch();
    first.membership([{ task_id: "watch" }]);
    other.membership([{ task_id: "watch" }]);
    first.result();
    other.result();
    expect(first.snapshot()).toMatchObject({ tasks: [], waiting: false });
    expect(other.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });

    first.translator.beginProcess();
    first.translator.beginTurn();
    first.membership([{ task_id: "watch" }]);
    first.result();
    expect(first.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
    expect(other.snapshot()).toMatchObject({ tasks: [{ taskId: "watch" }], waiting: true });
  });
});
