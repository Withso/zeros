// ──────────────────────────────────────────────────────────
// Checkbox — the painted tri-state box
// ──────────────────────────────────────────────────────────
//
// A real `<input type="checkbox">`, visually hidden, with the box painted
// beside it. Keeping the input rather than painting a `<div role="checkbox">`
// is what keeps keyboard focus, form semantics and the space bar working for
// free; `sr-only` (not `hidden`) is what keeps it in the accessibility tree.
//
// Tri-state because a control that stands for a GROUP has three answers, not
// two — all of them, some of them, none of them. `indeterminate` is a DOM
// property with no HTML attribute, so it is assigned to the node: the dash
// glyph alone would leave a screen reader announcing "not checked", which is
// the one thing the mixed state exists to deny.
//
// The label is the caller's job. Wrap this in a `<label>` (or pass `aria-label`
// when the row's own text is the label) — this component paints a box and
// nothing else, so it composes into a tree row, a settings row or a menu item
// without bringing a layout with it.
// ──────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { Check, Minus } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

/** `"indeterminate"` = some but not all of what this box stands for. Matches
 *  the Radix convention so a future move onto `@radix-ui/react-checkbox` is a
 *  swap rather than a rewrite of every caller. */
export type CheckedState = boolean | "indeterminate";

export interface CheckboxProps {
  checked: CheckedState;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible name. Omit only when an enclosing `<label>` supplies the text. */
  "aria-label"?: string;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  className,
}: CheckboxProps) {
  // The real input, held only so `indeterminate` can be written to it — there
  // is no JSX attribute for that property.
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "indeterminate";
  }, [checked]);
  const off = checked === false;
  return (
    <>
      <input
        ref={ref}
        type="checkbox"
        className="peer sr-only"
        aria-label={ariaLabel}
        checked={checked === true}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        aria-hidden
        className={cn(
          "peer-focus-visible:ring-highlighted-bright/50 grid size-3.5 shrink-0 place-items-center rounded-sm border peer-focus-visible:ring-[3px]",
          off
            ? "border-border4"
            : "bg-inverted-bg border-inverted-bg text-inverted-fg",
          disabled && "opacity-55",
          className,
        )}
      >
        {checked === true && <Check className="size-2.5" strokeWidth={3.5} />}
        {checked === "indeterminate" && (
          <Minus className="size-2.5" strokeWidth={3.5} />
        )}
      </span>
    </>
  );
}
