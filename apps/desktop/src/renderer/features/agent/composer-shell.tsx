// ──────────────────────────────────────────────────────────
// composer-shell.tsx — composer file-accept + surface geometry
// ──────────────────────────────────────────────────────────
//
// This module originally vendored three shared composer primitives:
// <ComposerShell>, <ComposerTextarea>, and <ComposerToolbar>. Call sites now
// use the canonical AI Elements `PromptInput` recipe,
// sites, and the TipTap composer later replaced the autosize hook +
// height constants. The file-accept string and surface geometry live here.
//
// Public API:
//   COMPOSER_FILE_ACCEPT    — canonical accept= string for the file picker
//   COMPOSER_SURFACE_RADIUS — 18px corners for the Create, workspace and edit composers
//   COMPOSER_SURFACE_CLS    — the sidebar-bg + composer-border surface they share
//   COMPOSER_DRAG_CLS       — a composer card while files are dragged over it
//   ComposerDropVeil        — the veil over that card
//   COMPOSER_SEND_CLS       — Send, Stop and Resend
//   PROMPT_SURFACE_RADIUS   — 12px corners shared by the prompt surfaces
//                             and the chat notices beside them
// ──────────────────────────────────────────────────────────

import { Upload } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

export const COMPOSER_FILE_ACCEPT =
  ""; // All formats are selectable; the shared policy explains excluded files.

/** Create, workspace and inline edit composers use the 18px corner geometry;
 *  sent messages keep the 12px prompt shape. */
export const COMPOSER_SURFACE_RADIUS = "rounded-[18px]";

/** The composer surface shared by Create and Agent chat: sidebar-bg with the
 *  composer-border edge (styles/semantic-tokens.css) and no shadow. Clicking
 *  in and typing change nothing; only a drag or a mode outline restyles it. */
export const COMPOSER_SURFACE_CLS = "border-(--composer-border) bg-sidebar-bg";

/** A file dragged over a composer card: the same edge, dashed, with a soft
 *  ring; `!` keeps it identical whether or not the composer is focused. */
export const COMPOSER_DRAG_CLS =
  "!border-(--composer-border) ring-highlighted-bright/30 border-dashed ring-2";

/** Send, Stop and Resend: 28px like every composer toolbar control, and the
 *  only circle. */
export const COMPOSER_SEND_CLS =
  "disabled:bg-bg2-hover disabled:text-fg2 aria-disabled:bg-bg2-hover aria-disabled:text-fg2 size-7 disabled:opacity-100";

/** The veil over a composer card while files are dragged over it. z-2 clears
 *  the card's content; the guarded-mode frame (z-3) is hidden during a drag. */
export function ComposerDropVeil() {
  return (
    <div
      className={cn(
        "bg-bg3/75 text-fg2 pointer-events-none absolute inset-0 z-2 flex flex-col items-center justify-center gap-1.5 p-3 text-xs",
        COMPOSER_SURFACE_RADIUS,
      )}
      aria-hidden="true"
    >
      <Upload size={20} />
      <span>Drop files to attach</span>
    </div>
  );
}

/** One 32px row for the transcript's own states (loading, waiting,
 *  unavailable, no history): 13/18 fg3 text after a 14px leading slot, with a
 *  24px Ghost action when there is one. */
export const TRANSCRIPT_STATUS_ROW_CLS =
  "text-fg3 flex min-h-8 items-center gap-2 text-xs leading-4.5";

/** A card docked above the composer (goal, queued messages, permission,
 *  question, plan review, terminal command): the composer's surface with
 *  12px corners and no shadow; the dock spaces them 8px apart. The @, / and #
 *  pickers docked on the composer take the same surface through
 *  `PopoverContent surface="composer"`. */
export const DOCK_CARD_CLS =
  "border-(--composer-border) bg-sidebar-bg rounded-[calc(var(--radius-lg)*1.5)] border";

/** 12px corners for sent user messages and the chat error/warning/sign-in
 *  notices (agent-notice.tsx) that share their shape.
 *
 *  DERIVED from the radius scale (1.5 × --radius-lg) exactly like
 *  menu-surface.ts's floating surfaces and settings-ui.tsx's
 *  SETTINGS_GROUP_RADIUS — not a fourth token. NOT `rounded-xl`:
 *  zeros-tokens.css resets `--radius-xl` to `initial` on purpose, so that
 *  class compiles to nothing. */
export const PROMPT_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";
