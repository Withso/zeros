import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/**
 * Tile — a large, low-emphasis surface button for "pick one of a few actions"
 * layouts: the no-projects welcome screen (Open project / GitHub / Quick start)
 * and any future onboarding / empty-state choosers.
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
      "border-border1 bg-bg2 text-fg1 rounded-lg border p-4 text-left",
      "transition-colors duration-120 ease-out",
      "hover:border-border2 hover:bg-bg2-hover",
      "focus-visible:ring-border2 focus-visible:ring-1 focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
Tile.displayName = "Tile";

export { Tile };
