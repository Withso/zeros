# Motion must read the authored frame source

- **Symptom:** a selected frame's inspector showed an existing animation, but
  its open timeline had zero tracks.
- **Cause:** the browser read HTML `<style>` blocks while Foundation projected
  keyframes only from CSS files. The main-frame smoke fixture supplied parsed
  keyframes directly, hiding that gap. The transaction adapter also rejected
  HTML keyframe targets, so a reader-only fix would still break Save.
- **Rule:** qualify existing animation flows from raw authored HTML/CSS through
  the production source reader and writer. Assert timeline tracks as well as
  animation metadata, and verify saved source, undo, and live generation
  adoption. Inline writes must preserve surrounding source and refuse ambiguous
  names or values that escape their style block.
- **Encoded:** `packages/design-web/src/__tests__/css.test.ts` and `api.test.ts`
  cover inline projection, surgical updates, source-relative URLs, refusal,
  exact undo/redo and document isolation. The frame Motion browser fixture now
  uses production parsing and mutation, and its smoke checks saved HTML and the
  effective runtime keyframe override. See eval `design-inline-motion`.
