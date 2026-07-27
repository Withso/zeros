// ============================================================
// Button — wrap-style migration to v0 (Phase 9.B step 8)
//
// 122 <Button> call sites across 27 files inherit v0 visuals
// by virtue of this file rewriting its implementation to
// delegate to `./v0/button`. Imports unchanged.
//
// API translation:
//
//   variant
//     legacy `default`     → v0 `default`
//     legacy `primary`     → v0 `default`
//         (intentional neutral-primary shift — RULES.md Rule 6
//          + Roadmap 01: primary buttons go neutral; brand color
//          is reserved for the user's accent slider, used only
//          on the small allowlist of accent surfaces. Brand CTA
//          buttons can adopt a brand variant later if needed.)
//     legacy `secondary`   → v0 `secondary`
//     legacy `ghost`       → v0 `ghost`
//     legacy `outline`     → v0 `secondary`
//         (2026-07-12: v0's `outline` variant is retired —
//          wherever it appeared, Secondary renders instead.)
//     legacy `destructive` → v0 `destructive`
//
//   size
//     legacy `sm`      → v0 `sm`
//     legacy `md`      → v0 `default`
//     legacy `lg`      → v0 `lg`
//     legacy `icon`    → v0 `icon-lg`
//     legacy `icon-sm` → v0 `icon`
//         (2026-07-12: v0's icon squares moved onto the shared
//          24/28/32 height scale — icon-sm 24 · icon 28 · new
//          icon-lg 32. Legacy `icon-sm` call sites rendered
//          28px before, so they map to v0 `icon` (still 28px);
//          legacy `icon` (36px) maps to the closest step,
//          `icon-lg` (32px). Every existing consumer keeps its
//          pixel size except the rare legacy `icon`, which
//          tightens 36 → 32.)
//
//   loading
//     Implemented locally as `aria-busy` + `disabled` since
//     v0's Button doesn't ship a loading prop.
// ============================================================
import * as React from "react";

import { Button as V0Button } from "./primitives/button";

type LegacyVariant =
  | "default"
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "destructive"
  | "destructive-secondary";

type LegacySize = "sm" | "md" | "lg" | "icon" | "icon-sm";

type V0ButtonProps = React.ComponentProps<typeof V0Button>;
type V0Variant = NonNullable<V0ButtonProps["variant"]>;
type V0Size = NonNullable<V0ButtonProps["size"]>;

const VARIANT_MAP: Record<LegacyVariant, V0Variant> = {
  default: "default",
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  // 2026-07-12: v0 retired `outline` — legacy call sites render Secondary.
  outline: "secondary",
  destructive: "destructive",
  "destructive-secondary": "destructive-secondary",
};

const SIZE_MAP: Record<LegacySize, V0Size> = {
  sm: "sm",
  md: "default",
  lg: "lg",
  // 2026-07-12: v0's icon squares sit on the shared 24/28/32 scale
  // (icon-sm 24 · icon 28 · icon-lg 32). Legacy names map to the step
  // that preserves their previous rendered size: legacy `icon-sm` was
  // 28px → v0 `icon` (28px); legacy `icon` was 36px → v0 `icon-lg`
  // (32px — the scale ceiling, so the closest step).
  icon: "icon-lg",
  "icon-sm": "icon",
};

export interface ButtonProps
  extends Omit<V0ButtonProps, "variant" | "size"> {
  variant?: LegacyVariant;
  size?: LegacySize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      // No default here on purpose: when the caller omits `variant`, forward
      // `undefined` so the primitive's defaultVariants (Secondary) is the single
      // source of truth for "the default button."
      variant,
      size = "md",
      loading = false,
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <V0Button
        ref={ref}
        variant={variant ? VARIANT_MAP[variant] : undefined}
        size={SIZE_MAP[size]}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...rest}
      />
    );
  },
);
