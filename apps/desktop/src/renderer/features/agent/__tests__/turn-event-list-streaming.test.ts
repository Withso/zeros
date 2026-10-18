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
import { groupMessagesIntoTurns, isProviderTurnTail } from "../turn-grouping";

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

const usageNotice = (id: string, createdAt: number): AgentMessage => ({ id, kind: "error_notice", severity: "warning",
  recoverable: true, code: "claude-rate-limit:five_hour", message: "Claude is nearing its usage limit.", createdAt });

describe("TurnEventList streaming projection", () => {
  it("keeps live usage where it arrived in the working feed, with later tool calls after it", () => {
    const html = renderToStaticMarkup(createElement(TurnEventList, {
      events: [usageNotice("usage", 1), ...events], isActive: true, isStreaming: true, showActivity: false, ctx,
    }));
    expect(html.match(/Claude is nearing its usage limit\./g)).toHaveLength(1);
    expect(html.indexOf("zeros-working-feed")).toBeLessThan(html.indexOf("Claude is nearing"));
    expect(html.indexOf("Claude is nearing")).toBeLessThan(html.indexOf("Running check"));
    expect(html.indexOf("Claude is nearing")).toBeLessThan(html.indexOf("Completed check"));
  });

  it("collapses settled usage with the work it preceded", () => {
    const html = renderToStaticMarkup(createElement(TurnEventList, {
      events: [usageNotice("usage", 1), ...events], isActive: true, isStreaming: false, showActivity: false, ctx,
    }));
    expect(html).toContain("2 tool calls, 1 message");
    expect(html).not.toContain("Claude is nearing");
    expect(html).toContain("Progress text");
  });

  it.each([true, false])("shows a repeated usage status once and adds nothing after the output (streaming=%s)", isStreaming => {
    const usage: AgentMessage = { id: "claude-feedback-usage-1", kind: "text", role: "agent", phase: "commentary", text: "Claude is nearing its usage limit.", createdAt: 1 };
    const answer: AgentMessage = { id: "answer", kind: "text", role: "agent", phase: "final_answer", text: "Confirmed report", createdAt: 4 };
    const html = renderToStaticMarkup(createElement(TurnEventList, {
      events: [usage, events[1], answer, { ...usage, id: "claude-feedback-usage-2", createdAt: 5 }],
      isActive: true, isStreaming, showActivity: false, ctx,
    }));
    if (isStreaming) {
      expect(html.match(/Claude is nearing its usage limit\./g)).toHaveLength(1);
      expect(html.indexOf("Claude is nearing")).toBeLessThan(html.indexOf("Completed check"));
    } else {
      expect(html).toContain("1 tool call, 1 message");
      expect(html).not.toContain("Claude is nearing");
    }
    const afterAnswer = html.slice(html.indexOf("Confirmed report"));
    expect(afterAnswer).not.toContain("Claude is nearing");
    expect(afterAnswer).not.toContain("zeros-working-feed");
    expect(afterAnswer).not.toMatch(/\d+ messages?/);
  });

  it.each([true, false])("keeps usage in the steer segment where it arrived and hides its repeat later in the provider turn (streaming=%s)", isStreaming => {
    const usage = usageNotice("usage-before-steer", 2);
    const turns = groupMessagesIntoTurns([
      { id: "prompt", kind: "text", role: "user", text: "Inspect the workspace", createdAt: 1 }, usage,
      { id: "steer", kind: "text", role: "user", steeredTurnId: "prompt", text: "Check the renderer too", createdAt: 3 },
      { id: "report", kind: "text", role: "agent", phase: "final_answer", text: "Report after steering", createdAt: 4 },
      { ...usage, id: "usage-after-steer", createdAt: 5 },
    ]);
    expect(isProviderTurnTail(turns, 0)).toBe(false);
    const [beforeSteer, afterSteer] = turns.map(turn => renderToStaticMarkup(createElement(TurnEventList, {
      events: turn.events, usageEvents: turn.providerEvents, isActive: true, isStreaming, showActivity: false, ctx,
    })));
    if (isStreaming) expect(beforeSteer.match(/Claude is nearing its usage limit\./g)).toHaveLength(1);
    else expect(beforeSteer).toContain("1 message");
    expect(afterSteer).toContain("Report after steering");
    expect(afterSteer).not.toContain("Claude is nearing");
    expect(afterSteer).not.toMatch(/\d+ messages?/);
  });

  it.each([true, false])("does not resurrect repeated usage when a second steer moves the tail (streaming=%s)", isStreaming => {
    const messages: AgentMessage[] = [
      { id: "prompt", kind: "text", role: "user", text: "Inspect", createdAt: 1 },
      usageNotice("first-warning", 2),
      { id: "steer-1", kind: "text", role: "user", steeredTurnId: "prompt", text: "Check tests", createdAt: 3 },
      usageNotice("repeated-warning", 4),
    ];
    const renderSegments = (source: AgentMessage[]) => groupMessagesIntoTurns(source).map(turn =>
      renderToStaticMarkup(createElement(TurnEventList, {
        events: turn.events, usageEvents: turn.providerEvents, isActive: true, isStreaming, showActivity: false, ctx,
      })));
    const before = renderSegments(messages);
    const after = renderSegments([...messages,
      { id: "steer-2", kind: "text", role: "user", steeredTurnId: "prompt", text: "Check docs", createdAt: 5 },
    ]);
    expect(before[1]).toBe("");
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toBe("");
  });

  it.each([true, false])("retains the other budget's warning across two steers (streaming=%s)", isStreaming => {
    const messages: AgentMessage[] = [
      { id: "prompt", kind: "text", role: "user", text: "Inspect", createdAt: 1 },
      { ...usageNotice("weekly-warning", 2), code: "claude-rate-limit:seven_day" } as AgentMessage,
      usageNotice("hourly-warning", 3),
      { id: "steer-1", kind: "text", role: "user", steeredTurnId: "prompt", text: "Check tests", createdAt: 4 },
      { ...usageNotice("hourly-recovery", 5), message: "Claude usage is available again." } as AgentMessage,
      { id: "steer-2", kind: "text", role: "user", steeredTurnId: "prompt", text: "Check docs", createdAt: 6 },
      { ...usageNotice("weekly-recovery", 7), code: "claude-rate-limit:seven_day", message: "Claude usage is available again." } as AgentMessage,
    ];
    const html = groupMessagesIntoTurns(messages).map(turn => renderToStaticMarkup(createElement(TurnEventList, {
      events: turn.events, usageEvents: turn.providerEvents, isActive: true, isStreaming, showActivity: false, ctx,
    })));
    expect(html[1]).toBe("");
    if (isStreaming) {
      expect(html[0]).toContain("Claude is nearing its usage limit.");
      expect(html[2]).toContain("Claude usage is available again.");
    } else {
      expect(html[0]).toContain("1 message");
      expect(html[2]).toContain("1 message");
    }
  });

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
