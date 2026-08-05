// Compatibility wrapper for the repository's pre-primitive Button API.
// Existing callers keep their variant and size names while the shared
// primitive remains the single source of visual styling. `loading` is handled
// here because it belongs to the compatibility API, not the primitive.
import * as React from "react";

import { Button as PrimitiveButton } from "./primitives/button";

type LegacyVariant =
  | "default"
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "destructive"
  | "destructive-secondary";

type LegacySize = "sm" | "md" | "lg" | "icon" | "icon-sm";

type PrimitiveButtonProps = React.ComponentProps<typeof PrimitiveButton>;
type PrimitiveVariant = NonNullable<PrimitiveButtonProps["variant"]>;
type PrimitiveSize = NonNullable<PrimitiveButtonProps["size"]>;

const VARIANT_MAP: Record<LegacyVariant, PrimitiveVariant> = {
  default: "default",
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  // The primitive has no outline treatment; preserve the established
  // compatibility behavior by rendering it as Secondary.
  outline: "secondary",
  destructive: "destructive",
  "destructive-secondary": "destructive-secondary",
};

const SIZE_MAP: Record<LegacySize, PrimitiveSize> = {
  sm: "sm",
  md: "default",
  lg: "lg",
  // Legacy names map to the closest step on the shared 24/28/32px scale.
  // `icon-sm` previously rendered at 28px; `icon` previously rendered at
  // 36px and therefore maps to the 32px scale ceiling.
  icon: "icon-lg",
  "icon-sm": "icon",
};

export interface ButtonProps extends Omit<
  PrimitiveButtonProps,
  "variant" | "size"
> {
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
      <PrimitiveButton
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
