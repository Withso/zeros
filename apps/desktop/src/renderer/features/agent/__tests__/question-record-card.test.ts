import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuestionRecordCard } from "../renderers/question-card";
import type { RendererContext } from "../renderers/types";
import type { AgentToolMessage } from "../use-agent-session";

const ctx = {
  pendingQuestionToolCallIds: new Set<string>(),
} as unknown as RendererContext;

describe("answered question transcript record", () => {
  it("shows the Answered chip without a redundant success icon", () => {
    const message = {
      id: "question-a",
      kind: "tool",
      toolCallId: "question-a",
      title: "MCP input requested",
      toolKind: "question",
      status: "completed",
      rawInput: {
        questions: [{ question: "Allow access?", options: ["Allow"] }],
      },
      rawOutput: {
        zerosQuestion: {
          outcome: "answered",
          summary: "Allow",
          answers: [{ prompt: "Allow access?", value: "Allow" }],
        },
      },
      createdAt: 1,
      updatedAt: 2,
    } as AgentToolMessage;

    const html = renderToStaticMarkup(
      createElement(QuestionRecordCard as never, { message, ctx }),
    );

    expect(html).toContain("Answered");
    expect(html).not.toContain("lucide-circle-check");
  });
});
