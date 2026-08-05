// ──────────────────────────────────────────────────────────
// AI Elements — Toast (Zeros Foundation bottom-right)
// ──────────────────────────────────────────────────────────
//
// SINGLE source of transient feedback for the entire Mac app.
// All errors, successes, warnings, and status messages MUST
// flow through this surface — no inline pills, no banners
// scattered through the chat. Rule lives in /zeros-foundation skill and
// styles/zeros-foundation.md.
//
// Visual recipe (matches the reference screenshots):
//   • Anchored bottom-right of the viewport, ~24px inset
//   • Fixed 350px card — every toast is the same width regardless of
//     text length — bg-bg1, rounded-lg (8px), NO border/ring (just a soft shadow)
//   • Close × is a ROUND secondary icon button (bg-bg1 + border3, hover
//     bg2/border4) overlapping the top-left corner
//   • An optional action renders as a PRIMARY button (no icon) BELOW the text
//   • Message text reads at text-sm, single line by default
//     but wraps if long
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
import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";

import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "@/renderer/shared/ui/primitives/button";

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
  info: "text-fg2",
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
        // Fixed 350px width so EVERY toast is the same size regardless of
        // text length. bg-bg1, 8px radius, NO border and NO ring — just a soft
        // drop shadow for lift. Any action button sits BELOW the text (not inline).
        "relative flex w-[350px] items-start gap-3 rounded-lg bg-bg1 px-4 py-3.5 text-sm text-fg1 shadow-[var(--shadow-dropdown)]",
      )}
    >
      {/* Close button — a secondary icon button (bg-bg1 + border3, hover
          bg2/border4) sitting half-on / half-off the top-left corner so it
          reads as an external affordance, not a card child. Hidden on the
          stacked-BEHIND toasts while the stack is collapsed — sonner sets
          data-front="false" + data-expanded="false" on those <li>s — so only
          the front toast shows a × (the peeking ×'s behind looked odd). On
          hover the stack expands (data-expanded="true") and every × returns. */}
      <button
        type="button"
        onClick={() => sonnerToast.dismiss(id)}
        aria-label="Dismiss"
        className="absolute -left-2 -top-2 inline-flex size-5 items-center justify-center rounded-sm border border-border3 bg-bg1 text-fg1 transition-colors hover:border-border4 hover:bg-bg2 focus-visible:outline-none focus-visible:border-highlighted-bright [[data-front=false][data-expanded=false]_&]:hidden"
      >
        <X className="size-3" strokeWidth={2.25} aria-hidden="true" />
      </button>

      {Icon && (
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", iconTone)}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg1 leading-snug break-words">
          {message}
        </div>
        {description && (
          <div className="mt-0.5 text-xs text-fg2 break-words">
            {description}
          </div>
        )}
        {action && (
          <Button
            variant="default"
            size="sm"
            className="mt-2.5"
            onClick={() => {
              action.onClick();
              sonnerToast.dismiss(id);
            }}
          >
            {action.label}
          </Button>
        )}
      </div>
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
  const defaultDuration =
    variant === "error" ? 6000 : variant === "success" ? 3000 : 4000;
  return sonnerToast.custom(
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
      ...(opts?.id !== undefined ? { id: opts.id } : {}),
    },
  );
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
baseToast.dismiss = (id) => sonnerToast.dismiss(id);

export const toast: ToastApi = baseToast;

/** Mount once at the app shell root. No props expected. */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={24}
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
