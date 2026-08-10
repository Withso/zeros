import { describe, expect, it } from "vitest";

import type { QuestionSpec } from "../../../platform/bridge/agent-events";
import { questionExternalUrl } from "../question-external-url";

function question(previews: Array<string | undefined>): QuestionSpec {
  return {
    id: "action",
    prompt: "Authorize access",
    options: previews.map((preview, index) => ({
      id: String(index),
      label: `Option ${index}`,
      preview,
    })),
    allowOther: false,
  };
}

describe("questionExternalUrl", () => {
  it("returns the first validated HTTP(S) preview", () => {
    expect(
      questionExternalUrl(
        question(["plain preview", "https://example.com/authorize"]),
      ),
    ).toEqual({
      href: "https://example.com/authorize",
      host: "example.com",
    });
  });

  it("rejects executable, local-file, and malformed schemes", () => {
    expect(
      questionExternalUrl(
        question(["javascript:alert(1)", "file:///tmp/token", "not a URL"]),
      ),
    ).toBeNull();
  });
});
