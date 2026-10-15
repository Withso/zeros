# File-pill intent and restored attachments

- Symptom: a tool's basename lost its exact path, and hovering/clicking the
  disclosure could not independently preview or open the file.
  Cause: one button owned both disclosure and the visual file tag.
  Rule: keep disclosure and file navigation as sibling controls; attach hover
  content to the file control and retain its literal path separately from its
  label. Encoded in `file-pill-interactions.test.ts` and `ui-smoke/core-inline.mjs`.
- Symptom: restored composer pills could target a retired attachment location.
  Cause: transfer progress masked the stale persisted path during same-session
  tests. Rule: clear transient progress when testing a restored draft and resolve
  saved records by stable id before opening. Include the exact cwd in the cache
  key even when two directories share one cloud owner. Encoded in
  `attachment-pill-file.test.ts` and `ui-smoke-composer-editor.mjs`.
- Symptom: a clean file requested from a tool row switched to an unrelated
  change. Cause: automatic list reconciliation discarded explicit file intent.
  Rule: preserve that target until the user chooses another file/comparison;
  show its empty state only after a successful comparison read. Encoded in
  `changes-selection.test.ts` and the `changes-explicit-file-target` eval.
- Verification: cloud attachment fixtures need a confirmed ready lifecycle
  document. An unknown cloud lifecycle correctly keeps staging queued; tests
  must seed that document instead of weakening production provisioning guards.
- Symptom: a quick Edit-pill click reopened its diff over the next hover
  target. Cause: closing the card left a pending focus timer active. Rule:
  dismiss pending hover intent until a fresh pointer/focus event, including
  when the owning surface becomes inactive. Encoded in the image and diff
  cards and the tool/File browser smoke sequence.
- Symptom: a file named `constructor` acquired an image card. Cause: the
  extension lookup accepted inherited object properties. Rule: image-format
  registries accept only own keys; unknown names fall back to their MIME type.
  Encoded in `file-pill-interactions.test.ts`.
