"use client";

// ──────────────────────────────────────────────────────────
// RadioGroup — a real single-choice control
// ──────────────────────────────────────────────────────────
//
// A vertical list of labelled radios with an optional body under each one (the
// "Custom" row in Settings → Git reveals a text field there). Built on Radix so
// the keyboard contract comes for free — the whole group is ONE tab stop and
// arrow keys move the selection — which is what a hand-rolled
// `<button role="radio">` list gets wrong: three plain buttons are three tab
// stops with no arrow handling, so keyboard users tab through options instead
// of choosing between them.
//
// Lives here, not next to its caller, per RULES.md: "If a primitive is missing,
// extend /src/zeros/ui/ first."
//
// The dot is `--fg1` on a `--border3` ring, matching the app's other selection
// affordances (Switch, the segmented auth control) rather than the brand accent
// — a settings choice is a state, not a call to action.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "@/zeros/ui/cn";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    />
  );
}

/** One option. `children` renders UNDER the label, indented to clear the dot —
 *  for a field the option reveals when picked. It sits outside the Radix Item
 *  on purpose: nesting an input inside the item would make clicking into the
 *  field re-fire the selection and swallow the caret. */
function RadioGroupItem({
  value,
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, "children"> & {
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <RadioGroupPrimitive.Item
        data-slot="radio-group-item"
        value={value}
        className={cn(
          "group flex cursor-pointer items-center gap-2 text-left focus-visible:outline-none",
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            "border-border3 group-hover:border-border4 group-data-[state=checked]:border-fg1 group-focus-visible:border-highlighted-bright flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          )}
        >
          <RadioGroupPrimitive.Indicator className="bg-fg1 size-2 rounded-full" />
        </span>
        {/* 14px matches the settings NAME scale and opts out of the
            .settings-type-scale shrink (see settings-ui.tsx). */}
        <span className="text-fg1 text-[14px]">{label}</span>
      </RadioGroupPrimitive.Item>
      {children && <div className="ml-6">{children}</div>}
    </div>
  );
}

export { RadioGroup, RadioGroupItem };
