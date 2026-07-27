// ──────────────────────────────────────────────────────────
// composer-shell.tsx — composer file-accept constant
// ──────────────────────────────────────────────────────────
//
// Phase D3 (2026-05-08) originally vendored three shared composer
// primitives here — <ComposerShell>, <ComposerTextarea>, and
// <ComposerToolbar>. Wave 4 (Roadmap 01b, 2026-05-16) replaced those
// with the canonical AI Elements `PromptInput` recipe at all call
// sites, and the TipTap composer later replaced the autosize hook +
// height constants. Only the canonical file-accept string survives.
//
// Public API:
//   COMPOSER_FILE_ACCEPT — canonical accept= string for the file picker
// ──────────────────────────────────────────────────────────

export const COMPOSER_FILE_ACCEPT =
  "image/*,text/*,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.sh";
