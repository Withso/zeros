# Files media preview boundaries

- PNG copying worked in a permissive browser but would fail in the packaged
  app → `connect-src` excludes `data:`, while `img-src` permits it → test new
  clipboard paths under the actual CSP and decode already-loaded bytes without
  fetch → `file-media-actions.test.ts` and the Files media browser harness.
- A controlled video seek range returned to its old value after pause/hide →
  relying on asynchronous `timeupdate` let React restore the old input between
  native input/change events → publish the requested seek value synchronously
  and then reconcile native media events → the pause, hide, return and keyboard
  seek case in `scripts/ui-smoke-file-media.mjs`.
- A clipboard test read the previous image before encoding finished → the
  browser click had completed, but the asynchronous write had not → wait on
  the copy control's completion before inspecting clipboard pixels → the SVG
  conversion case in the same browser suite.
- Cloud's count-only file cache could retain many megabytes per visited media
  file → the prior byte budget applied only to Local reads → share the weight
  accounting while keeping separate placement budgets → image/video pressure
  cases for both placements in `workspace-file-data-cache.test.ts`.
