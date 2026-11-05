import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/renderer/shared/ui/cn";

// Two sizes: inline (20px, 12/16, 4px corners) for text and rows, control
// (24px, 13/18, 6px corners) around the composer. One neutral look for every
// reference — bg2 + border2, hover border3 + bg2-highlight, on the selected
// fill with the resting edge unchanged — and tints only where they mean
// something.
const pillVariants = cva(
  "inline-flex max-w-60 shrink-0 items-center whitespace-nowrap border transition-colors duration-120 ease-out focus-visible:border-highlighted-bright focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&>span]:truncate",
  {
    variants: {
      size: {
        inline: "h-5 gap-1 rounded-sm px-1.5 text-3xxs leading-4 [&_svg]:size-3",
        control: "h-6 gap-1 rounded-md px-2 text-xs leading-4.5 [&_svg]:size-3.5",
      },
      tone: {
        neutral:
          "border-border2 bg-bg2 text-fg1 hover:border-border3 hover:bg-bg2-highlight aria-pressed:bg-selected-bg aria-pressed:hover:bg-selected-bg data-[state=open]:border-border4 data-[state=open]:bg-bg2-highlight [&_svg:not([class*='text-'])]:text-fg2",
        // A tool target that failed.
        failed: "border-transparent bg-red-bg text-red-fg [&_svg]:text-red-fg",
        // The Design mode tag.
        mode: "border-transparent bg-brown-bg text-brown-fg [&_svg]:text-brown-fg",
        // Anything whose target is gone.
        gone: "border-dashed border-border3 bg-transparent text-fg3",
        // A missing attachment: a yellow outline and a grey icon.
        invalid:
          "border-yellow-icon/45 bg-bg2 text-fg2 [&_svg]:opacity-60 [&_svg]:grayscale",
      },
    },
    defaultVariants: { size: "inline", tone: "neutral" },
  },
);

export interface PillProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof pillVariants> {}

/** A reference to a file, chat, workspace or attachment. Visual treatment
 * lives here so feature callers only supply layout, content, and behavior. */
const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ className, type = "button", size, tone, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(pillVariants({ size, tone }), className)}
      {...props}
    />
  ),
);
Pill.displayName = "Pill";

export { Pill, pillVariants };
