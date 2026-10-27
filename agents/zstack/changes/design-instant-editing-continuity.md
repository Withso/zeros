# Design instant editing: presentation continuity and render work

- Symptom: Layers showed "Loading frame…" and the inspector emptied after
  every save, tab return or a frame's 10 s document retirement; nested frame
  creation reloaded the document; the inspector flashed "Nothing selected" or
  a minimal frame view on fast selections.
- Cause: presentation was tied to authority. Retirement wiped the runtime tree;
  revalidation published all frames unprepared; structural writes always
  navigated a new document; selection details were read after publication.
- Rule: keep the last confirmed exact-generation presentation (tree, root and
  recent readbacks) through retirement and revalidation, bounded by bytes, and
  keep writes engine-checked. Adopt structural edits in place only through a
  structured, validated twin of the exact source edit. Name a new selection
  from its tree at once; never hold another target's properties behind a
  timeout (AGENTS "do not hide a data waterfall behind a … timeout").
- Rule: intent warming must respect passive ownership. Booting editors for
  frames the pointer merely crosses swapped vectors for live HTML and kept an
  editor in an overview; warm only from explicit chrome (titles, Layers rows)
  and clear intent once its frame is selected.
- Rule: identity does not survive postMessage. Compare runtime payloads by
  content before publishing, or every structured clone re-renders the whole
  surface: equal revision, tree, warnings, root readback and viewport. Every
  runtime path that changes the tree without an observed mutation (insert
  previews and their cancellation) must advance the revision; a root-only
  comparison dropped a child drawn inside a nested container.
- Rule: optimistic predictions must order behind in-flight writes that will
  adopt on top of them. An Undo prediction painted while an edit was still
  saving became that edit's recorded baseline; predict inside the lane after
  pending edits land, in submission order (a later step waits behind an
  earlier deferred prediction), but keep consecutive history predictions
  immediate.
  Speeding up the UI exposed this race (pre-existing on main) in CI first.
- Rule: attribute React commits to store publications before optimizing
  (production profiling build, scheduled-updater identities); most frame-switch
  commits were equal state re-set by effects, closed panels and loading flags.
- Verification gotchas: a second Vite server started from a worktree whose
  `node_modules` is symlinked to the main checkout shares `node_modules/.vite`
  and can re-optimize dependencies under a running smoke (React "null
  useState"); never run two dev servers over one dependency cache. Ad-hoc
  smoke servers must run `vite --mode ui-smoke`
  (dependency pre-scan includes harness entries) or a smoke's dynamic
  `import()` of a store hits a second module instance; fixtures that
  string-patch runtime source must match structurally, not one exact list;
  run `test:git` under `umask 022`.
- Encoded in: `design-runtime-store.test.ts`, `design-layer-panel-rows.test.ts`,
  `design-runtime-insert.test.ts`, `design-frame-intent.test.ts`,
  `design-node-warming.test.ts`, and the frame-children, selection and
  playback UI smokes.
