import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/renderer/shared/ui/cn";

const Tabs = TabsPrimitive.Root;

type TabsVariant = "default" | "chrome";

interface TabsListProps extends React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.List
> {
  /** Chrome tabs match the app's column tab strips without an outer segment. */
  variant?: TabsVariant;
}

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = "default", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "text-fg2 inline-flex items-center",
      variant === "chrome"
        ? "h-10 justify-start gap-1 bg-transparent p-1"
        : "bg-bg2 h-9 justify-center rounded-lg p-1",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

interface TabsTriggerProps extends React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Trigger
> {
  /** Chrome tabs use the same compact active pill as column panel tabs. */
  variant?: TabsVariant;
}

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant = "default", ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "focus-visible:ring-highlighted-bright/50 data-[state=active]:text-fg1 inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
      variant === "chrome"
        ? "data-[state=active]:bg-bg2 h-7 px-2.5 text-xs transition-none"
        : "data-[state=active]:bg-bg1 px-3 py-1 text-sm transition-colors data-[state=active]:shadow",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "focus-visible:ring-highlighted-bright/50 mt-2 focus-visible:ring-[3px] focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
