import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./button";

import { cn } from "@/renderer/shared/ui/cn";
import { useNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
function Dialog({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const publishOverlay = useNativeSurfaceOverlayIntent();
  return (
    <DialogPrimitive.Root
      {...props}
      onOpenChange={(open) => {
        publishOverlay(open);
        onOpenChange?.(open);
      }}
    />
  );
}

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

/** Shared compact close control for dialog titles and custom dialog headers. */
const DialogCloseButton = React.forwardRef<
  HTMLButtonElement,
  Omit<
    React.ComponentPropsWithoutRef<typeof Button>,
    "asChild" | "children" | "size" | "variant"
  >
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close asChild>
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close"
      data-slot="dialog-close"
      {...props}
      className={cn(
        "text-fg2 size-5 shrink-0 rounded-[var(--dialog-close-radius)]",
        className,
      )}
    >
      <X className="size-3" />
    </Button>
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = "DialogCloseButton";

// The title owns the visible close control, keeping it aligned with the heading
// even in dialogs with custom padding. Busy dialogs can still hide dismissal.
const DialogChromeContext = React.createContext(false);

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    data-slot="dialog-overlay"
    ref={ref}
    className={cn(
      "bg-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Render the title's top-right close (X) button. Default true; pass false for
     *  dialogs that own their own chrome (e.g. the full create-from picker). */
    showCloseButton?: boolean;
    /** Keep modal focus and scroll isolation without dimming the background. */
    backdrop?: "dimmed" | "clear";
    /** Allow dismissing by clicking the overlay / interacting outside the
     *  content. Default FALSE — a modal should only close via an explicit
     *  Cancel / close button / Escape, so an accidental backdrop click can't
     *  discard in-progress work (e.g. the Add-local-project adopt flow). Opt IN
     *  for transient surfaces like the command palette, where click-away IS the
     *  expected close. */
    dismissable?: boolean;
  }
>(
  (
    {
      className,
      children,
      showCloseButton = true,
      backdrop = "dimmed",
      dismissable = false,
      onPointerDownOutside,
      onInteractOutside,
      onKeyDown,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) => {
    // Radix handles Escape from a document capture listener. During the brief
    // overlap where a closing Tooltip is still its top layer, that listener
    // does not dispatch to this Dialog. Remember the native events Radix did
    // deliver so the content-bubble fallback can distinguish the two cases.
    const radixEscapeEvents = React.useRef<WeakSet<Event>>(new WeakSet());

    return (
      <DialogPortal>
        <DialogOverlay
          className={backdrop === "clear" ? "bg-transparent" : undefined}
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          ref={ref}
          {...popoverBoundaryProps}
          onEscapeKeyDown={(event) => {
            radixEscapeEvents.current.add(event);
            onEscapeKeyDown?.(event);
          }}
          onKeyDown={(event) => {
            // Bubble after focused descendants have had the chance to consume
            // Escape (comboboxes, editors, and other nested interaction state).
            onKeyDown?.(event);
            if (event.defaultPrevented || event.key !== "Escape") return;

            const nativeEvent = event.nativeEvent;
            if (radixEscapeEvents.current.has(nativeEvent)) return;

            // A Tooltip's closing Presence can briefly remain the topmost Radix
            // DismissableLayer after a modal opens. In that overlap window the
            // document listener misses Dialog. Invoke the consumer guard exactly
            // once, then close through Radix's public primitive.
            onEscapeKeyDown?.(nativeEvent);
            if (!event.defaultPrevented && !nativeEvent.defaultPrevented) {
              event.currentTarget
                .querySelector<HTMLButtonElement>("[data-dialog-escape-close]")
                ?.click();
            }
          }}
          className={cn(
            // Dead-centered on both axes, then a subtle scale-from-center on
            // open/close. There are deliberately NO slide-in / slide-out helper
            // classes here — and that omission is load-bearing:
            //
            // In Tailwind v4 the translate-x / translate-y utilities compile to the
            // standalone `translate` CSS property, which is INDEPENDENT of the
            // `transform` property that tw-animate-css animates. So the -50%/-50%
            // centering survives the whole animation on its own. If we ALSO add the
            // shadcn slide helpers (which shift the panel by half its width/height
            // on enter/exit), they inject a *second* -50% into the animated
            // `transform` — it stacks on top of `translate` and flings the panel
            // up-and-left (~-100%,-98% of its size) on the first frame, so it
            // visibly flies in from the top-left. A pure zoom + fade with
            // `origin-center` keeps the panel's center pinned to the viewport
            // center and scales symmetrically. (This is a v3→v4 migration trap: v3
            // composed translate INTO `transform`, so the slide helpers were
            // required there.)
            "bg-bg1 fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-0 border p-0 shadow-[var(--shadow-dropdown)]",
            // Smooth, subtle motion: 3% scale, decelerate in / accelerate out.
            "origin-center duration-200 ease-out data-[state=closed]:duration-150 data-[state=closed]:ease-in",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-97 data-[state=closed]:zoom-out-97",
            "sm:rounded-lg",
            className,
          )}
          onPointerDownOutside={(e) => {
            // Modal-by-default: an overlay click must not discard the dialog.
            if (!dismissable) e.preventDefault();
            onPointerDownOutside?.(e);
          }}
          onInteractOutside={(e) => {
            // Covers focus-outside as well as the pointer case above.
            if (!dismissable) e.preventDefault();
            onInteractOutside?.(e);
          }}
          {...props}
        >
          <DialogPrimitive.Close
            data-dialog-escape-close
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
          />
          <DialogChromeContext.Provider value={showCloseButton}>
            {children}
          </DialogChromeContext.Provider>
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-header"
    className={cn("flex shrink-0 flex-col gap-1.5 px-4 pt-3 pb-0 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

/** The middle section owns its spacing, including in scrollable dialogs. */
const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-body"
    className={cn("flex min-h-0 min-w-0 flex-col gap-4 px-4 py-6", className)}
    {...props}
  />
);
DialogBody.displayName = "DialogBody";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-footer"
    className={cn(
      "border-border1 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t p-2.5",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  const showCloseButton = React.useContext(DialogChromeContext);
  const title = (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="dialog-title"
      className={cn(
        "text-dialog-title min-w-0 leading-5 font-medium",
        className,
      )}
      {...props}
    />
  );
  // Accessibility-only titles must not introduce visible layout or controls.
  if (className?.split(/\s+/).includes("sr-only")) return title;
  return (
    <div
      data-slot="dialog-title-row"
      className="flex w-full min-w-0 items-center gap-2"
    >
      {title}
      {showCloseButton && <DialogCloseButton className="ml-auto" />}
    </div>
  );
});
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-fg2 text-xs", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
