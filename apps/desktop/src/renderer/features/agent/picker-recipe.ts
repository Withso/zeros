// The composer pickers (@ mentions, / commands, # pull requests) share one
// floating surface and one anatomy: a 12px fg3 header, 32px rows inset 4px
// with 6px corners that highlight on the surface hover, and 24px tabs.

export const PICKER_WRAP_CLS = "flex min-h-0 flex-col overflow-hidden";
export const PICKER_HEADER_CLS = "text-fg3 px-3 pt-2 pb-1 text-3xxs leading-4";
/** Seven rows show before the list scrolls. */
export const PICKER_LIST_CLS = "max-h-58 min-h-0 overflow-y-auto overscroll-contain p-1";
export const PICKER_ROW_CLS =
  "text-fg1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left transition-colors duration-120 ease-out hover:bg-(--surface-hover) data-[selected]:bg-(--surface-hover)";
export const PICKER_EMPTY_CLS = "text-fg2 px-3 py-2 text-xs leading-4.5";
export const PICKER_TABS_CLS = "flex items-center gap-1 px-1 pt-1";
export const PICKER_TAB_CLS = "h-6 cursor-pointer rounded-md px-2 hover:bg-(--surface-hover)";
