import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_SEGMENT_COUNT,
  filledWorkflowSegments,
  workflowPhaseCountLabel,
} from "../workflow-activity";

describe("workflow activity progress", () => {
  it("always renders the settled fixed horizontal segment count", () => {
    expect(WORKFLOW_SEGMENT_COUNT).toBe(32);
    expect(filledWorkflowSegments(3, 4)).toBe(24);
    expect(filledWorkflowSegments(8, 8)).toBe(32);
    expect(filledWorkflowSegments(0, 0)).toBe(0);
  });

  it("shows only exact counts or Queued", () => {
    expect(workflowPhaseCountLabel({ completed: 3, total: 4 })).toBe("3/4");
    expect(workflowPhaseCountLabel({ completed: 0, total: 0 })).toBe("Queued");
  });

  it("keeps the settled bg1 surface and eight-pixel fixed-density track", () => {
    const source = readFileSync(
      "src/zeros/agent/workflow-activity.tsx",
      "utf8",
    );
    expect(source).toContain("border-border2 bg-bg1");
    expect(source).toContain('className="flex h-2 min-w-0 gap-[2px]"');
    expect(source).toContain('"h-2 min-w-0 flex-1 rounded-[2px]"');
    expect(source).toContain('"bg-bg4"');
    expect(source).toContain('"bg-fg2"');
    expect(source).toContain('"bg-green-primary"');
    expect(source).not.toContain("h-[3px]");
  });
});
