import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/zeros/ui/cn";

const buttonVariants = cva(
  // Shared by EVERY button: fit content (no default width — width follows the
  // text + icons), 10px horizontal padding, 8px icon↔text gap, and a 4px radius
  // (--radius-sm; see RULES.md "Buttons"). The size variants set height only.
  "inline-flex w-fit items-center justify-center gap-2 whitespace-nowrap rounded-sm px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      // Canonical set: Primary (the rare main CTA) + Secondary (the everyday
      // button), two Destructive flavors, Ghost (icon buttons), and Link.
      variant: {
        // PRIMARY — inverted fill (near-white on dark, near-black on light).
        // Reserve for the single main action on a view.
        default:
          "bg-primary-button-bg text-primary-button-fg shadow hover:bg-primary-button-hover",
        // SECONDARY — the everyday button: TRANSPARENT fill so it blends with
        // whatever surface it sits on (bg1 / bg2 / bg3 alike) + border2 → hover
        // bg2-hover + border3. (2026-07-17: fill bg2 → transparent so the button
        // "matches its background"; on a bg2 surface this is visually identical
        // to the old bg2 fill — it just stops over-lifting on bg1/bg3.)
        secondary:
          "border border-border2 bg-transparent text-fg1 hover:border-border3 hover:bg-bg2-hover",
        // GHOST — transparent; icon buttons + subtle/secondary text actions.
        ghost: "hover:bg-bg2-hover hover:text-fg1",
        // DESTRUCTIVE (primary) — solid red fill (--red-secondary); text is the
        // static --red-secondary-fg (white in both themes — fg1 would flip dark in light).
        destructive: "bg-red-secondary text-red-secondary-fg shadow hover:bg-red-secondary/90",
        // DESTRUCTIVE (secondary) — same neutral surface as Secondary
        // (transparent fill + border2 → hover bg2-hover/border3); red-primary
        // text carries the danger cue.
        "destructive-secondary":
          "border border-border2 bg-transparent text-red-primary hover:border-border3 hover:bg-bg2-hover",
      },
      // Height only — 28px default; 24px (denser) / 32px (roomier) per layout.
      // Icon-only squares sit on the SAME 24/28/32 scale so mixed rows line
      // up: icon-sm ↔ sm, icon ↔ default, icon-lg ↔ lg. They drop the shared
      // padding. (2026-07-12: was icon 36px / icon-sm 28px.)
      size: {
        sm: "h-6 text-xs",
        default: "h-7",
        lg: "h-8",
        "icon-sm": "h-6 w-6 px-0",
        icon: "h-7 w-7 px-0",
        "icon-lg": "h-8 w-8 px-0",
      },
    },
    defaultVariants: {
      // Secondary is the everyday button, so it's the default when no variant
      // is passed. Primary (`variant="default"`) is the rare main-CTA opt-in.
      variant: "secondary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
