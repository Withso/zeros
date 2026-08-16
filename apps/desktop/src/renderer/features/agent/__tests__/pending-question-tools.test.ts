import { describe, expect, it } from "vitest";

import {
  collectPendingQuestionToolCallIds,
  questionRequestIsBrowserApproval,
} from "../pending-question-tools";
import type { QuestionRequest } from "../../../platform/bridge/agent-events";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";

const request = (over: Partial<QuestionRequest> = {}): QuestionRequest => ({
  sessionId: "sid" as never,
  questionId: "question-1",
  nativeRequestId: "toolu_1",
  toolCallId: "toolu_1",
  source: "native_dialog",
  blocking: true,
  questions: [{ id: "q0", prompt: "Pick one", options: [], allowOther: false }],
  ...over,
});

const questionTool = (over: Partial<AgentToolMessage> = {}): AgentToolMessage =>
  ({
    id: "m1",
    kind: "tool",
    toolCallId: "local-1",
    nativeToolCallId: "toolu_1",
    title: "AskUserQuestion",
    toolKind: "question",
    status: "in_progress",
    createdAt: 0,
    updatedAt: 0,
    rawInput: { questions: [{ question: "Pick one" }] },
    ...over,
  }) as AgentToolMessage;

describe("collectPendingQuestionToolCallIds", () => {
  it("includes the transcript row's local id when the pending request uses the native id", () => {
    const ids = collectPendingQuestionToolCallIds(
      [{ questionId: "question-1", request: request() }],
      [questionTool()] as AgentMessage[],
    );

    expect([...ids].sort()).toEqual(["local-1", "question-1", "toolu_1"]);
  });

  it("matches dialog question rows by prompt payload when no tool id is shared", () => {
    const ids = collectPendingQuestionToolCallIds(
      [
        {
          questionId: "question-1",
          request: request({
            nativeRequestId: "question-1",
            toolCallId: undefined,
          }),
        },
      ],
      [
        questionTool({
          toolCallId: "local-dialog-row",
          nativeToolCallId: undefined,
        }),
      ] as AgentMessage[],
    );

    expect(ids.has("local-dialog-row")).toBe(true);
  });

  it("does not mark an already stamped question row as awaiting", () => {
    const ids = collectPendingQuestionToolCallIds(
      [{ questionId: "question-1", request: request() }],
      [
        questionTool({
          rawOutput: { zerosQuestion: { outcome: "answered" } },
        }),
      ] as AgentMessage[],
    );

    expect(ids.has("local-1")).toBe(false);
    expect(ids.has("toolu_1")).toBe(true);
  });
});

describe("questionRequestIsBrowserApproval", () => {
  it("recognizes official Browser use origin and consequence approvals", () => {
    for (const approvalKind of ["browser_origin", "tool"] as const) {
      expect(
        questionRequestIsBrowserApproval(
          request({
            questions: [
              {
                id: "confirm",
                prompt: "Continue?",
                header: "Browser use",
                presentation: "one_click_approval",
                approvalKind,
                options: [{ id: "accept", label: "Allow" }],
                allowOther: false,
              },
            ],
          }),
        ),
      ).toBe(true);
    }
  });

  it("does not classify unrelated or mixed question requests as Browser work", () => {
    expect(questionRequestIsBrowserApproval(request())).toBe(false);
    expect(
      questionRequestIsBrowserApproval(
        request({
          questions: [
            {
              id: "confirm",
              prompt: "Continue?",
              header: "Browser use",
              presentation: "one_click_approval",
              approvalKind: "browser_origin",
              options: [{ id: "accept", label: "Allow" }],
              allowOther: false,
            },
            {
              id: "other",
              prompt: "Pick a deployment target",
              options: [],
              allowOther: true,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
