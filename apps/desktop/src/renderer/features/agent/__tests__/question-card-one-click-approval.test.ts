import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { QuestionRequest } from "../../../platform/bridge/agent-events";
import { QuestionCard } from "../question-card";

describe("one-click MCP approval card", () => {
  it("renders direct approval actions instead of option selection plus submit", () => {
    const request: QuestionRequest = {
      sessionId: "session-a" as never,
      questionId: "approval-a",
      nativeRequestId: "native-a",
      source: "native_rpc",
      blocking: true,
      allowDecline: true,
      questions: [
        {
          id: "__zeros_confirm__",
          prompt:
            "Browser use is requesting permission.\n\nAllow Browser use to access https://www.apple.com?\n\nTool: Access browser origin",
          header: "Browser use",
          presentation: "one_click_approval",
          approvalKind: "browser_origin",
          approvalTarget: "https://www.apple.com",
          approvalPrompt: "Allow Browser use to access https://www.apple.com?",
          multiSelect: false,
          options: [
            { id: "accept", label: "Allow" },
            { id: "accept_always", label: "Always allow" },
          ],
          allowOther: false,
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(QuestionCard, { request, onRespond: () => {} }),
    );

    expect(html).toContain(
      "Allow Browser use to access https://www.apple.com?",
    );
    expect(html).toContain("Allow for all sites");
    expect(html).toContain("Deny");
    expect(html).toContain("Allow once");
    expect(html).not.toContain(">Cancel<");
    expect(html).not.toContain(">Decline<");
    expect(html).not.toContain('aria-label="Submit answer"');
  });
});
