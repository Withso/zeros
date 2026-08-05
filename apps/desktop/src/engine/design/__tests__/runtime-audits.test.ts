import { describe, expect, it } from "vitest";

import {
  getDesignRuntimeAudit,
  resetDesignRuntimeAuditsForTests,
  setDesignRuntimeAudit,
} from "../runtime-audits";

describe("design runtime audit registry", () => {
  it("isolates exact source generations and bounds stale frame audits", () => {
    resetDesignRuntimeAuditsForTests();
    setDesignRuntimeAudit({
      workspacePath: "/work/a",
      frame: "home.html",
      sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
      warnings: [
        {
          ruleId: "contrast",
          severity: "warning",
          message: "Text contrast is 2.1:1.",
          file: "home.html",
          line: 1,
          column: 1,
          oid: "heading",
          fix: "Increase foreground/background contrast.",
        },
      ],
    });

    expect(
      getDesignRuntimeAudit("/work/a", "home.html", "aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toHaveLength(1);
    expect(
      getDesignRuntimeAudit("/work/a", "home.html", "bbbbbbbbbbbbbbbbbbbbbbbb"),
    ).toEqual([]);
    expect(
      getDesignRuntimeAudit("/work/b", "home.html", "aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toEqual([]);
  });
});
