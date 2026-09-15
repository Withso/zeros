// ──────────────────────────────────────────────────────────
// composer-shell.tsx — composer file-accept + surface geometry
// ──────────────────────────────────────────────────────────
//
// This module originally vendored three shared composer primitives:
// <ComposerShell>, <ComposerTextarea>, and <ComposerToolbar>. Call sites now
// use the canonical AI Elements `PromptInput` recipe,
// sites, and the TipTap composer later replaced the autosize hook +
// height constants. Only the canonical file-accept string survives.
//
// Public API:
//   COMPOSER_FILE_ACCEPT    — canonical accept= string for the file picker
//   PROMPT_SURFACE_RADIUS   — 12px corners shared by the prompt surfaces
// ──────────────────────────────────────────────────────────

export const COMPOSER_FILE_ACCEPT =
  "image/*,text/*,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.sh";

/** 12px corners for the three surfaces a user prompt lives on — the bottom
 *  composer card, the inline edit composer that replaces a sent message, and
 *  the sent user-message bubble itself. They share one radius so a prompt
 *  keeps its shape as it moves between them.
 *
 *  DERIVED from the radius scale (1.5 × --radius-lg) exactly like
 *  menu-surface.ts's 16px dropdown surface and settings-ui.tsx's
 *  SETTINGS_GROUP_RADIUS — not a fourth token. NOT `rounded-xl`:
 *  zeros-tokens.css resets `--radius-xl` to `initial` on purpose, so that
 *  class compiles to nothing. */
export const PROMPT_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";
