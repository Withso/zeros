// ──────────────────────────────────────────────────────────
// Shared floating surface geometry
// ──────────────────────────────────────────────────────────
//
// Every floating surface (DropdownMenu, ContextMenu, Select, Command,
// Popover, HoverCard, Toast) shares one chrome so menus read as one system:
//
//   surface  12px corners (1.5 × --radius-lg), 4px inset, bg3 + border2
//   dividers 1px border2 hairline, full-bleed, 4px above and below
//   rows     28px (min-h-7), 8px gap, 8px sides, 8px corners, text-xs
//   icons    14px (size-3.5), fg2 unless a row colours them itself
//
// Rows are 8px inside a 4px inset on a 12px surface, so the corners stay
// parallel (inner radius = outer radius − inset). The 12px corner is derived
// from the radius scale instead of adding a fourth token; zeros-tokens.css
// documents the nesting rule.

export const MENU_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";

/** Inset between the surface edge and its rows, equal on every side. */
export const MENU_SURFACE_INSET = "p-1";

/** Full-bleed hairline between row groups with the same 4px gap as the inset. */
export const MENU_SEPARATOR = "bg-border2 -mx-1 my-1 h-px";

/** Hover/selection fill on a row: the standard 8px radius-lg. */
export const MENU_ITEM_RADIUS = "rounded-lg";

/** A row's box: 28px for one line, growing for a second. */
export const MENU_ITEM_BOX = "min-h-7 gap-2 px-2 py-1 text-xs leading-4.5";

/** Group label: 12px medium fg3 in every menu. */
export const MENU_LABEL = "text-fg3 px-2 pt-1.5 pb-1 text-3xxs leading-4 font-medium";

/** A destructive row: red-primary text and icon, placed last. */
export const MENU_ITEM_DESTRUCTIVE =
  "text-red-primary focus:text-red-primary [&_svg]:text-red-primary";

export const MENU_ITEM_ICON =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-fg2";
