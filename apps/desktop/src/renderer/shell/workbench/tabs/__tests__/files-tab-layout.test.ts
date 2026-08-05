import { describe, expect, it } from "vitest";

import {
  resolveFilesTabLayout,
  shouldRestoreTreePanelFocus,
  TREE_PANEL_BOTTOM_GAP,
  TREE_PANEL_MIN_HEIGHT,
  TREE_PANEL_TOP_OFFSET,
  treePanelHeight,
} from "../files-tab-layout";

describe("resolveFilesTabLayout", () => {
  it("makes a blank File tab a full-width tree-only surface", () => {
    expect(resolveFilesTabLayout(undefined, false)).toEqual({
      hasFile: false,
      fileTreeVisible: true,
      viewerVisible: false,
      seamVisible: false,
      treeUsesSharedWidth: false,
      toggleVisible: false,
    });
  });

  it("gives a direct-open File tab a full-width viewer when collapsed", () => {
    expect(resolveFilesTabLayout("src/app.ts", false)).toEqual({
      hasFile: true,
      fileTreeVisible: false,
      viewerVisible: true,
      seamVisible: false,
      treeUsesSharedWidth: false,
      toggleVisible: true,
    });
  });

  it("shows the split and shared-width tree only for that expanded File tab", () => {
    expect(resolveFilesTabLayout("src/app.ts", true)).toEqual({
      hasFile: true,
      fileTreeVisible: true,
      viewerVisible: true,
      seamVisible: true,
      treeUsesSharedWidth: true,
      toggleVisible: true,
    });
  });
});

describe("treePanelHeight", () => {
  it("fills the tab body minus the header band and a floating bottom gap", () => {
    expect(treePanelHeight(420)).toBe(
      420 - TREE_PANEL_TOP_OFFSET - TREE_PANEL_BOTTOM_GAP,
    );
  });

  it("never collapses below the usable floor", () => {
    expect(treePanelHeight(0)).toBe(TREE_PANEL_MIN_HEIGHT);
    expect(treePanelHeight(TREE_PANEL_MIN_HEIGHT + TREE_PANEL_TOP_OFFSET)).toBe(
      TREE_PANEL_MIN_HEIGHT,
    );
  });

  it("is a snapshot of the open-time height — resize math never re-enters", () => {
    // The popup contract: the value is derived once from the height passed in
    // at open; there is no live input, so a later column resize cannot change
    // an open popup. (Behavioural freeze is covered by the browser smoke.)
    const atOpen = treePanelHeight(600);
    expect(atOpen).toBe(600 - TREE_PANEL_TOP_OFFSET - TREE_PANEL_BOTTOM_GAP);
    expect(treePanelHeight(600)).toBe(atOpen);
  });
});

describe("shouldRestoreTreePanelFocus", () => {
  it("bounces focus that lands back inside the panel (tree rows, shadow host)", () => {
    expect(shouldRestoreTreePanelFocus(true)).toBe(true);
  });

  it("bounces focus dropped to nowhere (scroller tail, non-focusable click)", () => {
    expect(shouldRestoreTreePanelFocus(null)).toBe(true);
  });

  it("respects focus leaving for a real outside surface", () => {
    expect(shouldRestoreTreePanelFocus(false)).toBe(false);
  });
});
