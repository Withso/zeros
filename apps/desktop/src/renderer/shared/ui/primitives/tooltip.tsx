import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/renderer/shared/ui/cn";
import { getLastInputModality } from "@/renderer/shared/ui/overlay-focus";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

// ──────────────────────────────────────────────────────────
// Tooltip — the ONE tooltip for the whole app.
//
// A GLASS chip: translucent --bg2 (40%) + backdrop blur(10px) & saturate,
// --fg1 text, a 50% --border2 hairline edge and the --shadow-dropdown lift.
// It sits ABOVE the trigger and CENTERED on it by default; Radix
// collision handling flips it BELOW (and nudges it inward) when
// there isn't room — e.g. a control flush against the top edge.
//
// This is the app's ONLY tooltip. Native `title=` system tooltips
// are banned (they render an unstyled OS chip, ignore the theme,
// and can't be positioned) — replace them with this component.
//
// Use hints for unfamiliar icons, shortcuts, and otherwise hidden information.
// Visible labels, routine + / × / ⋯ actions, and layer rows need no tooltip.
//   <Tooltip label="Split diff">{trigger}</Tooltip>
//   <Tooltip label="Show panel" shortcut="⌘⌥B">{trigger}</Tooltip>
//
// The trigger (children) must accept a ref + DOM props — a native
// element or any forwardRef component. The raw Radix parts
// (TooltipRoot / TooltipTrigger / TooltipContent) are exported for
// the rare case that needs full control (e.g. the sidebar rail).
// The single TooltipProvider is mounted once at the app root.
// ──────────────────────────────────────────────────────────

const TooltipSettings = React.createContext<
  Omit<React.ComponentProps<typeof TooltipPrimitive.Provider>, "children">
>({ delayDuration: 1000, skipDelayDuration: 0 });

function TooltipProvider({
  children,
  delayDuration = 1000,
  skipDelayDuration = 0,
  disableHoverableContent,
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const settings = React.useMemo(
    () => ({ delayDuration, skipDelayDuration, disableHoverableContent }),
    [delayDuration, skipDelayDuration, disableHoverableContent],
  );
  return (
    <TooltipSettings.Provider value={settings}>
      {children}
    </TooltipSettings.Provider>
  );
}
function TooltipRoot({
  open,
  defaultOpen = false,
  disabled = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & { disabled?: boolean }) {
  const settings = React.useContext(TooltipSettings);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const visible = !disabled && (open ?? uncontrolledOpen);
  const publishOverlay = useNativeSurfaceOverlayIntent();
  React.useEffect(() => {
    // A menu can suppress an already open tooltip without a Radix close event.
    // Release its native overlay intent too, and require a fresh hover later.
    if (disabled) setUncontrolledOpen(false);
    publishOverlay(visible);
  }, [disabled, visible, publishOverlay]);
  return (
    // Radix resets its shared instant-open flag on a timer, even with a zero
    // skip delay. Keep that state per tooltip so a neighboring control always
    // waits its own delay, including pointer moves before that timer runs.
    <TooltipPrimitive.Provider {...settings}>
      <TooltipPrimitive.Root
        {...props}
        open={visible}
        onOpenChange={(nextOpen) => {
          if (disabled && nextOpen) return;
          if (open === undefined) {
            publishOverlay(nextOpen);
            setUncontrolledOpen(nextOpen);
          }
          onOpenChange?.(nextOpen);
        }}
      />
    </TooltipPrimitive.Provider>
  );
}

// Radix opens a tooltip on ANY focus of its trigger — including the
// PROGRAMMATIC focus Radix overlays perform themselves. Concretely:
// Popover/Dialog focus-scope moves focus to the first tabbable element
// inside the content when it opens, and restores focus to the trigger
// when it closes. If that element is a tooltip trigger, its tooltip
// pops open with no hover and hangs (e.g. the model picker's hidden
// per-row ★ "Set as default" — first tabbable because cmdk rows are
// divs). Guard: while the user is mousing, cancel the focus-open
// (preventDefault → Radix's composed handler bails). Keyboard focus
// (Tab / arrow) keeps tooltips, so a11y is unchanged. Same modality
// split as overlay-focus.ts, which fixes the close-side twin bug.
const TooltipTrigger = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onFocus, onPointerMove, ...props }, ref) => (
  <TooltipPrimitive.Trigger
    ref={ref}
    onFocus={(event) => {
      onFocus?.(event);
      if (
        getLastInputModality() === "pointer" ||
        popupIsOpen(event.currentTarget)
      ) event.preventDefault();
    }}
    onPointerMove={(event) => {
      onPointerMove?.(event);
      if (popupIsOpen(event.currentTarget)) event.preventDefault();
    }}
    {...props}
  />
));
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

function popupIsOpen(trigger: HTMLElement): boolean {
  return (
    trigger.hasAttribute("aria-haspopup") &&
    trigger.getAttribute("aria-expanded") === "true"
  );
}

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-dropdown w-fit max-w-xs overflow-hidden rounded-sm border border-border2/50 bg-bg2/40 px-2 py-1 text-3xxs text-fg1 shadow-[var(--shadow-dropdown)] backdrop-blur-[10px] backdrop-saturate-[1.7] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export interface TooltipProps {
  /** The tooltip text (what used to be the native `title`). */
  label: React.ReactNode;
  /** Optional keyboard hint rendered muted after the label, e.g. "⌘R". */
  shortcut?: React.ReactNode;
  /** The trigger — a native element or any ref-forwarding component. */
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  /** Per-tooltip open delay override (defaults to the root provider's). */
  delayDuration?: number;
  /** Suppress help while the trigger's menu or popover is open. */
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The ergonomic single-call tooltip used across the app. Renders the
 * trigger bare when `label` is empty, so callers can pass a maybe-empty
 * label without conditionals and never get an empty chip.
 */
function Tooltip({
  label,
  shortcut,
  children,
  side = "top",
  align = "center",
  sideOffset,
  className,
  delayDuration,
  disabled,
  open,
  defaultOpen,
  onOpenChange,
}: TooltipProps) {
  if (label == null || label === "") return <>{children}</>;
  return (
    <TooltipRoot
      delayDuration={delayDuration}
      disabled={disabled}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
        {label}
        {shortcut != null && shortcut !== "" ? (
          <span className="ml-1.5 text-fg2">{shortcut}</span>
        ) : null}
      </TooltipContent>
    </TooltipRoot>
  );
}

export { Tooltip, TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent };
