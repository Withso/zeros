import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("shared PR status row placement", () => {
  it("mounts one row above the retained Changes and Review bodies", () => {
    const column = source(
      "apps/desktop/src/renderer/shell/workbench/workbench-pane.tsx",
    );
    const changes = source(
      "apps/desktop/src/renderer/shell/workbench/tabs/changes-surface.tsx",
    );
    const review = source(
      "apps/desktop/src/renderer/shell/workbench/tabs/review-surface.tsx",
    );

    expect(column.match(/<PrStatusRow\b/g)).toHaveLength(1);
    expect(changes).not.toMatch(/<PrStatusRow\b/);
    expect(review).not.toMatch(/<PrStatusRow\b/);
  });

  it("separates the PR row from the body before and after PR creation", () => {
    const column = source(
      "apps/desktop/src/renderer/shell/workbench/workbench-pane.tsx",
    );
    const row = source("apps/desktop/src/renderer/shell/pr/pr-status-row.tsx");
    const island = source(
      "apps/desktop/src/renderer/shell/pr/pr-status-island.tsx",
    );

    const headerClasses = column.match(
      /const WORKBENCH_HEADER_CLS\s*=\s*\n?\s*"([^"]+)"/,
    )?.[1];
    expect(headerClasses).toBeDefined();
    expect(headerClasses?.split(/\s+/)).not.toContain("border-b");

    expect(row).toMatch(
      /<PanelHeader size="window" className="gap-2"/,
    );
    const primitive = source(
      "apps/desktop/src/renderer/shared/ui/primitives/panel-header.tsx",
    );
    const emptyRowClasses = primitive.match(/window:\s*"([^"]+)"/)?.[1];
    expect(new Set(emptyRowClasses?.split(/\s+/))).toEqual(
      new Set(
        "border-border1 bg-bg1 flex h-10 shrink-0 items-center gap-1 border-b px-2".split(/\s+/),
      ),
    );

    expect(island).toMatch(
      /data-pr-island=""[\s\S]*?"flex h-10 shrink-0 items-center gap-2\.5 border-y px-2"/,
    );
  });
});

describe("Create PR routing", () => {
  it("sends the primary action to the agent and labels the engine path explicitly", () => {
    const button = source(
      "apps/desktop/src/renderer/shell/pr/create-pr-button.tsx",
    );
    expect(button).toMatch(
      /void askAgentToCreate\(false\)/,
    );
    expect(button).toContain("<span>Create PR directly</span>");
  });

  it("keeps PR controls independent of legacy workspace kind", () => {
    const button = source(
      "apps/desktop/src/renderer/shell/pr/create-pr-button.tsx",
    );
    expect(button).not.toContain('workspace.kind === "design"');
    expect(button).toMatch(
      /void askAgentToCreate\(false\)/,
    );
  });
});

describe("PR prompt single-flight wiring", () => {
  it("claims before sending and releases only when the accepted turn settles", () => {
    const island = source(
      "apps/desktop/src/renderer/shell/pr/pr-status-island.tsx",
    );

    expect(island).toContain(
      "const owner = claimAction(action.kind, action.behavior);",
    );
    expect(island).toContain("if (!owner) return;");
    expect(island).toContain("onSettled: () => finishAction(owner)");
  });
});
