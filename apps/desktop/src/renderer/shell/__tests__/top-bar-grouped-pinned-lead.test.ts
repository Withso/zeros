import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────
// Grouped mode, pinned at an overflow edge
// ──────────────────────────────────────────────────────────
//
// Two things happen when a Grouped selection reaches an edge: the pill drops
// the repository-surface treatment it can no longer belong to (square corners,
// half-transparent fill, top/bottom hairlines — a fragment of a group floating
// at the edge), and its repository icon travels with it so the pinned pill can
// still be attributed to a repository.
//
// Almost none of that is expressible in a rendered-DOM test: it is CSS sticky
// offsets, cascade specificity, and paint order. So these assertions pin the
// SOURCE invariants that no runtime check can catch — every one of them is a
// place where two independent declarations have to agree, and where the failure
// mode is silent misplacement rather than an exception.

const source = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/shell/top-bar.tsx"),
  "utf8",
);

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
}

function numericConstant(expression: string): number {
  const match = new RegExp(`const ${expression} =\\s*\\n?\\s*(\\d+);`).exec(
    source,
  );
  if (!match) throw new Error(`${expression} not found`);
  return Number(match[1]);
}

/** Tailwind's spacing scale is 0.25rem per step. */
function spacingClassToPx(classes: string, prefix: string): number {
  const match = new RegExp(
    `(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`,
  ).exec(classes);
  if (!match) throw new Error(`no ${prefix}-* on class list: "${classes}"`);
  return Number(match[1]) * 4;
}

describe("grouped pinned pill presentation", () => {
  it("restores the plain rounded selection the other lanes pin", () => {
    // The reported bug: at an edge the Grouped pill kept `rounded-none`, the
    // half-transparent bg2/50 surface and its border-y hairlines, so the
    // selection read as a square box around a rounded pill.
    const pinned = classConstant("GROUPED_PINNED_WORKSPACE_CLS");

    expect(pinned).toContain("rounded-md");
    expect(pinned).toContain("border-0");
    expect(pinned).toContain("bg-sidebar-bg-hover");
    // Same fill the unpinned selection state layer and every other lane use —
    // the point is that pinning changes nothing about WHICH selection colour.
    expect(classConstant("GROUPED_WORKSPACE_STATE_CLS")).toContain(
      "bg-sidebar-bg-hover",
    );
    expect(classConstant("WORKSPACE_TAB_CLS")).toContain(
      "data-[active=true]:bg-sidebar-bg-hover",
    );
  });

  it("doubles every pinned selector so it outranks the grouped fills", () => {
    // GROUPED_REPOSITORY_ITEM_CLS carries single-variant `data-[active=true]:`
    // and `data-[hovered=true]:` background rules, which are (0,2,0). A
    // single-variant override ties with them and is settled by Tailwind's
    // emission order — i.e. by luck. The lane marker plus the tab's own
    // `data-[active=true]` is (0,3,0) and decides it in the cascade instead.
    const grouped = classConstant("GROUPED_REPOSITORY_ITEM_CLS");
    expect(grouped).toContain("data-[active=true]:bg-bg2/50");
    expect(grouped).toContain("data-[hovered=true]:bg-bg2/50");

    for (const utility of classConstant("GROUPED_PINNED_WORKSPACE_CLS").split(
      /\s+/,
    )) {
      expect(utility).toMatch(
        /^group-data-\[workspace-pin\]\/lane:data-\[active=true\]:/,
      );
    }
  });

  it("keys the pinned pill off the LANE, never off the tab node itself", () => {
    // The regression this exists for: the marker used to be written onto
    // whatever node a workspace-id-keyed ref map happened to hold. A ref map
    // can hand back an element React has already replaced — it still measures a
    // live-looking 120px box, so the geometry and the fades stay right while
    // the marker lands on a node that is not on screen, and the pinned pill
    // silently keeps its group treatment. The lane is one element that lives as
    // long as the strip and cannot be missed.
    expect(classConstant("GROUPED_PINNED_WORKSPACE_CLS")).not.toContain(
      "data-[pinned]",
    );
    expect(source).toContain('data-workspace-lane="true"');
    expect(source).toContain('const WORKSPACE_PIN_ATTR = "workspacePin";');
    expect(source).toContain(
      'const WORKSPACE_PIN_LEAD_ATTR = "workspacePinLead";',
    );
    expect(source).toContain(
      "nav.querySelector<HTMLElement>('[data-workspace-lane=\"true\"]')",
    );
    // The lane carries the group name every pinned utility resolves against.
    const lane = /className="([^"]*group\/lane[^"]*)"/.exec(source)?.[1];
    expect(lane).toBeDefined();
    expect(lane).toContain("relative");
  });

  it("retires the grouped surface underneath the pinned pill", () => {
    // The selected pill no longer belongs to the continuous Grouped surface.
    // Clear that surface inside its box below the rounded state layer; the
    // shared WORKSPACE_PINNED_EDGE_CLS ring separately clears the transparent
    // corner pixels and the inward gap outside this root's overflow clip.
    const mask = classConstant("GROUPED_PINNED_WORKSPACE_MASK_CLS");

    expect(mask).toContain("bg-sidebar-bg");
    expect(mask).toMatch(/(?:^|\s)inset-0(?:\s|$)/);
    // Square and below the rounded state layer: the mask clears the entire
    // pinned box, while the state layer alone shapes the visible selection.
    expect(mask).not.toContain("rounded");
    expect(mask).toContain("-z-20");
    expect(classConstant("GROUPED_WORKSPACE_STATE_CLS")).toContain("-z-10");
    expect(mask).toContain("pointer-events-none");
    expect(mask).toContain("group-data-[workspace-pin]/lane:block");
    // `border-0` when pinned is what makes `inset-0` the whole 28px control;
    // with the group cap's border still on, the mask would stop short of the
    // hairline it is there to hide.
    expect(classConstant("GROUPED_PINNED_WORKSPACE_CLS")).toContain("border-0");
    // Only the selected tab: every other tab genuinely sits on that surface.
    expect(source.match(/groupedRepository && active && \(/g)).toHaveLength(2);
    expect(
      source.match(/className=\{GROUPED_PINNED_WORKSPACE_MASK_CLS\}/g),
    ).toHaveLength(2);
  });

  it("keeps the pinned overrides off the shared tab class", () => {
    // WORKSPACE_TAB_CLS is the contract for EVERY lane. Its own borderless
    // rounded pill is already correct when pinned, and workspace-tab-strip-gap
    // asserts it carries no border utility at all.
    const tab = classConstant("WORKSPACE_TAB_CLS");
    expect(tab).not.toContain("data-[pinned]");
    expect(tab).not.toMatch(/\bborder(?:-[lrtbxy])?(?:\s|$)/);
  });

  it("applies both grouped-only pin classes to real and pending tabs alike", () => {
    // A workspace selected the instant it is created is represented by the
    // optimistic placeholder, which pins through the same machinery. Divergence
    // here would make the pill change shape the moment the create landed.
    for (const cls of [
      "GROUPED_WORKSPACE_STICKY_INSET_CLS",
      "GROUPED_PINNED_WORKSPACE_CLS",
    ]) {
      expect(
        source.match(new RegExp(`groupedRepository && ${cls},`, "g")),
      ).toHaveLength(2);
    }
  });
});

describe("grouped pinned repository lead", () => {
  it("ties the pill's reserved leading inset to the CSS that produces it", () => {
    // Two independent declarations of the same 36px: the sticky `left-9` the
    // browser uses, and the constant the pin decision, the reveal target and
    // the fade placement use. Drift here silently pins the pill a lead-slot
    // early or late.
    const cssInset = spacingClassToPx(
      classConstant("GROUPED_WORKSPACE_STICKY_INSET_CLS"),
      "data-\\[active=true\\]:left",
    );
    const edge = numericConstant("WORKSPACE_STICKY_EDGE_INSET_PX");
    const gap = numericConstant("WORKSPACE_TAB_GAP_PX");
    const leadWidth = numericConstant("WORKSPACE_PINNED_LEAD_WIDTH_PX");

    expect(cssInset).toBe(edge + leadWidth + gap);
    expect(source).toMatch(
      /const WORKSPACE_PINNED_LEAD_SLOT_PX =\s*\n?\s*WORKSPACE_PINNED_LEAD_WIDTH_PX \+ WORKSPACE_TAB_GAP_PX;/,
    );
    expect(source).toMatch(
      /const WORKSPACE_GROUPED_LEADING_INSET_PX =\s*\n?\s*WORKSPACE_STICKY_EDGE_INSET_PX \+ WORKSPACE_PINNED_LEAD_SLOT_PX;/,
    );
  });

  it("keeps the lead width equal to the icon control it measures", () => {
    // The lead is a compact ProjectMarker: `size="icon"` plus ICON_BUTTON_CLS's
    // own h-7 w-7. The pin math reads the live offsetWidth, but the fade
    // placement and the reserved inset use this constant.
    expect(numericConstant("WORKSPACE_PINNED_LEAD_WIDTH_PX")).toBe(
      spacingClassToPx(classConstant("ICON_BUTTON_CLS"), "w"),
    );
  });

  it("publishes the lead's trailing inset through the variable its CSS reads", () => {
    // The trailing inset depends on the pill's content-sized width, so it
    // cannot be a static utility. A custom property lets the measure pass
    // publish it with one style write per frame instead of a React render —
    // but only if the name in the class and the name in the writer match.
    const variable =
      /const WORKSPACE_PINNED_LEAD_RIGHT_VAR =\s*\n?\s*"([^"]*)"/.exec(
        source,
      )?.[1];
    expect(variable).toBe("--zeros-workspace-pinned-lead-right");
    expect(classConstant("GROUPED_STICKY_LEAD_CLS")).toContain(
      `right-[var(${variable},`,
    );
    expect(source).toContain(
      "nav.style.setProperty(\n      WORKSPACE_PINNED_LEAD_RIGHT_VAR,",
    );
    expect(source).toContain("workspacePinnedLeadTrailingInset({");
  });

  it("sticks the lead at both edges and lifts it over the fades only when pinned", () => {
    const lead = classConstant("GROUPED_STICKY_LEAD_CLS");

    expect(lead).toMatch(/(?:^|\s)sticky(?:\s|$)/);
    expect(lead).toMatch(/(?:^|\s)left-1(?:\s|$)/);
    // z-10 is the overflow gradients. An always-lifted lead would punch through
    // them while it is still ordinary scrolling lane content; a never-lifted
    // one would be faded out at the very edge it is pinned to.
    expect(lead).toContain("group-data-[workspace-pin-lead]/lane:z-20");
    expect(lead).not.toMatch(/(?:^|\s)z-\d+(?:\s|$)/);
    // Its OWN marker, not the pill's: the pair can be pinned to different
    // edges, and at the leading edge the lead parks first and holds alone.
    expect(lead).not.toContain("group-data-[workspace-pin]/lane");
  });

  it("swaps the lead's presentation instantly rather than over a transition", () => {
    // The lead is a Button, and the primitive's base class is
    // `transition-colors`. Cross-fading the pinned mask means several frames of
    // tabs scrolling visibly through the pinned icon.
    expect(classConstant("GROUPED_STICKY_LEAD_CLS")).toMatch(
      /(?:^|\s)transition-none(?:\s|$)/,
    );
    expect(classConstant("WORKSPACE_TAB_CLS")).toMatch(
      /(?:^|\s)transition-none(?:\s|$)/,
    );
  });

  it("masks the lead and the carrier in front of the pill, squarely", () => {
    const mask = classConstant("GROUPED_PINNED_LEAD_MASK_CLS");
    const lead = classConstant("GROUPED_STICKY_LEAD_CLS");

    // Its own box plus the four-pixel carrier: without the overhang, the gap
    // between the pinned pair stays a window onto the scrolling tabs.
    expect(mask).toMatch(/(?:^|\s)left-0(?:\s|$)/);
    expect(mask).toMatch(/(?:^|\s)-right-1(?:\s|$)/);
    expect(mask).toMatch(/(?:^|\s)inset-y-0(?:\s|$)/);
    // The overhang IS the carrier: read the step back out of the class rather
    // than trusting the two to stay in step by eye.
    const overhang = /(?:^|\s)-right-(\d+(?:\.\d+)?)(?:\s|$)/.exec(mask);
    expect(overhang).not.toBeNull();
    expect(Number(overhang![1]) * 4).toBe(
      numericConstant("WORKSPACE_TAB_GAP_PX"),
    );
    // SQUARE and opaque: it hides a surface LIGHTER than itself, so any radius
    // hands that surface back at the corners as bright wedges.
    expect(mask).toContain("bg-sidebar-bg");
    expect(mask).not.toContain("rounded");
    // Under the rounded hover/focus layer, which still shapes interaction.
    expect(mask).toContain("-z-20");
    expect(classConstant("GROUPED_PROJECT_STATE_CLS")).toContain("-z-10");
    expect(classConstant("GROUPED_PROJECT_STATE_CLS")).toContain("rounded-md");
    // `border-0` is what makes the mask cover the whole control: `inset-0`
    // resolves against the padding box, which excludes the group cap's border.
    expect(lead).toContain("group-data-[workspace-pin-lead]/lane:border-0");
    expect(mask).toContain("pointer-events-none");
    expect(mask).toContain("group-data-[workspace-pin-lead]/lane:block");
  });

  it("marks the lead before the state layer so the mask paints under it", () => {
    // Both are negative-z children of one stacking context, so their DOM order
    // is their paint order. The mask has to come first or it covers hover.
    const marker = source.slice(
      source.indexOf("function ProjectMarker("),
      source.indexOf("function archivedAge("),
    );
    expect(marker.indexOf("GROUPED_PINNED_LEAD_MASK_CLS")).toBeGreaterThan(0);
    expect(marker.indexOf("GROUPED_PINNED_LEAD_MASK_CLS")).toBeLessThan(
      marker.indexOf("GROUPED_PROJECT_STATE_CLS"),
    );
    // Declared after the grouped surface: `sticky` and `relative` share
    // tailwind-merge's position group, so the lead wins that key only by order.
    expect(marker).toMatch(
      /GROUPED_PROJECT_MARKER_CLS,[\s\S]{0,400}?pinnedLead && GROUPED_STICKY_LEAD_CLS,/,
    );
  });

  it("promotes exactly one lead, and only in the Grouped lane", () => {
    // Ungrouped and Active paint repository identity inside each tab, and a
    // repository-only lane has nothing to disambiguate; neither renders a lane
    // icon to promote. Keying off the selected tab's own owner is what keeps it
    // to one, since Grouped emits one group per repository.
    expect(source).toMatch(
      /const pinnedLeadProjectId = useMemo\(\(\) => \{\s*if \(!groupedLane \|\| !activeWorkspaceTabKey\) return null;/,
    );
    expect(source).toContain(
      'const groupedLane = workspaceListFilter === "grouped";',
    );
    expect(source).toContain(
      "pinnedLead={item.project.id === pinnedLeadProjectId}",
    );
    expect(source).toContain(
      "data-top-bar-pinned-lead={pinnedLead || undefined}",
    );
  });

  it("reconstructs flow positions from the carrier, not from a sticky neighbour", () => {
    // Chromium reports a sticky element's CLAMPED offsetLeft, and the lead is
    // now sticky — so the previous-flow-item walk would have read a pinned
    // lead's edge position as the first tab's flow position. The carrier in
    // front of every item is never sticky and its right edge IS that position,
    // which also drops the walk's assumption that the carrier is the base four
    // pixels (Grouped widens the one before a repository icon to eight).
    const helper = source.slice(
      source.indexOf("function workspaceTabNaturalOffsetLeft("),
      source.indexOf("function setWorkspacePinned("),
    );
    expect(helper).toContain('sibling.dataset.topBarBoundary === "true"');
    expect(helper).toContain("sibling.offsetLeft + sibling.offsetWidth");
    expect(helper).toContain('sibling.dataset.topBarPinnedLead !== "true"');
    expect(source).toContain('data-top-bar-boundary="true"');
    expect(source).toContain(
      "data-top-bar-pinned-lead={pinnedLead || undefined}",
    );
  });

  it("drives both markers imperatively from the one measure pass", () => {
    // Same contract as `data-hovered`: a direct DOM write from the
    // scroll-synchronous measure pass, never a React render, so the markers
    // land on the frame the browser moved the sticky boxes on. Writing them to
    // the lane is what makes them self-clearing — one node, both markers,
    // no bookkeeping to follow the selection and nothing to tear down.
    expect(source).toContain("function setLanePinMarker(");
    expect(source).toContain("delete lane.dataset[attribute]");
    expect(source).toContain(
      "setLanePinMarker(lane, WORKSPACE_PIN_ATTR, pinSide)",
    );
    expect(source).toContain(
      "setLanePinMarker(lane, WORKSPACE_PIN_LEAD_ATTR, leadPinSide)",
    );
    expect(source).not.toContain("workspaceEdgePinnedNodesRef");
    expect(source).not.toContain("workspaceLeadRefs");
    // The pinned presentation stays CSS — no inline geometry mutation, which is
    // what the earlier border-writing implementation did.
    expect(source).not.toContain("applyWorkspacePinBorders");
    expect(source).not.toContain("style.borderLeft");
    expect(source).not.toContain("style.borderRight");
  });

  it("measures the pill the browser actually pinned, from the DOM", () => {
    // `data-active` is the same thing CSS sticky keys off, so a DOM query
    // cannot disagree with what the browser pinned. A workspace-id-keyed ref
    // map can: it is repopulated on every re-render through a fresh callback
    // and can hand back a replaced node, which measures a plausible 120px box
    // and puts the pin decision on the wrong element.
    const measure = source.slice(
      source.indexOf("const measureWorkspaceStrip = useCallback"),
      source.indexOf("const syncWorkspaceStrip = useCallback"),
    );
    expect(measure).toContain(
      '\'[data-workspace-tab="true"][data-active="true"]\'',
    );
    expect(measure).toContain("'[data-top-bar-pinned-lead=\"true\"]'");
    // The usage, not the name — the comment above the query names the map it
    // deliberately does not read.
    expect(measure).not.toContain("workspaceTabRefs.current");
    // The main checkout has no tab in this lane, so "no active tab here" is
    // the guard; a separate id comparison would just be a second way to be
    // wrong about it.
    expect(measure).not.toContain("mainWorkspace");
  });

  it("re-measures when the selection moves without changing the tab list", () => {
    // The measure pass reads both elements from the DOM, so nothing forces it
    // to re-run on selection change any more. Reselecting inside one repository
    // changes neither tab identity nor order, and the lane would keep a marker
    // describing the previous pill.
    const observer = source.slice(
      source.indexOf("// Recalculate masks when the window or tab content"),
    );
    const deps = observer.slice(
      observer.indexOf("}, ["),
      observer.indexOf("]);"),
    );
    expect(deps).toContain("activeWorkspaceTabKey");
    expect(deps).toContain("pinnedLeadProjectId");
    expect(deps).toContain("workspaceTabIdentity");
  });

  it("resolves both sides against the insets their own CSS declares", () => {
    // The pill and the lead pin on different thresholds, so each gets its own
    // asymmetric pair. Reading the pill's leading inset off the LANE MODE and
    // not off the lead element matters: the sticky utility is on every Grouped
    // tab, so 36px is the inset the browser uses whether or not a lead node is
    // registered yet.
    expect(source).toMatch(
      /const leadingInset = groupedLane\s*\?\s*WORKSPACE_GROUPED_LEADING_INSET_PX\s*:\s*WORKSPACE_STICKY_EDGE_INSET_PX;/,
    );
    expect(source).toMatch(
      /edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,\s*leadingInset,/,
    );
    expect(source).toMatch(/trailingInset: leadTrailingInset,/);
    // The reveal has to land the pill ON that inset, or sticky pushes the
    // freshly revealed pill a lead-slot right, over its own neighbour.
    expect(source).toMatch(
      /leadingInset: groupedLane\s*\?\s*WORKSPACE_GROUPED_LEADING_INSET_PX\s*:\s*WORKSPACE_CONTENT_INSET_PX,/,
    );
    expect(source).toContain(
      "workspaceFadeVisibility(overflow, pinSide, leadPinSide)",
    );
    expect(source).toContain("workspacePinnedFadeOffsets({");
  });

  it("re-reveals the selection when a filter switch restarts the strip", () => {
    // The scroll reset keys off the filter, so the reveal has to as well.
    // Identity alone missed it: Ungrouped and Active can publish the same keys
    // in the same order, leaving the selection off-screen after the reset.
    const reveal = source.slice(
      source.indexOf("// Dashboard cards and newly-created chats"),
    );
    const deps = reveal.slice(reveal.indexOf("}, ["), reveal.indexOf("]);"));
    expect(deps).toContain("workspaceListFilter");
    expect(deps).toContain("workspaceTabIdentity");
    expect(deps).toContain("groupedLane");
  });
});
