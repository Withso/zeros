import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: { addHook: vi.fn(), sanitize: (value: string) => value },
}));

import { BackgroundTaskRecord } from "../renderers/background-task-record";
import { resolveRenderer } from "../renderers/registry";
import type { AgentToolMessage } from "../use-agent-session";
import { TooltipProvider } from "../../ui/primitives/tooltip";
import {
  BackgroundTasksCard,
  BackgroundTasksWaitingLine,
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

  it("renders only the shared title plus name, elapsed time, and scoped Stop", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(BackgroundTasksCard, {
          tasks,
          active: false,
          onStop: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("Background Task");
    expect(html).toContain("Full test suite");
    expect(html).toContain("18s");
    expect(html).toContain('aria-label="Stop Full test suite"');
    expect(html).not.toMatch(/\b(?:Agent|LIVE|Running)\b/);
  });

  it("renders the parked-parent status independently above the composer", () => {
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
