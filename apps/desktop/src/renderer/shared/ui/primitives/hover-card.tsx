import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/renderer/shared/ui/cn";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

function HoverCard({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  const publishOverlay = useNativeSurfaceOverlayIntent();
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      {...props}
      onOpenChange={(open) => {
        publishOverlay(open);
        onOpenChange?.(open);
      }}
    />
  );
}

const HoverCardTrigger = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Trigger>
>(({ ...props }, ref) => (
  <HoverCardPrimitive.Trigger
    ref={ref}
    data-slot="hover-card-trigger"
    {...props}
  />
));
HoverCardTrigger.displayName = HoverCardPrimitive.Trigger.displayName;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal data-slot="hover-card-portal">
    <HoverCardPrimitive.Content
      ref={ref}
      data-slot="hover-card-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "border-border2 bg-bg2 text-fg1 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-lg border p-4 shadow-[var(--shadow-dropdown)] outline-hidden",
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
