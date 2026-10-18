# Live agent edits on the Design canvas

- Symptom: an agent's saved Design step could stay invisible until a later
  event. Cause: the engine shared one in-flight aggregate snapshot read per
  workspace, so a request made after a watcher-observed save could join a read
  that began before it; in the renderer, a frame-ready audit reconcile read the
  aggregate directly and published it with `setData`, clearing a newer
  invalidation. Rule: a shared read joins only flights that started in the
  current change epoch (fence on observation, before any debounce), and a
  direct read never publishes over a newer invalidation or publication. Encoded
  in `engine/design/snapshot-epoch.ts`, `service.test.ts` ("never answers a read
  requested after an observed source change"), `watch.test.ts` ("fences
  in-flight Design snapshot reads") and `design-workspace-cache.test.ts`
  (cases `design-snapshot-flight-joins-pre-save-read`,
  `design-audit-read-publishes-over-invalidation`).
- Symptom: packaged builds showed agent saves 0.9–1.6 s late. Cause: the
  compiled engine stat-polls worktrees at 1.5 s. Rule: a completed provider
  edit tool call for a Design path refreshes that workspace's canvas directly
  (`engine/design/agent-drafts.ts`); measure with clock readings before tuning
  debounces (`docs/design-mode-roadmap.md`, Native edit and refresh behavior).
- Symptom: the seeded `@layer reset` beat Tailwind utilities in every frame
  with an imported Tailwind source. Cause: imported sources are inserted first
  in head, so their layer list is declared before the reset; a later-declared
  layer wins. Rule: order engine-seeded layers explicitly before imported ones
  and assert computed styles in a real browser, not markup order (case
  `design-reset-layer-outranks-utilities`).
- Verification: `pnpm check:ui` also scans engine and renderer tests and
  harnesses; use named colors in fixtures. `scripts/ui-smoke/**` is a
  CI-definition path (owner merge), so add browser checks as a module called
  from an existing registered scenario. The official smoke runner stops at the
  first crash; to reach later scenarios when an unrelated scenario fails on the
  clean base too, run `runSmokeScenarios` with an injected `loadModule` that
  stubs only those run functions, and prove the base failure. Do not edit
  renderer files while a smoke run's Vite server is live: hot reload mixes
  states and produces false failures.
- Design frame runtime capabilities are validated as a closed set: a host
  rejects a ready payload naming any method it does not know. Adding a
  runtime method is therefore a breaking change for older desktops paired
  with newer engines (cloud VMs upgrade independently). Rule: a new runtime
  method is opt-in — the host lists it in the handshake's `features`, and the
  runtime advertises and accepts it only then (`DESIGN_RUNTIME_OPT_IN_METHODS`,
  `previewStylesheet`). Encoded in
  `design-runtime-stylesheet-preview.test.ts` and the bridge handshake test.
- Packaged engines must never arm a native file watcher (Bun's compiled
  runtime deadlocks once FSEvents is armed). Faster feedback comes from
  stat-polling only what a Design tab shows (style-build presence plus the
  directory the canvas last read), bounded in files, plus an immediate check
  when an agent tool that may write finishes (`engine/design/change-poller.ts`).
- Before building a provider's live preview, pin what its SDK actually
  delivers: Codex sends a whole patch at `item/started` (no deltas), and
  Cursor's SDK 1.0.37 drops edit content until after the write. Read
  normalized session updates first; add an adapter hook only for data the
  updates do not already carry.
