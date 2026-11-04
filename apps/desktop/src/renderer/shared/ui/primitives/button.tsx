import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading/zeros-spinner";

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
  // `aria-disabled` is the disabled state that keeps hover, so a Tooltip can
  // say why the action is unavailable; the caller keeps the click a no-op.
  // A loading button's spinner takes the leading icon's place.
  "inline-flex w-fit select-none items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1.5 py-1 text-xs leading-4.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_:where(svg:not([class*='size-']))]:size-3.5 [&>[data-zeros-loader]+svg]:hidden",
  {
    variants: {
      // Canonical set: Primary (the single main action), Secondary (the
      // everyday button), Ghost (toolbar and quiet actions) and two
      // Destructive flavors. Toggles use aria-pressed on Secondary or Ghost.
      variant: {
        // PRIMARY — inverted fill (near-white on dark, near-black on light).
        // Reserve for the single main action on a view. Flat: no shadow.
        primary:
          "bg-primary-button-bg text-primary-button-fg hover:bg-primary-button-hover",
        // SECONDARY — the everyday button, wearing the dropdown trigger's
        // exact chrome: TRANSPARENT fill so it blends with whatever surface it
        // sits on (bg1 / bg2 / bg3 alike) + border3 → hover/open bg2-highlight
        // + border4, so a secondary button and a Select are indistinguishable
        // at rest and on hover. Pressed (aria-pressed) holds the open look:
        // fill and border both lift, so it survives Light and colour blindness.
        secondary:
          "border-border3 bg-transparent text-fg1 hover:border-border4 hover:bg-bg2-highlight data-[state=open]:border-border4 data-[state=open]:bg-bg2-highlight aria-pressed:border-border4 aria-pressed:bg-bg2-highlight",
        // GHOST — transparent, no outline; toolbar and subtle text actions (a
        // dialog's Cancel). Its open menu and pressed state hold the hover.
        ghost:
          "hover:bg-bg2-highlight hover:text-fg1 data-[state=open]:bg-bg2-highlight data-[state=open]:text-fg1 aria-pressed:border-border4 aria-pressed:bg-bg2-highlight aria-pressed:text-fg1",
        // DESTRUCTIVE (primary) — solid red fill (--red-secondary); text is the
        // static --red-secondary-fg (white in both themes — fg1 would flip dark in light).
        destructive:
          "bg-red-secondary text-red-secondary-fg hover:bg-red-secondary-hover",
        // DESTRUCTIVE (secondary) — same neutral surface as Secondary
        // (transparent fill + border3 → hover bg2-highlight/border4);
        // red-primary text carries the danger cue.
        "destructive-secondary":
          "border-border3 bg-transparent text-red-primary hover:border-border4 hover:bg-bg2-highlight",
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
      // is passed. Primary (`variant="primary"`) is the rare main-CTA opt-in.
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
  /** Busy: the button disables, reports aria-busy and shows the spinner in
   *  its leading icon's place, keeping its colour. */
  loading?: boolean;
}

const SPINNER_TONE = {
  primary: "inverted",
  destructive: "inherit",
} as const;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const compact = size === "compact" || size === "icon-compact";
    return (
      <Comp
        {...props}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || props["aria-busy"] || undefined}
      >
        {loading && !asChild ? (
          <ZerosSpinner
            size={compact ? 16 : 18}
            tone={
              (variant &&
                SPINNER_TONE[variant as keyof typeof SPINNER_TONE]) ??
              "default"
            }
            label="Working"
          />
        ) : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
