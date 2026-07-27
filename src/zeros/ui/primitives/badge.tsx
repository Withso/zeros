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

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
