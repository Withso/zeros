// The composer pickers (@ mentions, / commands, # pull requests) share one
// anatomy on the surface they open on (the composer's, when docked above it):
// a 12px medium fg3 header, 32px rows inset 4px with 8px corners that
// highlight on the surface hover, and 24px tabs over a border1 rule.

export const PICKER_WRAP_CLS = "flex min-h-0 flex-col overflow-hidden";
export const PICKER_HEADER_CLS = "text-fg3 px-3 pt-2.5 pb-1 text-3xxs leading-4 font-medium";
/** Seven rows show before the list scrolls. */
export const PICKER_LIST_CLS = "max-h-58 min-h-0 overflow-y-auto overscroll-contain p-1";
export const PICKER_ROW_CLS =
  "text-fg1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left font-normal transition-colors duration-120 ease-out hover:bg-(--surface-hover) data-[selected]:bg-(--surface-hover)";
/** A row's name (13/18 medium), its hint (fg3) and its trailing kind (12/16). */
export const PICKER_NAME_CLS = "text-fg1 max-w-[60%] shrink-0 truncate text-xs leading-4.5 font-medium";
export const PICKER_HINT_CLS = "text-fg3 min-w-0 flex-1 truncate text-xs leading-4.5";
export const PICKER_KIND_CLS = "text-fg3 shrink-0 text-3xxs leading-4";
export const PICKER_EMPTY_CLS = "text-fg2 px-3 py-2 text-xs leading-4.5";
export const PICKER_TABS_CLS = "border-border1 mx-1 mt-1 flex items-center gap-0.5 border-b pb-1";
export const PICKER_TAB_CLS = "h-6 cursor-pointer rounded-md px-2 text-3xxs leading-4 hover:bg-(--surface-hover)";
