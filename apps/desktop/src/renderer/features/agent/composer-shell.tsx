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
//   PROMPT_SURFACE_RADIUS   — 12px corners shared by the prompt surfaces
// ──────────────────────────────────────────────────────────

export const COMPOSER_FILE_ACCEPT =
  ""; // All formats are selectable; the shared policy explains excluded files.

/** Create and workspace composers use the requested 18px corner geometry.
 * Sent messages and inline edits retain their existing prompt shape. */
export const COMPOSER_SURFACE_RADIUS = "rounded-[18px]";

/** 12px corners for sent user messages and their inline edit composer.
 *
 *  DERIVED from the radius scale (1.5 × --radius-lg) exactly like
 *  menu-surface.ts's 16px dropdown surface and settings-ui.tsx's
 *  SETTINGS_GROUP_RADIUS — not a fourth token. NOT `rounded-xl`:
 *  zeros-tokens.css resets `--radius-xl` to `initial` on purpose, so that
 *  class compiles to nothing. */
export const PROMPT_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";
