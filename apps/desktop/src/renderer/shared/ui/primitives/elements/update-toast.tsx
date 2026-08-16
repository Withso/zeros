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

import { Button } from "@/renderer/shared/ui/primitives/button";
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
    <div className="relative flex w-[350px] flex-col rounded-lg bg-bg1 px-4 py-3.5 text-sm text-fg1 shadow-[var(--shadow-dropdown)]">
      {/* Round × overlapping the top-left corner — same affordance as the
          standard toast card. Fires the caller's dismiss (which arms the
          re-show timer), then tears down the sonner toast. */}
      <button
        type="button"
        onClick={() => {
          onDismiss();
          sonnerToast.dismiss(id);
        }}
        aria-label="Dismiss"
        className="absolute -left-2 -top-2 inline-flex size-5 items-center justify-center rounded-sm border border-border3 bg-bg1 text-fg1 transition-colors hover:border-border4 hover:bg-bg2 focus-visible:outline-none focus-visible:border-highlighted-bright"
      >
        <X className="size-3" strokeWidth={2.25} aria-hidden="true" />
      </button>

      <div className="font-medium text-fg1 leading-snug">{title}</div>
      {description && (
        <div className="mt-0.5 text-xs text-fg2 break-words">{description}</div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onSeeChanges}>
          See changes
        </Button>
        {onRestartWhenIdle && (
          <Button variant="secondary" size="sm" onClick={onRestartWhenIdle}>
            Restart when idle
          </Button>
        )}
        <Button variant="default" size="sm" onClick={onRestart}>
          Restart
        </Button>
      </div>
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
