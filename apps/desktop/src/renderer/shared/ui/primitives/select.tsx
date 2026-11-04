"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/renderer/shared/ui/cn"
import { ANCHORED_OVERLAY_MOTION } from "@/renderer/shared/ui/anchored-overlay-motion"
import {
  MENU_ITEM_RADIUS,
  MENU_SEPARATOR,
  MENU_SURFACE_INSET,
  MENU_SURFACE_RADIUS,
} from "@/renderer/shared/ui/menu-surface"
import { suppressPointerRefocus } from "@/renderer/shared/ui/overlay-focus"
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay"
import { resolvePopoverBoundary } from "@/renderer/shared/ui/popover-boundary"
import { FIELD_FOCUS, FIELD_INVALID } from "./field"

/** Shared between the trigger and the (portaled) content so the content can
 *  find the layout column its trigger lives in — see popover-boundary.ts.
 *  Radix gives the content no handle on the trigger, hence the ref. */
interface SelectAnchorContextValue {
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>
  open: boolean
}
const SelectAnchorContext =
  React.createContext<SelectAnchorContextValue | null>(null)
const useClientLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function Select({
  onOpenChange,
  open: openProp,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const publishOverlay = useNativeSurfaceOverlayIntent()
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  // Mirror open state (controlled or not) so SelectContent can resolve its
  // column boundary on the render that mounts the list — the trigger is in
  // the DOM by then, whereas it is NOT when the (always-mounted) content
  // wrapper first renders.
  const [openState, setOpenState] = React.useState(defaultOpen ?? false)
  const open = openProp ?? openState
  const anchor = React.useMemo(() => ({ triggerRef, open }), [open])
  // Navigation/owner changes can close a controlled Select without Radix's
  // callback. Release its token so the next popup can announce native parking.
  useClientLayoutEffect(() => {
    publishOverlay(open)
  }, [open, publishOverlay])
  return (
    <SelectAnchorContext.Provider value={anchor}>
      <SelectPrimitive.Root
        data-slot="select"
        open={openProp}
        defaultOpen={defaultOpen}
        {...props}
        onOpenChange={(next) => {
          setOpenState(next)
          publishOverlay(next)
          onOpenChange?.(next)
        }}
      />
    </SelectAnchorContext.Provider>
  )
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

/** Trigger width modes. `fit` (the default, used almost everywhere) hugs
 *  the selected label; `fixed` pins one shared width so a row of pickers
 *  with wildly different label lengths (code themes, model names) doesn't
 *  reflow as the value changes. A caller's own `w-*` class still wins. */
type SelectTriggerWidth = "fit" | "fixed"

const SELECT_TRIGGER_WIDTH: Record<SelectTriggerWidth, string> = {
  fit: "w-fit",
  fixed: "w-40",
}

// The Input field box as a trigger: 8px left padding so a value lines up
// with Input text above or below it, 6px right, 4px vertical, a 4px gap to
// the 14px chevron → 28px tall, the same box as every Button. No fill at
// rest; hover and open paint bg2-highlight. Compact keeps the line box and
// drops to 24px.
const SELECT_TRIGGER_BASE = cn(
  "group/select-trigger flex items-center justify-between gap-1 rounded-md border border-border3 bg-transparent py-1 pr-1.5 pl-2 text-xs leading-4.5 whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-120 ease-out outline-none hover:border-border4 hover:bg-bg2-highlight data-[state=open]:border-border4 data-[state=open]:bg-bg2-highlight data-[size=compact]:py-0.5 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-fg3 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-fg2",
  FIELD_FOCUS,
  FIELD_INVALID,
)

/** The trigger's chevron: muted-fg at rest, fg2 on hover and while open. */
const SELECT_CHEVRON =
  "text-muted-fg group-hover/select-trigger:text-fg2 group-data-[state=open]/select-trigger:text-fg2 size-3.5 transition-colors duration-120 ease-out"

/** The dropdown-trigger chrome as a class string, for the rare menu whose
 *  trigger should look like a Select (an action menu such as "Open in ▾")
 *  even though it isn't bound to a value. Keeps every dropdown button in
 *  the app on one geometry. */
function selectTriggerClassName(
  width: SelectTriggerWidth = "fit",
  className?: string
): string {
  return cn(SELECT_TRIGGER_BASE, SELECT_TRIGGER_WIDTH[width], className)
}

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    /** compact is the 24px trigger for dense rows; sm is the former name of
     *  the standard 28px size. */
    size?: "sm" | "default" | "compact"
    width?: SelectTriggerWidth
  }
>(function SelectTrigger(
  { className, size = "default", width = "fit", children, ...props },
  forwardedRef
) {
  const anchor = React.useContext(SelectAnchorContext)
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (anchor) anchor.triggerRef.current = node
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [anchor, forwardedRef]
  )
  return (
    <SelectPrimitive.Trigger
      ref={setRef}
      data-slot="select-trigger"
      data-size={size}
      data-width={width}
      className={selectTriggerClassName(width, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon data-slot="select-chevron" className={SELECT_CHEVRON} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

function SelectContent({
  className,
  children,
  // Always drop the menu directly BELOW the trigger (flipping ABOVE only when
  // there's no room at the bottom of the window — Radix's avoidCollisions).
  // The Radix default, position="item-aligned", overlays the *selected* row on
  // the trigger (so a mid-list selection appears centered) and falls back to the
  // top-left window corner when it can't measure the selected item — e.g. a
  // freshly-rendered Select with no value yet. "popper" anchors to the trigger
  // instead, so neither happens. This is the unified behavior for every Select.
  //
  // ALIGNMENT: end-aligned by default (the list's right edge on the trigger's
  // right edge) — pickers overwhelmingly sit at the right of their row, so a
  // start-aligned list would hang past the card. The list is then bounded by
  // the nearest layout COLUMN (popover-boundary.ts): if end-alignment would
  // cross the column's left edge, Radix shifts it right until it fits, so a
  // trigger at a column's left edge reads as start-aligned instead of
  // overlaying the neighboring pane. The viewport still applies on top, so a
  // narrow window overrides both. Pass `align` / `collisionBoundary` to opt
  // out for a specific picker.
  position = "popper",
  side = "bottom",
  align = "end",
  sideOffset = 4,
  collisionBoundary,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const anchor = React.useContext(SelectAnchorContext)
  const open = anchor?.open ?? false
  // Resolved on the render that opens the list (trigger is mounted by then);
  // reading the ref here is deliberate — it's a positioning input, not state.
  const columnBoundary = React.useMemo(
    () => (open ? resolvePopoverBoundary(anchor?.triggerRef.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-resolve per open, not per ref identity
    [open]
  )
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        collisionPadding={8}
        // Default: drop the spurious focus ring Radix leaves on the
        // trigger after a pointer-driven close (see overlay-focus.ts).
        // Still forward to any consumer-supplied handler.
        onCloseAutoFocus={(event) => {
          suppressPointerRefocus(event)
          onCloseAutoFocus?.(event)
        }}
        className={cn(
          ANCHORED_OVERLAY_MOTION,
          "relative z-dropdown max-h-(--radix-select-content-available-height) max-w-(--radix-select-content-available-width) min-w-[min(8rem,var(--radix-select-content-available-width))] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain border border-border2 bg-bg3 text-fg1 shadow-[var(--shadow-dropdown)]",
          MENU_SURFACE_RADIUS,
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary ?? columnBoundary ?? undefined}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            MENU_SURFACE_INSET,
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1.5"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs text-fg2", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        MENU_ITEM_RADIUS,
        "relative flex w-full cursor-default items-center gap-2 py-1.5 pr-8 pl-2 text-xs outline-hidden select-none focus:bg-bg3-hover focus:text-fg1 focus:[&_.text-muted-fg]:text-fg3 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-fg2 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none", MENU_SEPARATOR, className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SELECT_CHEVRON,
  selectTriggerClassName,
}
