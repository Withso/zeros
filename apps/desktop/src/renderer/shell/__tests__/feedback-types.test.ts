import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEEDBACK_TYPE,
  FEEDBACK_TYPE_OPTIONS,
} from "../../features/feedback/feedback-types";

describe("feedback type taxonomy", () => {
  it("exposes exactly the three product-approved choices", () => {
    expect(FEEDBACK_TYPE_OPTIONS).toEqual([
      { value: "bug", label: "Bug or Issue" },
      { value: "feedback", label: "Feedback" },
      { value: "feature", label: "Feature Request" },
    ]);
    expect(FEEDBACK_TYPE_OPTIONS.map(({ value }) => value)).not.toContain(
      "issue",
    );
  });

  it("starts on the combined Bug or Issue choice", () => {
    expect(DEFAULT_FEEDBACK_TYPE).toBe("bug");
  });
});
