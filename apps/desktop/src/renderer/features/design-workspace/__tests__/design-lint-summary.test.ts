import { describe, expect, it } from "vitest";

import {
  blockingDesignLintReason,
  designLintFindingsByFrame,
  frameBlockingDesignLintErrors,
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

  it("labels unknown-class warnings without promoting their severity", () => {
    const first = { ruleId: "unknown-class", severity: "warning" as const, message: "Unknown class", file: "home.html", line: 2, column: 5 };
    expect(groupDesignLintViolations([first, { ...first, line: 3 }])).toEqual([
      { ruleId: "unknown-class", label: "Unknown classes", count: 2, first },
    ]);
  });

  it("labels the authoring contract warnings and any rule id it does not know", () => {
    const at = (ruleId: string, line: number) => ({ ruleId, severity: "warning" as const, message: ruleId, file: "home.html", line, column: 1 });
    expect(groupDesignLintViolations([
      at("repeated-inline-style", 1),
      at("literal-token-value", 2),
      at("repeated-markup", 3),
      at("layer-tree-limit", 4),
      at("future-rule", 5),
    ]).map(({ ruleId, label }) => [ruleId, label])).toEqual([
      ["future-rule", "future-rule"],
      ["layer-tree-limit", "Layer tree limit"],
      ["literal-token-value", "Literal token values"],
      ["repeated-inline-style", "Repeated inline styles"],
      ["repeated-markup", "Repeated markup"],
    ]);
  });

  it("keeps only the selected frame's errors, so another frame's error never shows on this one", () => {
    const at = (file: string, severity: "error" | "warning", line: number) => ({ ruleId: "no-script", severity, message: "Script", file, line, column: 1 });
    const violations = [at("other.html", "error", 1), at("home.html", "warning", 2), at("home.html", "error", 3)];
    expect(frameBlockingDesignLintErrors(violations, "home.html")).toEqual([violations[2]]);
    expect(frameBlockingDesignLintErrors(violations, "third.html")).toEqual([]);
    expect(frameBlockingDesignLintErrors(violations, undefined)).toEqual([]);
  });

  it("splits one report into each frame's own findings, keeping their order", () => {
    const at = (file: string, line: number) => ({ ruleId: "contrast", severity: "warning" as const, message: "Contrast", file, line, column: 1 });
    const violations = [at("a.html", 3), at("b.html", 1), at("a.html", 1)];
    const byFrame = designLintFindingsByFrame(violations);
    expect(byFrame.get("a.html")).toEqual([violations[0], violations[2]]);
    expect(byFrame.get("b.html")).toEqual([violations[1]]);
    expect(byFrame.get("c.html")).toBeUndefined();
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
