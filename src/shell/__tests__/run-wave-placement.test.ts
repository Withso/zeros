import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("live Run wave placement", () => {
  it("leads each running action tab in the terminal with fg2", () => {
    const terminalTab = source("src/shell/column3-tabs/terminal-tab.tsx");

    expect(terminalTab).toContain("<RunWave");
    expect(terminalTab).toContain("text-fg2");
    expect(terminalTab).toContain('<RunWave size={12} className="text-fg2');
    expect(terminalTab).toMatch(
      /leading=\{[\s\S]*state === "running"[\s\S]*<RunWave/,
    );
  });

  it("marks every running workspace blue-primary, selected or not", () => {
    const topBar = source("src/shell/top-bar.tsx");

    expect(topBar).toContain("runActionRunning");
    expect(topBar).toContain("<RunWave");
    expect(topBar).toContain("useWorkspaceRunActivitySync(realWorkspaces)");
    expect(topBar).toContain("useAnyRunActionRunning(workspace.path)");
    // A live run is the loudest thing a tab can say, so it stays the accent
    // colour in every tab — dimming the unselected ones hid running work.
    expect(topBar).toContain(
      '<RunWave size={12} className="text-blue-primary"',
    );
    expect(topBar).not.toMatch(/<RunWave[\s\S]{0,120}?active \?/);
    expect(topBar).not.toContain(
      "anyRunActionRunning && activeWorkspaceId === workspace.id",
    );
    expect(topBar).not.toContain("useRunStatuses");
  });

  it("shows the counts AND the wave, counts first", () => {
    const topBar = source("src/shell/top-bar.tsx");

    // They no longer compete for one slot: the tab is content-sized, so it can
    // afford both, and a running workspace should still report what it changed.
    // DOM order is the visual order — counts sit to the LEFT of the wave.
    expect(topBar).toContain("useWorkspaceChangeLines(workspace)");
    expect(topBar).toMatch(
      /<WorkspaceChangeCounts \{\.\.\.changeLines\} active=\{active\} \/>[\s\S]*?<RunWave/,
    );
    // Each is independently optional — neither may sit in the other's branch,
    // or one of them goes back to suppressing the other.
    expect(topBar).toMatch(/\{!archiving && \([\s\S]*?<WorkspaceChangeCounts/);
    expect(topBar).toMatch(/\{runActionRunning && \([\s\S]*?<RunWave/);
    expect(topBar).not.toMatch(/runActionRunning \?[\s\S]{0,200}?<RunWave/);
  });

  it("keeps the wave and the counts out of the truncation path", () => {
    const topBar = source("src/shell/top-bar.tsx");
    const counts = source("src/shell/workspace-change-counts.tsx");

    // The tab's 180px cap has to land on the branch name. RunWave is shrink-0
    // inside its own component; the ± pair declares it on its wrapper span. If
    // either could shrink, a busy workspace would render half a number.
    expect(counts).toMatch(/className="[^"]*\bshrink-0\b/);
    expect(topBar).toMatch(
      /<span className="[^"]*\bflex-auto\b[^"]*">\{label\}/,
    );
  });

  it("only publishes the cross-surface run signal once it is an answer", () => {
    // The publication is authoritative for its folder — it supersedes the top
    // bar's own poll — so a placeholder must never reach it. useRunStatuses
    // reads {} both before its first workspace.runInfo lands and when nothing
    // is running; publishing the first as if it were the second blanks a live
    // wave on that workspace's own tab for a round-trip, every cold open.
    const terminalTab = source("src/shell/column3-tabs/terminal-tab.tsx");

    expect(terminalTab).toContain("ready: runStatusesReady");
    expect(terminalTab).toMatch(
      /if \(!actionsReady \|\| !runStatusesReady\) return;\s*publishRunActivity\(/,
    );
  });

  it("keeps the running Stop face static", () => {
    const runControl = source("src/shell/terminal/run-control.tsx");
    const start = runControl.indexOf("const face = defaultRunning ? (");
    const end = runControl.indexOf("\n  ) : (", start);
    const runningFace = runControl.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(runningFace).toContain("<Square");
    expect(runningFace).toContain("<span>Stop</span>");
    expect(runningFace).not.toContain("RunHorseShimmer");
    expect(runningFace).not.toContain("RunWave");
  });
});
