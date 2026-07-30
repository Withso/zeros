import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/zeros/ui/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-[3px] focus:ring-highlighted-bright/50",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary-button-bg text-primary-button-fg shadow hover:bg-primary-button-hover",
        secondary:
          "border-transparent bg-bg2-hover text-fg1 hover:bg-bg2-hover/80",
        destructive:
          "border-transparent bg-red-secondary text-red-secondary-fg shadow hover:bg-red-secondary/80",
        outline: "text-fg1",
        // Filled STATUS pair — soft token bg with its matching fg (on a
        // `--<family>-bg` surface use `--<family>-fg`; zeros-foundation.md).
        // Non-interactive: no hover shift (these read as state, not actions).
        success: "border-transparent bg-green-bg text-green-fg",
        failure: "border-transparent bg-red-bg text-red-fg",
        // Inline chip for a NAME carried inside a sentence (the chat's
        // "Created <workspace>" provenance row). The blue container pair —
        // `--blue-bg` fill, `--blue-primary` text (2026-07-29 founder
        // direction; the family's `-fg` anchor is the usual partner for a
        // `-bg` surface, but the brighter `-primary` is what was asked for and
        // it clears contrast on both themes).
        //
        // Blue rather than the earlier neutral `--bg1-highlight`: this chip is
        // the one interactive token in an otherwise inert block, and on the
        // transcript's own `--bg1` a neutral lift was too quiet to read as a
        // trigger. Both tokens are theme-defined, so unlike `--bg3` (== bg1 ==
        // white in light mode) the chip cannot vanish.
        //
        // Hover outlines rather than shifting the fill. A fill shift can't be
        // written once for both themes here — `--blue-bg` is near-black in
        // dark and near-white in light, so any single lighten/darken (or an
        // opacity step) improves one theme and washes out the other. The
        // border slot is already reserved by the base class, so an anchor
        // colour in it is theme-correct by construction and leaves the
        // load-bearing text colour alone.
        //
        // Carries its own typography (14px regular, overriding the base's 13px
        // semibold) because this chip sits INSIDE a sentence — every other word
        // in the provenance row is 14px regular UI font, and a louder chip made
        // the workspace name the loudest thing in the block. In the variant, not
        // the call site: RULES.md Rule 5 keeps typography out of `className`.
        accent:
          "border-transparent bg-blue-bg text-blue-primary text-sm font-normal hover:border-blue-primary",
        // Inline chip for a piece of READ-ONLY account data carried inside a
        // label — the connected GitHub login in Settings → Git. Neutral rather
        // than `accent`: this one is inert (nothing happens if you click it),
        // and the blue chip is the app's clickable-name treatment.
        //
        // `--bg2`, NOT the `--bg1-highlight` first asked for (2026-07-29): its
        // only call site sits INSIDE a settings card, and that card is already
        // painted `--bg1-highlight` (SETTINGS_CARD_LIST_CLS), so the chip would
        // have been the exact same colour as the surface under it in both
        // themes — #181716 on #181716 dark, #F7F7F7 on #F7F7F7 light. `--bg2`
        // is the next step up and reads on the card either way (founder picked
        // it over an outlined variant). Not `--bg3`: light-mode bg3 == bg1 and
        // check:ui rejects it as a fill.
        //
        // Typography in the variant, not the call site (RULES.md Rule 5): 14px
        // regular so the chip matches the radio label it is embedded in rather
        // than shouting over it at the base 13px semibold.
        neutral: "border-transparent bg-bg2 text-fg1 text-sm font-normal",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/** forwardRef is load-bearing, not boilerplate: a Badge is used as an `asChild`
 *  trigger (Radix DropdownMenu / Tooltip clone the child and attach a ref to
 *  anchor the popper). Without it React warns "Function components cannot be
 *  given refs", the anchor ref stays null, and the menu has nothing to position
 *  against — see OpenInBadgeMenu in shell/column2-topbar.tsx. */
const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };
