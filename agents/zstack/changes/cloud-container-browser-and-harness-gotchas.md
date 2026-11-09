# Cloud containers: browser build, module instances and deep evaluate results

Target: `gotchas.md` (browser and harness section).

- **Browser build.** The repository's `@playwright/test` expects a Chromium
  build the cloud container may not ship (1.59.1 wants 1217; the container had
  1243), and `playwright install` is not allowed there. Point
  `PLAYWRIGHT_BROWSERS_PATH` at a scratch directory holding
  `chromium-<wanted>` and `chromium_headless_shell-<wanted>` symlinks to the
  installed builds; Chromium-backed Vitest and ui-smoke suites then run.
- **One module graph.** A `tsx` script written as `.mts` (top-level `await`)
  that imports engine modules got its own instance of
  `directory-registry.ts`, so `primeDesignDirectoryName` never reached
  `render-preparation.ts` and every linked stylesheet silently resolved
  against the default `Zeros Design/`. Write engine harness scripts as CJS
  `.ts` with an async `main()`.
- **Deep results.** `page.evaluate` cannot return an object nested ~130
  levels deep: the call fails with "Execution context was destroyed". A 64-level
  Design layer tree crosses the frame's `MessagePort` fine; summarize such
  snapshots inside the page before returning them.
- **Shard 2 dependencies.** `ui-smoke-chat-titles` loads `hono` from
  `apps/control-plane`, which the root install skips. Run
  `pnpm --dir apps/control-plane install --frozen-lockfile` (CI's command)
  before shard 2.

Encoded elsewhere: the Layers depth smoke fixture now derives its depth from
`DESIGN_RUNTIME_TREE_DEPTH_LIMIT`, after a hard-coded 40-level fixture went
stale when the limit moved from 32 to 64 — adjacent Vitest runs never load
ui-smoke scripts, so run the smoke shards for runtime limit changes.
