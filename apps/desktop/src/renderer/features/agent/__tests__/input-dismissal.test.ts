// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { QuestionRecordCard } from "../renderers/question-card";
import { ExitPlanModeCard } from "../renderers/tool-exit-plan-mode";
import type { RendererContext } from "../renderers/types";
import type { AgentToolMessage } from "../use-agent-session";

vi.mock("../turn-disclosures", () => ({ useTurnDisclosure: () => [true, () => {}] }));
const ctx = { pendingQuestionToolCallIds: new Set<string>() } as RendererContext;
const message = { id: "input", kind: "tool", toolCallId: "input", status: "failed", createdAt: 1, updatedAt: 2 } as AgentToolMessage;

it("shows the saved timeout reason beside the unanswered question in its existing details", () => {
  const html = renderToStaticMarkup(createElement(QuestionRecordCard, { ctx, message: { ...message,
    title: "User input", toolKind: "question", rawInput: { questions: [{ question: "Which route?", options: [] }] },
    rawOutput: { zerosQuestion: { outcome: "skipped", summary: "dismissed after 15 minutes without an answer" } },
  } }));
  expect(html).toContain("Which route?");
  expect(html).toContain("dismissed after 15 minutes without an answer");
  expect(html).not.toContain("Answered");
});

it("shows a workspace-stop dismissal with the plan without calling it approved", () => {
  const html = renderToStaticMarkup(createElement(ExitPlanModeCard, { ctx, message: { ...message,
    title: "ExitPlanMode", toolKind: "switch_mode", rawInput: { plan: "Add the change" },
    rawOutput: { zerosInputDismissal: "dismissed when the workspace stopped" },
  } }));
  expect(html).toContain("Add the change");
  expect(html).toContain("dismissed when the workspace stopped");
  expect(html).not.toContain("Plan approved");
});
