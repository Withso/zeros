# Document previews and attachment groups

- Images and videos loaded in development but were blank in the installed app
  → Vite's renderer meta CSP omitted the native media scheme allowed by the
  Electron response header → qualify native previews under both policies
  → `renderer-media-csp.test.ts` and `smoke-file-media-electron.mjs --packaged`.
- PDFs appeared as encoded text → document extensions fell through the text
  heuristic → route documents through bounded, authorized file metadata/ranges
  in both readers → Local `file-media-stream.test.ts` and worker `files.test.ts`.
- Replacing a video's source could erase its replacement → the old layout
  cleanup ran after React updated the same video node → bind the decoder node
  to source identity → `runVideoSourceRefreshSmoke` in `ui-smoke-file-media.mjs`.
- Leaving extraction kept a busy menu, and removing a video retained its decoder
  → cancellation retired refs without resetting UI or observing editor removal
  → cancel from both surface and document lifetime, then clear operation state
  → held-decoder cases in `ui-smoke-attachment-groups.mjs`.
- Container metadata did not bound actual Word expansion → compressed bytes can
  disagree with declared sizes → validate local entries and bounded streaming
  expansion before library allocation → `document-preview-source.test.ts`.
- A single visible pill could hide lost members after restore → group metadata
  crosses editor, clipboard, source retention, message serialization and Files
  navigation → keep independent file ownership and test each boundary
  → attachment-group unit tests and browser reload/sent-message checks.
- An edited group's later members were treated as unchanged → pristine-edit
  comparison inspected only the primary attachment → compare every member's
  durable identity and order → `edit-draft-preservation.test.ts`.
- A screenshot captured an empty Word frame during navigation → a mounted iframe
  did not prove document paint → wait for readable frame content before capture
  → document and group browser screenshot assertions.
