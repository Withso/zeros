import * as React from "react";

import { cn } from "@/zeros/ui/cn";

/**
 * Tile — a large, low-emphasis surface button for "pick one of a few actions"
 * layouts: the no-projects welcome screen (Open project / GitHub / Quick start)
 * and any future onboarding / empty-state choosers.
 *
 * Owns the surface lane — border + bg + hover + focus ring + radius +
 * transition — so call sites stay layout-only (size + internal arrangement via
 * className) and content-only (children). See RULES.md Rule 4/5.
 */
const Tile = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "rounded-lg border border-border1 bg-bg2 p-4 text-left text-fg1",
      "transition-colors duration-120 ease-out",
      "hover:border-border2 hover:bg-bg2-hover",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border2",
      className,
    )}
    {...props}
  />
));
Tile.displayName = "Tile";

export { Tile };
