// ──────────────────────────────────────────────────────────
// Shared dropdown / popover menu geometry
// ──────────────────────────────────────────────────────────
//
// Every dropdown-style surface (Popover, DropdownMenu, ContextMenu, Select)
// shares one chrome so menus read as a single system:
//
//   surface  16px corners (2 × --radius-lg), 4px inset, bg3 + border2
//   rows     8px gap, 8px × 6px padding, 12px corners (16 − 4 inset), text-xs
//   icons    14px (size-3.5), fg2 unless a row colors them itself
//
// The 16px corner is intentionally derived from the radius scale instead of
// adding a fourth token; zeros-tokens.css documents the nesting rule.

export const MENU_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*2)]";

/** Hover/selection fill on a row: surface radius minus the 4px inset. */
export const MENU_ITEM_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";

/** Row icon sizing/coloring that still lets an explicit class win. */
export const MENU_ITEM_ICON =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-fg2";
