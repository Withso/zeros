import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/renderer/shared/ui/cn";
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion";
import { COMPOSER_DOCK_FADE } from "@/renderer/shared/ui/composer-surface";
import { MENU_SURFACE_INSET, MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
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

function usePopoverOpenControl(): ((open: boolean) => void) | null {
  return React.useContext(PopoverOpenContext);
}

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
> {
  /** Width owned by the primitive: sm 240, md 320 (the default), lg 400;
   *  fit wraps a single action. Pickers that were wider take lg (P7). */
  size?: "sm" | "md" | "lg" | "default" | "fit";
  /** Edge-to-edge feature surfaces use their own section primitives; inset
   *  is the menu's 4px, for rows and actions. */
  padding?: "default" | "none" | "inset";
  /** floating (the default) is the bg3 menu surface with the dropdown lift;
   *  composer is for a picker docked on the composer: the same bg3 as every
   *  menu and dropdown (P5), on the composer-border edge with no lift. While
   *  it opens above its anchor it is the top of the composer stack, so it
   *  carries the stack's fade. bare only positions its content, which draws
   *  its own surface (an inline floating Toolbar). */
  surface?: "floating" | "composer" | "bare";
}

const POPOVER_SURFACE = {
  floating:
    "bg-bg3 border-border2 shadow-[var(--shadow-dropdown)] overflow-x-hidden overflow-y-auto overscroll-contain",
  // The card only bounds the height; its content scrolls in an inner box, so
  // the card never clips the fade it carries above its top edge.
  composer:
    "bg-bg3 border-(--composer-border) group/composer-dock relative flex flex-col",
  bare: "border-0 bg-transparent shadow-none",
} as const;

const POPOVER_WIDTH = {
  sm: "w-60",
  md: "w-80",
  default: "w-80",
  lg: "w-100",
  fit: "w-fit",
} as const;

const POPOVER_PADDING = {
  default: "p-3",
  none: "p-0",
  inset: MENU_SURFACE_INSET,
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
            surface !== "bare" && MENU_SURFACE_RADIUS,
            POPOVER_WIDTH[size],
            surface === "bare" ? "p-0" : POPOVER_PADDING[padding],
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

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  usePopoverOpenControl,
};
