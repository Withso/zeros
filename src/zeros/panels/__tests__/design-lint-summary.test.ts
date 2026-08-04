import { describe, expect, it } from "vitest";

import {
  blockingDesignLintReason,
  groupDesignLintViolations,
  lintReviewBadgeLabel,
} from "../design-lint-summary";

describe("design lint review summary", () => {
  it("groups repeated per-layer advisories into understandable review rules", () => {
    const violations = [
      ...Array.from({ length: 95 }, (_, index) => ({
        ruleId: "spacing-scale" as const,
        severity: "warning" as const,
        message: `Spacing ${index}`,
        file: "todo.html",
        line: index + 1,
        column: 1,
        oid: `node-${index}`,
      })),
      {
        ruleId: "contrast" as const,
        severity: "warning" as const,
        message: "Contrast",
        file: "todo.html",
        line: 100,
        column: 1,
        oid: "copy",
      },
    ];

    const groups = groupDesignLintViolations(violations);

    expect(groups).toEqual([
      expect.objectContaining({
        ruleId: "spacing-scale",
        label: "Spacing scale",
        count: 95,
      }),
      expect.objectContaining({
        ruleId: "contrast",
        label: "Text contrast",
        count: 1,
      }),
    ]);
    expect(lintReviewBadgeLabel(groups)).toBe("Review 2 rules");
  });

  it("names the exact first blocking file, line, and rule", () => {
    expect(
      blockingDesignLintReason({
        ruleId: "component-invalid",
        severity: "error",
        message: "Component zd-card contains invalid HTML.",
        file: "checkout.html",
        line: 14,
        column: 3,
      }),
    ).toBe("checkout.html:14 · component-invalid");
  });
});
