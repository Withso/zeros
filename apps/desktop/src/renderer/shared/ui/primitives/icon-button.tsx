import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/renderer/shared/ui/cn";
import { buttonVariants } from "./button";

type IconButtonMotion =
  | "hover"
  /** @deprecated Preserves a pre-existing recipe; unify during the UI iteration. */
  | "colors"
  /** @deprecated Preserves a pre-existing recipe; unify during the UI iteration. */
  | "colors-hover"
  /** @deprecated Preserves a pre-existing recipe; unify during the UI iteration. */
  | "none";

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  label: string;
  /** inline = 20px action embedded in rows/tabs;
   * standard = 28px chrome action (Button icon-sm geometry). */
  size?: "inline" | "standard";
  hover?:
    | "raised"
    /** @deprecated Preserves a pre-existing recipe; unify during the UI iteration. */
    | "subtle";
  motion?: IconButtonMotion;
  asChild?: boolean;
}

const SIZE_CLASSES = {
  inline: "inline-flex size-5 items-center justify-center",
  standard: buttonVariants({ variant: "ghost", size: "icon-sm" }),
} as const;

const HOVER_CLASSES = {
  raised: "hover:bg-bg2-hover hover:text-fg1",
  subtle: "hover:bg-bg2-hover/40 hover:text-fg1",
} as const;

const MOTION_CLASSES = {
  hover: "transition-[background-color,color] duration-120 ease-out",
  colors: "transition-colors",
  "colors-hover": "transition-colors duration-120 ease-out",
  none: "",
} as const;

/** Icon-only action with a required accessible name. New callers use the
 * defaults (size as needed, hover="raised", motion="hover"). asChild preserves
 * link semantics; standard size retains Button's focus and SVG contracts. */
const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      size = "inline",
      hover = "raised",
      motion = "hover",
      asChild = false,
      type,
      className,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        {...props}
        ref={ref}
        type={asChild ? type : (type ?? "button")}
        aria-label={label}
        className={cn(
          SIZE_CLASSES[size],
          "text-fg2 rounded-sm",
          HOVER_CLASSES[hover],
          MOTION_CLASSES[motion],
          className,
        )}
      />
    );
  },
);
IconButton.displayName = "IconButton";

export { IconButton };
