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
// Without `label` this paints a box and nothing else, so it composes into a
// tree row, a settings row or a menu item (wrap it in a `<label>` or pass
// `aria-label`). With `label` it is the whole choice row: the 13/18 label, an
// optional 12px hint, and the row as the click target.
// ──────────────────────────────────────────────────────────

import * as React from "react";
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
  /** Accessible name. Omit only when an enclosing `<label>` or `label`
   *  supplies the text. */
  "aria-label"?: string;
  /** Renders the choice row around the box. */
  label?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}

/** 16px box (the Radio's size): border4, fg3 on hover, inverted when on and a
 *  shade darker on hover, the standard ring on keyboard focus. */
const BOX =
  "peer-focus-visible:ring-highlighted-bright/50 peer-focus-visible:border-highlighted-bright grid size-4 shrink-0 place-items-center rounded-sm border transition-[background-color,border-color,box-shadow] duration-120 ease-out peer-focus-visible:ring-[3px]";

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  label,
  hint,
  className,
}: CheckboxProps) {
  // The real input, held only so `indeterminate` can be written to it — there
  // is no JSX attribute for that property.
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "indeterminate";
  }, [checked]);
  const off = checked === false;
  const box = (
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
          BOX,
          off
            ? "border-border4 hover:border-fg3 group-hover/choice:border-fg3"
            : "bg-inverted-bg border-inverted-bg text-inverted-fg hover:bg-primary-button-hover hover:border-primary-button-hover group-hover/choice:bg-primary-button-hover group-hover/choice:border-primary-button-hover",
          // A row dims as a whole, so its box does not dim twice.
          disabled && label === undefined && "opacity-50",
          label === undefined && className,
        )}
      >
        {checked === true && <Check className="size-3" strokeWidth={2} />}
        {checked === "indeterminate" && <Minus className="size-3" strokeWidth={2} />}
      </span>
    </>
  );
  if (label === undefined) return box;
  return (
    <label
      className={cn(
        "group/choice text-fg1 inline-flex min-w-0 cursor-pointer items-start gap-2 text-left text-xs leading-4.5 [&>span[aria-hidden]]:mt-px",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {box}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        {hint ? <span className="text-fg3 text-3xxs leading-4">{hint}</span> : null}
      </span>
    </label>
  );
}
