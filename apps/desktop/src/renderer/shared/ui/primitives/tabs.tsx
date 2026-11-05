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
        ? "h-10 justify-start gap-0.5 bg-transparent p-1"
        : "bg-bg2 justify-center gap-0.5 rounded-lg p-0.5",
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
      // One tab recipe for every strip and one segmented control: 13px, flat,
      // 6px corners, the keyboard ring; active is medium fg1 on a fill, never
      // an edge.
      "focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright data-[state=active]:text-fg1 inline-flex items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 text-xs leading-4.5 whitespace-nowrap focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
      variant === "chrome"
        ? "hover:bg-bg1-hover hover:text-fg1 data-[state=active]:bg-bg2 data-[state=active]:hover:bg-bg2 h-7 transition-none"
        : "hover:text-fg1 data-[state=active]:bg-selected-bg h-6 transition-colors",
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
