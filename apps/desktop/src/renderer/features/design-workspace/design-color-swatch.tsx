// PURPOSE: A colour swatch over a checkerboard, shared by the colour picker
// and the token lists, apart from both so neither imports the other.

import type React from "react";

import { cn } from "../../shared/ui/cn";

/** The checkerboard behind a translucent colour. */
export function checkerboardBackground(): React.CSSProperties {
  return {
    backgroundColor: "var(--bg1)",
    backgroundImage:
      "linear-gradient(45deg,var(--border2) 25%,transparent 25%),linear-gradient(-45deg,var(--border2) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--border2) 75%),linear-gradient(-45deg,transparent 75%,var(--border2) 75%)",
    backgroundPosition: "0 0,0 4px,4px -4px,-4px 0",
    backgroundSize: "8px 8px",
  };
}

export function DesignColorSwatch({
  value,
  className,
  mixed = false,
}: {
  value: string;
  className?: string;
  /** Several differing colors: a neutral swatch that shows none of them. */
  mixed?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative block shrink-0 overflow-hidden rounded-sm shadow-[inset_0_0_0_1px_var(--border3)]",
        mixed && "bg-bg2-hover",
        className,
      )}
      style={mixed ? undefined : checkerboardBackground()}
      aria-hidden="true"
      data-design-color-mixed={mixed ? "" : undefined}
    >
      {mixed ? null : (
        <span className="absolute inset-0" style={{ background: value }} />
      )}
      <span className="absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--border3)]" />
    </span>
  );
}
