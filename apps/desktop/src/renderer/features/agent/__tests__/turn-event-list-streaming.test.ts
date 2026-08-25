// TurnEventList's live DOM is deliberately a committed projection: completed
// tools may mount while the turn runs, but provisional answer text and mutable
// tool rows must not. The settled render swaps directly to collapsed history
// plus the complete answer.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: { addHook: vi.fn(), sanitize: (value: string) => value },
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
    title: "PENDING TOOL MUST STAY UNMOUNTED",
    toolKind: undefined,
    status: "in_progress",
    createdAt: 2,
    updatedAt: 3,
  },
  {
    id: "completed-tool",
    kind: "tool",
    toolCallId: "completed-tool",
    title: "COMPLETED TOOL IS COMMITTED",
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
    text: "PROVISIONAL ANSWER MUST STAY UNMOUNTED",
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
  it("mounts only completed tools while a turn is live", () => {
    const html = render(true);

    expect(html).toContain("COMPLETED TOOL IS COMMITTED");
    expect(html).not.toContain("PENDING TOOL MUST STAY UNMOUNTED");
    expect(html).not.toContain("PROVISIONAL ANSWER MUST STAY UNMOUNTED");
    expect(html).toContain("zeros-working-feed");
  });

  it("reveals the complete answer only after the turn settles", () => {
    const html = render(false);

    expect(html).toContain("PROVISIONAL ANSWER MUST STAY UNMOUNTED");
    expect(html).toContain("2 tool calls");
    expect(html).not.toContain("COMPLETED TOOL IS COMMITTED");
  });
});
