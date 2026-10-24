import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion";
import {
  MENU_ITEM_ICON,
  MENU_ITEM_RADIUS,
  MENU_SEPARATOR,
  MENU_SURFACE_INSET,
  MENU_SURFACE_RADIUS,
} from "@/renderer/shared/ui/menu-surface";
import { suppressPointerRefocus } from "@/renderer/shared/ui/overlay-focus";
import { useOverlayEscape } from "@/renderer/shared/ui/overlay-escape";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

const DropdownMenuOpenContext = React.createContext<
  ((open: boolean) => void) | null
>(null);
const useClientLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function DropdownMenu({
  onOpenChange,
  open: controlledOpen,
  defaultOpen = false,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
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
  useClientLayoutEffect(() => {
    // A controlled owner can close the menu without Radix's callback.
    publishOverlay(open);
  }, [open, publishOverlay]);
  return (
    <DropdownMenuOpenContext.Provider value={setOpen}>
      <DropdownMenuPrimitive.Root {...props} open={open} onOpenChange={setOpen} />
    </DropdownMenuOpenContext.Provider>
  );
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

// Menus that represent a current value mark it with one of these standard
// selection attributes. Focusing that item when the menu opens makes arrow-key
// navigation continue from the current value instead of restarting at row one.
// Radix then naturally hands focus to whichever row the mouse enters.
const SELECTED_ITEM_SELECTOR = [
  '[role="menuitem"][aria-current]:not([aria-current="false"])',
  '[role="menuitem"][aria-selected="true"]',
  '[role="menuitem"][data-selected="true"]',
  '[role="menuitemradio"][data-state="checked"]',
  '[role="menuitemcheckbox"][data-state="checked"]',
].join(",");

function setForwardedRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "focus:bg-bg3-hover focus:[&_.text-muted-fg]:text-fg3 data-[state=open]:bg-bg3-hover data-[state=open]:[&_.text-muted-fg]:text-fg3 flex cursor-default items-center gap-2 px-2 py-1.5 text-xs outline-none select-none",
      MENU_ITEM_RADIUS,
      MENU_ITEM_ICON,
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, onEscapeKeyDown, onKeyDown, ...props }, ref) => {
  const setOpen = React.useContext(DropdownMenuOpenContext);
  const escapeHandlers = useOverlayEscape({
    onEscapeKeyDown,
    onKeyDown,
    onDismiss: () => setOpen?.(false),
  });
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        collisionPadding={8}
        className={cn(
          ANCHORED_OVERLAY_MOTION,
          "bg-bg3 text-fg1 border-border2 z-dropdown min-w-[min(8rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)]",
          MENU_SURFACE_RADIUS,
          MENU_SURFACE_INSET,
          className,
        )}
        {...props}
        {...escapeHandlers}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, onCloseAutoFocus, onEscapeKeyDown, onKeyDown, ...props }, ref) => {
  const setOpen = React.useContext(DropdownMenuOpenContext);
  const escapeHandlers = useOverlayEscape({
    onEscapeKeyDown,
    onKeyDown,
    onDismiss: () => setOpen?.(false),
  });
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const initializedNodesRef = React.useRef(new WeakSet<HTMLDivElement>());
  const initialScrollRef = React.useRef<ResizeObserver | null>(null);
  React.useEffect(() => () => {
    initialScrollRef.current?.disconnect();
    initialScrollRef.current = null;
  }, []);
  const composedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      setForwardedRef(ref, node);
      if (node && !initializedNodesRef.current.has(node)) {
        initialScrollRef.current?.disconnect();
        initialScrollRef.current = null;
        initializedNodesRef.current.add(node);
        // Radix DropdownMenu intentionally keeps Menu's open-autofocus hook
        // private. Run after its mount focus pass, then make the current
        // value the visible and keyboard navigation origin. Track the DOM
        // node so roving-focus re-renders cannot reapply this initial focus.
        queueMicrotask(() => {
          if (contentRef.current !== node || node.dataset.state !== "open")
            return;
          const selectedItem = node.querySelector<HTMLElement>(
            SELECTED_ITEM_SELECTOR,
          );
          if (!selectedItem) return;
          selectedItem.focus({ preventScroll: true });
          // Popper constrains height after mounting. Its placement hook is
          // private to Menu, so wait for the measured available height before
          // scrolling; an earlier scroll can leave the focused row clipped.
          const scrollWhenSized = () => {
            if (contentRef.current !== node || node.dataset.state !== "open") {
              initialScrollRef.current?.disconnect();
              initialScrollRef.current = null;
              return;
            }
            const height = Number.parseFloat(getComputedStyle(node).getPropertyValue("--radix-dropdown-menu-content-available-height"));
            if (!(height > 0)) return;
            selectedItem.scrollIntoView({ block: "nearest", inline: "nearest" });
            initialScrollRef.current?.disconnect();
            initialScrollRef.current = null;
          };
          initialScrollRef.current = new ResizeObserver(scrollWhenSized);
          initialScrollRef.current.observe(node);
          scrollWhenSized();
        });
      }
    },
    [ref],
  );

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        collisionPadding={8}
        {...props}
        {...escapeHandlers}
        ref={composedRef}
        sideOffset={sideOffset}
        onPointerDownOutside={(event) => {
          // The trigger's pointer handler owns toggling. The outside listener
          // must not dismiss an opening from that same pointer event.
          const content = contentRef.current;
          const triggerId = content?.getAttribute("aria-labelledby");
          const trigger = triggerId
            ? content?.ownerDocument.getElementById(triggerId)
            : null;
          const originalEvent = event.detail.originalEvent;
          if (
            originalEvent.button === 0 &&
            !originalEvent.ctrlKey &&
            event.target instanceof Node &&
            trigger?.contains(event.target)
          ) {
            event.preventDefault();
          }
          props.onPointerDownOutside?.(event);
        }}
        // Default: drop the spurious focus ring Radix leaves on the
        // trigger after a pointer-driven close (see overlay-focus.ts).
        // Still forward to any consumer-supplied handler.
        onCloseAutoFocus={(event) => {
          suppressPointerRefocus(event);
          onCloseAutoFocus?.(event);
        }}
        className={cn(
          ANCHORED_OVERLAY_MOTION,
          "bg-bg3 text-fg1 border-border2 z-dropdown min-w-[min(8rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto overscroll-contain border shadow-[var(--shadow-dropdown)]",
          MENU_SURFACE_RADIUS,
          MENU_SURFACE_INSET,
          className,
        )}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "focus:bg-bg3-hover focus:text-fg1 focus:[&_.text-muted-fg]:text-fg3 relative flex cursor-default items-center gap-2 px-2 py-1.5 text-xs transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      MENU_ITEM_RADIUS,
      MENU_ITEM_ICON,
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & {
    /** Trailing boxed selection for range/group menus. */
    indicatorSide?: "start" | "end";
  }
>(
  (
    { className, children, checked, indicatorSide = "start", ...props },
    ref,
  ) => (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        "focus:bg-bg3-hover focus:text-fg1 focus:[&_.text-muted-fg]:text-fg3 relative flex cursor-default items-center py-1.5 pr-2 pl-8 text-xs transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        MENU_ITEM_RADIUS,
        indicatorSide === "end" && "pr-8 pl-2",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className={cn(
          "absolute flex size-3.5 items-center justify-center",
          indicatorSide === "start"
            ? "left-2"
            : "border-border4 right-2 rounded-sm border",
          indicatorSide === "end" &&
            checked &&
            "bg-inverted-bg border-inverted-bg text-inverted-fg",
        )}
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className={indicatorSide === "end" ? "size-3" : "size-3.5"} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  ),
);
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    indicator?: "dot" | "check";
    indicatorSide?: "start" | "end";
  }
>(({ className, children, indicator = "dot", indicatorSide = "start", ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "focus:bg-bg3-hover focus:text-fg1 focus:[&_.text-muted-fg]:text-fg3 relative flex cursor-default items-center py-1.5 pr-2 pl-8 text-xs transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      MENU_ITEM_RADIUS,
      indicatorSide === "end" && "pr-8 pl-2",
      className,
    )}
    {...props}
  >
    <span className={cn("absolute flex size-3.5 items-center justify-center", indicatorSide === "end" ? "right-2" : "left-2")}>
      <DropdownMenuPrimitive.ItemIndicator>
        {indicator === "check" ? (
          <Check className="size-3.5" />
        ) : (
          <Circle className="h-2 w-2 fill-current" />
        )}
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-xs font-semibold",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn(MENU_SEPARATOR, className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  );
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
