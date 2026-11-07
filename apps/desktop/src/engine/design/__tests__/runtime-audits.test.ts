import { describe, expect, it } from "vitest";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";

import {
  getDesignRuntimeAudit,
  resetDesignRuntimeAuditsForTests,
  setDesignRuntimeAudit,
} from "../runtime-audits";

describe("design runtime audit registry", () => {
  it("accepts nested frame paths and keeps same basenames isolated", () => {
    resetDesignRuntimeAuditsForTests();
    const input = { workspacePath: "/work/a", frame: "page-1/home.html", sourceVersion: "a".repeat(24), warnings: [{
      ruleId: "contrast" as const, severity: "warning" as const, message: "Contrast", file: "page-1/home.html", line: 1, column: 1,
    }] };
    setDesignRuntimeAudit(input);
    expect(getDesignRuntimeAudit(input.workspacePath, input.frame, input.sourceVersion)).toHaveLength(1);
    expect(getDesignRuntimeAudit(input.workspacePath, "checkout/home.html", input.sourceVersion)).toEqual([]);
    expect(() => setDesignRuntimeAudit({ ...input, frame: "page-1/../home.html" })).toThrow();
  });
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

  it("keeps an audit for every frame of a full page, bounding retained warnings instead", () => {
    resetDesignRuntimeAuditsForTests();
    const version = "c".repeat(24);
    const warning = (frame: string) => ({
      ruleId: "contrast" as const, severity: "warning" as const, message: "Contrast", file: frame, line: 1, column: 1,
    });
    const publish = (frame: string, count: number) =>
      setDesignRuntimeAudit({ workspacePath: "/work/a", frame, sourceVersion: version, warnings: Array.from({ length: count }, () => warning(frame)) });
    const frames = Array.from({ length: DESIGN_MAX_FRAMES_PER_PAGE }, (_, index) => `page-1/f${index}.html`);
    for (const frame of frames) publish(frame, 1);
    expect(frames.every((frame) => getDesignRuntimeAudit("/work/a", frame, version).length === 1)).toBe(true);
    publish("page-2/extra.html", 1);
    expect(getDesignRuntimeAudit("/work/a", frames[0]!, version)).toEqual([]);
    resetDesignRuntimeAuditsForTests();
    // 256 frames of 128 warnings is the retained ceiling: a further heavy audit evicts the oldest.
    for (const frame of frames.slice(0, 256)) publish(frame, 128);
    expect(getDesignRuntimeAudit("/work/a", frames[0]!, version)).toHaveLength(128);
    publish(frames[256]!, 128);
    expect(getDesignRuntimeAudit("/work/a", frames[1]!, version)).toEqual([]);
    expect(getDesignRuntimeAudit("/work/a", frames[0]!, version)).toHaveLength(128);
    expect(getDesignRuntimeAudit("/work/a", frames[256]!, version)).toHaveLength(128);
  });
});
