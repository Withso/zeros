import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TOP_BAR = "apps/desktop/src/renderer/shell/top-bar.tsx";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** The Tailwind spacing scale is 4px per step, so `gap-2` is 8px and the
 *  half-steps (`gap-1.5`) are 6px. */
function gapClassToPx(token: string): number {
  return Number(token) * 4;
}

/** The class list on the flex container that lays the workspace tabs out.
 *  Anchored on the tab map rather than on a class list, so reordering or adding
 *  utility classes cannot make this silently match the wrong element. */
function stripClasses(src: string): string {
  const map = src.indexOf("{realWorkspaces.map(");
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
  return gapClassToPx(gap[1]);
}

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
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
  it("keeps WORKSPACE_TAB_GAP_PX equal to the strip's gap-* class", () => {
    const topBar = source(TOP_BAR);

    expect(numericConstant(topBar, "WORKSPACE_TAB_GAP_PX")).toBe(
      stripGapPx(topBar),
    );
  });

  it("keeps both edge-inset constants equal to the CSS they describe", () => {
    // Same class of drift as the gap: WORKSPACE_CONTENT_INSET_PX is the first
    // tab's assumed offset (the lane's own padding) and the scroll-into-view
    // margin, while WORKSPACE_STICKY_EDGE_INSET_PX is where a pinned tab lands
    // and where the pinned fades are placed. Nothing reads the computed style,
    // so a constant that disagrees with the class misplaces the pin silently.
    const topBar = source(TOP_BAR);
    const lane = stripClasses(topBar);

    const lanePadding = /(?:^|\s)px-(\d+)(?:\s|$)/.exec(lane);
    expect(lanePadding).not.toBeNull();
    expect(numericConstant(topBar, "WORKSPACE_CONTENT_INSET_PX")).toBe(
      Number(lanePadding![1]) * 4,
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

  it("draws one hairline per edge on a pinned tab", () => {
    // At its pinned edge the tab is flush against a cell that already draws a
    // border there, so it must suppress its own on that side and draw the
    // opposite one. Suppressing the wrong side is the "double border" bug.
    const topBar = source(TOP_BAR);
    const start = topBar.indexOf("function applyWorkspacePinBorders");
    expect(start).toBeGreaterThan(-1);
    const fn = topBar.slice(
      start,
      topBar.indexOf("function setWorkspaceFadeVisible", start),
    );
    expect(fn).not.toBe("");

    expect(fn).toContain('const drawLeft = pinSide === "right"');
    expect(fn).toContain('const drawRight = pinSide === "left"');
    // Width alone renders nothing on a side whose style is still `none`.
    expect(fn).toMatch(/borderLeftStyle/);
    expect(fn).toMatch(/borderRightStyle/);
    // The carrier must be retired when the pin moves, or the inline borders
    // strand on a tab that is no longer pinned.
    expect(topBar).toContain("workspacePinnedTabRef.current = pinnedTab");
    expect(topBar).toMatch(
      /workspacePinnedTabRef\.current !== pinnedTab[\s\S]{0,120}?applyWorkspacePinBorders\(\s*workspacePinnedTabRef\.current,\s*null,?\s*\)/,
    );
  });

  it("draws the divider as a border on the tab, never as an element", () => {
    // workspaceTabNaturalOffsetLeft walks previousElementSibling for the last
    // [data-workspace-tab] and adds ONLY the gap constant. A separator element
    // between tabs would be skipped by that walk and its width never added, so
    // every tab's reconstructed offset would drift by the separator width — and
    // it would punch a 1px hole in the strip's hover hit-testing. A border is
    // inside offsetWidth, so it costs the walk nothing.
    const topBar = source(TOP_BAR);
    const tabCls = classConstant(topBar, "WORKSPACE_TAB_CLS");

    expect(tabCls).toMatch(/\bborder-l\b/);
    expect(tabCls).toMatch(/\bfirst:border-l-0\b/);
    expect(tabCls).toMatch(/\bborder-border1\b/);
    // Zero gap is what makes the borders read as one shared divider rather
    // than two edges with a hole between them.
    expect(stripGapPx(topBar)).toBe(0);
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
    const labelSpans = topBar.match(
      /<span className="[^"]*">\s*\{label\}\s*<\/span>/g,
    );
    expect(labelSpans).toHaveLength(2);
    for (const span of labelSpans ?? []) {
      expect(span).toMatch(/\bflex-auto\b/);
      expect(span).toMatch(/\btruncate\b/);
      expect(span).not.toMatch(/\bflex-1\b/);
    }
  });
});
