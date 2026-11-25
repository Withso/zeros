import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/renderer/shared/ui/cn";
import { FLOATING_SURFACE } from "@/renderer/shared/ui/layout/surface";
import { MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

function HoverCard({
  onOpenChange,
  open,
  enabled = true,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root> & { enabled?: boolean }) {
  const publishOverlay = useNativeSurfaceOverlayIntent();
  // A controlled close can bypass Radix's callback while keeping this root
  // mounted. Release its native-surface token, and ignore delayed hover intent
  // when the owner has disabled the preview.
  React.useEffect(() => {
    if (!enabled || open === false) publishOverlay(false);
  }, [enabled, open, publishOverlay]);
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      {...props}
      open={enabled ? open : false}
      onOpenChange={(nextOpen) => {
        if (!enabled) return;
        publishOverlay(nextOpen);
        onOpenChange?.(nextOpen);
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

/** The Popover's widths (P7): sm 240, md 320 (the default), lg 400, and fit
 *  for content that sizes itself. Callers never hand-set a width. */
const HOVER_CARD_WIDTH = {
  sm: "w-60",
  md: "w-80",
  lg: "w-100 max-w-[calc(100vw-24px)]",
  fit: "w-max max-w-[calc(100vw-24px)]",
} as const;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content> & {
    size?: keyof typeof HOVER_CARD_WIDTH;
  }
>(({ className, align = "center", sideOffset = 4, size = "md", ...props }, ref) => (
  <HoverCardPrimitive.Portal data-slot="hover-card-portal">
    <HoverCardPrimitive.Content
      ref={ref}
      data-slot="hover-card-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        ANCHORED_OVERLAY_MOTION,
        "border-border2 text-fg1 z-dropdown origin-(--radix-hover-card-content-transform-origin) border p-3 shadow-[var(--shadow-dropdown)] outline-hidden",
        HOVER_CARD_WIDTH[size],
        FLOATING_SURFACE,
        MENU_SURFACE_RADIUS,
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
