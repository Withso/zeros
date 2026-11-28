import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("live Run stream placement", () => {
  it("keeps action streams in primary tabs, bottom tabs, and the terminal list", () => {
    const terminalTab = source(
      "apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx",
    );
    const primary = source(
      "apps/desktop/src/renderer/shell/workbench/tab-strip.tsx",
    );
    const sidebar = source(
      "apps/desktop/src/renderer/shell/terminal/terminal-workbench-layout.tsx",
    );
    expect(primary).toContain("<RunStream");
    expect(sidebar).toContain("<RunStream");
    expect(terminalTab).toContain("<RunStream");
  });

  it("keeps the sidebar row free of the Run stream, while still naming the run", () => {
    const row = source(
      "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx",
    );
    const sidebar = source("apps/desktop/src/renderer/shell/app-sidebar.tsx");
    // The Run tab and the Terminal show a live run; the row stays quiet so
    // only agent work moves in the navigation.
    expect(row).not.toContain("<RunStream");
    expect(row).not.toContain("RunStream");
    expect(row).toContain("useAnyRunActionRunning(workspace.path)");
    expect(row).toMatch(/workspaceTabDescription\(\{\s*label,\s*runActionRunning,/);
    expect(sidebar).toContain("useWorkspaceRunActivitySync(realWorkspaces)");
    expect(row).not.toContain("useRunStatuses");
  });

  it("hands the ± counts to the hover card", () => {
    const row = source(
      "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx",
    );
    expect(row).toMatch(
      /useWorkspaceChangeLines\(\s*localFolder \? null : workspace,/,
    );
    expect(row).not.toContain("<WorkspaceChangeCounts");
    expect(row).toContain("changeLines={changeLines}");
  });

  it("keeps the right end's marks out of the truncation path", () => {
    const row = source(
      "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx",
    );
    // Only the name may truncate; the trailing cluster is shrink-0.
    expect(row).toMatch(
      /<span className="text-fg1 min-w-0 truncate">\{label\}<\/span>/,
    );
    expect(row).toMatch(
      /const SIDEBAR_WORKSPACE_TRAILING_CLS =\s*\n?\s*"[^"]*\bshrink-0\b/,
    );
    expect(row).toContain('cn(SIDEBAR_WORKSPACE_TRAILING_CLS, "ml-auto")');
  });

  it("only publishes the cross-surface run signal once it is an answer", () => {
    // The publication is authoritative for its folder — it supersedes the top
    // bar's own poll — so a placeholder must never reach it. useRunStatuses
    // reads {} both before its first workspace.runInfo lands and when nothing
    // is running; publishing the first as if it were the second blanks a live
    // stream on that workspace's own tab for a round-trip, every cold open.
    const terminalTab = source(
      "apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx",
    );

    expect(terminalTab).toContain("ready: runStatusesReady");
    expect(terminalTab).toMatch(
      /if \(!actionsReady \|\| !runStatusesReady\) return;\s*publishRunActivity\(/,
    );
  });
});
