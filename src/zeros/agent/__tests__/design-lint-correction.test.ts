import { describe, expect, it } from "vitest";

import type { DesignLintReportWire } from "../../../native/git";
import {
  designLintCorrectionPrompt,
  designLintCorrectionSignature,
} from "../design-lint-correction";

function report(
  violations: DesignLintReportWire["violations"],
): DesignLintReportWire {
  return {
    workspacePath: "/work/design",
    checkedFiles: ["home.html"],
    healedOids: 0,
    violations,
  };
}

describe("design lint correction", () => {
  it("returns no signature for warnings-only reports", () => {
    expect(
      designLintCorrectionSignature(
        report([
          {
            ruleId: "spacing-scale",
            severity: "warning",
            message: "Prefer the spacing scale.",
            file: "home.html",
            line: 4,
            column: 2,
          },
        ]),
      ),
    ).toBeNull();
  });

  it("deduplicates the same errors regardless of report order", () => {
    const first = {
      ruleId: "no-script",
      severity: "error" as const,
      message: "Scripts are not allowed.",
      file: "home.html",
      line: 8,
      column: 1,
    };
    const second = {
      ruleId: "unknown-token",
      severity: "error" as const,
      message: "Unknown token --missing.",
      file: "home.html",
      line: 12,
      column: 3,
    };
    expect(designLintCorrectionSignature(report([first, second]))).toBe(
      designLintCorrectionSignature(report([second, first])),
    );
  });

  it("builds a concrete correction prompt with rule ids and fixes", () => {
    const prompt = designLintCorrectionPrompt(
      report([
        {
          ruleId: "unknown-token",
          severity: "error",
          message: "Unknown token --missing.",
          file: "home.html",
          line: 12,
          column: 3,
          fix: "Declare it in tokens.css.",
        },
      ]),
    );

    expect(prompt).toContain("[unknown-token] home.html:12:3");
    expect(prompt).toContain("Declare it in tokens.css.");
    expect(prompt).toContain("run lint_design");
  });
});
