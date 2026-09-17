import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/renderer/shared/ui/cn";
import { MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
import { suppressPointerRefocus } from "@/renderer/shared/ui/overlay-focus";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

function Popover({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const publishOverlay = useNativeSurfaceOverlayIntent();
  // A controlled owner can close after navigation without Radix calling
  // onOpenChange. Release that intent too, or the next overlay cannot announce
  // its opening to an Electron browser surface. Pointer opens still announce
  // synchronously in onOpenChange, before their portal is mounted.
  React.useLayoutEffect(() => {
    if (props.open !== undefined) publishOverlay(props.open);
  }, [props.open, publishOverlay]);
  return (
    <PopoverPrimitive.Root
      {...props}
      onOpenChange={(open) => {
        publishOverlay(open);
        onOpenChange?.(open);
      }}
    />
  );
}

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
> {
  /** Width recipe owned by the primitive. */
  size?: "default" | "wide";
  /** Edge-to-edge feature surfaces use their own section primitives. */
  padding?: "default" | "none";
}

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      onCloseAutoFocus,
      size = "default",
      padding = "default",
      ...props
    },
    ref,
  ) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        // Default: drop the spurious focus ring Radix leaves on the
        // trigger after a pointer-driven close (see overlay-focus.ts).
        // Still forward to any consumer-supplied handler.
        onCloseAutoFocus={(event) => {
          suppressPointerRefocus(event);
          onCloseAutoFocus?.(event);
        }}
        className={cn(
          "border-border2 bg-bg3 text-fg1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)] outline-none",
          MENU_SURFACE_RADIUS,
          size === "default" ? "w-72" : "w-[min(34rem,calc(100vw-1rem))]",
          padding === "default" ? "p-4" : "p-0",
          className,
        )}
        {...props}
        data-zeros-native-overlay="popover"
      />
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
