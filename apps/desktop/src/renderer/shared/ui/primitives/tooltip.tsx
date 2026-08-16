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
//   <Tooltip label="New terminal">{trigger}</Tooltip>
//   <Tooltip label="Toggle right sidebar" shortcut="⌘⌥B">{trigger}</Tooltip>
//
// The trigger (children) must accept a ref + DOM props — a native
// element or any forwardRef component. The raw Radix parts
// (TooltipRoot / TooltipTrigger / TooltipContent) are exported for
// the rare case that needs full control (e.g. the sidebar rail).
// The single TooltipProvider is mounted once at the app root.
// ──────────────────────────────────────────────────────────

const TooltipProvider = TooltipPrimitive.Provider;
function TooltipRoot({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const publishOverlay = useNativeSurfaceOverlayIntent();
  return (
    <TooltipPrimitive.Root
      {...props}
      onOpenChange={(open) => {
        publishOverlay(open);
        onOpenChange?.(open);
      }}
    />
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
>(({ onFocus, ...props }, ref) => (
  <TooltipPrimitive.Trigger
    ref={ref}
    onFocus={(event) => {
      onFocus?.(event);
      if (getLastInputModality() === "pointer") event.preventDefault();
    }}
    {...props}
  />
));
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

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
        "z-50 w-fit max-w-xs overflow-hidden rounded-md border border-border2/50 bg-bg2/40 px-2.5 py-1.5 text-xs text-fg1 shadow-[var(--shadow-dropdown)] backdrop-blur-[10px] backdrop-saturate-[1.7] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
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
  open,
  defaultOpen,
  onOpenChange,
}: TooltipProps) {
  if (label == null || label === "") return <>{children}</>;
  return (
    <TooltipRoot
      delayDuration={delayDuration}
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
