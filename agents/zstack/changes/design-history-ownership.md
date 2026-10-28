# Keep Design history focused, ordered and separate from authority

- Symptom: native menu Undo bypassed the canvas; frame movement and inspector
  values waited for persistence; a predicted inverse could become the next
  save's baseline; page and theme edits had no matching workspace history.
- Cause: native menu roles and a global renderer key listener disagreed about
  focus, the inverse journal held only runtime generations, and prediction
  shared state with confirmed adoption. A directory with an identical catalog
  could also reuse an earlier session's journal.
- Rule: route native and keyboard history through an exact active focus owner;
  leave native text history intact. Keep speculative inverse pixels and values
  separate from confirmed snapshots, navigation and save baselines. Normalize
  legacy catalog shapes before comparison. Fence every queued step by directory
  lifetime, and charge retained payloads through pending callbacks as well as
  visible stores. Capture catalog restore points from the read that authorizes
  the write, and bound checkpoint collection before retaining a whole page.
- Encoded in native menu/IPC, history-command/lane/presentation, page-history,
  workspace-page and real runtime-history regressions. These hold replies across
  edit/Undo/Redo, replacement, hidden retirement and rejection; the page smoke
  checks real Layers/canvas/inspector consumers before releasing engine history.
  The theme CAS test rejects a stale merge instead of overwriting native edits.
  `design-history-focus-owner.json` replays the escaped native-menu bypass.
- Measurement: frozen production artifacts compare input-to-DOM changes, with
  element and inspector latency reported separately. A fresh dev server avoids
  duplicate module instances after shared-tree HMR. Neither proves native macOS
  menu behavior or compositor latency; those need platform qualification.
