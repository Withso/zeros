import { DEFAULT_CODE_VIEW_LAYOUT, type CodeViewOptions } from "@pierre/diffs";
import { zerosCodeViewOptions } from "@/renderer/shared/theme/diff-theme";

/** One card per file (plans.md §2): a 12px inset and gap on bg1, a border1
 * edge and 8px corners. The corners clip without a scroll container, so the
 * file headers keep sticking. The inset and edge are important because the
 * document's preflight resets every element's margin and border, and a
 * document rule outranks a normal `:host` one. */
export const CHANGES_FILE_CARD_CSS = `
  :host {
    margin-inline: 12px !important;
    border: 1px solid var(--border1) !important;
    border-radius: 8px;
    overflow: clip;
  }
`;

/** Changes-specific chrome lives in Pierre's shadow DOM. Keep the painted
 * dimensions and the virtualizer's estimates together: mismatches accumulate
 * across files and can leave the last card outside the scrollable extent. */
export function changesDiffOptions<LAnnotation = undefined>(options: {
  diffStyle: "unified" | "split";
  codeThemeId: string;
}): CodeViewOptions<LAnnotation, undefined> {
  const shared = zerosCodeViewOptions<LAnnotation>(options);
  return {
    ...shared,
    unsafeCSS: `${shared.unsafeCSS ?? ""}\n${CHANGES_FILE_CARD_CSS}`,
    // Pierre's layout owns the gaps and the ends of the scroll range, so its
    // estimates include them; 64px at the end keeps the final lines and fold
    // controls clear of the pane edge.
    layout: {
      ...DEFAULT_CODE_VIEW_LAYOUT,
      ...shared.layout,
      paddingTop: 12,
      gap: 12,
      paddingBottom: 64,
    },
    itemMetrics: {
      ...shared.itemMetrics,
      hunkLineCount: 1,
      // The 36px header plus the card's top and bottom edges. Pierre sizes a
      // collapsed file as its header region alone, so both edges count here.
      diffHeaderHeight: 38,
    },
  };
}
