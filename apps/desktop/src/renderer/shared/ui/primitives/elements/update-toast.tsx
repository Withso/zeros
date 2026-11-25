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

import type * as React from "react";
import { toast as sonnerToast } from "sonner";

import { Button } from "@/renderer/shared/ui/primitives/button";
import { ToastCard } from "./toast";
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
  // The one toast shape (ToastCard) with a row of actions; the caller's
  // dismiss arms the re-show timer before the toast tears down.
  return (
    <ToastCard
      id={id}
      variant="default"
      message={title}
      description={description}
      onDismiss={onDismiss}
      actions={
        <>
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
        </>
      }
    />
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
