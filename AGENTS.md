# Zeros agent instructions

These instructions apply to the entire repository.

> **On `docs/`:** everything under `docs/` is local-only working notes. It is
> gitignored and is **not** present in a public clone, so the `docs/…`
> references below resolve only inside a maintainer's working tree. Each rule
> here is written to stand on its own without them — if a doc is missing, the
> rule still applies as stated.

- Read and follow [RULES.md](RULES.md) for every change.
- For renderer state, navigation, data fetching, tabs, panels, lists, or loading UI, also read and follow `docs/ui-interaction-performance.md` when it is present locally; the performance rules below are the binding summary either way.
- Treat bridge/native/remote reads as keyed server state. Share requests, retain the last confirmed exact-key snapshot while revalidating, and never clear usable data merely because a refresh started.
- Compute All, Uncommitted, Staged, and Unstaged rows/counts from their own Git comparisons; porcelain status only enriches them. The Changes badge is the All Changes total (an `AD` path is 0/0/1/1 respectively).
- A target-branch picker updates metadata only. History rewriting (rebase/merge/autostash) must be a separate explicit action.
- A navigation action must publish route and destination identity atomically. Do not use a later effect to repair a visibly incomplete selection.
- Every durable selection must be keyed by its semantic owner (app, repository, workspace, or tab), restored synchronously on the destination's first render, bounded, validated, and pruned when its owner is removed. Modal/draft-only state stays ephemeral.
- Owner deletion must include normalized descendant cwd keys without crossing into a separately registered, more-specific nested owner.
- Warm likely destinations on pointer/focus intent. The click handler itself must not await data.
- Preserve expensive UI only with an explicit bound and teardown behavior. Hidden retained surfaces must be inert and must gate active-only effects, shortcuts, focus, and polling.
- Keep selector and collection references stable. Do not pass fresh objects through hot Zustand selectors or rematerialize unchanged historical rows/turns.
- Do not add a fade, skeleton, spinner, or timeout to conceal a data waterfall. Fix the waterfall first; a delayed busy indicator is only for a genuine cold load.
- Performance-sensitive changes require exact-key/race tests plus `pnpm typecheck:app`, targeted Vitest coverage, `pnpm lint`, `pnpm check:ui`, and `pnpm build:ui` before handoff.
- Test WHILE developing, not only at handoff: after each meaningful edit, run the Vitest suites adjacent to the files you touched (`pnpm exec vitest run <dir-or-file>` — every nearby `__tests__/` dir is in scope), because a fix in one module routinely breaks a sibling contract. Before handoff, run the full local gate CI runs: `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`, `pnpm test:git`, plus every `check:*` script your change could affect (preload allowlist for IPC changes, migrations for db changes, secrets always). Touching `.github/workflows/**` also requires `pnpm check:actions` — that runs the same pinned actionlint (incl. shellcheck over `run:` blocks) that `lint-ci.yml` runs, and it is the ONLY local gate that reads the workflows at all; without it a broken workflow is discoverable only by pushing.
- Composer / overlay / focus / popover changes additionally require `pnpm test:ui-smoke` (real-browser interaction contract — unit tests structurally cannot catch event-timing races such as a capture listener racing Radix's open/focus sequence). Engine lifecycle changes (electron/sidecar.ts, spawn/health/watchdog) require `pnpm smoke:engine` on macOS.
- Backend (backend/) changes require `pnpm test:backend` and `cd backend && pnpm typecheck` before handoff. The control plane has no manual QA pass behind it, so a red backend test is a release blocker, not a follow-up.
- When fixing a bug, first write the failing test (or smoke-harness assertion) that reproduces it, then fix it, then keep the test. A bug without a regression test will come back.
- Internal-only features (Settings → Internal) must gate every runtime surface on `useInternalFeatureActive(...)` — the account allowlist AND the flag, never the raw flag alone — and attach hotkey listeners only while that gate holds. A flag alone is a UI-level hide, not an access control. They are separate from Experimental (user-visible opt-ins) and from PostHog flags (not used for this).
