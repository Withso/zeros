import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/renderer/shared/ui/cn";
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion";
import { MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
import { suppressPointerRefocus } from "@/renderer/shared/ui/overlay-focus";
import { useOverlayEscape } from "@/renderer/shared/ui/overlay-escape";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

const PopoverOpenContext = React.createContext<((open: boolean) => void) | null>(
  null,
);

function Popover({
  onOpenChange,
  open: controlledOpen,
  defaultOpen = false,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const publishOverlay = useNativeSurfaceOverlayIntent();
  const setOpen = React.useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      publishOverlay(next);
      onOpenChange?.(next);
    },
    [onOpenChange, publishOverlay],
  );
  // A controlled owner can close after navigation without Radix calling
  // onOpenChange. Release that intent too, or the next overlay cannot announce
  // its opening to an Electron browser surface. Pointer opens still announce
  // synchronously in onOpenChange, before their portal is mounted.
  React.useLayoutEffect(() => {
    publishOverlay(open);
  }, [open, publishOverlay]);
  return (
    <PopoverOpenContext.Provider value={setOpen}>
      <PopoverPrimitive.Root {...props} open={open} onOpenChange={setOpen} />
    </PopoverOpenContext.Provider>
  );
}

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
> {
  /** Width owned by the primitive: sm 240, md 320 (the default), lg 400.
   *  wide fills up to 34rem for full-width feature pickers. */
  size?: "sm" | "md" | "lg" | "default" | "wide";
  /** Edge-to-edge feature surfaces use their own section primitives. */
  padding?: "default" | "none";
}

const POPOVER_WIDTH = {
  sm: "w-60",
  md: "w-80",
  default: "w-80",
  lg: "w-100",
  wide: "w-[min(34rem,calc(100vw-1rem))]",
} as const;

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
      onEscapeKeyDown,
      onKeyDown,
      size = "default",
      padding = "default",
      ...props
    },
    ref,
  ) => {
    const setOpen = React.useContext(PopoverOpenContext);
    const escapeHandlers = useOverlayEscape({
      onEscapeKeyDown,
      onKeyDown,
      onDismiss: () => setOpen?.(false),
    });
    return (
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
            ANCHORED_OVERLAY_MOTION,
            "border-border2 bg-bg3 text-fg1 z-dropdown max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)] outline-none",
            MENU_SURFACE_RADIUS,
            POPOVER_WIDTH[size],
            padding === "default" ? "p-3" : "p-0",
            className,
          )}
          {...props}
          {...escapeHandlers}
          data-zeros-native-overlay="popover"
        />
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
