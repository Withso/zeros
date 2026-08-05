# Zeros agent instructions

These instructions apply to the entire repository.

> **On `docs/`:** everything under `docs/` is working notes — scratch analyses,
> audits and plans, often superseded as fast as they are written. It is tracked
> (so the `docs/…` references below resolve in any clone), but treat it as a
> record of what was thought at the time, not as spec. Each rule here is
> written to stand on its own — if a doc is missing or stale, the rule still
> applies as stated.

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

## Cursor Cloud specific instructions

### Environment overview

This is a macOS Electron app (Zeros) with a backend control plane. The Cloud Agent VM runs Linux, so Electron-native features (app launch, `pnpm electron:dev`) cannot be tested here. The testable surface includes:

- **Renderer (Vite):** `pnpm dev` → http://localhost:5193 (serves the React renderer; shows auth gate without the desktop app)
- **Engine tests:** `pnpm test:git` (vitest, ~5000 tests covering engine/git/agents/transport/store/bridge)
- **Backend:** `cd backend && pnpm dev` (Hono on port 8080; requires Postgres via `DATABASE_URL`)
- **Backend tests:** `pnpm test:backend` (no DB required for unit-only; set `TEST_DATABASE_URL` for integration)
- **Lint / typecheck / build:** `pnpm lint`, `pnpm typecheck`, `pnpm build:ui`

### Critical gotchas

1. **GPG commit signing:** The Cloud Agent VM has `commit.gpgsign=true` globally. Engine tests create temp git repos and call `git commit`, which hangs if the signing key isn't in the ssh-agent. Run tests with signing disabled:
   ```bash
   GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pnpm test:git
   ```
2. **Backend is a separate pnpm root:** `backend/` has its own `pnpm-workspace.yaml` and lockfile. Always `cd backend && pnpm install` separately.
3. **Bun is required** by `electron:dev` and `electron:build` scripts. Installed at `~/.bun/bin/bun`; add to PATH with `export PATH="$HOME/.bun/bin:$PATH"`.
4. **Playwright browsers** are needed for `packages/core` design-runtime tests. Install with `pnpm exec playwright install chromium`.
5. **Git watcher tests** (`src/engine/git/__tests__/watch.test.ts`) are timing-sensitive and may flake in virtualized environments — not a code defect.
6. **`website/web-app`** is intentionally NOT a pnpm workspace member (uses npm + its own lockfile for Cloudflare Pages deployment).
7. **The app requires Auth0 sign-in** — the renderer cannot get past the login screen without access to the hosted auth tenant. UI development is verified via `pnpm dev` + `pnpm build:ui` rather than interactive use.
