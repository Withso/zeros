import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/renderer/shared/ui/cn";
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion";
import { COMPOSER_DOCK_FADE } from "@/renderer/shared/ui/composer-surface";
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
  /** floating (the default) is the bg3 menu surface with the dropdown lift;
   *  composer is for a picker docked on the composer, which takes the
   *  composer's own surface like every card above it: sidebar-bg, the
   *  composer-border edge and no lift. While it opens above its anchor it is
   *  the top of the composer stack, so it carries the stack's fade. */
  surface?: "floating" | "composer";
}

const POPOVER_SURFACE = {
  floating:
    "bg-bg3 border-border2 shadow-[var(--shadow-dropdown)] overflow-x-hidden overflow-y-auto overscroll-contain",
  // The card only bounds the height; its content scrolls in an inner box, so
  // the card never clips the fade it carries above its top edge.
  composer:
    "bg-sidebar-bg border-(--composer-border) group/composer-dock relative flex flex-col",
} as const;

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
      children,
      align = "center",
      sideOffset = 4,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onKeyDown,
      size = "default",
      padding = "default",
      surface = "floating",
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
            "text-fg1 z-dropdown max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) border outline-none",
            POPOVER_SURFACE[surface],
            MENU_SURFACE_RADIUS,
            POPOVER_WIDTH[size],
            padding === "default" ? "p-3" : "p-0",
            className,
          )}
          {...props}
          {...escapeHandlers}
          data-zeros-native-overlay="popover"
        >
          {surface === "composer" ? (
            <>
              {/* Offsets resolve inside the 1px border, so -inset-x-px and
                  mb-px reach past it without covering it. Flipped below its
                  anchor the picker covers the composer, so the fade shows only
                  while it opens above. */}
              <span
                aria-hidden="true"
                data-composer-dock-fade=""
                className={cn(COMPOSER_DOCK_FADE, "-inset-x-px mb-px hidden group-data-[side=top]/composer-dock:block")}
              />
              <div className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-[inherit]">
                {children}
              </div>
            </>
          ) : (
            children
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
