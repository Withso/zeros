import { describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "../../../types";
import { ClaudeStreamTranslator } from "../translator";

function session() {
  const updates: SessionNotification[] = [];
  let messages: AgentMessage[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "task-runs",
    emit: (note) => {
      updates.push(note);
      messages = applyUpdate(messages, note);
    },
  });
  const system = (subtype: string, extra: Record<string, unknown> = {}) =>
    t.feed({ type: "system", subtype, task_id: "task", ...extra });
  const start = (run_id: string, extra: Record<string, unknown> = {}) =>
    system("task_started", { run_id, description: "Audit source", is_backgrounded: true, ...extra });
  const membership = (run_id?: string) =>
    system("background_tasks_changed", {
      tasks: run_id ? [{ task_id: "task", run_id, description: "Audit source" }] : [],
    });
  const background = () => updates.map((n) => n.update)
    .filter((u) => u.sessionUpdate === "background_tasks_update").at(-1)!;
  const row = () => messages.find((m) => m.kind === "tool" && m.toolKind === "background_task")!;
  t.beginTurn();
  return { t, updates, system, start, membership, background, row };
}

describe("Claude stable tasks with per-run lifetimes", () => {
  it.each(["completed", "failed"])("reopens the same Background Task after a %s run without restarting the turn clock", (status) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { t, updates, system, start, membership, background, row } = session();
      start("run-001");
      membership("run-001");
      const first = row();
      system("task_notification", { run_id: "run-001", status, summary: "First run finished", output_file: "/tmp/first" });
      membership();
      t.feed({ type: "result", subtype: "success" });
      expect(t.hasProcessWork).toBe(false);

      now.mockReturnValue(5_000);
      start("run-002");
      expect(background()).toMatchObject({
        tasks: [{ taskId: "task" }], waiting: true,
        activity: { state: "idle", startedAt: 1_000 },
      });
      expect(t.hasProcessWork).toBe(true);
      expect(row()).toMatchObject({
        id: first.id, status: "in_progress", rawInput: { runOrdinal: 2 },
      });
      expect(row()).not.toHaveProperty("rawOutput.outputFile");
      expect(row()).toHaveProperty("settledAt", undefined);
      membership("run-002");
      start("run-002");
      expect(updates.filter((n) => n.update.sessionUpdate === "tool_call" && n.update.kind === "background_task")).toHaveLength(1);
      expect(JSON.stringify(updates)).not.toContain("run-00");
      system("task_notification", { run_id: "run-002", status: "completed", summary: "Second run finished" });
      expect(row()).toMatchObject({ id: first.id, status: "completed", rawInput: { runOrdinal: 2 }, rawOutput: { summary: "Second run finished" } });
      expect(t.hasProcessWork).toBe(false);
    } finally { now.mockRestore(); }
  });

  it.each([
    ["task_notification", { status: "failed", summary: "Late older completion" }],
    ["task_updated", { patch: { status: "completed" } }],
    ["task_updated", { patch: { is_backgrounded: false } }],
    ["task_progress", { summary: "Late older progress", usage: { duration_ms: 50_000 } }],
    ["task_started", { is_backgrounded: true, description: "Late older start" }],
  ])("ignores an older run's %s after a newer run started", (subtype, extra) => {
    const { t, updates, system, start, membership, background, row } = session();
    start("run-001");
    membership("run-001");
    start("run-002");
    membership("run-002");
    const before = updates.length;
    const snapshot = background();
    system(subtype, { run_id: "run-001", ...extra });
    expect(updates).toHaveLength(before);
    expect(background()).toBe(snapshot);
    expect(t.hasProcessWork).toBe(true);
    expect(row()).toMatchObject({ status: "in_progress", rawInput: { runOrdinal: 2 } });
    system("task_notification", { run_id: "run-002", status: "completed" });
    expect(t.hasProcessWork).toBe(false);
  });

  it("keeps the newest run through a stale membership entry but honors an empty replacement", () => {
    const { t, start, membership, background, row } = session();
    start("run-001");
    membership("run-001");
    start("run-002");
    membership("run-002");
    const snapshot = background();
    membership("run-001");
    expect(background()).toBe(snapshot);
    expect(t.hasProcessWork).toBe(true);
    expect(row()).toMatchObject({ rawInput: { runOrdinal: 2 } });
    membership();
    expect(background().tasks).toEqual([]);
    expect(t.hasProcessWork).toBe(false);
  });

  it("accepts a resumed level before its start edge and still merges same-run terminal bookends", () => {
    const { t, system, start, membership, row } = session();
    start("run-001");
    system("task_notification", { run_id: "run-001", status: "completed" });
    membership();
    membership("run-002");
    start("run-002");
    system("task_updated", { run_id: "run-002", patch: { status: "completed", description: "Resumed audit complete" } });
    system("task_notification", { run_id: "run-002", status: "completed", output_file: "/tmp/second", usage: { duration_ms: 250 } });
    expect(row()).toMatchObject({
      status: "completed", rawInput: { runOrdinal: 2 },
      rawOutput: { summary: "Resumed audit complete", outputFile: "/tmp/second", durationMs: 250 },
    });
    expect(t.hasProcessWork).toBe(false);
  });

  it("retains a resumed ambient run without exposing a row or accepting an older completion", () => {
    const { t, updates, system, start, background } = session();
    start("run-001", { ambient: true });
    system("task_notification", { run_id: "run-001", status: "completed" });
    start("run-002", { ambient: true });
    system("task_notification", { run_id: "run-001", status: "completed" });
    expect(t.hasProcessWork).toBe(true);
    expect(background()).toMatchObject({ tasks: [], waiting: false });
    expect(updates.some((n) => n.update.sessionUpdate === "tool_call")).toBe(false);
    system("task_notification", { run_id: "run-002", status: "completed" });
    expect(t.hasProcessWork).toBe(false);
  });
});
