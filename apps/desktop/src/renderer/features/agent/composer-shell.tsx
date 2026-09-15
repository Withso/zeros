// ──────────────────────────────────────────────────────────
// composer-shell.tsx — composer file-accept constant
// ──────────────────────────────────────────────────────────
//
// This module originally vendored three shared composer primitives:
// <ComposerShell>, <ComposerTextarea>, and <ComposerToolbar>. Call sites now
// use the canonical AI Elements `PromptInput` recipe,
// sites, and the TipTap composer later replaced the autosize hook +
// height constants. Only the canonical file-accept string survives.
//
// Public API:
//   COMPOSER_FILE_ACCEPT — canonical accept= string for the file picker
// ──────────────────────────────────────────────────────────

export const COMPOSER_FILE_ACCEPT =
  ""; // All formats are selectable; the shared policy explains excluded files.
