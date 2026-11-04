import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/renderer/shared/ui/cn";

// One size: 20px, 12/16 medium, 6px sides, 4px corners. Badges are state,
// not actions: no hover shift and no stock shadow. Status badges are tinted
// pairs, family-bg with family-fg (docs/design-system.md); callers do not
// reshape them.
const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-1.5 text-3xxs leading-4 font-medium [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "bg-bg2 text-fg2",
        outline: "border-border3 text-fg2",
        success: "bg-green-bg text-green-fg",
        failure: "bg-red-bg text-red-fg",
        warning: "bg-yellow-bg text-yellow-fg",
        info: "bg-blue-bg text-blue-fg",
        merged: "bg-violet-bg text-violet-fg",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/** forwardRef is load-bearing, not boilerplate: a Badge is used as an `asChild`
 *  trigger (Radix DropdownMenu / Tooltip clone the child and attach a ref to
 *  anchor the popper). Without it React warns "Function components cannot be
 *  given refs", the anchor ref stays null, and the menu has nothing to position
 *  against — see OpenInBadgeMenu in shell/conversation/conversation-header.tsx. */
const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };
