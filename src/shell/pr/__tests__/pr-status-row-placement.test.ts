import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("shared PR status row placement", () => {
  it("mounts one row above the retained Changes and Review bodies", () => {
    const column = source("src/shell/column3.tsx");
    const changes = source("src/shell/column3-tabs/changes-row1-tab.tsx");
    const review = source("src/shell/column3-tabs/review-row1-tab.tsx");

    expect(column.match(/<PrStatusRow\b/g)).toHaveLength(1);
    expect(changes).not.toMatch(/<PrStatusRow\b/);
    expect(review).not.toMatch(/<PrStatusRow\b/);
  });
});

describe("Create PR routing", () => {
  it("sends the primary action to the agent and labels the engine path explicitly", () => {
    const button = source("src/shell/pr/create-pr-button.tsx");
    expect(button).toContain("onClick={() => void askAgentToCreate(false)}");
    expect(button).toContain("<span>Create PR directly</span>");
  });
});

describe("PR prompt single-flight wiring", () => {
  it("claims before sending and releases only when the accepted turn settles", () => {
    const island = source("src/shell/pr/pr-status-island.tsx");

    expect(island).toContain("if (!claimAction(action.kind)) return;");
    expect(island).toContain(
      "onSettled: () => finishAction(action.kind)",
    );
  });
});
