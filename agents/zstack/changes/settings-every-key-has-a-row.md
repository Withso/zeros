# Every settings key has a Settings row; master switches govern every provider

Target: `principles.md` (settings), `zstack-review` checklist.

- Symptom: turning off "Enable computer use" still let Codex use its
  built-in computer use, and a failed settings read left Codex's plugins on.
  Cause: `resolveComputerUseRoute` returned `codex-native` before checking
  `enabled`, and the Codex adapter disabled the plugins only when
  `codexNative === false` (absent meant "leave Codex's config alone").
  Rule: a master switch decides first for every agent family. A capability
  Zeros replaces is disabled unconditionally, never only when a setting says
  so. Encoded: protocol route tests and `adapters/codex/built-in-plugins.ts`.
- Symptom: `app_access`, `navigation_approval` and the `codex_native` keys
  changed behavior with no Settings row, so a stray hand edit brought back
  prompts and nothing showed why. Rule: no settings.toml key without a
  Settings row. Retire a key by folding it into its replacement as each layer
  is read (`settings/retired-agent-control.ts`), keeping any opt-out, and
  remove it from the user's file once (`settings/agent-control-migration.ts`).
- Symptom (review): the first retirement only rewrote the user's file, so an
  organization's managed `in_app_enabled = false` silently turned browser use
  back on, shown as unmanaged. Cause: managed and team files are read-only to
  Zeros; a file migration never reaches them. Rule: retire a key at read time
  in every layer that may set it, and fail closed where the old value asked
  for a question Zeros no longer asks. Encoded: `resolve.test.ts` managed
  cases.
