import { describe, expect, it } from "vitest";

import type {
  QuestionRequest,
  QuestionResponse,
} from "../../../platform/bridge/agent-events";
import { externalUrlsForQuestionResponse } from "../question-external-actions";

const request = (url: string): QuestionRequest => ({
  sessionId: "session-1",
  questionId: "question-1",
  nativeRequestId: "native-1",
  source: "native_rpc",
  blocking: true,
  questions: [
    {
      id: "url-action",
      prompt: "Continue?",
      options: [
        {
          id: "open",
          label: "Open example.com",
          externalAction: { kind: "open-url", url },
        },
      ],
      allowOther: false,
    },
  ],
});

const response = (selectedOptionIds: string[]): QuestionResponse => ({
  outcome: {
    outcome: "answered",
    answers: [{ questionId: "url-action", selectedOptionIds }],
  },
});

describe("question external actions", () => {
  it("returns an accepted http(s) URL only after its exact option is selected", () => {
    expect(
      externalUrlsForQuestionResponse(
        request("https://example.com/oauth?state=opaque"),
        response(["open"]),
      ),
    ).toEqual(["https://example.com/oauth?state=opaque"]);
    expect(
      externalUrlsForQuestionResponse(
        request("https://example.com/oauth"),
        { outcome: { outcome: "dismissed" } },
      ),
    ).toEqual([]);
  });

  it("fails closed for forged choices, duplicate answers, and unsafe URLs", () => {
    expect(
      externalUrlsForQuestionResponse(
        request("file:///etc/passwd"),
        response(["open"]),
      ),
    ).toEqual([]);
    expect(
      externalUrlsForQuestionResponse(
        request("https://example.com"),
        response(["forged"]),
      ),
    ).toEqual([]);
    const duplicate = response(["open"]);
    if (duplicate.outcome.outcome === "answered") {
      duplicate.outcome.answers.push({
        questionId: "url-action",
        selectedOptionIds: ["open"],
      });
    }
    expect(
      externalUrlsForQuestionResponse(
        request("https://example.com"),
        duplicate,
      ),
    ).toEqual([]);
  });
});
