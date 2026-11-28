# Devin handoff: renderer harness (never merge)

## What survived

The real-renderer harness behind the fixture-backed Settings screenshots for #1320 and #1321 is lost. It lived only in `/tmp`, and the VM restart wiped it:

- `/tmp/pr1-renderer-run/` (#1320 at 4a8d196e, 9e328b6, 42b9da8b)
- `/tmp/pr2-test/` (#1321 at 2b07ca9e)
- `/tmp/pr2-review-3e56b77/` (#1321 at 3e56b77c)

No copy exists anywhere else. This branch holds:

- `prototype/`: the separate offline design prototype from before #1320. It is a Vite and React mock with Playwright `verify-*.cjs` checks, not the production renderer.
- `prototype/pr1-macos-dependencies.md` and `prototype/pr2-renderer-environment.md`: the environment notes.

Neither directory contains credentials. A pattern scan found no token, key or JWT shapes.

## How the lost harness worked (to rebuild it)

Each round had these files:

| File | Role |
|---|---|
| `server.mjs` | Isolated Vite server |
| `fixture-review.tsx` | Production `SettingsPage` mount, a caller-switch helper and, for #1320, the shell-level `GithubAppNotifications` |
| `init.cjs` | Synthetic account, native IPC, credential and mutable Cloud responses, injected with `context.addInitScript` |
| `tests.cjs` | Playwright scenario runner. It takes scenario names as arguments and writes the screenshots itself. |
| `show.cjs` | Headed Chrome over CDP, for recording |

The server settings:

- Vite root is the repository root, with `vite.config.ts`, `mode: "ui-smoke"`, HMR off and its own `cacheDir`. A shared cache returned 403s.
- Entry: `apps/desktop/src/renderer/harnesses/harness-repo-settings.html`.
- A Vite `transform` replaced `harness-repo-settings.tsx` in memory with `fixture-review.tsx`. No tracked file was edited.
- A second `transform` rewrote the `cloudAccountRequest` import in these files to call `window.qaCloud`, which `init.cjs` supplied:
  - `apps/desktop/src/renderer/platform/cloud-github-connection.ts`
  - `apps/desktop/src/renderer/platform/cloud-github-levels.ts`

Ports and URLs:

| Round | Vite port | CDP port |
|---|---|---|
| #1320 | 32018 | Not recorded |
| #1321 at 2b07ca9e | 32122 | 32302 |
| #1321 at 3e56b77c | 32133 | 32313 |

The URL was `http://127.0.0.1:<port>/apps/desktop/src/renderer/harnesses/harness-repo-settings.html`. The legacy-rail case added `?feature-off=unified-workspaces`.

Playwright settings:

- Package: `playwright-core@1.59.1` from `node_modules/.pnpm`.
- Browser: `channel: 'chrome'`, the installed Google Chrome.
- Viewport 1280×1000 with reduced motion.
- Network routing allowed only the Vite origin.
- Fixtures used synthetic data only, such as the literal `synthetic-test-token`.

Commands for the #1321 round at 3e56b77c:

```sh
node server.mjs
node tests.cjs member pat-saved pat-missing no-app no-app-selected owner admin \
  personal-device org-local personal-cloud solo absent legacy > results.log 2>&1
grep '^PASS' results.log
node show.cjs   # headed recording
```

The round at 2b07ca9e used the scenarios `owner admin member personal-device org-local personal-cloud solo absent legacy edges pat-saved pat-missing`.

The exact file names and commands for the #1320 rounds were not kept.

## Tracked smoke that survives

```sh
pnpm test:ui-smoke --scenario=repo-settings --scenario=core-inline --scenario=cloud-github
```

This runs the committed Settings harness with its own synthetic native and Cloud responses.
