# Open tool sources outside the Changes comparison

- Symptom: an Edit pill for an ignored `.context` file stayed on “No current
  changes” even though its source was readable. Cause: explicit navigation
  correctly prevented automatic selection of an unrelated diff, but never
  resolved an absent target into Files. Rule: distinguish the requested file
  from its preferred presentation; a confirmed exact Branch list decides
  whether Changes can display it, and an absent target opens its source.
- Preserve cold requests until their comparison succeeds. Consume the request
  and open the Files destination in one reducer transaction, guarded by its
  workspace, active tab and requested path. Returning to Changes must not
  redirect again. Failed reads and hidden surfaces cannot initiate fallback.
- Git paths belong to the repository root; Files paths belong to the chat's
  cwd. Test nested Local and cloud folders, exact comparison bases, renamed
  paths, literal image names, and reused tabs with editor revisions. An exact
  current path takes precedence over another file's old rename path.
- A dirty legacy Changes editor also makes its preferred destination
  unavailable. Open the other source with the chat-relative path and preserve
  the draft's comparison; passing its Git-relative path to Files duplicated
  nested folder prefixes. Keep this branch covered even with a cold cache.
- Encoded in `file-pill-navigation.test.ts`, `requested-changes-file.test.ts`,
  `changes-selection.test.ts` and `ui-smoke-file-pill-navigation.mjs`. The
  browser regression uses real tool controls, Changes reads and Files content,
  with a held Git response and a later navigation. Its fixture returns the
  complete code-review response identity so unrelated errors cannot hide in
  screenshot evidence.
