import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Play, SquareCheckBig } from "lucide-react";

vi.mock("dompurify", () => ({
  default: { addHook: vi.fn(), sanitize: (value: string) => value },
}));

import { BackgroundTaskRecord } from "../renderers/background-task-record";
import { resolveRenderer } from "../renderers/registry";
import { TaskToolRecord } from "../renderers/task-tool-record";
import type { AgentToolMessage } from "../use-agent-session";
import { TooltipProvider } from "../../ui/primitives/tooltip";
import {
  BackgroundTasksCard,
  BackgroundTasksWaitingLine,
  shouldKeepTurnLiveForBackgroundTasks,
  shouldShowBackgroundTasksCard,
} from "../background-tasks-card";

describe("background task transcript routing", () => {
  it("routes the canonical kind to the quiet expandable record", () => {
    const message: AgentToolMessage = {
      id: "tool-task-1",
      kind: "tool",
      toolCallId: "task-1",
      title: "Background Task",
      toolKind: "background_task",
      status: "completed",
      rawInput: { name: "Full test suite", command: "pnpm test" },
      rawOutput: { status: "completed", summary: "212 tests passed" },
      createdAt: 1,
      updatedAt: 2,
    };

    expect(resolveRenderer(message).Component).toBe(BackgroundTaskRecord);
  });

  it("keeps the provider task id in expanded details even when a command exists", () => {
    const message: AgentToolMessage = {
      id: "tool-task-1",
      kind: "tool",
      toolCallId: "task-1",
      title: "Task Started",
      toolKind: "background_task",
      status: "in_progress",
      rawInput: {
        taskId: "provider-task-17",
        name: "Full test suite",
        command: "pnpm test:git",
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const renderRecord = (
      BackgroundTaskRecord as unknown as {
        type: (props: {
          message: AgentToolMessage;
          ctx: never;
        }) => ReactElement;
      }
    ).type;
    const eventRow = renderRecord({ message, ctx: {} as never });
    const html = renderToStaticMarkup(
      cloneElement(eventRow, { defaultOpen: true }),
    );

    expect(html).toContain("Task ID");
    expect(html).toContain("provider-task-17");
    expect(html).toContain("pnpm test:git");
    expect(eventRow.props.meta.Icon).toBe(Play);
    expect(eventRow.props.meta.label).toBe("Background Task");
  });

  it("shows both the provider summary and error for a failed task", () => {
    const message: AgentToolMessage = {
      id: "tool-task-failed",
      kind: "tool",
      toolCallId: "task-failed",
      title: "Background Task",
      toolKind: "background_task",
      status: "failed",
      rawInput: { taskId: "provider-task-18", name: "Deploy preview" },
      rawOutput: {
        status: "failed",
        summary: "Deployment did not complete",
        error: "Preview service returned 503",
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const renderRecord = (
      BackgroundTaskRecord as unknown as {
        type: (props: {
          message: AgentToolMessage;
          ctx: never;
        }) => ReactElement;
      }
    ).type;
    const eventRow = renderRecord({ message, ctx: {} as never });
    const html = renderToStaticMarkup(
      cloneElement(eventRow, { defaultOpen: true }),
    );

    expect(html).toContain("Deployment did not complete");
    expect(html).toContain("Preview service returned 503");
  });
});

describe("background task live surfaces", () => {
  const tasks = [
    {
      taskId: "task-1",
      name: "Full test suite",
      taskType: "local_bash",
      startedAt: Date.now() - 18_000,
      updatedAt: Date.now(),
    },
  ];

  it("uses the bg1 surface and exact 36px header/rows without a timer", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(BackgroundTasksCard, {
          tasks,
          onStop: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("Background Task");
    expect(html).toContain("Full test suite");
    expect(html).toContain("bg-bg1");
    expect(html.match(/h-9/g)).toHaveLength(2);
    expect(html).not.toContain("18s");
    expect(html).toContain('aria-label="Stop Full test suite"');
    expect(html).not.toMatch(/\b(?:Agent|LIVE|Running)\b/);
  });

  it("keeps every active task visible and stoppable regardless of effort or streaming", () => {
    for (const options of [
      {
        agentId: "claude",
        effort: "high",
        foregroundStreaming: false,
        taskCount: 1,
      },
      {
        agentId: "claude",
        effort: "ultracode",
        foregroundStreaming: true,
        taskCount: 1,
      },
      {
        agentId: "cursor",
        effort: null,
        foregroundStreaming: false,
        taskCount: 1,
      },
    ]) {
      expect(shouldShowBackgroundTasksCard(options)).toBe(true);
    }
    expect(
      shouldShowBackgroundTasksCard({
        agentId: "claude",
        effort: "high",
        foregroundStreaming: false,
        taskCount: 0,
      }),
    ).toBe(false);
  });

  it("keeps only a quiet Claude Ultracode continuation logically live", () => {
    const continuation = {
      agentId: "claude",
      effort: "ultracode",
      foregroundStreaming: false,
      taskCount: 1,
    };
    expect(shouldKeepTurnLiveForBackgroundTasks(continuation)).toBe(true);
    expect(
      shouldKeepTurnLiveForBackgroundTasks({
        ...continuation,
        foregroundStreaming: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepTurnLiveForBackgroundTasks({ ...continuation, effort: "max" }),
    ).toBe(false);
    expect(
      shouldKeepTurnLiveForBackgroundTasks({
        ...continuation,
        agentId: "codex",
      }),
    ).toBe(false);
    expect(
      shouldKeepTurnLiveForBackgroundTasks({
        ...continuation,
        agentId: "cursor",
      }),
    ).toBe(false);
    expect(
      shouldKeepTurnLiveForBackgroundTasks({
        ...continuation,
        taskCount: 0,
      }),
    ).toBe(false);
  });

  it("retains an explicit parked-turn waiting explanation", () => {
    const html = renderToStaticMarkup(
      createElement(BackgroundTasksWaitingLine, {
        tasks,
        startedAt: Date.now() - 24_000,
        active: false,
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Waiting for 1 background task");
    expect(html).toContain("Waiting for background tasks");
  });
});

describe("Claude task tools", () => {
  it("renders TaskCreate as Task Created with the subject as its description", () => {
    const message = {
      id: "tool-task-create",
      kind: "tool",
      toolCallId: "task-create",
      title: "Task Created",
      toolKind: "task_create",
      status: "completed",
      rawInput: {
        subject: "Dispatch and verify the Production release workflow",
        description: "Watch the release through every gate.",
      },
      rawOutput: {
        task: {
          id: "3",
          subject: "Dispatch and verify the Production release workflow",
        },
      },
      createdAt: 1,
      updatedAt: 2,
    } as AgentToolMessage;

    expect(resolveRenderer(message).Component).toBe(TaskToolRecord);
    const renderRecord = (
      TaskToolRecord as unknown as {
        type: (props: {
          message: AgentToolMessage;
          ctx: never;
        }) => ReactElement;
      }
    ).type;
    const eventRow = renderRecord({ message, ctx: {} as never });
    const html = renderToStaticMarkup(
      cloneElement(eventRow, { defaultOpen: true }),
    );

    expect(eventRow.props.meta.Icon).toBe(SquareCheckBig);
    expect(eventRow.props.meta.label).toBe("Task Created");
    expect(eventRow.props.meta.target).toBe(
      "Dispatch and verify the Production release workflow",
    );
    expect(html).toContain("Watch the release through every gate.");
    expect(html).toContain("Task ID");
    expect(html).toContain("3");
  });

  it("renders an in-progress TaskUpdate as Task Started with explicit status", () => {
    const message = {
      id: "tool-task-update",
      kind: "tool",
      toolCallId: "task-update",
      title: "Task Started",
      toolKind: "task_update",
      status: "completed",
      rawInput: { taskId: "3", status: "in_progress" },
      rawOutput: { success: true, taskId: "3" },
      createdAt: 1,
      updatedAt: 2,
    } as AgentToolMessage;
    const renderRecord = (
      TaskToolRecord as unknown as {
        type: (props: {
          message: AgentToolMessage;
          ctx: never;
        }) => ReactElement;
      }
    ).type;
    const eventRow = renderRecord({ message, ctx: {} as never });
    const html = renderToStaticMarkup(
      cloneElement(eventRow, { defaultOpen: true }),
    );

    expect(eventRow.props.meta.label).toBe("Task Started");
    expect(html).toContain("Status");
    expect(html).toContain("in_progress");
    expect(html).toContain("Task ID");
    expect(html).toContain("3");
  });
});
