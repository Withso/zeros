import { DEFAULT_CODE_VIEW_LAYOUT, type CodeViewOptions } from "@pierre/diffs";
import { DIFF_HUNK_SEPARATOR_HEIGHT, zerosCodeViewOptions } from "@/renderer/shared/theme/diff-theme";

/** Changes-specific chrome lives in Pierre's shadow DOM. Keep the painted
 * dimensions and the virtualizer's estimates together: mismatches accumulate
 * across files and can leave the last card outside the scrollable extent. */
export function changesDiffOptions(options: {
  diffStyle: "unified" | "split";
  codeThemeId: string;
}): CodeViewOptions<undefined, undefined> {
  const shared = zerosCodeViewOptions(options);
  const hunkSeparatorHeight = DIFF_HUNK_SEPARATOR_HEIGHT;
  return {
    ...shared,
    // Reserve the end of the scroll range in Pierre's layout, rather than
    // padding its measured viewport or every file. This keeps the final lines
    // and fold controls clear of the pane edge without adding gaps between cards.
    layout: {
      ...DEFAULT_CODE_VIEW_LAYOUT,
      ...shared.layout,
      paddingBottom: 64,
    },
    itemMetrics: {
      ...shared.itemMetrics,
      hunkLineCount: 1,
      diffHeaderHeight: 36,
      hunkSeparatorHeight,
    },
  };
}
