// ──────────────────────────────────────────────────────────
// AI Elements — Toast (Zeros Foundation bottom-right)
// ──────────────────────────────────────────────────────────
//
// SINGLE source of transient feedback for the entire Mac app.
// All errors, successes, warnings, and status messages MUST
// flow through this surface — no inline pills, no banners
// scattered through the chat. Rule lives in docs/design-system.md
// (Feedback).
//
// Visual recipe (the floating family, docs/design-system.md):
//   • Anchored bottom-right of the viewport, ~24px inset
//   • Fixed 360px card — every toast is the same width regardless of
//     text length — bg3, border2, 12px corners and the dropdown shadow
//   • Close × is a 24px IconButton inside the top-right corner
//   • A status toast leads with its tone's 16px icon; info is blue-primary
//   • An optional action renders as a PRIMARY button (no icon) BELOW the text
//   • Title 13/18 medium, description 12/16 fg2; both wrap if long
//   • Default auto-dismiss after 4s; user can hover-pause
//   • Errors stay 6s; successes 3s; info 4s
//
// API (use these helpers, never call sonner directly so we
// keep the visual contract centralised):
//
//   import { toast } from "@/renderer/shared/ui/primitives/elements";
//
//   toast("Now targeting create-greeting-md.");        // default
//   toast.success("Pushed to main.");
//   toast.error("Couldn't reach the engine.");
//   toast.warning("Attachment is too large.");
//   toast.info("Switched to Claude Sonnet 4.6.");
//
// Mount <Toaster /> exactly once at the root of the app
// shell — already wired in apps/desktop/src/renderer/app-shell.tsx. Do not mount it
// per-route or per-panel.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { X, CircleCheck, CircleX, TriangleAlert, Info } from "lucide-react";
import { Toaster as SonnerToaster, toast as sonnerToast, useSonner } from "sonner";

import { cn } from "@/renderer/shared/ui/cn";
import { FLOATING_SURFACE } from "@/renderer/shared/ui/layout/surface";
import { MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { createNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

const toastOverlayIntents = new Map<
  string | number,
  ReturnType<typeof createNativeSurfaceOverlayIntent>
>();

function releaseToastOverlay(id: string | number): void {
  toastOverlayIntents.get(id)?.(false);
  toastOverlayIntents.delete(id);
}

/** Variants. `default` is the plain dark card from the screenshots; the
 *  others add a left status icon + tint the ring/border subtly. */
export type ToastVariant = "default" | "success" | "error" | "warning" | "info";

/** Optional primary action rendered as a primary button BELOW the text
 *  (no icon). Used for recovery toasts ("Native bridge missing → [Reload]")
 *  and any other case where the user can acknowledge by *doing* something
 *  rather than just dismissing. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastCardProps {
  id: string | number;
  message: React.ReactNode;
  variant: ToastVariant;
  /** Optional secondary line — small muted text below the headline. */
  description?: React.ReactNode;
  /** Optional primary action — renders as a button. Clicking it
   *  dismisses the toast AFTER firing the handler. */
  action?: ToastAction;
}

const VARIANT_ICON: Record<Exclude<ToastVariant, "default">, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
};

const VARIANT_ICON_TONE: Record<Exclude<ToastVariant, "default">, string> = {
  success: "text-green-primary",
  error: "text-red-primary",
  warning: "text-yellow-primary",
  info: "text-blue-primary",
};

function ToastCard({
  id,
  message,
  variant,
  description,
  action,
}: ToastCardProps) {
  const Icon = variant !== "default" ? VARIANT_ICON[variant] : null;
  const iconTone = variant !== "default" ? VARIANT_ICON_TONE[variant] : "";

  return (
    <div
      className={cn(
        "border-border2 text-fg1 relative flex w-90 items-start gap-2.5 border p-3 shadow-[var(--shadow-dropdown)]",
        FLOATING_SURFACE,
        MENU_SURFACE_RADIUS,
      )}
    >
      {Icon && (
        <Icon
          className={cn("mt-px size-4 shrink-0", iconTone)}
          aria-hidden="true"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-fg1 text-xs leading-4.5 font-medium break-words">
          {message}
        </div>
        {description && (
          <div className="text-fg2 text-3xxs leading-4 break-words">
            {description}
          </div>
        )}
        {action && (
          <Button
            variant="primary"
            className="mt-2"
            onClick={() => {
              action.onClick();
              sonnerToast.dismiss(id);
            }}
          >
            {action.label}
          </Button>
        )}
      </div>
      {/* Only the front toast shows its × while the stack is collapsed:
          sonner marks the stacked-behind <li>s data-front="false" +
          data-expanded="false". Hover expands the stack and every × returns. */}
      <IconButton
        size="compact"
        label="Dismiss"
        onClick={() => sonnerToast.dismiss(id)}
        className="-mt-1 -mr-1 [[data-front=false][data-expanded=false]_&]:hidden"
      >
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}

interface ToastOptions {
  description?: React.ReactNode;
  /** Override the default duration (ms). Set Infinity to require user dismiss. */
  duration?: number;
  /** Optional action button. The handler is fired BEFORE the toast
   *  is dismissed, so consumers can rely on the side effect (e.g.
   *  `window.location.reload()`) running synchronously. */
  action?: ToastAction;
  /** Stable key: a re-emit with the same id REPLACES the visible toast
   *  instead of stacking an identical copy (sonner dedupe). Use for
   *  repeatable failures (e.g. one slot per chat's agent error). */
  id?: string | number;
}

function emit(
  variant: ToastVariant,
  message: React.ReactNode,
  opts?: ToastOptions,
) {
  const publishOverlay = createNativeSurfaceOverlayIntent();
  publishOverlay(true);
  const defaultDuration =
    variant === "error" ? 6000 : variant === "success" ? 3000 : 4000;
  const id = sonnerToast.custom(
    (id) => (
      <ToastCard
        id={id}
        message={message}
        variant={variant}
        description={opts?.description}
        action={opts?.action}
      />
    ),
    {
      duration: opts?.duration ?? defaultDuration,
      onDismiss: () => releaseToastOverlay(id),
      onAutoClose: () => releaseToastOverlay(id),
      ...(opts?.id !== undefined ? { id: opts.id } : {}),
    },
  );
  const replaced = toastOverlayIntents.get(id);
  if (replaced && replaced !== publishOverlay) replaced(false);
  toastOverlayIntents.set(id, publishOverlay);
  return id;
}

/** The single allowed entry point for transient feedback. */
interface ToastApi {
  (message: React.ReactNode, opts?: ToastOptions): string | number;
  success: (message: React.ReactNode, opts?: ToastOptions) => string | number;
  error: (message: React.ReactNode, opts?: ToastOptions) => string | number;
  warning: (message: React.ReactNode, opts?: ToastOptions) => string | number;
  info: (message: React.ReactNode, opts?: ToastOptions) => string | number;
  dismiss: (id?: string | number) => void;
}

const baseToast = ((message: React.ReactNode, opts?: ToastOptions) =>
  emit("default", message, opts)) as ToastApi;
baseToast.success = (m, o) => emit("success", m, o);
baseToast.error = (m, o) => emit("error", m, o);
baseToast.warning = (m, o) => emit("warning", m, o);
baseToast.info = (m, o) => emit("info", m, o);
baseToast.dismiss = (id) => {
  if (id === undefined) {
    for (const toastId of toastOverlayIntents.keys()) {
      releaseToastOverlay(toastId);
    }
  } else {
    releaseToastOverlay(id);
  }
  sonnerToast.dismiss(id);
};

export const toast: ToastApi = baseToast;

/** The toasts' inset from the window's bottom-right corner. */
export const TOAST_OFFSET_PX = 24;

const SHOWN_TOAST_SELECTOR =
  '[data-sonner-toast]:not([data-removed="true"]):not([data-visible="false"])';
/** Toasts slide, stack and spread with 400ms transitions. */
const TOAST_SETTLE_MS = 450;

function measureToastReach(): number {
  const viewportHeight = window.innerHeight;
  let top = viewportHeight;
  for (const node of document.querySelectorAll(SHOWN_TOAST_SELECTOR)) {
    const rect = node.getBoundingClientRect();
    if (rect.height > 0 && rect.top < top) top = rect.top;
  }
  return Math.max(0, Math.round(viewportHeight - top));
}

/** How far above the window's bottom edge the toasts reach, so another
 * surface in the bottom-right corner can sit clear of them: 0 with none.
 * Follows toasts as they arrive, stack, spread and leave, while `enabled`. */
export function useToastReach(enabled = true): number {
  const { toasts } = useSonner();
  const [reach, setReach] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measureToastReach();
        setReach((current) => (current === next ? current : next));
      });
    };
    measure();
    const settle = window.setTimeout(measure, TOAST_SETTLE_MS);
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-sonner-toaster]")) {
        measure();
      }
    };
    document.addEventListener("transitionend", onTransitionEnd, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      document.removeEventListener("transitionend", onTransitionEnd, true);
      window.removeEventListener("resize", measure);
    };
  }, [enabled, toasts]);
  return enabled ? reach : 0;
}

/** Mount once at the app shell root. No props expected. */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={TOAST_OFFSET_PX}
      gap={10}
      visibleToasts={3}
      // We render custom JSX; suppress sonner's default chrome so our
      // card is the ONLY visual.
      toastOptions={{
        unstyled: true,
        classNames: { toast: "!bg-transparent !shadow-none !border-0 !p-0" },
      }}
    />
  );
}
