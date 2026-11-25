import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/**
 * Tile — a large, low-emphasis surface button for "pick one of a few actions"
 * layouts: the Create page's start banners (Open project / GitHub / Start from
 * scratch) and any future onboarding / empty-state choosers.
 *
 * Owns the surface lane — border + bg + hover + focus ring + radius +
 * transition — so call sites stay layout-only (size + internal arrangement via
 * className) and content-only (children). See RULES.md component rules.
 */
const Tile = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "border-border1 bg-bg2 text-fg1 rounded-xl border p-4 text-left",
      "transition-colors duration-fast ease-out",
      // bg2's own hover (stepped up in 2026-11 to read on bg2) on border3;
      // selected-bg stays for selection, so a hovered tile never looks picked.
      "hover:border-border3 hover:bg-bg2-hover",
      "focus-visible:border-accent focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
Tile.displayName = "Tile";

export { Tile };
