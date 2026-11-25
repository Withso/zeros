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
  "inline-flex w-fit select-none items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1.5 py-1 text-xs leading-4.5 font-medium transition-[background-color,border-color,color,opacity] duration-fast ease-out focus-visible:border-accent focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_:where(svg:not([class*='size-']))]:size-3.5 [&>[data-zeros-loader]+svg]:hidden",
  {
    variants: {
      // Canonical set: Primary (the single main action), Secondary (the
      // everyday button), Ghost (toolbar and quiet actions) and two
      // Destructive flavors. Toggles use aria-pressed on Secondary or Ghost.
      variant: {
        // PRIMARY — inverted fill (near-white on dark, near-black on light).
        // Reserve for the single main action on a view. Flat: no shadow.
        primary:
          "bg-primary-button-bg text-primary-button-fg hover:opacity-90",
        // SECONDARY — the everyday button, wearing the dropdown trigger's
        // exact chrome: TRANSPARENT fill so it blends with whatever surface it
        // sits on (bg1 / bg2 / bg3 alike) + border3 → hover/open selected-bg
        // + border4, so a secondary button and a Select are indistinguishable
        // at rest and on hover. Pressed (aria-pressed) is the selected fill:
        // selection never draws or changes an edge.
        secondary:
          "border-border3 bg-transparent text-fg1 hover:border-border4 hover:bg-selected-bg data-[state=open]:border-border4 data-[state=open]:bg-selected-bg aria-pressed:bg-selected-bg aria-pressed:hover:bg-selected-bg",
        // GHOST — transparent, no outline; toolbar and subtle text actions (a
        // dialog's Cancel). Its open menu holds the hover; pressed is the
        // selected fill with no edge.
        ghost:
          "hover:bg-selected-bg hover:text-fg1 data-[state=open]:bg-selected-bg data-[state=open]:text-fg1 aria-pressed:bg-selected-bg aria-pressed:text-fg1 aria-pressed:hover:bg-selected-bg",
        // DESTRUCTIVE (primary) — solid red fill (--red-solid); text is the
        // static --red-solid-fg (white in both themes — fg1 would flip dark in light).
        destructive:
          "bg-red-solid text-red-solid-fg hover:opacity-90",
        // DESTRUCTIVE (secondary) — same neutral surface as Secondary
        // (transparent fill + border3 → hover selected-bg/border4);
        // red-text text carries the danger cue.
        "destructive-secondary":
          "border-border3 bg-transparent text-red-text hover:border-border4 hover:bg-selected-bg",
      },
      // Three control heights (P7):
      //   standard 28px — every button by default, identical to the Select
      //     trigger.
      //   compact 24px — dense rows: tab/row trailing actions, chips. 2px
      //     vertical padding on the same 18px line box; unsized glyphs drop
      //     to 12px (text and icon-only alike).
      //   inline 20px — an item in an inline floating group (Toolbar
      //     size="inline"): 12/16 text, 14px icons, 4px corners.
      // Never mix them in one row; size the whole row with one of them.
      size: {
        standard: "",
        compact: "py-0.5 [&_:where(svg:not([class*='size-']))]:size-3",
        inline: "h-5 rounded-sm px-1.5 py-0 text-3xxs leading-4",
        icon: "size-7 p-0",
        "icon-compact":
          "size-6 p-0 [&_:where(svg:not([class*='size-']))]:size-3",
      },
    },
    defaultVariants: {
      // Secondary is the everyday button, so it's the default when no variant
      // is passed. Primary (`variant="primary"`) is the rare main-CTA opt-in.
      variant: "secondary",
      size: "standard",
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
        {/* Slot takes exactly one child, so asChild passes it alone. */}
        {asChild ? (
          children
        ) : (
          <>
            {loading ? (
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
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
