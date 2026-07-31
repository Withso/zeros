import { describe, expect, it } from "vitest";

import type { TurnFile } from "../../../native/turns";
import { designTurnFiles } from "../design-change-card";
import {
  groupDesignLintViolations,
  lintReviewBadgeLabel,
} from "../design-lint-summary";

describe("designTurnFiles", () => {
  it("keeps only disk-authoritative files owned by the design directory", () => {
    const files: TurnFile[] = [
      {
        path: "Zeros Design/home.html",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
      {
        path: "src/app.tsx",
        status: "modified",
        additions: 2,
        deletions: 2,
      },
      {
        path: "Zeros Design/tokens.css",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ];

    expect(designTurnFiles(files).map((file) => file.path)).toEqual([
      "Zeros Design/home.html",
      "Zeros Design/tokens.css",
    ]);
  });

  it("does not treat a similarly named sibling as design output", () => {
    expect(
      designTurnFiles([
        {
          path: "Zeros Designer/readme.md",
          status: "added",
          additions: 1,
          deletions: 0,
        },
      ]),
    ).toEqual([]);
  });
});

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
});
