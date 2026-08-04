// ClaudeStreamTranslator.onUser — verifies the LIVE stream never re-emits
// a `type:"user"` event as a user_message_chunk. In stream-json those
// events are (1) the prompt echo (already shown optimistically + seeded by
// the engine's persistUserPrompt), (2) tool_result wrappers, or (3) a
// SUBAGENT's internal user turn (stamped with parent_tool_use_id). Emitting
// any of them as a top-level user message produced the user's reported bugs:
// a duplicated user bubble, and "a subagent's message shows up as MY
// message". Tool results must still surface; assistant text is unaffected.

import { describe, expect, it } from "vitest";

import { ClaudeStreamTranslator } from "../translator";
import type { SessionNotification } from "../../../types";

function collect() {
  const updates: SessionNotification[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "s1",
    emit: (n) => updates.push(n),
  });
  const kinds = () => updates.map((u) => u.update.sessionUpdate);
  return { t, updates, kinds };
}

describe("ClaudeStreamTranslator onUser", () => {
  it("does NOT re-emit the prompt echo as a user_message_chunk", () => {
    const { t, kinds } = collect();
    t.feed({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    expect(kinds()).not.toContain("user_message_chunk");
  });

  it("does NOT render a subagent's internal user turn as the user (parent_tool_use_id set)", () => {
    const { t, kinds } = collect();
    t.feed({
      type: "user",
      parent_tool_use_id: "toolu_parent",
      message: {
        role: "user",
        content: [{ type: "text", text: "internal subagent prompt" }],
      },
    });
    expect(kinds()).not.toContain("user_message_chunk");
  });

  it("still surfaces a tool_result from a user event as a completed tool_call_update", () => {
    const { t, updates } = collect();
    // Register the tool_use first so the result correlates back to it.
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
        ],
      },
    });
    const upd = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update",
    );
    expect(upd).toBeDefined();
    expect((upd!.update as { status?: string }).status).toBe("completed");
  });

  it("unwraps <tool_use_error> from a failed tool_result's text", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Skill",
            input: { skill: "EnterPlanMode" },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content:
              "<tool_use_error>Unknown skill: EnterPlanMode</tool_use_error>",
          },
        ],
      },
    });
    const upd = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update",
    )!.update as {
      status?: string;
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(upd.status).toBe("failed");
    expect(upd.content?.[0]?.content?.text).toBe(
      "Unknown skill: EnterPlanMode",
    );
  });

  it("still emits assistant text as agent_message_chunk", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(
      updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
    ).toBe(true);
  });
});

describe("ClaudeStreamTranslator task tools", () => {
  it("normalizes TaskCreate with structured output", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-create-1",
            name: "TaskCreate",
            input: {
              subject: "Audit the release workflow",
              description: "Check every release gate.",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      tool_use_result: {
        task: { id: "7", subject: "Audit the release workflow" },
      },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-create-1",
            content: "Task #7 created successfully: Audit the release workflow",
          },
        ],
      },
    });

    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      title: "Task Created",
      kind: "task_create",
    });
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      rawOutput: {
        task: { id: "7", subject: "Audit the release workflow" },
      },
    });
  });

  it.each([
    ["in_progress", "Task Started"],
    ["completed", "Task Completed"],
    ["deleted", "Task Deleted"],
    ["pending", "Task Updated"],
  ])("normalizes TaskUpdate status %s as %s", (status, title) => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `task-update-${status}`,
            name: "TaskUpdate",
            input: { taskId: "7", status },
          },
        ],
      },
    });

    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      title,
      kind: "task_update",
    });
  });
});

describe("ClaudeStreamTranslator background task lifecycle", () => {
  it("does not retain unrelated or unbounded raw tool inputs", () => {
    const { t } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "large-write",
            name: "Write",
            input: {
              file_path: "/tmp/large.txt",
              content: "large-payload-marker".repeat(10_000),
            },
          },
        ],
      },
    });

    const retained = (
      t as unknown as { toolInputs: Map<string, Record<string, unknown>> }
    ).toolInputs;
    expect(retained.size).toBe(0);

    for (let index = 0; index < 520; index += 1) {
      t.feed({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `shell-${index}`,
              name: "Bash",
              input: { command: `printf ${index}` },
            },
          ],
        },
      });
    }
    expect(retained.size).toBeLessThanOrEqual(500);
    expect(JSON.stringify([...retained.values()])).not.toContain(
      "large-payload-marker",
    );
  });

  it("retains start/progress metadata when edge events beat the membership level", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-shell",
            name: "Bash",
            input: { command: "pnpm test:git" },
          },
        ],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-early",
      tool_use_id: "tool-shell",
      description: "Git tests",
      task_type: "shell",
    });
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "task-early",
      summary: "Checking rename cases",
      last_tool_name: "Bash",
      usage: { duration_ms: 4_000 },
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-early",
          task_type: "shell",
          description: "Git tests",
        },
      ],
    });

    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [
        expect.objectContaining({
          taskId: "task-early",
          command: "pnpm test:git",
          summary: "Checking rename cases",
          lastToolName: "Bash",
        }),
      ],
    });
  });

  it("merges one-shot scheduled wakeups into the task snapshot but excludes recurring jobs", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "shell-1",
          task_type: "shell",
          description: "pnpm test",
        },
      ],
    });

    t.setScheduledWakeups([
      {
        id: "wake-1",
        schedule: "3 19 31 7 *",
        recurring: false,
        prompt: "Check whether the deployment is ready",
      },
      {
        id: "cron-1",
        schedule: "0 9 * * 1-5",
        recurring: true,
        prompt: "Daily report",
      },
    ]);

    const snapshots = updates
      .filter((u) => u.update.sessionUpdate === "background_tasks_update")
      .map(
        (u) =>
          u.update as Extract<
            typeof u.update,
            { sessionUpdate: "background_tasks_update" }
          >,
      );
    expect(snapshots.at(-1)?.tasks).toEqual([
      expect.objectContaining({ taskId: "shell-1", name: "pnpm test" }),
      expect.objectContaining({
        taskId: "scheduled-wakeup:wake-1",
        taskType: "scheduled_wakeup",
        name: "Next check at 19:03 · Check whether the deployment is ready",
      }),
    ]);

    // A later native level snapshot replaces only native membership; the
    // independently-authoritative scheduled wake remains present.
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [expect.objectContaining({ taskId: "scheduled-wakeup:wake-1" })],
    });

    t.setScheduledWakeups([]);
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({ tasks: [] });
  });

  it("uses only a successful ScheduleWakeup reason for the next-check row", () => {
    const { t, updates } = collect();
    const schedule = (id: string, reason: string, isError = false) => {
      t.feed({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id,
              name: "ScheduleWakeup",
              input: {
                delaySeconds: 120,
                reason,
                prompt: "<<autonomous-loop-dynamic>>",
              },
            },
          ],
        },
      });
      t.feed({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: isError ? "could not schedule" : "scheduled",
              is_error: isError,
            },
          ],
        },
      });
    };

    schedule("wake-ok", "preview still provisioning");
    schedule("wake-failed", "wrong failed reason", true);
    t.setScheduledWakeups([
      {
        id: "wake-1",
        schedule: "3 19 31 7 *",
        recurring: false,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);

    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [
        expect.objectContaining({
          name: "Next check at 19:03 · preview still provisioning",
        }),
      ],
    });
  });

  it("does not overwrite an existing wake-up reason when a later one is scheduled", () => {
    const { t, updates } = collect();
    t.setScheduledWakeups([
      {
        id: "wake-existing",
        schedule: "3 19 31 7 *",
        recurring: false,
        prompt: "Check the existing deployment",
      },
    ]);
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wake-new-tool",
            name: "ScheduleWakeup",
            input: {
              reason: "check the second deployment",
              prompt: "<<autonomous-loop-dynamic>>",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wake-new-tool",
            content: "scheduled",
          },
        ],
      },
    });
    t.setScheduledWakeups([
      {
        id: "wake-existing",
        schedule: "3 19 31 7 *",
        recurring: false,
        prompt: "Check the existing deployment",
      },
      {
        id: "wake-new",
        schedule: "5 19 31 7 *",
        recurring: false,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);

    const tasks = (
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update as Extract<
        (typeof updates)[number]["update"],
        { sessionUpdate: "background_tasks_update" }
      >
    ).tasks;
    expect(tasks.map((task) => task.name)).toEqual([
      "Next check at 19:03 · Check the existing deployment",
      "Next check at 19:05 · check the second deployment",
    ]);
  });

  it("does not consume a pending reason on an unchanged same-prompt snapshot", () => {
    const { t, updates } = collect();
    const existing = {
      id: "wake-existing",
      schedule: "3 19 31 7 *",
      recurring: false,
      prompt: "<<autonomous-loop-dynamic>>",
    };
    t.setScheduledWakeups([existing]);
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wake-new-tool",
            name: "ScheduleWakeup",
            input: {
              reason: "check the new deployment",
              prompt: "<<autonomous-loop-dynamic>>",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wake-new-tool",
            content: "scheduled",
          },
        ],
      },
    });

    t.setScheduledWakeups([existing]);
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [expect.objectContaining({ name: "Next check at 19:03" })],
    });

    t.setScheduledWakeups([
      existing,
      {
        id: "wake-new",
        schedule: "5 19 31 7 *",
        recurring: false,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [
        expect.objectContaining({ name: "Next check at 19:03" }),
        expect.objectContaining({
          name: "Next check at 19:05 · check the new deployment",
        }),
      ],
    });
  });

  it("attributes a new wake-up reason to the new id, not an existing entry whose schedule also changed", () => {
    const { t, updates } = collect();
    t.setScheduledWakeups([
      {
        id: "wake-existing",
        schedule: "3 19 31 7 *",
        recurring: false,
        prompt: "Check the existing deployment",
      },
    ]);
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wake-new-tool",
            name: "ScheduleWakeup",
            input: {
              reason: "check the new deployment",
              prompt: "<<autonomous-loop-dynamic>>",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wake-new-tool",
            content: "scheduled",
          },
        ],
      },
    });

    t.setScheduledWakeups([
      {
        id: "wake-existing",
        schedule: "4 19 31 7 *",
        recurring: false,
        prompt: "Check the existing deployment",
      },
      {
        id: "wake-new",
        schedule: "5 19 31 7 *",
        recurring: false,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);

    const tasks = (
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update as Extract<
        (typeof updates)[number]["update"],
        { sessionUpdate: "background_tasks_update" }
      >
    ).tasks;
    expect(tasks.map((task) => task.name)).toEqual([
      "Next check at 19:04 · Check the existing deployment",
      "Next check at 19:05 · check the new deployment",
    ]);
  });

  it("keeps a successful wake-up reason across a transient empty hook snapshot", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wake-tool",
            name: "ScheduleWakeup",
            input: {
              reason: "wait for the preview",
              prompt: "<<autonomous-loop-dynamic>>",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wake-tool",
            content: "scheduled",
          },
        ],
      },
    });

    t.setScheduledWakeups([]);
    t.setScheduledWakeups([
      {
        id: "wake-new",
        schedule: "5 19 31 7 *",
        recurring: false,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);

    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [
        expect.objectContaining({
          name: "Next check at 19:05 · wait for the preview",
        }),
      ],
    });
  });

  it("reserves snapshot capacity for a stoppable one-shot wake-up", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: Array.from({ length: 100 }, (_, index) => ({
        task_id: `native-${index}`,
        task_type: "shell",
        description: `Native task ${index}`,
      })),
    });
    t.setScheduledWakeups([
      {
        id: "wake-visible",
        schedule: "5 19 31 7 *",
        recurring: false,
        prompt: "Check the deployment",
      },
    ]);

    const snapshot = updates
      .filter((u) => u.update.sessionUpdate === "background_tasks_update")
      .at(-1)?.update as Extract<
      (typeof updates)[number]["update"],
      { sessionUpdate: "background_tasks_update" }
    >;
    expect(snapshot.tasks).toHaveLength(100);
    expect(snapshot.tasks).toContainEqual(
      expect.objectContaining({ taskId: "scheduled-wakeup:wake-visible" }),
    );
  });

  it("treats background_tasks_changed as a replace snapshot and enriches progress", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Full test suite",
      task_type: "shell",
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-1",
          task_type: "shell",
          description: "Full test suite",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "Running provider checks",
      last_tool_name: "Bash",
      usage: { duration_ms: 12_000 },
    });
    t.feed({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
    });

    const snapshots = updates
      .filter((u) => u.update.sessionUpdate === "background_tasks_update")
      .map(
        (u) =>
          (u.update as unknown as { tasks: Array<Record<string, unknown>> })
            .tasks,
      );
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        name: "Full test suite",
        summary: "Running provider checks",
        lastToolName: "Bash",
      }),
    ]);
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toEqual(expect.objectContaining({ waiting: true }));

    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toEqual({
      sessionUpdate: "background_tasks_update",
      tasks: [],
      waiting: false,
    });
  });

  it("clears a stale waiting flag when a new turn begins without a running-state edge", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-1",
          task_type: "shell",
          description: "Watch deployment",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
    });
    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({ waiting: true });

    t.beginTurn();

    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({ waiting: false });
  });

  it("accepts an updated description from the authoritative level snapshot", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-rename",
          task_type: "shell",
          description: "Starting shell",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-rename",
          task_type: "shell",
          description: "Run pnpm test:git",
        },
      ],
    });

    expect(
      updates
        .filter((u) => u.update.sessionUpdate === "background_tasks_update")
        .at(-1)?.update,
    ).toMatchObject({
      tasks: [expect.objectContaining({ name: "Run pnpm test:git" })],
    });
  });

  it("does not emit a second bridge frame for an identical observation", () => {
    const { t, updates } = collect();
    const level = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-stable",
          task_type: "shell",
          description: "Run tests",
        },
      ],
    };
    t.feed(level);
    const before = updates.filter(
      (u) => u.update.sessionUpdate === "background_tasks_update",
    ).length;

    t.feed(level);

    expect(
      updates.filter(
        (u) => u.update.sessionUpdate === "background_tasks_update",
      ),
    ).toHaveLength(before);
  });

  it("settles one durable Background Task record even when notification repeats", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Full test suite",
      task_type: "shell",
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-1",
          task_type: "shell",
          description: "Full test suite",
        },
      ],
    });
    const notification = {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "212 tests passed",
      output_file: "/tmp/task-1.output",
      usage: { duration_ms: 12_000 },
    };
    t.feed(notification);
    t.feed(notification);

    const lifecycle = updates.filter((u) => {
      const update = u.update as { kind?: string };
      return (
        (u.update.sessionUpdate === "tool_call" ||
          u.update.sessionUpdate === "tool_call_update") &&
        update.kind === "background_task"
      );
    });
    expect(
      lifecycle.filter((u) => u.update.sessionUpdate === "tool_call"),
    ).toHaveLength(1);
    expect(lifecycle[0]?.update).toMatchObject({
      title: "Background Task",
    });
    expect(
      lifecycle.filter((u) => u.update.sessionUpdate === "tool_call_update"),
    ).toHaveLength(1);
    expect(lifecycle.at(-1)?.update).toEqual(
      expect.objectContaining({
        title: "Background Task",
        status: "completed",
        rawOutput: expect.objectContaining({
          status: "completed",
          summary: "212 tests passed",
        }),
      }),
    );
  });

  it("merges terminal update details into the later notification on one row", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-merge",
      description: "Deploy preview",
      task_type: "shell",
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-merge",
          task_type: "shell",
          description: "Deploy preview",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "task_updated",
      task_id: "task-merge",
      patch: {
        status: "failed",
        description: "Deployment did not complete",
        error: "Preview service returned 503",
      },
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-merge",
      status: "failed",
      summary: "Deployment failed",
      output_file: "/tmp/task-merge.output",
      usage: { duration_ms: 2_000 },
    });

    const lifecycle = updates.filter((notification) => {
      const update = notification.update as { kind?: string };
      return (
        (notification.update.sessionUpdate === "tool_call" ||
          notification.update.sessionUpdate === "tool_call_update") &&
        update.kind === "background_task"
      );
    });
    expect(
      lifecycle.filter(
        (notification) => notification.update.sessionUpdate === "tool_call",
      ),
    ).toHaveLength(1);
    expect(lifecycle.at(-1)?.update).toMatchObject({
      status: "failed",
      rawOutput: {
        status: "failed",
        summary: "Deployment failed",
        error: "Preview service returned 503",
        outputFile: "/tmp/task-merge.output",
        durationMs: 2_000,
      },
    });
  });

  it("never turns a provider task notification into human input", () => {
    const { t, kinds } = collect();
    t.feed({
      type: "user",
      parent_tool_use_id: "task-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "background task completed" }],
      },
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "done",
      output_file: "/tmp/task-1.output",
      usage: { duration_ms: 100 },
    });
    expect(kinds()).not.toContain("user_message_chunk");
  });

  it("retains level metadata when completion arrives without a start edge", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-without-start",
          task_type: "local_bash",
          description: "Full test suite",
        },
      ],
    });
    // The level signal commonly removes the task before the completion edge.
    // Missing task_started must not make that ordering erase durable history.
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-without-start",
      status: "completed",
      summary: "All tests passed",
      output_file: "/tmp/task.output",
      usage: { duration_ms: 1_000 },
    });

    expect(
      updates.find((update) => {
        const payload = update.update as { kind?: string };
        return (
          update.update.sessionUpdate === "tool_call" &&
          payload.kind === "background_task"
        );
      })?.update,
    ).toMatchObject({
      rawInput: {
        taskId: "task-without-start",
        name: "Full test suite",
        taskType: "local_bash",
      },
    });
  });

  it("keeps a missed-start ambient task out of durable history", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "ambient-task",
          task_type: "housekeeping",
          description: "Refresh internal index",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "ambient-task",
      status: "completed",
      summary: "done",
      skip_transcript: true,
    });

    expect(
      updates.filter((notification) => {
        const update = notification.update as { kind?: string };
        return (
          (notification.update.sessionUpdate === "tool_call" ||
            notification.update.sessionUpdate === "tool_call_update") &&
          update.kind === "background_task"
        );
      }),
    ).toEqual([]);
  });

  it("does not resurrect a completed task from a late level snapshot", () => {
    const { t, updates } = collect();
    const active = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-1",
          task_type: "shell",
          description: "Full test suite",
        },
      ],
    };
    t.feed(active);
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "done",
      usage: { duration_ms: 100 },
    });
    // SDK docs explicitly leave ordering between level and edge signals
    // unspecified. A stale level event after the completion must not reopen it.
    t.feed(active);

    const final = updates
      .filter((u) => u.update.sessionUpdate === "background_tasks_update")
      .at(-1)?.update as unknown as { tasks: unknown[] };
    expect(final.tasks).toEqual([]);
  });

  it("does not resurrect a completed task from a late backgrounding edge", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "task-1",
          task_type: "shell",
          description: "Full test suite",
        },
      ],
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "done",
      usage: { duration_ms: 100 },
    });
    t.feed({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "running", is_backgrounded: true },
    });

    const final = updates
      .filter((u) => u.update.sessionUpdate === "background_tasks_update")
      .at(-1)?.update as unknown as { tasks: unknown[] };
    expect(final.tasks).toEqual([]);
  });

  it("settles a task backgrounded and completed in the same update", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "fast-background-task",
      description: "Fast background task",
      task_type: "shell",
    });
    t.feed({
      type: "system",
      subtype: "task_updated",
      task_id: "fast-background-task",
      patch: {
        status: "completed",
        is_backgrounded: true,
        description: "Finished immediately",
      },
    });

    const lifecycle = updates.filter((notification) => {
      const update = notification.update as { kind?: string };
      return (
        (notification.update.sessionUpdate === "tool_call" ||
          notification.update.sessionUpdate === "tool_call_update") &&
        update.kind === "background_task"
      );
    });
    expect(
      lifecycle.map((notification) => notification.update.sessionUpdate),
    ).toEqual(["tool_call", "tool_call_update"]);
    expect(lifecycle.at(-1)?.update).toMatchObject({
      status: "completed",
      rawOutput: {
        status: "completed",
        summary: "Finished immediately",
      },
    });
    const snapshots = updates.filter(
      (notification) =>
        notification.update.sessionUpdate === "background_tasks_update",
    );
    expect(snapshots).toEqual([]);
  });

  it("does not create a Background Task transcript row for foreground subagents", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "foreground-subagent",
      description: "Explore the repository",
      task_type: "subagent",
      subagent_type: "Explore",
    });
    t.feed({
      type: "system",
      subtype: "task_notification",
      task_id: "foreground-subagent",
      status: "completed",
      summary: "done",
      usage: { duration_ms: 100 },
    });

    expect(
      updates.filter((notification) => {
        const update = notification.update as { kind?: string };
        return (
          (notification.update.sessionUpdate === "tool_call" ||
            notification.update.sessionUpdate === "tool_call_update") &&
          update.kind === "background_task"
        );
      }),
    ).toEqual([]);
  });
});

// Token-by-token streaming: with streamPartials on, text/thinking render
// from stream_event deltas, and the matching blocks of the final full
// assistant message are skipped so nothing double-renders.
function collectPartials() {
  const updates: SessionNotification[] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "s1",
    emit: (n) => updates.push(n),
    streamPartials: true,
  });
  return { t, updates };
}
const textDelta = (text: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const thinkingDelta = (thinking: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: {
    type: "content_block_delta",
    delta: { type: "thinking_delta", thinking },
  },
});
type ChunkUpdate = {
  content?: { text?: string };
  messageId?: string;
  parentToolId?: string;
  redacted?: boolean;
};

describe("ClaudeStreamTranslator local workflow progress", () => {
  it("replaces live phase progress, surfaces narration as a standard tool row, and clears at turn end", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "workflow-1",
      task_type: "local_workflow",
      workflow_name: "dependency-audit",
    });
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-1",
      usage: { duration_ms: 2_000 },
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Find" },
        {
          type: "workflow_agent",
          index: 0,
          label: "scan package manifests",
          phaseIndex: 0,
          phaseTitle: "Find",
          state: "done",
        },
        {
          type: "workflow_agent",
          index: 1,
          label: "scan lockfiles",
          phaseIndex: 0,
          phaseTitle: "Find",
          state: "progress",
        },
        { type: "workflow_phase", index: 1, title: "Verify" },
        {
          type: "workflow_agent",
          index: 0,
          label: "verify findings",
          phaseIndex: 1,
          phaseTitle: "Verify",
          state: "start",
        },
        {
          type: "workflow_log",
          message: "Find phase identified two dependency risks.",
        },
      ],
    });

    const workflowUpdates = updates.filter(
      (note) => note.update.sessionUpdate === "workflow_progress_update",
    ) as Array<{
      update: {
        workflows: Array<{
          taskId: string;
          name: string;
          status: string;
          phases: Array<{
            title: string;
            completed: number;
            total: number;
            status: string;
          }>;
        }>;
      };
    }>;
    expect(workflowUpdates.at(-1)?.update.workflows).toMatchObject([
      {
        taskId: "workflow-1",
        name: "dependency-audit",
        status: "running",
        phases: [
          { title: "Find", completed: 1, total: 2, status: "running" },
          { title: "Verify", completed: 0, total: 1, status: "running" },
        ],
      },
    ]);

    const narration = updates.filter((note) => {
      const update = note.update as {
        sessionUpdate?: string;
        title?: string;
        rawOutput?: unknown;
      };
      return (
        update.sessionUpdate === "tool_call" &&
        update.title === "Workflow update"
      );
    });
    expect(narration).toHaveLength(1);
    expect(narration[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      status: "completed",
      rawOutput: "Find phase identified two dependency risks.",
    });
    expect(narration[0].update).not.toHaveProperty("kind");

    // A level-identical provider frame does not cross the bridge twice, and
    // the same narrator line does not duplicate in the transcript.
    const before = updates.length;
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-1",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Find" },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 0,
          phaseTitle: "Find",
          state: "done",
        },
        {
          type: "workflow_agent",
          index: 1,
          phaseIndex: 0,
          phaseTitle: "Find",
          state: "progress",
        },
        { type: "workflow_phase", index: 1, title: "Verify" },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 1,
          phaseTitle: "Verify",
          state: "start",
        },
        {
          type: "workflow_log",
          message: "Find phase identified two dependency risks.",
        },
      ],
    });
    expect(updates).toHaveLength(before);

    t.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const cleared = updates.filter(
      (note) => note.update.sessionUpdate === "workflow_progress_update",
    ).at(-1)?.update as { workflows?: unknown[] };
    expect(cleared.workflows).toEqual([]);
  });

  it("scopes narrator dedupe to the workflow RUN, not the whole SDK process", () => {
    const { t, updates } = collect();
    const narrationCount = () =>
      updates.filter(
        (note) =>
          (note.update as { sessionUpdate?: string; title?: string })
            .sessionUpdate === "tool_call" &&
          (note.update as { title?: string }).title === "Workflow update",
      ).length;
    const run = () => {
      t.feed({
        type: "system",
        subtype: "task_started",
        task_id: "workflow-1",
        task_type: "local_workflow",
        workflow_name: "dependency-audit",
      });
      t.feed({
        type: "system",
        subtype: "task_progress",
        task_id: "workflow-1",
        workflow_progress: [
          { type: "workflow_phase", index: 0, title: "Find" },
          { type: "workflow_log", message: "Scanning 12 manifests." },
        ],
      });
    };

    run();
    expect(narrationCount()).toBe(1);
    // Same line, same run → still exactly one durable row.
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-1",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Find" },
        { type: "workflow_log", message: "Scanning 12 manifests." },
      ],
    });
    expect(narrationCount()).toBe(1);

    t.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    // A LATER workflow re-using the task id must narrate again rather than be
    // silently suppressed by the previous run's fingerprint.
    run();
    expect(narrationCount()).toBe(2);
  });

  it("recovers when workflow progress arrives before task_started", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-out-of-order",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Find" },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 0,
          state: "done",
        },
      ],
    });
    const latest = updates.filter(
      (note) => note.update.sessionUpdate === "workflow_progress_update",
    ).at(-1)?.update as {
      workflows?: Array<{ taskId: string; phases: unknown[] }>;
    };
    expect(latest.workflows?.[0]).toMatchObject({
      taskId: "workflow-out-of-order",
      phases: [{ title: "Find", completed: 1, total: 1 }],
    });
  });

  it("counts cumulative state transitions for one workflow agent only once", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "task_started",
      task_id: "workflow-cumulative",
      task_type: "local_workflow",
      workflow_name: "cumulative-progress",
    });
    t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-cumulative",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 0,
          label: "run tests",
          state: "start",
        },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 0,
          label: "run tests",
          state: "progress",
        },
        {
          type: "workflow_agent",
          index: 0,
          phaseIndex: 0,
          label: "run tests",
          state: "done",
        },
        {
          type: "workflow_agent",
          index: 1,
          phaseIndex: 0,
          label: "review output",
          state: "progress",
        },
      ],
    });

    const latest = updates.filter(
      (note) => note.update.sessionUpdate === "workflow_progress_update",
    ).at(-1)?.update as {
      workflows?: Array<{
        phases: Array<{
          index: number;
          title: string;
          completed: number;
          total: number;
          status: string;
        }>;
      }>;
    };
    expect(latest.workflows?.[0]?.phases).toEqual([
      {
        index: 0,
        title: "Verify",
        completed: 1,
        total: 2,
        status: "running",
      },
    ]);
  });

  it("preserves an out-of-order pause edge and never reopens after a terminal edge", () => {
    const paused = collect();
    paused.t.feed({
      type: "system",
      subtype: "task_updated",
      task_id: "workflow-paused",
      patch: { status: "paused" },
    });
    paused.t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-paused",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
      ],
    });
    const pausedFrame = paused.updates.filter(
      (note) => note.update.sessionUpdate === "workflow_progress_update",
    ).at(-1)?.update as { workflows?: Array<{ status: string }> };
    expect(pausedFrame.workflows?.[0]?.status).toBe("paused");

    const terminal = collect();
    terminal.t.feed({
      type: "system",
      subtype: "task_updated",
      task_id: "workflow-done",
      patch: { status: "completed" },
    });
    terminal.t.feed({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-done",
      workflow_progress: [
        { type: "workflow_phase", index: 0, title: "Find" },
      ],
    });
    expect(
      terminal.updates.some(
        (note) => note.update.sessionUpdate === "workflow_progress_update",
      ),
    ).toBe(false);
  });
});

describe("ClaudeStreamTranslator streamPartials (token streaming)", () => {
  it("emits a chunk per text_delta and SKIPS the final full assistant text", () => {
    const { t, updates } = collectPartials();
    t.feed(textDelta("Hel"));
    t.feed(textDelta("lo"));
    // Final full message arrives with the SAME text — must NOT re-emit.
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
    const chunks = updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks.map((u) => (u.update as ChunkUpdate).content?.text)).toEqual([
      "Hel",
      "lo",
    ]);
    // Coalesced under a single messageId so the renderer grows one bubble.
    expect(
      new Set(chunks.map((u) => (u.update as ChunkUpdate).messageId)).size,
    ).toBe(1);
  });

  // De-dup mechanism (2026-07-12): the per-token accumulator IS grown on
  // the live path again, and onAssistant compares the final full block
  // against it — a streamed block adds nothing, while a SYNTHETIC no-delta
  // message (see the "synthetic assistant text" suite) still renders.
  // Three single-char deltas, then ONE final full block carrying the
  // concatenation — exactly 3 chunks emit, and the final adds NOTHING.
  it("emits one chunk per delta and the final full assistant block adds nothing", () => {
    const { t, updates } = collectPartials();
    t.feed(textDelta("a"));
    t.feed(textDelta("b"));
    t.feed(textDelta("c"));
    const chunksBeforeFinal = updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    ).length;
    // Final full message carries the full concatenation "abc".
    t.feed({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
    });
    const chunks = updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    // Exactly the three deltas — the final full block emitted no new chunk.
    expect(chunks.map((u) => (u.update as ChunkUpdate).content?.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(chunks.length).toBe(chunksBeforeFinal);
    expect(chunks.length).toBe(3);
  });

  it("emits thinking deltas and skips the final full thinking block", () => {
    const { t, updates } = collectPartials();
    t.feed(thinkingDelta("pondering"));
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pondering" }],
      },
    });
    const thoughts = updates.filter(
      (u) => u.update.sessionUpdate === "agent_thought_chunk",
    );
    expect(thoughts.length).toBe(1);
    expect((thoughts[0].update as ChunkUpdate).content?.text).toBe("pondering");
  });

  it("still renders redacted_thinking from the final message (it has no delta form)", () => {
    const { t, updates } = collectPartials();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "xx" }],
      },
    });
    expect(
      updates.some(
        (u) =>
          u.update.sessionUpdate === "agent_thought_chunk" &&
          (u.update as ChunkUpdate).redacted === true,
      ),
    ).toBe(true);
  });

  it("propagates parentToolId for a subagent's streamed text", () => {
    const { t, updates } = collectPartials();
    // Register the parent Task tool_use so its id resolves.
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_parent", name: "Task", input: {} },
        ],
      },
    });
    t.feed({
      type: "stream_event",
      parent_tool_use_id: "toolu_parent",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "sub" },
      },
    });
    const chunk = updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunk).toBeDefined();
    expect((chunk!.update as ChunkUpdate).parentToolId).toBeTruthy();
  });

  it("renders a helper heartbeat Bash operation as the standard nested Bash tool call", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_parent",
            name: "Task",
            input: { description: "Audit dependencies" },
          },
        ],
      },
    });
    const parent = updates.find(
      (note) =>
        note.update.sessionUpdate === "tool_call" &&
        (note.update as { nativeToolCallId?: string }).nativeToolCallId ===
          "toolu_parent",
    )?.update as { toolCallId?: string } | undefined;

    t.feed({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_helper_bash",
            name: "Bash",
            input: { command: "git status --short" },
          },
        ],
      },
    });
    const child = updates.find(
      (note) =>
        note.update.sessionUpdate === "tool_call" &&
        (note.update as { nativeToolCallId?: string }).nativeToolCallId ===
          "toolu_helper_bash",
    )?.update as
      | { kind?: string; parentToolId?: string; title?: string }
      | undefined;

    expect(parent?.toolCallId).toBeTruthy();
    expect(child).toMatchObject({
      kind: "execute",
      parentToolId: parent?.toolCallId,
    });
    expect(child?.title).toContain("git status --short");
  });

  it("coalesces redacted_thinking onto the streamed thinking (same messageId)", () => {
    const { t, updates } = collectPartials();
    t.feed(thinkingDelta("reasoning"));
    // Anthropic interleaves a redacted block WITH the plaintext thinking of the
    // same reasoning step. The redacted sentinel must land on the SAME bubble
    // (messageId) as the already-streamed thinking — NOT rotate into a separate
    // thought bubble. (Before the fix, redacted_thinking failed the
    // text/thinking-only check and rotated the id, splitting the two.)
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "redacted_thinking", data: "xx" },
        ],
      },
    });
    const thoughts = updates.filter(
      (u) => u.update.sessionUpdate === "agent_thought_chunk",
    );
    // One streamed delta + one redacted sentinel, under a SINGLE messageId.
    expect(
      new Set(thoughts.map((u) => (u.update as ChunkUpdate).messageId)).size,
    ).toBe(1);
    expect(
      thoughts.some((u) => (u.update as ChunkUpdate).redacted === true),
    ).toBe(true);
  });
});

// Regression: the SDK adapter reuses ONE translator for the whole session
// (persistent query) and reads `terminalError` after EVERY result to classify
// auth-required / session-expired. The field must reflect only the LATEST
// turn — otherwise one error turn poisons every later (even successful) turn,
// permanently locking the session.
describe("ClaudeStreamTranslator terminalError (per-turn reset)", () => {
  it("captures the error text of an is_error result", () => {
    const { t } = collect();
    t.feed({ type: "result", is_error: true, result: "Please sign in" });
    expect(t.terminalError).toBe("Please sign in");
  });

  it("CLEARS terminalError on a later clean result (no cross-turn poisoning)", () => {
    const { t } = collect();
    t.feed({ type: "result", is_error: true, result: "Please sign in" });
    expect(t.terminalError).toBe("Please sign in");
    // Next turn succeeds — the stale error must not linger and re-trigger a
    // false auth-required / session-expired rejection.
    t.feed({ type: "result", is_error: false, subtype: "success" });
    expect(t.terminalError).toBeNull();
  });
});

describe("ClaudeStreamTranslator MultiEdit routing", () => {
  it("routes MultiEdit to the edit card (kind=edit, 'Editing <path>')", () => {
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_me",
            name: "MultiEdit",
            input: {
              file_path: "/abs/app.ts",
              edits: [
                { old_string: "a", new_string: "b" },
                { old_string: "c", new_string: "d" },
              ],
            },
          },
        ],
      },
    });
    const call = updates.find((u) => u.update.sessionUpdate === "tool_call");
    expect(call).toBeDefined();
    expect((call!.update as { kind?: string }).kind).toBe("edit");
    expect((call!.update as { title?: string }).title).toBe(
      "Editing /abs/app.ts",
    );
  });
});

describe("ClaudeStreamTranslator tool_call identity", () => {
  it("carries Claude's native tool_use id as nativeToolCallId (question-card correlation)", () => {
    // The QuestionRequest / permission request reference Claude's OWN
    // tool_use id (canUseTool's toolUseID) while the timeline row gets a
    // minted uuid — nativeToolCallId is the bridge between the two. Without
    // it the question card's AWAITING/ANSWERED/SKIPPED states can never
    // match their transcript row.
    const { t, updates } = collect();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_ask1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Pick one", options: [] }] },
          },
        ],
      },
    });
    const call = updates.find((u) => u.update.sessionUpdate === "tool_call");
    expect(call).toBeDefined();
    const upd = call!.update as {
      toolCallId?: string;
      nativeToolCallId?: string;
      kind?: string;
    };
    expect(upd.nativeToolCallId).toBe("toolu_ask1");
    expect(upd.kind).toBe("question");
    // The minted uuid stays distinct — updates still correlate through it.
    expect(upd.toolCallId).toBeDefined();
    expect(upd.toolCallId).not.toBe("toolu_ask1");
  });
});

describe("ClaudeStreamTranslator tool_use_result structuredPatch (2026-07-05)", () => {
  // Claude Code's rich result for Edit/Write/MultiEdit carries
  // `structuredPatch` — real hunks with REAL file line numbers. The
  // translator surfaces just that field as rawOutput so the EditCard renders
  // the true patch; everything else (originalFile = the whole pre-edit file)
  // is dropped before persistence.
  const HUNK = {
    oldStart: 40,
    oldLines: 3,
    newStart: 40,
    newLines: 4,
    lines: [" ctx", "-old", "+new1", "+new2"],
  };

  function feedEditResult(toolUseResult: unknown) {
    const updates: SessionNotification[] = [];
    const t = new ClaudeStreamTranslator({
      sessionId: "s1",
      emit: (n) => updates.push(n),
    });
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_e",
            name: "Edit",
            input: {
              file_path: "/x.ts",
              old_string: "old",
              new_string: "new1\nnew2",
            },
          },
        ],
      },
    });
    t.feed({
      type: "user",
      tool_use_result: toolUseResult,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_e", content: "ok" },
        ],
      },
    });
    return updates.find((u) => u.update.sessionUpdate === "tool_call_update")!
      .update as { rawOutput?: unknown };
  }

  it("surfaces structuredPatch as rawOutput and drops originalFile", () => {
    const upd = feedEditResult({
      filePath: "/x.ts",
      originalFile: "the entire pre-edit file body…",
      structuredPatch: [HUNK],
    });
    expect(upd.rawOutput).toEqual({ structuredPatch: [HUNK] });
  });

  it("keeps content-array rawOutput when the result has no structuredPatch", () => {
    const upd = feedEditResult({ stdout: "done", stderr: "" });
    expect(upd.rawOutput).toBe("ok");
  });

  it("keeps content-array rawOutput for a malformed structuredPatch", () => {
    const upd = feedEditResult({ structuredPatch: [{ nope: true }] });
    expect(upd.rawOutput).toBe("ok");
  });
});

// ── api_retry → error_notice ─────────────────────────────
//
// The CLI retries transient API errors itself, emitting one
// `system/api_retry` per attempt. The translator surfaces ONE compact
// error_notice row per retry BURST (not per attempt) so the user sees why
// the stream stalled without ten rows landing in the transcript. Any
// non-system event ends the burst; a later api_retry starts a new one.
describe("ClaudeStreamTranslator api_retry", () => {
  const apiRetry = (attempt: number, status: number | null = 529) => ({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 2_000,
    error_status: status,
    session_id: "sdk-1",
  });
  const notices = (updates: SessionNotification[]) =>
    updates.filter((u) => u.update.sessionUpdate === "error_notice");

  it("emits ONE recoverable warning notice for a retry burst", () => {
    const { t, updates } = collect();
    t.feed(apiRetry(1));
    t.feed(apiRetry(2));
    t.feed(apiRetry(3));
    const rows = notices(updates);
    expect(rows.length).toBe(1);
    const upd = rows[0].update as {
      severity?: string;
      recoverable?: boolean;
      message?: string;
      noticeId?: string;
    };
    expect(upd.severity).toBe("warning");
    expect(upd.recoverable).toBe(true);
    expect(upd.message).toContain("HTTP 529");
    expect(upd.message).toMatch(/retrying/i);
    expect(upd.noticeId).toBeTruthy();
    // The renderer keys its live "Reconnecting agent" shimmer row on this
    // code (event-row-renderer.tsx / event-meta.ts) — a rename breaks the UI.
    expect((rows[0].update as { code?: string }).code).toBe("api_retry");
  });

  it("labels a no-response connection error without an HTTP status", () => {
    const { t, updates } = collect();
    t.feed(apiRetry(1, null));
    const upd = notices(updates)[0].update as { message?: string };
    expect(upd.message).toContain("connection error");
  });

  it("a new burst after real progress gets its own notice row", () => {
    const { t, updates } = collect();
    t.feed(apiRetry(1));
    // The retried call succeeded — assistant output flows again.
    t.feed({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
    });
    // A second blip later in the same turn.
    t.feed(apiRetry(1));
    const rows = notices(updates);
    expect(rows.length).toBe(2);
    // Distinct noticeIds so the reducer renders two rows, not a dedupe.
    const ids = rows.map((r) => (r.update as { noticeId?: string }).noticeId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("does not emit notices for other unknown system subtypes", () => {
    const { t, updates } = collect();
    t.feed({ type: "system", subtype: "status", session_id: "sdk-1" });
    t.feed({ type: "system", subtype: "hook_started", session_id: "sdk-1" });
    expect(notices(updates).length).toBe(0);
  });
});

describe("ClaudeStreamTranslator compact_boundary (§3.5 Task C)", () => {
  it("emits a SETTLED compaction tool row with trigger/preTokens detail", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      compact_metadata: { trigger: "auto", pre_tokens: 168_400 },
    } as never);
    const rows = updates.filter((u) => u.update.sessionUpdate === "tool_call");
    expect(rows).toHaveLength(1);
    const row = rows[0].update as {
      title: string;
      kind: string;
      status: string;
      rawInput: { trigger?: string; preTokens?: number };
    };
    // Claude's signal arrives AT the boundary — the row appears directly
    // settled ("Context compacted · Done"), never a fake "Compacting.." phase.
    expect(row.title).toBe("Context compacted");
    expect(row.kind).toBe("compaction");
    expect(row.status).toBe("completed");
    expect(row.rawInput).toEqual({ trigger: "auto", preTokens: 168_400 });
  });

  it("tolerates a boundary with no compact_metadata", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
    } as never);
    const row = updates.find((u) => u.update.sessionUpdate === "tool_call")!
      .update as { title: string; rawInput: object };
    expect(row.title).toBe("Context compacted");
    expect(row.rawInput).toEqual({});
  });
});

describe("ClaudeStreamTranslator compaction lifecycle (status messages, 2026-07-12)", () => {
  // Wire-verified against claude CLI 2.1.207: /compact narrates as
  // system/status {status:"compacting"} → (success) system/compact_boundary,
  // or (failure) system/status {compact_result:"failed", compact_error}.
  const compacting = {
    type: "system",
    subtype: "status",
    status: "compacting",
    session_id: "sdk-1",
  } as never;

  it("status:compacting opens ONE running row; the boundary settles the SAME row", () => {
    const { t, updates } = collect();
    t.feed(compacting);
    const open = updates.filter((u) => u.update.sessionUpdate === "tool_call");
    expect(open).toHaveLength(1);
    const row = open[0].update as {
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      rawInput: { trigger?: string };
    };
    expect(row.title).toBe("Compacting context");
    expect(row.kind).toBe("compaction");
    expect(row.status).toBe("in_progress");
    expect(row.rawInput.trigger).toBe("auto");

    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      compact_metadata: { trigger: "auto", pre_tokens: 90_000 },
    } as never);
    // Settled via tool_call_update on the SAME id — no second row.
    expect(
      updates.filter((u) => u.update.sessionUpdate === "tool_call"),
    ).toHaveLength(1);
    const settle = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update",
    )!.update as { toolCallId: string; title: string; status: string };
    expect(settle.toolCallId).toBe(row.toolCallId);
    expect(settle.title).toBe("Context compacted");
    expect(settle.status).toBe("completed");
  });

  it("compact_result:failed settles the row as a visible failure with the CLI's reason", () => {
    const { t, updates } = collect();
    t.feed(compacting);
    t.feed({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "Not enough messages to compact.",
      session_id: "sdk-1",
    } as never);
    const settle = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update",
    )!.update as {
      title: string;
      status: string;
      rawOutput?: { error?: string };
    };
    expect(settle.title).toBe("Compaction failed");
    expect(settle.status).toBe("failed");
    expect(settle.rawOutput?.error).toBe("Not enough messages to compact.");
  });

  it("expectManualCompaction stamps the row's trigger as manual (standalone placement)", () => {
    const { t, updates } = collect();
    t.expectManualCompaction();
    t.feed(compacting);
    const row = updates.find((u) => u.update.sessionUpdate === "tool_call")!
      .update as { rawInput: { trigger?: string } };
    expect(row.rawInput.trigger).toBe("manual");
  });

  it("a second compaction after a settled one opens a FRESH row", () => {
    const { t, updates } = collect();
    t.feed(compacting);
    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      compact_metadata: { trigger: "auto" },
    } as never);
    t.feed(compacting);
    const rows = updates.filter((u) => u.update.sessionUpdate === "tool_call");
    expect(rows).toHaveLength(2);
  });

  it("early success-status settles; the trailing boundary only merges metadata (no dup row)", () => {
    const { t, updates } = collect();
    t.feed(compacting);
    t.feed({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      session_id: "sdk-1",
    } as never);
    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      compact_metadata: { trigger: "manual", pre_tokens: 120_000 },
    } as never);
    expect(
      updates.filter((u) => u.update.sessionUpdate === "tool_call"),
    ).toHaveLength(1);
    const settles = updates.filter(
      (u) => u.update.sessionUpdate === "tool_call_update",
    );
    expect(settles.length).toBe(2); // early settle + metadata merge
    const merged = settles[1].update as { rawInput?: { preTokens?: number } };
    expect(merged.rawInput?.preTokens).toBe(120_000);
  });

  it("a standalone boundary (no status narration) still emits a settled row", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      compact_metadata: { trigger: "auto", pre_tokens: 10 },
    } as never);
    const rows = updates.filter((u) => u.update.sessionUpdate === "tool_call");
    expect(rows).toHaveLength(1);
    expect((rows[0].update as { status: string }).status).toBe("completed");
  });

  it("local_command_output renders as assistant-style text", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "local_command_output",
      content: "Current usage: 42%",
      session_id: "sdk-1",
    } as never);
    const chunk = updates.find(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunk).toBeDefined();
    expect(
      (chunk!.update as { content?: { text?: string } }).content?.text ?? "",
    ).toBe("Current usage: 42%");
  });
});

describe("ClaudeStreamTranslator result usage_update (zero-dip guard, 2026-07-12)", () => {
  it("a billed result emits size/used", () => {
    const { t, updates } = collect();
    t.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 5_000, output_tokens: 300 },
    } as never);
    const u = updates.find((x) => x.update.sessionUpdate === "usage_update")!
      .update as { size?: number; used?: number };
    expect(u.used).toBe(5_000);
    // No init seen yet → unknown model → the conservative 200k default.
    expect(u.size).toBe(200_000);
  });

  it("reports the 1M window for every 1M model the picker offers", () => {
    // REGRESSION (2026-07-25): contextWindowForClaudeModel only matched
    // /opus-4-[78].*\[1m\]/, so Fable 5, Sonnet 5 and Opus 5 reported 200k
    // here while the picker listed them as 1M models — the gauge read 5x
    // fuller than reality until the adapter's best-effort getContextUsage
    // overwrite landed (and stayed wrong whenever that control request was
    // unavailable). The rule now lives in @zeros/core, shared with the
    // renderer's attachment budget.
    for (const model of [
      "claude-fable-5[1m]",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
    ]) {
      const { t, updates } = collect();
      t.feed({
        type: "system",
        subtype: "init",
        session_id: "abc",
        model,
      } as never);
      t.feed({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 5_000, output_tokens: 300 },
      } as never);
      const u = updates.find((x) => x.update.sessionUpdate === "usage_update")!
        .update as { size?: number };
      expect(u.size, model).toBe(1_000_000);
    }
  });

  it("keeps Haiku at 200k (declares a 1m suffix but has no 1M beta)", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "init",
      session_id: "abc",
      model: "claude-haiku-4-5",
    } as never);
    t.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1_000, output_tokens: 10 },
    } as never);
    const u = updates.find((x) => x.update.sessionUpdate === "usage_update")!
      .update as { size?: number };
    expect(u.size).toBe(200_000);
  });

  it("a ~zero-usage result (the /compact run) does NOT clobber the window reading", () => {
    // The compact run settles with ~zero billed usage; writing used:0 into
    // the store made the gauge dip to 0 until getContextUsage overwrote it.
    const { t, updates } = collect();
    t.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as never);
    const usageUpdates = updates.filter(
      (x) => x.update.sessionUpdate === "usage_update",
    );
    for (const u of usageUpdates) {
      const upd = u.update as { size?: number; used?: number };
      expect(upd.used).toBeUndefined();
      expect(upd.size).toBeUndefined();
    }
  });
});

describe("ClaudeStreamTranslator synthetic assistant text (2026-07-12)", () => {
  // A synthetic full assistant message with NO stream deltas (the CLI's
  // local responses — e.g. "Not enough messages to compact." after a failed
  // /compact) must render. Before this fix the streamPartials path skipped
  // ALL text blocks, so those messages vanished ("/compact does nothing").
  it("renders a no-delta full assistant message under streamPartials", () => {
    const { t, updates } = collectPartials();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Not enough messages to compact." }],
      },
    });
    const chunks = updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    expect((chunks[0].update as ChunkUpdate).content?.text).toBe(
      "Not enough messages to compact.",
    );
  });

  it("does NOT re-emit streamed text when the final event pairs it with a tool_use (id rotation)", () => {
    const { t, updates } = collectPartials();
    t.feed(textDelta("Let me check."));
    // The final full event carries [text, tool_use] — the tool_use rotates
    // the message id BEFORE the block loop; the text must still dedup
    // against the pre-rotation streamed snapshot.
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_9",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
      },
    });
    const chunks = updates.filter(
      (u) => u.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks.map((u) => (u.update as ChunkUpdate).content?.text)).toEqual([
      "Let me check.",
    ]);
  });
});

describe("ClaudeStreamTranslator string message.content (2026-07-12)", () => {
  // The SDK emits user messages whose content is a plain STRING — notably
  // the continuation summary it replays right after a /compact. `.filter`
  // on a string crashed the whole translate call ("blocks.filter is not a
  // function"), which surfaced as "/compact does nothing" in the app.
  it("does not throw on a user event with string content (post-compact summary)", () => {
    const { t, kinds } = collect();
    expect(() =>
      t.feed({
        type: "user",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation…",
        },
      } as never),
    ).not.toThrow();
    // Nothing to render from it either — it is not a new user turn.
    expect(kinds()).not.toContain("user_message_chunk");
  });

  it("does not throw on an assistant event with string content", () => {
    const { t } = collect();
    expect(() =>
      t.feed({
        type: "assistant",
        message: { role: "assistant", content: "plain string" },
      } as never),
    ).not.toThrow();
  });
});

describe("ClaudeStreamTranslator distinct stop reasons (§3.6 R5/R3)", () => {
  it("maps a success result with stop_reason max_tokens → 'max_tokens' (was dead code)", () => {
    const { t } = collect();
    t.feed({ type: "result", subtype: "success", stop_reason: "max_tokens" });
    expect(t.stopReason).toBe("max_tokens");
    // Not an error — no terminalError, so the adapter resolves cleanly.
    expect(t.terminalError).toBeNull();
  });

  it("maps error_max_budget_usd → 'budget_exhausted' + a 'Turn stopped' budget tool call", () => {
    const { t, updates } = collect();
    t.budgetCapUsd = 5;
    t.feed({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      terminal_reason: "budget_exhausted",
    });
    expect(t.stopReason).toBe("budget_exhausted");
    // A budget stop is a CLEAN named ending, never a generic refusal/error.
    expect(t.terminalError).toBeNull();
    const call = updates.find(
      (u) =>
        u.update.sessionUpdate === "tool_call" &&
        (u.update as { kind?: string }).kind === "budget_stop",
    );
    expect(call).toBeTruthy();
    expect((call!.update as { title?: string }).title).toBe("Turn stopped");
    expect((call!.update as { status?: string }).status).toBe("completed");
    expect(
      (call!.update as { rawInput?: { capUsd?: number } }).rawInput?.capUsd,
    ).toBe(5);
  });

  it("maps terminal_reason blocking_limit / prompt_too_long distinctly (not refusal)", () => {
    const a = collect();
    a.t.feed({
      type: "result",
      is_error: true,
      terminal_reason: "blocking_limit",
    });
    expect(a.t.stopReason).toBe("blocking_limit");
    expect(a.t.terminalError).toBeNull();
    const b = collect();
    b.t.feed({
      type: "result",
      is_error: true,
      terminal_reason: "prompt_too_long",
    });
    expect(b.t.stopReason).toBe("prompt_too_long");
  });

  it("keeps the refusal path for a generic is_error result (stale-resume detection intact)", () => {
    const { t } = collect();
    t.feed({
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      result: "No conversation found with session ID abc",
    });
    expect(t.stopReason).toBe("refusal");
    expect(t.terminalError).toContain("No conversation found");
  });

  it("a clean end_turn still maps to end_turn", () => {
    const { t } = collect();
    t.feed({ type: "result", subtype: "success", stop_reason: "end_turn" });
    expect(t.stopReason).toBe("end_turn");
  });
});

describe("ClaudeStreamTranslator overload fallback (§3.6 R2)", () => {
  it("emits ONE 'Model switched' tool call when a top-level assistant answers on a different model", () => {
    const { t, updates } = collect();
    t.armFallbackDetection("claude-fable-5[1m]", true);
    const msg = {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-5-20260203",
        content: [{ type: "text", text: "hello" }],
      },
    };
    t.feed(msg);
    t.feed(msg); // same turn — no duplicate record
    const calls = updates.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call" &&
        (u.update as { kind?: string }).kind === "model_switch",
    );
    expect(calls).toHaveLength(1);
    const raw = (
      calls[0].update as {
        rawInput?: { fromModel?: string; toModel?: string; reason?: string };
      }
    ).rawInput;
    expect(raw?.fromModel).toBe("claude-fable-5[1m]");
    expect(raw?.toModel).toBe("claude-sonnet-5-20260203");
    expect(raw?.reason).toBe("overloaded");
  });

  it("does NOT fire for the primary model itself ([1m]/dated-id normalization)", () => {
    const { t, updates } = collect();
    t.armFallbackDetection("claude-fable-5[1m]", true);
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-fable-5-20260203",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(
      updates.some(
        (u) => (u.update as { kind?: string }).kind === "model_switch",
      ),
    ).toBe(false);
  });

  it("does NOT fire for subagent messages (they legitimately run other models)", () => {
    const { t, updates } = collect();
    t.armFallbackDetection("claude-fable-5[1m]", true);
    t.feed({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "subagent output" }],
      },
    });
    expect(
      updates.some(
        (u) => (u.update as { kind?: string }).kind === "model_switch",
      ),
    ).toBe(false);
  });

  it("does NOT fire when no fallback is configured (detection unarmed)", () => {
    const { t, updates } = collect();
    t.armFallbackDetection("claude-fable-5[1m]", false);
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(
      updates.some(
        (u) => (u.update as { kind?: string }).kind === "model_switch",
      ),
    ).toBe(false);
  });

  it("re-arms per turn: a result resets the dedupe so the next turn can record again", () => {
    const { t, updates } = collect();
    t.armFallbackDetection("claude-fable-5[1m]", true);
    const msg = {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hello" }],
      },
    };
    t.feed(msg);
    t.feed({ type: "result", subtype: "success" });
    t.feed(msg);
    const calls = updates.filter(
      (u) => (u.update as { kind?: string }).kind === "model_switch",
    );
    expect(calls).toHaveLength(2);
  });

  it("surfaces the SDK's explicit model_refusal_fallback as a refusal-reason switch", () => {
    const { t, updates } = collect();
    t.feed({
      type: "system",
      subtype: "model_refusal_fallback",
      original_model: "claude-fable-5",
      fallback_model: "claude-opus-4-8",
    });
    const call = updates.find(
      (u) => (u.update as { kind?: string }).kind === "model_switch",
    );
    expect(call).toBeTruthy();
    const raw = (
      call!.update as {
        rawInput?: { fromModel?: string; toModel?: string; reason?: string };
      }
    ).rawInput;
    expect(raw?.reason).toBe("refusal");
    expect(raw?.toModel).toBe("claude-opus-4-8");
  });
});

describe("ClaudeStreamTranslator per-model usage (§3.6 R6)", () => {
  it("itemizes result.modelUsage into turnUsage.perModel, priciest first", () => {
    const { t } = collect();
    t.feed({
      type: "result",
      subtype: "success",
      total_cost_usd: 1.87,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 30,
          outputTokens: 10,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 50,
          costUSD: 0.19,
        },
        "claude-fable-5": {
          inputTokens: 70,
          outputTokens: 40,
          cacheReadInputTokens: 700,
          cacheCreationInputTokens: 150,
          costUSD: 1.68,
        },
      },
    });
    const usage = t.turnUsage!;
    expect(usage.totalCostUsd).toBe(1.87);
    expect(usage.perModel).toHaveLength(2);
    // Sorted by cost, priciest first — the popover reads main-model-first.
    expect(usage.perModel![0].model).toBe("claude-fable-5");
    expect(usage.perModel![0].costUsd).toBe(1.68);
    expect(usage.perModel![0].cacheReadTokens).toBe(700);
    expect(usage.perModel![1].model).toBe("claude-haiku-4-5");
  });

  it("omits perModel when the result carries no modelUsage", () => {
    const { t } = collect();
    t.feed({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(t.turnUsage?.perModel).toBeUndefined();
  });
});
