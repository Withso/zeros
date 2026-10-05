import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import type { LayoutElement } from "./layout-props";

export interface SurfaceProps extends React.HTMLAttributes<HTMLElement> {
  as?: LayoutElement;
  kind: "canvas" | "raised" | "floating" | "sidebar";
}

const SURFACE_CLASSES = {
  canvas:
    "bg-bg1 [--surface-hover:var(--bg1-hover)] [--surface-border:var(--border1)]",
  raised:
    "bg-bg2 [--surface-hover:var(--bg2-hover)] [--surface-border:var(--border2)]",
  floating:
    "bg-bg3 [--surface-hover:var(--bg3-hover)] [--surface-border:var(--border2)]",
  sidebar:
    "bg-sidebar-bg [--surface-hover:var(--sidebar-bg-hover)] [--surface-border:var(--border2)]",
} as const;

/** Paints a surface and binds its descendants' hover/selected fill and border.
 * Use hover:bg-(--surface-hover) and border-(--surface-border) within it. */
const Surface = React.forwardRef<HTMLElement, SurfaceProps>(
  ({ as = "div", kind, className, ...props }, ref) =>
    React.createElement(as, {
      ...props,
      ref,
      "data-surface": kind,
      className: cn(SURFACE_CLASSES[kind], className),
    }),
);
Surface.displayName = "Surface";

export { Surface };
