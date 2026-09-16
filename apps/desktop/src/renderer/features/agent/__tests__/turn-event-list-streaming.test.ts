// Live narration and tool activity remain inspectable. The settled render
// collapses working history while preserving the final answer.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: { addHook: vi.fn(), sanitize: (value: string) => value },
}));
vi.mock("@/renderer/shared/ui/loading", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/renderer/shared/ui/loading")>(),
  ActivityShimmer: () => "LIVE ACTIVITY",
}));

import { TurnEventList } from "../turn-event-list";
import type { RendererContext } from "../renderers";
import type { AgentMessage } from "../use-agent-session";

const ctx = {
  isStreaming: true,
  lastMessageId: "partial-answer",
  activeTurnStartedAt: 1,
  editBaselines: new Map(),
  respondToQuestion: () => {},
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  respondToPermission: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  chatId: null,
  setMode: null,
  subagentChildren: new Map(),
  editAndResubmit: () => {},
} as unknown as RendererContext;

const events = [
  {
    id: "pending-tool",
    kind: "tool",
    toolCallId: "pending-tool",
    title: "Running check",
    toolKind: undefined,
    status: "in_progress",
    createdAt: 2,
    updatedAt: 3,
  },
  {
    id: "completed-tool",
    kind: "tool",
    toolCallId: "completed-tool",
    title: "Completed check",
    toolKind: undefined,
    status: "completed",
    createdAt: 3,
    updatedAt: 5,
    settledAt: 5,
  },
  {
    id: "partial-answer",
    kind: "text",
    role: "agent",
    text: "Progress text",
    createdAt: 4,
  },
] as AgentMessage[];

function render(isStreaming: boolean): string {
  return renderToStaticMarkup(
    createElement(TurnEventList, {
      events,
      isActive: true,
      isStreaming,
      showActivity: false,
      ctx: { ...ctx, isStreaming },
    }),
  );
}

describe("TurnEventList streaming projection", () => {
  it("places quiet background waiting after the settled output and footer, then resumes the working feed", () => {
    const props = {
      events, isActive: true, isStreaming: false,
      backgroundTasks: [{ taskId: "bg-1", name: "Tests", startedAt: 2, updatedAt: 3 }],
      activityStartedAt: 1, footer: createElement("div", null, "OUTPUT FOOTER"), ctx,
    };
    const waiting = renderToStaticMarkup(createElement(TurnEventList, props));
    expect(waiting).toContain("Waiting for 1 background task");
    expect(waiting).not.toContain("LIVE ACTIVITY");
    expect(waiting).not.toContain("Completed check");
    expect(waiting.indexOf("Progress text")).toBeLessThan(waiting.indexOf("OUTPUT FOOTER"));
    expect(waiting.indexOf("OUTPUT FOOTER")).toBeLessThan(waiting.indexOf("Waiting for 1 background task"));
    const resumed = renderToStaticMarkup(createElement(TurnEventList, { ...props, isStreaming: true }));
    expect(resumed).not.toContain("Waiting for 1 background task");
    expect(resumed).toContain("LIVE ACTIVITY");
    expect(resumed).toContain("Completed check");
  });
  it("keeps activity visible while an optional question awaits an answer", () => {
    const html = renderToStaticMarkup(createElement(TurnEventList, {
      events, isActive: true, isStreaming: true,
      ctx: { ...ctx, hasBlockingQuestion: false, pendingQuestionToolCallIds: new Set(["optional"]) } as RendererContext,
    }));
    expect(html).toContain("LIVE ACTIVITY");
  });
  it("mounts running tools and progress text while a turn is live", () => {
    const html = render(true);

    expect(html).toContain("Completed check");
    expect(html).toContain("Running check");
    expect(html).toContain("Progress text");
    expect(html).toContain("zeros-working-feed");
  });

  it("collapses tools while retaining the settled answer", () => {
    const html = render(false);

    expect(html).toContain("Progress text");
    expect(html).toContain("2 tool calls");
    expect(html).not.toContain("Completed check");
  });
});
