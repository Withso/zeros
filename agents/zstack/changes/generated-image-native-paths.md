# Qualify native image recovery at the file and transcript boundaries

- Symptom: attachment-store image results no longer carried inline previews.
  Cause: the provider returned an opaque file ID while the saved image remained
  on the agent's machine. Rule: recover only a bounded, verified native image
  where the agent runs, then persist provider-neutral bytes. The worker driver
  parity test reopens stored history to prove the preview survives reload.
- Native filesystem names are not resource URIs. Preserve literal percent
  escapes in source pills, and check the saved path's original spelling before
  normalization can erase a missing or symlinked parent. The mirrored desktop
  and worker generated-image tests cover parent traversal, leaf/parent symlinks
  and a swap-and-restore at the real file open; renderer tests cover literal
  source names and workspace-contained navigation.
- Optional media must not hold up turn settlement. Hold a resolver in tests,
  deliver other items and terminal events, then release it across replay, Stop
  and turn replacement. Assert the exact row content and unchanged lifecycle.
  Keep a real-I/O fixture as well as that seam; native ESM namespace exports
  need a configurable module mock before spying on a file operation.
- Removing empty Codex metadata must not hide other providers' structured
  image results or a native partial-image failure. Suppress only the known
  empty field shape; the renderer regression retains both useful siblings.
- Encoded in both Codex `generated-image.test.ts` suites, worker
  `parity.test.ts`, renderer `tool-details.test.ts`, and
  `ui-smoke-generated-images.mjs` through the Codex transcript smoke. Browser
  checks exercise Local, organization-local and cloud source pills, owner
  switching, failed decode/replacement and hidden-row inertness in both themes.
