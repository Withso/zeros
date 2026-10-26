# Files editing and exact turn navigation

- Native Pierre edit events carry a complete document before React necessarily
  commits the corresponding prop. An immediate Save shortcut originally read
  an older prop. Keep a synchronous draft ref, keep controlled item input stable
  during typing, and accept the completed native item. The browser regression
  edits, undoes, redoes and immediately saves through the real library.
- A zero-line diff has no row to attach a caret to. Start an empty document with
  Pierre's file editor, without inventing saved whitespace. Identical nonempty
  files need context-only rows. Initialize the virtual viewport only while
  visible: a Markdown file first mounted behind Preview otherwise kept a
  zero-size viewport when switched to Edit. Retain its document/edit-state key
  outside that viewport. The smoke covers Preview/Edit/tab switches, clean and
  empty files, full erasure, CRLF and missing trailing newlines through writes.
- Opening File options after an autosave failure triggered another write via
  blur. Gate blur saves on the same failure state as the debounce. Preserve
  newer typing during a held write, and distinguish outstanding save echoes
  from a genuine external revert after the latest save was acknowledged.
  Encoded in `source-editor-sync.test.ts` and `ui-smoke-file-editor.mjs` for
  Personal Local, organization-local and cloud placements.
- Screenshot evidence must wait for the popover's completed opacity, and
  change appearance through the theme store so native syntax colors follow the
  app. Setting only `data-theme` is not a light-theme editor test.
- A global Diff view preference also reaches plain-folder compatibility rows;
  their synthetic workspace identity is not Git capability. Keep their source
  editor available. Porcelain staged additions also do not prove a new file in
  the All comparison: a re-add can exactly restore its base. Only untracked
  files need a synthetic absent baseline. Both are real-browser regressions.
- The requested product contract supersedes the source-fallback behavior in
  `file-pill-source-fallback.md`: diff pills now always retain the Changes
  destination, including empty comparisons. Ordinary source links still open
  Files. Footer file rows publish the clicked path and explicit recorded turn
  together. Preserve the previous nested-path, rename and draft safeguards.
  Encoded in navigation unit suites and tool/turn browser smoke scenarios.
