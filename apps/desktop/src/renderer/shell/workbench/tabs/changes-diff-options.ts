import { DEFAULT_CODE_VIEW_LAYOUT, type CodeViewOptions } from "@pierre/diffs";
import { zerosCodeViewOptions } from "@/renderer/shared/theme/diff-theme";

/** Changes-specific chrome lives in Pierre's shadow DOM. Keep the painted
 * dimensions and the virtualizer's estimates together: mismatches accumulate
 * across files and can leave the last card outside the scrollable extent. */
export function changesDiffOptions(options: {
  diffStyle: "unified" | "split";
  codeThemeId: string;
}): CodeViewOptions<undefined, undefined> {
  const shared = zerosCodeViewOptions(options);
  const hunkSeparatorHeight = 24;
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
    unsafeCSS: `${shared.unsafeCSS}
      :host {
        --diffs-bg-separator-override: var(--bg2);
        --diffs-bg-addition-override: color-mix(in lab, var(--diffs-bg) 15%, color-mix(in srgb, var(--green-primary) 65%, var(--fg2)));
        --diffs-bg-deletion-override: color-mix(in lab, var(--diffs-bg) 15%, color-mix(in srgb, var(--red-primary) 65%, var(--fg2)));
      }
      [data-separator="line-info"] {
        height: ${hunkSeparatorHeight}px;
      }
      [data-separator="line-info"] [data-separator-wrapper] {
        grid-template-columns: 24px auto;
      }
      [data-separator="line-info"] [data-expand-button] {
        min-width: 24px;
      }
      [data-separator="line-info"] [data-expand-button] [data-icon] {
        width: 12px;
        height: 12px;
      }
      @media (pointer: coarse) {
        [data-separator="line-info"] [data-separator-multi-button] {
          grid-template-columns: 24px 24px auto;
        }
      }
    `,
    itemMetrics: {
      ...shared.itemMetrics,
      hunkLineCount: 1,
      diffHeaderHeight: 36,
      hunkSeparatorHeight,
    },
  };
}
