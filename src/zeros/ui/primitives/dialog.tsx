import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/zeros/ui/cn";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Render the top-right close (X) button. Default true; pass false for
     *  dialogs that own their own chrome (e.g. the full create-from picker). */
    showCloseButton?: boolean;
    /** Allow dismissing by clicking the overlay / interacting outside the
     *  content. Default FALSE — a modal should only close via an explicit
     *  Cancel / close button / Escape, so an accidental backdrop click can't
     *  discard in-progress work (e.g. the Add-local-project adopt flow). Opt IN
     *  for transient surfaces like the command palette, where click-away IS the
     *  expected close. */
    dismissable?: boolean;
  }
>(({ className, children, showCloseButton = true, dismissable = false, onPointerDownOutside, onInteractOutside, onKeyDownCapture, onEscapeKeyDown, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (event.defaultPrevented || event.key !== "Escape") return;

        // A Tooltip's closing Presence can briefly remain the topmost Radix
        // DismissableLayer after a modal opens. In that overlap window the
        // document-level Escape handler closes the already-closing tooltip and
        // never reaches Dialog. Capture the key inside the focused modal and
        // close through Radix's public Close primitive so teardown and trigger
        // focus restoration keep their normal semantics.
        onEscapeKeyDown?.(event.nativeEvent);
        if (!event.defaultPrevented && !event.nativeEvent.defaultPrevented) {
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
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-bg1 p-6 shadow-[var(--shadow-dropdown)]",
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
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-[3px] focus:ring-highlighted-bright/50 disabled:pointer-events-none data-[state=open]:bg-bg2-hover data-[state=open]:text-fg2">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-fg2", className)}
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
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
