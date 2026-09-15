import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-menu";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import {
  MENU_ITEM_ICON,
  MENU_ITEM_RADIUS,
  MENU_SEPARATOR,
  MENU_SURFACE_INSET,
  MENU_SURFACE_RADIUS,
} from "@/renderer/shared/ui/menu-surface";
import { suppressPointerRefocus } from "@/renderer/shared/ui/overlay-focus";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";
import {
  createMenuAnchor,
  isMenuAnchorAvailable,
  type MenuAnchor,
} from "@/renderer/shared/ui/menu-anchor";

// Right-click context menu — the ContextMenu sibling of dropdown-menu.tsx, same
// Zeros Foundation surface (bg3 popover, bg3-hover items, fg1 text) and submenu
// support. Use Radix's underlying Menu so the anchor can follow the source
// element; ContextMenu's built-in virtual anchor freezes the click coordinates.

const MenuAnchorContext = React.createContext<{
  open: boolean;
  modal: boolean;
  setAnchor: (anchor: MenuAnchor) => void;
  setOpen: (open: boolean) => void;
} | null>(null);

interface ContextMenuProps extends React.ComponentProps<
  typeof ContextMenuPrimitive.Root
> {
  /** External trees can keep their own selection / open lifecycle. */
  anchor?: MenuAnchor;
}

function ContextMenu({
  open: controlledOpen,
  anchor: controlledAnchor,
  onOpenChange,
  children,
  modal = true,
  ...props
}: ContextMenuProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [internalAnchor, setAnchor] = React.useState<MenuAnchor | null>(null);
  const open = controlledOpen ?? internalOpen;
  const anchor = controlledAnchor ?? internalAnchor;
  const anchorRef = React.useRef<MenuAnchor | null>(anchor);
  anchorRef.current = anchor;
  const publishOverlay = useNativeSurfaceOverlayIntent();
  const setOpen = React.useCallback(
    (next: boolean) => {
      publishOverlay(next);
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, publishOverlay],
  );
  React.useLayoutEffect(() => {
    publishOverlay(open);
  }, [open, publishOverlay]);
  React.useEffect(() => {
    if (!open || !anchor) return;
    let frame = 0;
    const checkAnchor = () => {
      if (!isMenuAnchorAvailable(anchor.contextElement)) {
        setOpen(false);
        return;
      }
      frame = requestAnimationFrame(checkAnchor);
    };
    frame = requestAnimationFrame(checkAnchor);
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, setOpen]);
  const context = React.useMemo(
    () => ({ open, modal, setAnchor, setOpen }),
    [open, modal, setOpen],
  );
  return (
    <MenuAnchorContext.Provider value={context}>
      <ContextMenuPrimitive.Root
        {...props}
        modal={modal}
        open={open}
        onOpenChange={setOpen}
      >
        <ContextMenuPrimitive.Anchor virtualRef={anchorRef} />
        {children}
      </ContextMenuPrimitive.Root>
    </MenuAnchorContext.Provider>
  );
}

const ContextMenuTrigger = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span"> & {
    asChild?: boolean;
    disabled?: boolean;
    placement?: "pointer" | "below-trigger";
  }
>(function ContextMenuTrigger(
  {
    asChild,
    disabled,
    placement = "pointer",
    style,
    onContextMenu,
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    ...props
  },
  ref,
) {
  const context = React.useContext(MenuAnchorContext)!;
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const clearPress = React.useCallback(() => clearTimeout(timer.current), []);
  React.useEffect(() => clearPress, [clearPress, disabled]);
  const openAt = (element: HTMLElement, point?: { x: number; y: number }) => {
    context.setAnchor(createMenuAnchor(element, point));
    context.setOpen(true);
  };
  const Trigger = asChild ? Slot : "span";
  return (
    <Trigger
      {...props}
      ref={ref}
      style={{ WebkitTouchCallout: "none", ...style }}
      data-state={context.open ? "open" : "closed"}
      data-disabled={disabled ? "" : undefined}
      onContextMenu={(event) => {
        onContextMenu?.(event);
        if (disabled || event.defaultPrevented) return;
        clearPress();
        event.preventDefault();
        openAt(
          event.currentTarget,
          placement === "pointer"
            ? { x: event.clientX, y: event.clientY }
            : undefined,
        );
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          disabled ||
          event.defaultPrevented ||
          !(
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
        )
          return;
        event.preventDefault();
        clearPress();
        openAt(event.currentTarget);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (disabled || event.defaultPrevented || event.pointerType === "mouse")
          return;
        clearPress();
        const element = event.currentTarget;
        const point =
          placement === "pointer"
            ? { x: event.clientX, y: event.clientY }
            : undefined;
        timer.current = setTimeout(() => openAt(element, point), 700);
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        clearPress();
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        clearPress();
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        clearPress();
      }}
    />
  );
});

const ContextMenuGroup = ContextMenuPrimitive.Group;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

// Preserve the CSS properties exported by the former ContextMenu wrapper.
const CONTEXT_MENU_VARIABLES = {
  "--radix-context-menu-content-transform-origin":
    "var(--radix-popper-transform-origin)",
  "--radix-context-menu-content-available-width":
    "var(--radix-popper-available-width)",
  "--radix-context-menu-content-available-height":
    "var(--radix-popper-available-height)",
  "--radix-context-menu-trigger-width": "var(--radix-popper-anchor-width)",
  "--radix-context-menu-trigger-height": "var(--radix-popper-anchor-height)",
} as React.CSSProperties;

function ContextMenuSub({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub> & {
  defaultOpen?: boolean;
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  return (
    <ContextMenuPrimitive.Sub
      {...props}
      open={controlledOpen ?? internalOpen}
      onOpenChange={(open) => {
        setInternalOpen(open);
        onOpenChange?.(open);
      }}
    />
  );
}

const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "focus:bg-bg3-hover focus:text-fg1 data-[state=open]:bg-bg3-hover flex cursor-default items-center gap-2 px-2 py-1.5 text-xs outline-none select-none",
      MENU_ITEM_RADIUS,
      MENU_ITEM_ICON,
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={8}
      updatePositionStrategy="always"
      className={cn(
        MENU_SURFACE_RADIUS,
        "border-border2 bg-bg3 text-fg1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-popper-available-height) max-w-(--radix-popper-available-width) min-w-[min(8rem,var(--radix-popper-available-width))] overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)]",
        MENU_SURFACE_INSET,
        className,
      )}
      {...props}
      style={{ ...props.style, ...CONTEXT_MENU_VARIABLES }}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, onCloseAutoFocus, onInteractOutside, ...props }, ref) => {
  const context = React.useContext(MenuAnchorContext);
  const interactedOutside = React.useRef(false);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        side="right"
        align="start"
        sideOffset={2}
        collisionPadding={8}
        updatePositionStrategy="always"
        // Drop the spurious focus ring Radix leaves on the trigger after a
        // pointer-driven close (see overlay-focus.ts); still forward the handler.
        onCloseAutoFocus={(event) => {
          suppressPointerRefocus(event);
          onCloseAutoFocus?.(event);
          if (interactedOutside.current) event.preventDefault();
          interactedOutside.current = false;
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!event.defaultPrevented && !context?.modal)
            interactedOutside.current = true;
        }}
        className={cn(
          MENU_SURFACE_RADIUS,
          "border-border2 bg-bg3 text-fg1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-popper-available-height) max-w-(--radix-popper-available-width) min-w-[min(9rem,var(--radix-popper-available-width))] overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)]",
          MENU_SURFACE_INSET,
          className,
        )}
        {...props}
        style={{ ...props.style, ...CONTEXT_MENU_VARIABLES }}
      />
    </ContextMenuPrimitive.Portal>
  );
});
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "focus:bg-bg3-hover focus:text-fg1 relative flex cursor-default items-center gap-2 px-2 py-1.5 text-xs transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      MENU_ITEM_RADIUS,
      MENU_ITEM_ICON,
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn("text-fg2 px-2 py-1.5 text-xs", inset && "pl-8", className)}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn(MENU_SEPARATOR, className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
};
