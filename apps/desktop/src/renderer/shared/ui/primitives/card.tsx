import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  surface?: "default" | "base";
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, surface = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // One card surface, shared with Settings groups: bg1-bright, border1,
        // 12px corners, 16 padding and 12 between parts.
        "border-border1 text-fg2 flex flex-col gap-3 rounded-[calc(var(--radius-lg)*1.5)] border p-4",
        surface === "base" ? "bg-bg1" : "bg-bg1-bright",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col gap-0.5", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-fg1 text-xs leading-4.5 font-medium", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-fg2 text-xs leading-4.5", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-w-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center justify-end gap-2", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
