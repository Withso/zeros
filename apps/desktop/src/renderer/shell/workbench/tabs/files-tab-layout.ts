export interface FilesTabLayout {
  hasFile: boolean;
  fileTreeVisible: boolean;
  viewerVisible: boolean;
  seamVisible: boolean;
  treeUsesSharedWidth: boolean;
  toggleVisible: boolean;
}

// ── Floating tree panel (the collapsed state's quick file switcher) ──

/** Panel top inside the tab body: the 36px header band + a 4px popup offset
 * (the popover primitives' default sideOffset). */
export const TREE_PANEL_TOP_OFFSET = 40;
/** Air under the popup so it visibly floats instead of touching the tab's
 * bottom edge. */
export const TREE_PANEL_BOTTOM_GAP = 8;
/** Height floor so a squeezed column still yields a usable list (the popup
 * may then clip against the tab body, which beats an unusably short list). */
export const TREE_PANEL_MIN_HEIGHT = 160;

/** The popup's height, derived ONCE from the tab body's height at open time.
 * A popup keeps its size while it is up — resizing the column afterwards must
 * not reflow it — so the trigger measures the tab body when it fires and the
 * result rides the panel as a fixed height until it closes. */
export function treePanelHeight(containerHeight: number): number {
  return Math.max(
    TREE_PANEL_MIN_HEIGHT,
    containerHeight - TREE_PANEL_TOP_OFFSET - TREE_PANEL_BOTTOM_GAP,
  );
}

/** The popup's filter input owns focus for its whole lifetime. Focus that
 * lands back INSIDE the panel (a clicked tree row, the shadow host after a
 * context-menu close → `true`) and focus DROPPED to nowhere (`relatedTarget:
 * null`, e.g. a click on the scroller's empty tail → `null`) bounce back to
 * the input; focus that leaves for a real surface OUTSIDE the panel
 * (`false` — the header's popovers, the trigger, a dismissal target) is
 * respected, because those interactions also dismiss the popup. */
export function shouldRestoreTreePanelFocus(
  relatedTargetInsidePanel: boolean | null,
): boolean {
  return relatedTargetInsidePanel !== false;
}

/** Resolve the Files surface synchronously from the selected path and the
 * individual tab's persisted tree preference. Blank tabs deliberately ignore
 * a stale/corrupt collapsed value: they are full-width tree-only surfaces. */
export function resolveFilesTabLayout(
  filePath: string | undefined,
  storedTreeVisible: boolean | undefined,
): FilesTabLayout {
  const hasFile = Boolean(filePath);
  const fileTreeVisible = !hasFile || storedTreeVisible === true;

  return {
    hasFile,
    fileTreeVisible,
    viewerVisible: hasFile,
    seamVisible: hasFile && fileTreeVisible,
    treeUsesSharedWidth: hasFile && fileTreeVisible,
    toggleVisible: hasFile,
  };
}
