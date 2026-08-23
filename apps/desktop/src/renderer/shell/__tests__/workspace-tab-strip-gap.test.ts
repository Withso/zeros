import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TOP_BAR = "apps/desktop/src/renderer/shell/top-bar.tsx";
const RESOURCE_MONITOR = "apps/desktop/src/renderer/shell/resource-monitor.tsx";
const ELECTRON_MAIN = "apps/desktop/electron/main.ts";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** The Tailwind spacing scale is 4px per step, so `gap-2`/`w-2` are 8px. */
function spacingClassToPx(token: string): number {
  return Number(token) * 4;
}

function heightClassToPx(classes: string): number {
  const height = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(classes);
  if (!height) throw new Error(`no h-* on class list: "${classes}"`);
  return Number(height[1]) * 4;
}

/** The literal classes on the root header, anchored to its accessible name. */
function headerClasses(src: string): string {
  const label = src.indexOf('aria-label="Workspace navigation"');
  if (label < 0) throw new Error("top-bar accessible label not found");
  const opener = src.lastIndexOf('className="', label);
  if (opener < 0) throw new Error("top-bar header className not found");
  return src.slice(
    opener + 'className="'.length,
    src.indexOf('"', opener + 'className="'.length),
  );
}

/** The class list on the flex container that lays the workspace tabs out.
 *  Anchored on the tab map rather than on a class list, so reordering or adding
 *  utility classes cannot make this silently match the wrong element. */
function stripClasses(src: string): string {
  const map = src.indexOf("{navItems.map(");
  if (map < 0) throw new Error("workspace tab map not found");
  const opener = src.lastIndexOf('className="', map);
  if (opener < 0) throw new Error("strip container className not found");
  return src.slice(
    opener + 'className="'.length,
    src.indexOf('"', opener + 'className="'.length),
  );
}

/** The `gap-*` on that container, in pixels. */
function stripGapPx(src: string): number {
  const classes = stripClasses(src);
  const gap = /(?:^|\s)gap-(\d+(?:\.\d+)?)(?:\s|$)/.exec(classes);
  if (!gap) throw new Error(`no gap-* on the strip container: "${classes}"`);
  return spacingClassToPx(gap[1]);
}

function widthClassToPx(classes: string): number {
  const width = /(?:^|\s)w-(\d+(?:\.\d+)?)(?:\s|$)/.exec(classes);
  if (!width) throw new Error(`no numeric w-* on class list: "${classes}"`);
  return spacingClassToPx(width[1]);
}

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
}

/** The class utilities on each span that renders `{label}` — one per tab
 *  variant. Walks back from the child to its own opening tag and collects every
 *  string literal in the attribute, so this holds for a plain `className="…"`
 *  and for `className={cn(…)}` (the placeholder's conditional trailing-marker
 *  reservation is one). `${label}` interpolations are skipped. */
function labelSpanClasses(src: string): string[] {
  const out: string[] = [];
  for (
    let at = src.indexOf("{label}");
    at >= 0;
    at = src.indexOf("{label}", at + 1)
  ) {
    if (src[at - 1] === "$") continue;
    const opener = src.lastIndexOf("<span", at);
    if (opener < 0) continue;
    const literals = src.slice(opener, at).match(/"[^"]*"/g);
    if (literals) {
      out.push(literals.map((literal) => literal.slice(1, -1)).join(" "));
    }
  }
  return out;
}

/** The value of a top-level `const NAME = <number>;`. */
function numericConstant(src: string, name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1]);
}

// A sticky element reports its CLAMPED position in `offsetLeft`, so the active
// tab cannot be measured directly while it is pinned. workspaceTabNaturalOffset
// Left reconstructs the true flow position as (previous tab's right edge + the
// strip's gap) — which means the JS constant has to agree with the CSS class or
// every pin and fade lands off by the difference. Nothing at runtime reads the
// computed style, so drift here is invisible until the strip visibly misaligns.
describe("workspace tab strip gap", () => {
  it("keeps pin math equal to the four-pixel boundary carrier", () => {
    const topBar = source(TOP_BAR);
    const boundaryWidth = widthClassToPx(
      classConstant(topBar, "TOP_BAR_BOUNDARY_CLS"),
    );

    // Boundary carriers own the physical gap so their optional hairline does
    // not add width. Flex gap must remain zero or every boundary doubles it.
    expect(stripGapPx(topBar)).toBe(0);
    expect(boundaryWidth).toBe(4);
    expect(numericConstant(topBar, "WORKSPACE_TAB_GAP_PX")).toBe(boundaryWidth);
  });

  it("keeps both edge-inset constants equal to the CSS they describe", () => {
    // Same class of drift as the gap: WORKSPACE_CONTENT_INSET_PX is the first
    // tab's assumed offset (the leading boundary carrier) and the
    // scroll-into-view margin, while WORKSPACE_STICKY_EDGE_INSET_PX is where a
    // pinned tab lands and where the pinned fades are placed. Nothing reads the
    // computed style, so a disagreement silently misplaces the pin.
    const topBar = source(TOP_BAR);
    const lane = stripClasses(topBar);

    const lanePadding = /(?:^|\s)px-(\d+)(?:\s|$)/.exec(lane);
    expect(lanePadding).not.toBeNull();
    expect(Number(lanePadding![1])).toBe(0);
    expect(numericConstant(topBar, "WORKSPACE_CONTENT_INSET_PX")).toBe(
      widthClassToPx(classConstant(topBar, "TOP_BAR_BOUNDARY_CLS")),
    );

    const tabCls = classConstant(topBar, "WORKSPACE_TAB_CLS");
    const stickyLeft = /data-\[active=true\]:left-(\d+)(?:\s|$)/.exec(tabCls);
    const stickyRight = /data-\[active=true\]:right-(\d+)(?:\s|$)/.exec(tabCls);
    expect(stickyLeft).not.toBeNull();
    expect(stickyRight).not.toBeNull();
    // A pinned tab has to land on the SAME inset at both edges, or one side
    // pins flush and the other floats.
    expect(stickyLeft![1]).toBe(stickyRight![1]);
    expect(numericConstant(topBar, "WORKSPACE_STICKY_EDGE_INSET_PX")).toBe(
      Number(stickyLeft![1]) * 4,
    );
  });

  it("keeps pinned pills borderless and masks both edge gutters", () => {
    // A selected pill floats four pixels in from either edge. Opaque gutters
    // preserve that breathing room while tabs scroll underneath it; mutating
    // inline borders would reintroduce the divided, boxy treatment.
    const topBar = source(TOP_BAR);
    const root = topBar.slice(topBar.indexOf("export function TopBar"));

    expect(topBar).not.toContain("applyWorkspacePinBorders");
    expect(topBar).not.toContain("workspacePinnedTabRef");
    expect(
      root.match(/bg-sidebar-bg[^"\n]*\bz-30\b[^"\n]*\bw-1\b/g),
    ).toHaveLength(2);
  });

  it("clears a two-pixel inward edge around every pinned pill", () => {
    // A sticky pill floats over the scrolling lane. Without an opaque sliver
    // immediately INSIDE the lane, the next workspace (and, in Grouped mode,
    // its continuous surface and hairline) paints through the rounded corner.
    // A ring paints below the rounded pill without changing its size, so its
    // inward half is the requested breathing room while its outward half merges
    // harmlessly into the existing opaque edge gutter. It is shared by every
    // filter: Grouped, Ungrouped, Active and a repository-only lane all use the
    // same sticky workspace component.
    const topBar = source(TOP_BAR);
    const pinned = classConstant(topBar, "WORKSPACE_PINNED_EDGE_CLS");

    const ringWidth =
      /group-data-\[workspace-pin\]\/lane:data-\[active=true\]:ring-(\d+)/.exec(
        pinned,
      );
    expect(ringWidth).not.toBeNull();
    expect(Number(ringWidth![1])).toBe(2);
    expect(pinned).toContain(
      "group-data-[workspace-pin]/lane:data-[active=true]:ring-sidebar-bg",
    );

    for (const [start, end] of [
      ["function WorkspaceTab(", "function PendingWorkspaceTab("],
      ["function PendingWorkspaceTab(", "interface ProjectMarkerProps"],
    ] as const) {
      const component = topBar.slice(
        topBar.indexOf(start),
        topBar.indexOf(end),
      );
      expect(component).toContain("WORKSPACE_PINNED_EDGE_CLS");
    }
  });

  it("uses centered subtle separators without putting borders on pills", () => {
    // The active tab should read as one floating selection, while inactive
    // workspaces get a short hairline in the boundary carrier. The carrier is
    // already the physical gap, so the line adds no width to pin math.
    const topBar = source(TOP_BAR);
    const tabCls = classConstant(topBar, "WORKSPACE_TAB_CLS");
    const boundaryCls = classConstant(topBar, "TOP_BAR_BOUNDARY_CLS");
    const separatorCls = classConstant(topBar, "TOP_BAR_SEPARATOR_CLS");

    expect(tabCls).toMatch(/\bh-7\b/);
    expect(tabCls).toMatch(/\brounded-md\b/);
    expect(tabCls).not.toMatch(/\bborder(?:-[lrtbxy])?(?:\s|$)/);
    expect(boundaryCls).toMatch(/\bw-1\b/);
    expect(boundaryCls).toMatch(/\bitems-center\b/);
    expect(boundaryCls).toMatch(/\bjustify-center\b/);
    expect(separatorCls).toMatch(/\bbg-border1\b/);
    expect(separatorCls).toMatch(/(?:^|\s)h-\[14px\](?:\s|$)/);
    expect(separatorCls).toMatch(/\bw-px\b/);
  });

  it("keeps conditional boundary utilities token-separated", () => {
    const topBar = source(TOP_BAR);
    const boundary = topBar.slice(
      topBar.indexOf("function TopBarBoundary"),
      topBar.indexOf("function setWorkspaceFadeVisible"),
    );

    // Keep conditional fragments in the class combiner. Direct template
    // concatenation silently produced invalid utilities such as
    // `w-pxinvisible` and `justify-centerrelative`, and the Tailwind Prettier
    // plugin normalizes away leading whitespace used as a workaround.
    expect(boundary).toMatch(
      /cn\(\s*TOP_BAR_BOUNDARY_CLS,\s*edge && "relative z-40",\s*groupedBackground\s*&&\s*"h-7 border-y border-border2\/50 bg-bg2\/50",\s*groupGap && WORKSPACE_GROUP_GAP_CLS,?\s*\)/,
    );
    expect(boundary).toMatch(
      /cn\(\s*TOP_BAR_SEPARATOR_CLS,\s*\(!showSeparator \|\| suppressSeparator\) && "invisible",?\s*\)/,
    );
  });

  it("widens only the inter-group carrier and leaves pin math on the base width", () => {
    // The group gap overrides the carrier's own w-1 through tailwind-merge, so
    // it must stay LAST in that cn() and must not leak into WORKSPACE_TAB_GAP_PX
    // — the pin reconstruction adds that constant after the previous flow item,
    // and in Grouped mode a tab's previous flow item is always its own
    // repository icon or the tab beside it, never across a group boundary.
    const topBar = source(TOP_BAR);
    const baseWidth = widthClassToPx(
      classConstant(topBar, "TOP_BAR_BOUNDARY_CLS"),
    );
    const groupGap = widthClassToPx(
      classConstant(topBar, "WORKSPACE_GROUP_GAP_CLS"),
    );

    expect(groupGap).toBeGreaterThan(baseWidth);
    expect(numericConstant(topBar, "WORKSPACE_TAB_GAP_PX")).toBe(baseWidth);
    expect(numericConstant(topBar, "WORKSPACE_CONTENT_INSET_PX")).toBe(
      baseWidth,
    );
    expect(numericConstant(topBar, "WORKSPACE_STICKY_EDGE_INSET_PX")).toBe(
      baseWidth,
    );
  });

  it("sizes tabs by content between a 120px floor and a 180px cap", () => {
    // A `w-*` of any kind defeats intrinsic sizing and pins every tab to one
    // width — the whole point of the content fit is that a tab pays only for
    // the name and indicators it actually carries.
    const topBar = source(TOP_BAR);
    const tabCls = classConstant(topBar, "WORKSPACE_TAB_CLS");

    expect(tabCls).toMatch(/(?:^|\s)min-w-\[120px\](?:\s|$)/);
    expect(tabCls).toMatch(/(?:^|\s)max-w-\[180px\](?:\s|$)/);
    expect(tabCls).not.toMatch(/(?:^|\s)w-\[/);
    expect(tabCls).not.toMatch(/(?:^|\s)w-(?:\d|full|fit|screen)\b/);
  });

  it("lets only the branch name absorb the cap", () => {
    // `flex-1` sets a basis of 0, which erases the child from the tab's
    // intrinsic width and collapses every tab onto the floor. Both the open
    // Button and the two label spans have to stay basis-auto for the tab to
    // measure its own contents.
    const topBar = source(TOP_BAR);

    expect(classConstant(topBar, "WORKSPACE_OPEN_BUTTON_CLS")).toMatch(
      /\bflex-auto\b/,
    );
    expect(classConstant(topBar, "WORKSPACE_OPEN_BUTTON_CLS")).not.toMatch(
      /\bflex-1\b/,
    );
    const labelSpans = labelSpanClasses(topBar);
    expect(labelSpans).toHaveLength(2);
    for (const span of labelSpans) {
      expect(span).toMatch(/\bflex-auto\b/);
      expect(span).toMatch(/\btruncate\b/);
      expect(span).not.toMatch(/\bflex-1\b/);
    }
  });
});

describe("top-bar borderless navigation chrome", () => {
  it("keeps a 40px rail with six pixels around its 28px controls", () => {
    const topBar = source(TOP_BAR);
    const header = headerClasses(topBar);
    const railHeight = heightClassToPx(header);

    expect(railHeight).toBe(40);

    // h-10 must be the rail's TOTAL painted height (no `box-content` pushing the
    // hairline outside the box for a 41px rail), and the 1px border-b must be
    // balanced by 1px of top padding — otherwise the 28px controls center in the
    // 39px above the hairline and sit half a pixel above the rail's center line.
    expect(header).not.toMatch(/\bbox-content\b/);
    expect(header).toMatch(/\bborder-b\b/);
    expect(header).toMatch(/\bpt-px\b/);

    for (const name of [
      "ICON_BUTTON_CLS",
      "MENU_ICON_BUTTON_CLS",
      "MAIN_TAB_CLS",
      "PROJECT_TRIGGER_CLS",
      "WORKSPACE_TAB_CLS",
    ]) {
      const controlHeight = heightClassToPx(classConstant(topBar, name));
      expect(controlHeight).toBe(28);
      expect((railHeight - controlHeight) / 2).toBe(6);
    }
  });

  it("keeps the native traffic lights aligned to the 40px title rail", () => {
    const electronMain = source(ELECTRON_MAIN);

    // hiddenInset is Electron's compact native macOS treatment. Electron can
    // position or hide these OS-owned buttons, but exposes no diameter API.
    expect(electronMain).toContain('titleBarStyle: "hiddenInset"');
    expect(electronMain).toContain("trafficLightPosition: { x: 19, y: 12 }");
  });

  it("removes full-height cell borders and uses inset rounded controls", () => {
    const topBar = source(TOP_BAR);
    const root = topBar.slice(topBar.indexOf("export function TopBar"));
    const resourceMonitorSource = source(RESOURCE_MONITOR);
    const resourceMonitor = resourceMonitorSource.slice(
      resourceMonitorSource.indexOf("export const ResourceMonitor"),
    );

    expect(root).not.toMatch(/\bborder-l\b/);
    expect(root).not.toMatch(/\bborder-r\b/);
    expect(resourceMonitor).not.toMatch(/\bborder-l\b/);
    expect(resourceMonitor).not.toMatch(/\bborder-r\b/);
    // Padding on both adjacent wrappers used to add up to an 8–12px gap.
    // Four-pixel boundary carriers own navigation gaps; the conditional
    // Resource/Archive pair uses the equivalent gap-1 so a null ResourceMonitor
    // cannot leave a phantom carrier behind.
    expect(root).not.toMatch(/flex h-full shrink-0 items-center px-[12]\b/);
    expect(resourceMonitor).not.toMatch(/items-center px-2\b/);
    expect(root).toMatch(
      /className="flex h-full shrink-0 items-center gap-1">\s*<ResourceMonitor \/>/,
    );
    for (const name of [
      "ICON_BUTTON_CLS",
      "MENU_ICON_BUTTON_CLS",
      "MAIN_TAB_CLS",
      "PROJECT_TRIGGER_CLS",
    ]) {
      expect(classConstant(topBar, name)).toMatch(/\brounded-md\b/);
    }
  });

  it("gives the selected workspace an opaque inset fill at either sticky edge", () => {
    const topBar = source(TOP_BAR);
    const tabCls = classConstant(topBar, "WORKSPACE_TAB_CLS");

    expect(tabCls).toMatch(/data-\[active=true\]:left-1\b/);
    expect(tabCls).toMatch(/data-\[active=true\]:right-1\b/);
    expect(tabCls).toMatch(/data-\[active=true\]:bg-sidebar-bg-hover\b/);
    expect(tabCls).toMatch(/data-\[active=true\]:text-fg1\b/);
  });

  it("suppresses carriers around selected real and pending entries in the unified lane", () => {
    const topBar = source(TOP_BAR);
    const navMap = topBar.slice(
      topBar.indexOf("{navItems.map("),
      topBar.indexOf("{/* The removed per-repository plus"),
    );

    expect(navMap).toContain('item.kind === "workspace"');
    expect(navMap).toContain('item.kind === "pending"');
    expect(navMap).toContain("const leftActive");
    expect(navMap).toMatch(
      /showSeparator=\{navigationBoundarySeparatorVisible\(\s*leftActive,\s*active,?\s*\)\}/,
    );
  });

  it("registers the selected optimistic workspace with the same pin machinery", () => {
    // A newly-created workspace is selected before its engine row arrives. It
    // must remain sticky/revealable during that optimistic interval, not only
    // after PendingWorkspaceTab is replaced by WorkspaceTab.
    const topBar = source(TOP_BAR);
    const pending = topBar.slice(
      topBar.indexOf("function PendingWorkspaceTab"),
      topBar.indexOf("interface ProjectMarkerProps"),
    );

    expect(pending).toContain("tabRef");
    expect(pending).toContain("ref={tabRef}");
    expect(topBar).toMatch(
      /const activeWorkspaceTabKey\s*=\s*activeWorkspaceId\s*\?\?\s*activePendingCreate\?\.token\s*\?\?\s*null/,
    );
    expect(topBar).toContain('if (activePage !== "workspace") return null;');
    expect(topBar).toContain("registerWorkspaceTab(item.pending.token, node)");
    expect(topBar).toContain("activeWorkspaceTabKey");
  });
});
