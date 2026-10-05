import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/renderer/shared/ui/cn";

const buttonVariants = cva(
  // Shared by EVERY button — and IDENTICAL to the Select dropdown trigger
  // (primitives/select.tsx) so a button and a dropdown in one row are the
  // same object in two roles: fit content, 6px corners (--radius-md), 6px
  // horizontal / 4px vertical padding, 4px icon↔text gap, 13px text on an
  // 18px line (leading-4.5), 14px glyphs. Height is NOT set — it falls out of
  // the padding + line box + 1px border as 28px, exactly the trigger's. Every
  // variant carries a border (transparent where it has no outline) so filled
  // and outlined buttons measure the same. Size variants are height-neutral;
  // only the icon-only squares pin a 28px box.
  // :where keeps fallback SVG sizing below caller descendant selectors;
  // explicit size classes on an SVG still take precedence as well.
  "inline-flex w-fit items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1.5 py-1 text-xs leading-4.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_:where(svg:not([class*='size-']))]:size-3.5",
  {
    variants: {
      // Canonical set: Primary (the rare main CTA) + Secondary (the everyday
      // button), two Destructive flavors, Ghost (icon buttons), and Link.
      variant: {
        // PRIMARY — inverted fill (near-white on dark, near-black on light).
        // Reserve for the single main action on a view.
        default:
          "bg-primary-button-bg text-primary-button-fg shadow hover:bg-primary-button-hover",
        // SECONDARY — the everyday button, wearing the dropdown trigger's
        // exact chrome: TRANSPARENT fill so it blends with whatever surface it
        // sits on (bg1 / bg2 / bg3 alike) + border3 → hover/open bg2-highlight
        // + border4. (2026-07-17: fill bg2 → transparent so the button "matches
        // its background"; 2026-09-15: border2/bg2-hover → the trigger's
        // border3/bg2-highlight so a secondary button and a Select are
        // indistinguishable at rest and on hover.)
        secondary:
          "border-border3 bg-transparent text-fg1 hover:border-border4 hover:bg-bg2-highlight data-[state=open]:border-border4 data-[state=open]:bg-bg2-highlight",
        // GHOST — transparent, no outline; icon buttons + subtle/secondary text
        // actions (a dialog's Cancel). Same hover fill as the dropdown.
        ghost: "hover:bg-bg2-highlight hover:text-fg1",
        // DESTRUCTIVE (primary) — solid red fill (--red-secondary); text is the
        // static --red-secondary-fg (white in both themes — fg1 would flip dark in light).
        destructive:
          "bg-red-secondary text-red-secondary-fg shadow hover:bg-red-secondary-hover",
        // DESTRUCTIVE (secondary) — same neutral surface as Secondary
        // (transparent fill + border3 → hover bg2-highlight/border4);
        // red-primary text carries the danger cue.
        "destructive-secondary":
          "border-border3 bg-transparent text-red-primary hover:border-border4 hover:bg-bg2-highlight",
        // SECONDARY-ON — a Secondary button in a latched/selected state, for a
        // toggle that stays on screen after you press it (the empty chat's
        // transcript pills). Deliberately NOT Primary: N white fills is N main
        // CTAs stacked above the view's real one, which is what the Primary
        // reservation above exists to prevent.
        //
        // It lifts one step in BOTH fill and border rather than relying on
        // colour, so it survives the light theme and colour-blind readers; the
        // caller adds the brand-coloured mark and the check that carry the
        // rest of the signal. border4 (not highlighted-bright) because
        // highlighted-bright is the app's focus ring — overloading it would
        // make a focused-but-off control and an on-but-unfocused control look
        // identical.
        "secondary-on":
          "border-border4 bg-bg2-highlight text-fg1 hover:bg-bg2-highlight",
      },
      // Two control heights (docs/design-system.md → Controls):
      //   standard 28px — every button by default, identical to the Select
      //     trigger. `sm` / `default` / `lg` are kept as names so call sites
      //     don't churn, but they are the same 28px control (2026-09-15:
      //     unified with the dropdown trigger).
      //   compact 24px — dense rows: inline toolbars, tab/row trailing
      //     actions, chips. 2px vertical padding on the same 18px line box;
      //     unsized glyphs drop to 12px (text and icon-only alike).
      // Never mix the two in one row; size the whole row with one of them.
      size: {
        sm: "",
        default: "",
        lg: "",
        compact: "py-0.5 [&_:where(svg:not([class*='size-']))]:size-3",
        "icon-sm": "size-7 p-0",
        icon: "size-7 p-0",
        "icon-lg": "size-7 p-0",
        "icon-compact":
          "size-6 p-0 [&_:where(svg:not([class*='size-']))]:size-3",
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
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
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
