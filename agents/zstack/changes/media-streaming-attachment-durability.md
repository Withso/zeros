# Streaming media and attachment durability

- A valid Range parser still failed real seeking when an experiment shortened
  open-ended responses → Chromium interpreted the response end as EOF → preserve
  the requested HTTP range and bound packets inside its stream → indexed 200 MB
  playback/seek/download in `scripts/smoke-file-media-electron.mjs`.
- Rapid cancelled seeks could start more upstream reads than the stream cap →
  ending HTTP did not cancel already-sent workspace RPCs → retain each RPC's
  slot through reply/timeout and let bounded, cancellable waiters apply
  backpressure → `file-media-stream.test.ts`.
- Completing one destination removed a source needed by a queued destination →
  the queue retained the mutable composer object → capture and retain a separate
  source snapshot before waiting → `file-attachment-transfer.test.ts` and the
  real IndexedDB ownership cases in `ui-smoke-attachment-persistence.mjs`.
- An idle report could race an upload while persistence flushed → the final
  idle recheck omitted transfers → count uploads at admission, periodic busy
  reporting and the post-flush recheck; abort them before Stop ACK →
  `worker-attachments.test.ts`.
- Completed ignored attachments disappeared after VM replacement → generic
  checkpoint capture skipped ignored directories and files over 1 MiB → archive
  recognized regular attachment files explicitly, preserving the existing
  combined cap and refusing symlink restore parents → `checkpoint.test.ts`,
  `checkpoint-attachment-contract.test.ts` and the checkpoint eval case.
  Upload completion also refuses redirected attachment records, and the private
  partial-upload directory stays out of checkpoints (`attachments.test.ts`).
- Oversized pending media could retain a Blob despite never being previewable →
  its bytes were excluded from the optional preview budget → keep only size
  metadata above the preview cap → `pending-file-preview.test.ts`.
- A transient temporary-storage error made every upload Retry fail → the
  rejected initialization promise stayed cached → retire failed initialization
  without replacing a concurrent successor → cloud `attachments.test.ts`.
- Saved-image hovers assumed every image read contained a data URL → streaming
  changed the shared cache to metadata → open a visible-only native lease below
  the hover cap and verify source retirement and zero oversized reads in the
  native smoke. Composer undo now verifies exact saved paths, ownership and
  original bytes after upload instead of requiring an unnecessary source Blob.
- A queued range event could arrive after its renderer source closed → no
  handler meant its native budget slot stayed occupied until timeout → reply
  with an error immediately → renderer `platform/__tests__/file-media.test.ts`.
- Pending SVG previews failed when picker MIME said text/plain → object URLs
  kept the incorrect MIME until upload completed → apply the saved-file MIME
  policy through a shared-byte Blob slice → pending preview unit tests and
  Local/organization/cloud browser regressions.
- Exact-runtime ownership exposed incomplete browser bridges hidden by unchecked
  casts → audit object-shaped request/on fixtures regardless of whether they use
  `as never` or a RuntimeClient cast, and supply the real execution identity;
  inherited WorkspaceRuntimeClient fixtures already own it → browser harness
  corrections and the full UI smoke, without weakening production fencing.
- Native range tests passed on Node 24 but failed on CI's Node 22 → one promise
  microtask did not establish that ReadableStream had requested the next packet
  → await the observed request count before inspecting, replying or cancelling
  → Electron `file-media-stream.test.ts`, reproduced on Node 22.23.3.
- CodeQL flagged a replacement-file fixture that wrote through a checked path
  → renaming the old file does not make a later pathname write exclusive →
  create the replacement exclusively and write through its held descriptor
  → engine `file-media-stream.test.ts`, preserving the replacement rejection.

The verification skill now requires real native range/seek evidence and
checkpoint/source-owner tests before recovery reclamation. Linux Electron
request-byte budgets remain separate from Mac CPU/GPU/memory qualification.
