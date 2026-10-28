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
- Saved image navigation lost its thumbnail → the new Files-link branch skipped
  the existing image source → preserve thumbnail loading and verify the click
  opens the original image → `runSavedImageAttachmentSmoke`.
- A screenshot captured an empty Word frame during navigation → a mounted iframe
  did not prove document paint → wait for readable frame content before capture
  → document and group browser screenshot assertions.
- Grouping hid the failing member's filename and upload error → the pill reduced
  per-file status to a boolean → preserve the first precise error and count
  additional failures without changing pill geometry → grouped upload smoke.
- Escape from Create's grouped preview lost composer focus → the preview saved
  a temporary menu item as its return target → open after the menu focus trap
  closes and restore the editor first → Create draft/reload browser smoke.
- PDF's optional native canvas made release licenses depend on the build host
  → the platform normalizer did not know the new dependency family → normalize
  to the shipped macOS target and test Linux/macOS/absent variants →
  `license-platforms.test.ts` and the generated inventory contract.
- Composer and history grouping worked while cloud Send rejected the message
  → both durable prompt schemas are strict and lacked the optional metadata
  → test the real send validator and independently deployed mirror, including
  legacy payloads and field bounds → cloud channel and contract-parity tests.
- Explicit extraction failed in the older composer smoke after upload completed
  → its saved-file fixture decoded every format as text, while automatic
  extraction had only used the selected Blob → model saved media responses as
  media and exercise extraction after publication → composer attachment smoke
  verifies the saved JPEG scene colors and timeline in one group.
