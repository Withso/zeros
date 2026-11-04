// ──────────────────────────────────────────────────────────
// AI Elements — Update toast (persistent, multi-action)
// ──────────────────────────────────────────────────────────
//
// A dedicated variant of the bottom-right toast for the auto-updater's
// "New update available" prompt. Unlike the transient `toast()` helpers it is
// PERSISTENT (duration: Infinity) and carries a ROW of actions — See changes,
// an optional "Restart when idle" (only while an agent is mid-turn), and
// Restart — instead of a single action button below the text.
//
// Driven imperatively by <UpdateNotifications/> (apps/desktop/src/renderer/features/update), which
// shows / updates / dismisses the single instance by its stable id as updater
// status + agent-running state change. Kept in this module so the sonner call
// stays centralised — same rule as toast.tsx, never call sonner elsewhere.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { X } from "lucide-react";
import { toast as sonnerToast } from "sonner";

import { cn } from "@/renderer/shared/ui/cn";
import { FLOATING_SURFACE } from "@/renderer/shared/ui/layout/surface";
import { MENU_SURFACE_RADIUS } from "@/renderer/shared/ui/menu-surface";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { createNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";

const publishUpdateOverlay = createNativeSurfaceOverlayIntent();

/** Stable id so repeat calls UPDATE the one update toast in place (rather than
 *  stacking duplicates) and so <UpdateNotifications/> can dismiss it by id. */
export const UPDATE_TOAST_ID = "zeros-update-available";

export interface UpdateToastProps {
  title: string;
  description?: React.ReactNode;
  /** Open the changelog. */
  onSeeChanges: () => void;
  /** Restart + install now. */
  onRestart: () => void;
  /** Defer the restart until agents are idle. Provided ONLY when an agent is
   *  currently running — when omitted the button is hidden (matches the
   *  reference: an idle app shows just "See changes" + "Restart"). */
  onRestartWhenIdle?: () => void;
  /** User clicked × — the caller suppresses + arms the re-show timer. */
  onDismiss: () => void;
}

function UpdateToastCard({
  id,
  title,
  description,
  onSeeChanges,
  onRestart,
  onRestartWhenIdle,
  onDismiss,
}: UpdateToastProps & { id: string | number }) {
  return (
    <div
      className={cn(
        "border-border2 text-fg1 relative flex w-90 items-start gap-2.5 border p-3 shadow-[var(--shadow-dropdown)]",
        FLOATING_SURFACE,
        MENU_SURFACE_RADIUS,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-fg1 text-xs leading-4.5 font-medium">{title}</div>
        {description && (
          <div className="text-fg2 text-3xxs leading-4 break-words">{description}</div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onSeeChanges}>
            See changes
          </Button>
          {onRestartWhenIdle && (
            <Button variant="secondary" onClick={onRestartWhenIdle}>
              Restart when idle
            </Button>
          )}
          <Button variant="primary" onClick={onRestart}>
            Restart
          </Button>
        </div>
      </div>
      {/* The caller's dismiss arms the re-show timer, then the sonner toast
          tears down. */}
      <IconButton
        size="compact"
        label="Dismiss"
        className="-mt-1 -mr-1"
        onClick={() => {
          onDismiss();
          sonnerToast.dismiss(id);
        }}
      >
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/** Show — or update in place — the single persistent update toast. */
export function showUpdateToast(props: UpdateToastProps): void {
  publishUpdateOverlay(true);
  sonnerToast.custom((id) => <UpdateToastCard id={id} {...props} />, {
    id: UPDATE_TOAST_ID,
    duration: Infinity,
    onDismiss: () => publishUpdateOverlay(false),
  });
}

/** Tear down the update toast (no-op if it isn't showing). */
export function dismissUpdateToast(): void {
  publishUpdateOverlay(false);
  sonnerToast.dismiss(UPDATE_TOAST_ID);
}
