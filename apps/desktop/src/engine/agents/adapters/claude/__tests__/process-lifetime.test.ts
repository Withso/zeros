import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "../../../types";
import { ClaudeStreamTranslator } from "../translator";

function session() {
  const updates: SessionNotification[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "process-lifetime",
    emit: (note) => updates.push(note),
  });
  const background = () =>
    updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === "background_tasks_update")
      .at(-1)!;
  const workflows = () =>
    updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === "workflow_progress_update")
      .at(-1)?.workflows;
  const system = (subtype: string, extra: Record<string, unknown> = {}) =>
    t.feed({ type: "system", subtype, session_id: "same-session", ...extra });
  const membership = (tasks: Array<{ task_id: string; ambient?: boolean }>) =>
    system("background_tasks_changed", { tasks });
  const start = (task_id: string, extra: Record<string, unknown> = {}) =>
    system("task_started", {
      task_id,
      description: task_id,
      is_backgrounded: true,
      ...extra,
    });
  t.beginTurn();
  system("init");
  return { t, updates, background, workflows, system, membership, start };
}

describe("Claude process-owned work across turn boundaries", () => {
  it("never marks completed rows failed when lifecycle caches evict in different orders", () => {
    const { t, start, system, updates } = session();
    for (let index = 0; index < 500; index++) start(`task-${index}`);
    for (let index = 499; index >= 0; index--) {
      system("task_notification", {
        task_id: `task-${index}`,
        status: "completed",
      });
    }
    start("new-task");
    system("task_notification", { task_id: "new-task", status: "completed" });
    const before = updates.length;
    t.endActivity();
    expect(
      updates
        .slice(before)
        .filter((n) => n.update.sessionUpdate === "tool_call_update"),
    ).toEqual([]);
  });

  it("preserves live tasks, wakeups, their clock and durable rows across repeated init", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { t, updates, background, system, membership, start } = session();
      start("first");
      start("second");
      membership([{ task_id: "first" }, { task_id: "second" }]);
      t.setScheduledWakeups([
        {
          id: "wake",
          schedule: "0 12 5 8 *",
          recurring: false,
          prompt: "Check later",
        },
      ]);
      t.feed({ type: "result", subtype: "success" });
      const before = background();
      now.mockReturnValue(5_000);
      system("init");
      expect(background()).toBe(before);
      expect(t.hasActiveWork).toBe(true);
      expect(t.hasProcessWork).toBe(true);
      system("task_notification", { task_id: "first", status: "completed" });
      expect(background()).toMatchObject({
        waiting: true,
        tasks: [{ taskId: "second" }, { taskType: "scheduled_wakeup" }],
        activity: { state: "idle", startedAt: 1_000 },
      });
      // A replayed start after another turn's metadata cannot duplicate its row.
      system("init");
      start("second");
      const rows = updates
        .map((n) => n.update)
        .filter(
          (u) =>
            u.sessionUpdate === "tool_call" && u.kind === "background_task",
        );
      expect(rows).toHaveLength(2);
      expect(background().tasks[0].startedAt).toBe(1_000);
    } finally {
      now.mockRestore();
    }
  });

  it("retains live workflow state, pause and narrator dedupe until native termination", () => {
    const { t, updates, workflows, system } = session();
    system("task_started", {
      task_id: "workflow",
      task_type: "local_workflow",
    });
    const progress = {
      task_id: "workflow",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Inspect" },
        { type: "workflow_log", message: "Inspecting sources" },
      ],
    };
    system("task_progress", progress);
    system("task_updated", {
      task_id: "workflow",
      patch: { status: "paused" },
    });
    const before = workflows();
    t.feed({ type: "result", subtype: "success" });
    system("init");
    system("task_progress", progress);
    expect(workflows()).toBe(before);
    expect(t.hasActiveWork).toBe(true);
    expect(
      updates.filter(
        (n) =>
          n.update.sessionUpdate === "tool_call" &&
          n.update.title === "Workflow update",
      ),
    ).toHaveLength(1);
    system("task_updated", {
      task_id: "workflow",
      patch: { status: "completed" },
    });
    expect(workflows()).toMatchObject([{ status: "completed" }]);
    expect(t.hasActiveWork).toBe(false);
    expect(t.hasProcessWork).toBe(false);
    t.feed({ type: "result", subtype: "success" });
    expect(workflows()).toEqual([]);
    system("init");
    system("task_progress", progress);
    expect(workflows()).toEqual([]);
  });

  it("resets live ownership on actual process replacement before any init arrives", () => {
    const { t, background, workflows, start, system, updates } = session();
    start("task");
    start("hidden", { ambient: true });
    system("task_started", {
      task_id: "workflow",
      task_type: "local_workflow",
    });
    t.setScheduledWakeups([
      {
        id: "wake",
        schedule: "0 12 5 8 *",
        recurring: false,
        prompt: "Check later",
      },
    ]);
    const oldRow = updates
      .map((n) => n.update)
      .find(
        (u) => u.sessionUpdate === "tool_call" && u.kind === "background_task",
      )!;
    t.beginProcess();
    expect(background()).toMatchObject({
      tasks: [],
      waiting: false,
      activity: null,
    });
    expect(workflows()).toEqual([]);
    expect(t.hasProcessWork).toBe(false);
    expect(
      updates
        .map((n) => n.update)
        .filter(
          (u) =>
            "toolCallId" in u &&
            "toolCallId" in oldRow &&
            u.toolCallId === oldRow.toolCallId,
        )
        .at(-1),
    ).toMatchObject({ status: "failed" });
    // Native session identity may survive resume; task IDs belong to the new process.
    t.beginTurn();
    start("task");
    system("init");
    expect(background().tasks).toMatchObject([{ taskId: "task" }]);
    expect(t.hasProcessWork).toBe(true);
  });

  it("retains hidden ambient ownership without a waiting indicator, and replaces it on an empty level", () => {
    const { t, background, membership, start, system } = session();
    membership([{ task_id: "watcher", ambient: true }]);
    start("watcher", { ambient: true });
    t.feed({ type: "result", subtype: "success" });
    system("init");
    expect(background()).toMatchObject({ tasks: [], waiting: false });
    expect(t.hasActiveWork).toBe(false);
    expect(t.hasProcessWork).toBe(true);
    membership([]);
    expect(t.hasProcessWork).toBe(false);
    // Membership is authoritative even when its matching start edge is delayed.
    start("watcher", { ambient: true });
    expect(t.hasProcessWork).toBe(false);
  });

  it.each(["task_notification", "task_updated"])(
    "releases ambient ownership on %s without leaking transcript rows",
    (subtype) => {
      const { t, background, membership, start, system, updates } = session();
      start("watcher", { ambient: true });
      membership([{ task_id: "watcher", ambient: true }]);
      system("init");
      system(subtype, {
        task_id: "watcher",
        status: "completed",
        patch: { status: "completed" },
      });
      expect(t.hasProcessWork).toBe(false);
      membership([{ task_id: "watcher", ambient: true }]);
      expect(t.hasProcessWork).toBe(false);
      expect(background().tasks).toEqual([]);
      expect(
        updates.filter((n) => n.update.sessionUpdate === "tool_call"),
      ).toEqual([]);
    },
  );

  it("keeps skip_transcript tasks out of indicators on legacy edge-only delivery", () => {
    const { t, background, start, system } = session();
    start("watcher", { skip_transcript: true });
    t.feed({ type: "result", subtype: "success" });
    expect(background()).toMatchObject({ tasks: [], waiting: false });
    expect(t.hasProcessWork).toBe(true);
    system("task_notification", { task_id: "watcher", status: "completed" });
    expect(t.hasProcessWork).toBe(false);
  });

  it("uses the authoritative ambient flag even when an older start edge arrives later", () => {
    const { t, background, membership, start } = session();
    membership([{ task_id: "watcher", ambient: true }]);
    start("watcher", { ambient: false });
    t.feed({ type: "result", subtype: "success" });
    expect(background()).toMatchObject({ tasks: [], waiting: false });
    membership([{ task_id: "watcher", ambient: false }]);
    start("watcher", { ambient: true });
    expect(background()).toMatchObject({
      tasks: [{ taskId: "watcher" }],
      waiting: true,
    });
  });

  it("does not let ambient entries consume the visible task capacity", () => {
    const { t, membership, background } = session();
    membership([
      ...Array.from({ length: 110 }, (_, index) => ({
        task_id: `watcher-${index}`,
        ambient: true,
      })),
      { task_id: "visible-work" },
    ]);
    t.feed({ type: "result", subtype: "success" });
    expect(background()).toMatchObject({
      tasks: [{ taskId: "visible-work" }],
      waiting: true,
    });
    membership([]);
    expect(t.hasProcessWork).toBe(false);
  });

  it("does not clear confirmed membership on a malformed or missing snapshot", () => {
    const { t, membership, system, background } = session();
    membership([{ task_id: "live" }]);
    const before = background();
    system("background_tasks_changed");
    system("background_tasks_changed", { tasks: null });
    expect(background()).toBe(before);
    expect(t.hasProcessWork).toBe(true);
  });

  it("keeps a paused workflow paused when only its description changes after a result", () => {
    const { t, workflows, system } = session();
    system("task_started", {
      task_id: "workflow",
      task_type: "local_workflow",
    });
    system("task_updated", {
      task_id: "workflow",
      patch: { status: "paused" },
    });
    t.feed({ type: "result", subtype: "success" });
    system("task_updated", {
      task_id: "workflow",
      patch: { description: "Waiting for input" },
    });
    expect(workflows()).toMatchObject([
      { name: "Waiting for input", status: "paused" },
    ]);
  });

  it("settles an existing task row when the task becomes ambient before completing", () => {
    const { updates, membership, start, system } = session();
    start("watcher");
    const row = updates
      .map((n) => n.update)
      .find(
        (u) => u.sessionUpdate === "tool_call" && u.kind === "background_task",
      )!;
    membership([{ task_id: "watcher", ambient: true }]);
    system("task_notification", { task_id: "watcher", status: "completed" });
    expect(
      updates
        .map((n) => n.update)
        .filter(
          (u) =>
            "toolCallId" in u &&
            "toolCallId" in row &&
            u.toolCallId === row.toolCallId,
        )
        .at(-1),
    ).toMatchObject({ status: "completed" });
  });

  it("keeps a stopped background row stopped when completion arrives late", () => {
    const { t, start, system, updates, background } = session();
    start("task");
    t.endActivity();
    system("task_notification", {
      task_id: "task",
      status: "completed",
      output_file: "/tmp/task-output",
    });
    expect(
      updates
        .map((n) => n.update)
        .filter(
          (u) =>
            u.sessionUpdate === "tool_call_update" &&
            u.kind === "background_task",
        )
        .at(-1),
    ).toMatchObject({
      status: "failed",
      rawOutput: { status: "stopped", outputFile: "/tmp/task-output" },
    });
    expect(background()).toMatchObject({
      tasks: [],
      waiting: false,
      activity: null,
    });
    expect(t.hasProcessWork).toBe(false);
  });

  it("retains process ownership beyond the UI/ID budgets until the next complete snapshot", () => {
    const { t, membership, system, background } = session();
    membership(
      Array.from({ length: 600 }, (_, index) => ({
        task_id: `watcher-${index}`,
        ambient: true,
      })),
    );
    expect(t.hasProcessWork).toBe(true);
    for (let index = 0; index < 500; index++) {
      system("task_notification", {
        task_id: `watcher-${index}`,
        ambient: true,
        status: "completed",
      });
    }
    expect(t.hasProcessWork).toBe(true);
    expect(background().tasks).toEqual([]);
    membership([]);
    expect(t.hasProcessWork).toBe(false);
  });

  it("excludes an ambient workflow from visible activity while retaining its process", () => {
    const { t, system, membership, workflows } = session();
    system("task_started", {
      task_id: "workflow",
      task_type: "local_workflow",
    });
    membership([{ task_id: "workflow", ambient: true }]);
    t.feed({ type: "result", subtype: "success" });
    expect(workflows()).toEqual([]);
    expect(t.hasActiveWork).toBe(false);
    expect(t.hasProcessWork).toBe(true);
    membership([{ task_id: "workflow", ambient: false }]);
    expect(workflows()).toMatchObject([
      { taskId: "workflow", status: "running" },
    ]);
  });
});
