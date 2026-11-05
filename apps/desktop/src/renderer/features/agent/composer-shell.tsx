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
//   COMPOSER_SURFACE_RADIUS — 18px corners for Create and workspace composers
//   COMPOSER_SURFACE_CLS    — the sidebar-bg + composer-border surface they share
//   PROMPT_SURFACE_RADIUS   — 12px corners shared by the prompt surfaces
//                             and the chat notices beside them
// ──────────────────────────────────────────────────────────

export const COMPOSER_FILE_ACCEPT =
  ""; // All formats are selectable; the shared policy explains excluded files.

/** Create and workspace composers use the requested 18px corner geometry.
 * Sent messages and inline edits retain their existing prompt shape. */
export const COMPOSER_SURFACE_RADIUS = "rounded-[18px]";

/** The composer surface shared by Create and Agent chat: sidebar-bg with the
 *  composer-border edge (styles/semantic-tokens.css) and no shadow. Clicking
 *  in and typing change nothing; only a drag or a mode outline restyles it. */
export const COMPOSER_SURFACE_CLS = "border-(--composer-border) bg-sidebar-bg";

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

/** 12px corners for sent user messages, their inline edit composer, and the
 *  chat error/warning/sign-in notices (agent-notice.tsx) that share their shape.
 *
 *  DERIVED from the radius scale (1.5 × --radius-lg) exactly like
 *  menu-surface.ts's floating surfaces and settings-ui.tsx's
 *  SETTINGS_GROUP_RADIUS — not a fourth token. NOT `rounded-xl`:
 *  zeros-tokens.css resets `--radius-xl` to `initial` on purpose, so that
 *  class compiles to nothing. */
export const PROMPT_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";
