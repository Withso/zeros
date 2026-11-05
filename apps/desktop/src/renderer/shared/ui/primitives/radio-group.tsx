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
// extend /apps/desktop/src/renderer/shared/ui/ first."
//
// The same 16px box as Checkbox: border4 at rest, fg3 on hover, and selected
// fills with inverted-bg around an inverted-fg dot, the same "on" look as a
// checked box. A settings choice is a state, not a call to action, so it never
// takes the brand accent.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "@/renderer/shared/ui/cn";

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
  description,
  variant = "default",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, "children"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
  variant?: "default" | "card";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <RadioGroupPrimitive.Item
        data-slot="radio-group-item"
        value={value}
        className={cn(
          "group flex cursor-pointer items-center gap-2 text-left focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          variant === "card" &&
            "border-border1 bg-bg1-highlight hover:bg-bg1-hover data-[state=checked]:border-border4 data-[state=checked]:bg-bg1-hover flex-row-reverse justify-between gap-4 rounded-lg border px-3.5 py-3",
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            // Keyboard focus is the standard halo on the box; the checked
            // fill keeps the highlighted-bright border visible inside it.
            "border-border4 group-hover:border-fg3 group-data-[state=checked]:border-inverted-bg group-data-[state=checked]:bg-inverted-bg group-data-[state=checked]:group-hover:border-primary-button-hover group-data-[state=checked]:group-hover:bg-primary-button-hover group-focus-visible:border-highlighted-bright group-data-[state=checked]:group-focus-visible:border-highlighted-bright group-focus-visible:ring-highlighted-bright/50 flex size-4 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,box-shadow] duration-120 ease-out group-focus-visible:ring-[3px]",
          )}
        >
          <RadioGroupPrimitive.Indicator className="bg-inverted-fg size-1.5 rounded-full" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg1 text-xs leading-4.5">{label}</span>
          {description && <span className="text-fg3 text-3xxs leading-4">{description}</span>}
        </span>
      </RadioGroupPrimitive.Item>
      {children && <div className="ml-6">{children}</div>}
    </div>
  );
}

export { RadioGroup, RadioGroupItem };
