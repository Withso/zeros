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
// fills with the accent around a white (accent-fg) dot, the same "on" look as
// a checked box. A choice that needs a frame sits in a Settings group like
// every other row; there is no card variant.
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
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, "children"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
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
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            // Keyboard focus is a 1px accent line one pixel off the circle,
            // so it still shows around the accent fill.
            "border-border4 group-hover:border-fg3 group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent group-focus-visible:outline-accent flex size-4 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color] duration-fast ease-out group-focus-visible:outline-1 group-focus-visible:outline-offset-1",
          )}
        >
          <RadioGroupPrimitive.Indicator className="bg-accent-fg size-1.5 rounded-full" />
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
