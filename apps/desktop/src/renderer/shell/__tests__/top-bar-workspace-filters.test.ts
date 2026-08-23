import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/shell/top-bar.tsx"),
  "utf8",
);

describe("multi-repository top-bar controls", () => {
  it("keeps Home, Create, and Filter as the three leading destinations", () => {
    const root = source.slice(source.indexOf("export function TopBar"));
    const home = root.indexOf('aria-label="Home"');
    const create = root.indexOf('aria-label="Create workspace"');
    const filter = root.indexOf('aria-label="Filter workspaces"');

    expect(home).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(home);
    expect(filter).toBeGreaterThan(create);
  });

  it("offers Grouped, Ungrouped, Active, then repository filters and no trailing create action", () => {
    const root = source.slice(source.indexOf("export function TopBar"));

    expect(root).toContain('(["grouped", "ungrouped", "active"] as const)');
    expect(root).toContain("<DropdownMenuSeparator />");
    expect(root).toContain("repositoryWorkspaceListFilter(project.id)");
    expect(root).not.toContain("handleCreateWorkspace");
    expect(root).not.toContain("createWorkspaceForProject");
  });

  it("uses repository icons and a zero-layout trailing agent state in mixed filters", () => {
    const tab = source.slice(
      source.indexOf("function WorkspaceTab("),
      source.indexOf("function PendingWorkspaceTab("),
    );

    expect(tab).toContain("<WorkspaceProjectIcon project={project} />");
    expect(tab).toContain("trailingAgentState");
    expect(tab).toContain("className={WORKSPACE_TRAILING_STATE_CLS}");
    expect(tab).toContain('trailingTabState && "-mr-5 pr-5"');
    expect(source).toMatch(
      /const WORKSPACE_TRAILING_STATE_CLS =\s*\n\s*"[^"]*\babsolute inset-y-0 right-1\b[^"]*"/,
    );
    expect(source).toMatch(
      /const WORKSPACE_ACTION_OVERLAY_CLS =\s*\n\s*"[^"]*\bz-20\b[^"]*"/,
    );
    expect(source).toContain("isMixedWorkspaceListFilter(workspaceListFilter)");
    expect(source).toContain("useAnyChatAgentWorking");
    expect(source).not.toContain("useAnyChatWorking(agentChatIds)");
  });

  // A mixed lane spends the leading glyph on repository identity, and design
  // workspaces carry the same colour-word branch names code ones do — so
  // dropping the PenTool made a design tab indistinguishable from a code tab.
  // It relocates to the same zero-layout trailing slot agent state uses, in
  // BOTH tab variants so the pending → confirmed swap moves nothing.
  it("relocates the design marker instead of dropping it in mixed filters", () => {
    const confirmed = source.slice(
      source.indexOf("function WorkspaceTab("),
      source.indexOf("function PendingWorkspaceTab("),
    );
    const pendingTab = source.slice(
      source.indexOf("function PendingWorkspaceTab("),
      source.indexOf("interface ProjectMarkerProps"),
    );

    for (const tab of [confirmed, pendingTab]) {
      expect(tab).toContain("trailingDesignMark");
      const slotAt = tab.indexOf(
        "<span className={WORKSPACE_TRAILING_STATE_CLS}",
      );
      expect(slotAt).toBeGreaterThanOrEqual(0);
      const slot = tab.slice(slotAt, slotAt + 260);
      // The PenTool has to be IN the trailing slot, and visual-only exactly
      // like the leading glyph it replaces — the tab's accessible name stays
      // workspaceTabDescription's alone.
      expect(slot).toContain('aria-hidden="true"');
      expect(slot).toContain("<PenTool");
      // Zero layout on both sides of the swap, or the tab resizes mid-create.
      expect(tab).toMatch(/"-mr-5 pr-5"/);
    }
  });

  it("animates Active reorders minimally and respects reduced motion", () => {
    expect(source).toContain("WORKSPACE_REORDER_DURATION_MS");
    expect(source).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(source).toContain("node.animate(");
    expect(source).toContain('workspaceListFilter === "active"');
  });

  it("paints Grouped repositories as one surface with one hover and selection fill", () => {
    const groupedSurface =
      /const GROUPED_REPOSITORY_ITEM_CLS =\s*\n\s*"([^"]*)"/.exec(source)?.[1];
    expect(groupedSurface).toContain("bg-bg2/50");
    expect(groupedSurface).toContain("border-y");
    expect(groupedSurface).toContain("border-border2/50");
    expect(groupedSurface).not.toMatch(/(?:^|\s)border-[lr](?:\s|$)/);

    const groupedState =
      /const GROUPED_WORKSPACE_STATE_CLS =\s*\n\s*"([^"]*)"/.exec(source)?.[1];
    expect(groupedState).toBeDefined();
    expect(groupedState).toContain("bg-sidebar-bg-hover");
    expect(groupedState).toContain(
      "group-data-[hovered=true]/workspace:opacity-100",
    );
    expect(groupedState).toContain(
      "group-data-[active=true]/workspace:opacity-100",
    );

    const navMap = source.slice(
      source.indexOf("{navItems.map("),
      source.indexOf("{/* The removed per-repository plus"),
    );
    expect(navMap).toMatch(
      /const groupedRepository\s*=\s*workspaceListFilter === "grouped";/,
    );
    expect(navMap).toContain("groupedBackground={");
    expect(navMap).toContain("groupEnd={groupEnd}");
    expect(source).toMatch(
      /groupedBackground\s*&&\s*"h-7 border-y border-border2\/50 bg-bg2\/50"/,
    );
    const projectSurface =
      /const GROUPED_PROJECT_MARKER_CLS =\s*\n\s*"([^"]*)"/.exec(source)?.[1];
    expect(projectSurface).toContain("bg-bg2/50");
    expect(projectSurface).toContain("border-y");
    expect(projectSurface).toContain("border-l");
    expect(projectSurface).toContain("border-border2/50");
    expect(projectSurface).not.toMatch(/(?:^|\s)border-r(?:\s|$)/);
    expect(
      source.match(/groupedRepository && groupEnd && "rounded-r-md border-r"/g),
    ).toHaveLength(2);
  });

  it("keeps the archive overlay on the same radius as the hover pill", () => {
    // In Grouped mode the tab root is rounded-none, so `overflow-hidden` clips
    // children to a SQUARE box and cannot be relied on to shape them. The
    // overlay's right half is solid sidebar-bg-hover out to right-0, so without
    // a matching right radius it squared off the pill painted by the state
    // layer — visible on every hovered workspace except a group's last one,
    // which the root's own rounded-r-md happened to clip.
    const state = /const GROUPED_WORKSPACE_STATE_CLS =\s*\n\s*"([^"]*)"/.exec(
      source,
    )?.[1];
    const overlay =
      /const WORKSPACE_ACTION_OVERLAY_CLS =\s*\n\s*"([^"]*)"/.exec(source)?.[1];
    const groupedItem =
      /const GROUPED_REPOSITORY_ITEM_CLS =\s*\n\s*"([^"]*)"/.exec(source)?.[1];

    expect(groupedItem).toMatch(/(?:^|\s)rounded-none(?:\s|$)/);
    const pillRadius = /(?:^|\s)rounded-(\w+)(?:\s|$)/.exec(state ?? "")?.[1];
    const overlayRadius = /(?:^|\s)rounded-r-(\w+)(?:\s|$)/.exec(
      overlay ?? "",
    )?.[1];
    expect(pillRadius).toBeDefined();
    expect(overlayRadius).toBe(pillRadius);
    // The overlay must still reach the tab edge; insetting it instead would
    // leave a sliver of un-masked label beside the archive button.
    expect(overlay).toMatch(/(?:^|\s)right-0(?:\s|$)/);
  });

  it("separates Grouped repositories with a wider carrier only between groups", () => {
    // The gap has to key off the repository icon, not off groupEnd: a group's
    // last workspace paints the surface's rounded right edge, so widening its
    // own trailing carrier would push the gap inside the next group's border.
    // `index > 0` is what keeps the first group flush with the lane inset.
    const navMap = source.slice(
      source.indexOf("{navItems.map("),
      source.indexOf("{/* The removed per-repository plus"),
    );

    expect(navMap).toMatch(
      /const groupGap\s*=\s*groupedRepository && item\.kind === "project" && index > 0;/,
    );
    expect(navMap).toContain("groupGap={groupGap}");
    expect(source).toMatch(/const WORKSPACE_GROUP_GAP_CLS = "w-\d+";/);
  });

  it("gives the three leading icon controls one spacing-rhythm gap", () => {
    expect(source).toMatch(
      /const TOP_BAR_LEADING_ACTIONS_CLS =\s*\n\s*"[^"]*\bgap-1\b[^"]*"/,
    );
    expect(source).toContain("<div className={TOP_BAR_LEADING_ACTIONS_CLS}>");
  });
});
