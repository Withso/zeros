# Verification gotchas

Read this when a local check fails in a way your diff does not explain. Each
entry is an environment fact that has already cost a loop. First rule out
whether the environment changed under you (PATH tools, database encoding, a
disk precondition), then rerun the failing files on a clean checkout of your
base commit. A base worktree at another path changes path- and Git-dependent
suites: for an exact comparison, swap only your changed files back to the base
revision in the same checkout and compare failing test names.

## Shell and Git

- `cd X && (a) & (b) & wait` runs only the first job in X. Put the `cd` inside
  each job (`(cd X && a) & (cd X && b) & wait`) and record which tree produced
  each result.
- A pipe through `sed` or `grep` buffers output. Use `sed -u` or
  `--line-buffered` when a later step needs a line at once.
- Print probed values with `printf '%s\n'`, not `echo`: shells disagree on
  backslashes. Child output that a parent parses must be the only output; use
  `pnpm --silent` or a receipt file.
- Bash can read its rc files for socket stdin even without `-i`. Real-shell
  fixtures pass `--noprofile --norc` (zsh: `-f`) and await the shell's exit
  before removing its home.
- `git update-index` needs `--stdin` as its last argument. Give every script
  fallback a test case that only the primary path passes.
- Trimming `git status --porcelain` drops the first line's leading space.
  Assert with `git diff --name-only` (and `--cached`).
- A missing-object fixture must start from a source that never had the object.
  Assert that `git cat-file -e` fails before relying on it.
- In a sparse checkout, `git checkout -b` and `-m` overwrite an untracked file
  at a path the target adds and only warn; `git read-tree <tree>` clears
  skip-worktree bits. Restore an index with `git reset -q <tree> -- .`.
- Never run `git stash` where another agent shares the repository's worktrees:
  the stash list is shared. After resolving conflicts, run `git diff --check`
  and search for `^<<<<<<< ` before continuing.
- `pnpm check:runtime-skew` needs full history and Git 2.44 or later
  (`--no-lazy-fetch`); a shallow clone or Git 2.43 reports
  `runtime_skew_source_unavailable`.

## Node, Vitest and TypeScript

- `pnpm typecheck` keeps incremental state in
  `node_modules/.cache/zeros-typecheck`. Confirm an error in an untouched file
  with `pnpm exec tsgo --noEmit -p tsconfig.typecheck.json --incremental false`.
  `typecheck:app` and `typecheck:electron` run TypeScript 7 (`tsgo`); editors,
  ESLint and compiler-API scripts stay on `typescript` 5.x, so code must compile
  under both. Re-read state through a method after an `await` instead of a
  narrowed property.
- Outside CI, Vitest reuses modules from `node_modules/.experimental-vitest-cache`.
  Clear it with `pnpm exec vitest --clearCache` when a rerun disagrees with a
  fresh checkout.
- Forward Vitest path filters directly through a pnpm script: an extra `--`
  runs the whole root suite. `mergeConfig` concatenates `test.include`. Confirm
  the matched file count before calling a run adjacent.
- Run protocol suites from the repository root, for example
  `timeout 900 pnpm exec vitest run packages/protocol/src/__tests__/cloud-v2-relay.test.ts`;
  package-local Vitest may find no tests, which is unverified. Release tests use
  `--config scripts/release/vitest.config.ts`.
- Do not return a mock from `beforeEach`: Vitest treats it as a cleanup callback.
  Run stream and lifecycle tests on CI's Node major too; Node 22 and 24 differ.
- Inside an agent chat, the provider's environment (for example
  `CLAUDE_CONFIG_DIR`) reaches engine suites. Rerun them with `env -i` (HOME,
  USER, SHELL, LANG and a plain PATH) and a real `TMPDIR`.
- On macOS the default `TMPDIR` is reached through the `/var` symlink, so
  path-safety suites fail with `*_unsafe` or "not canonical". Set `TMPDIR` under
  `/private/tmp`.
- Typecheck and tests do not load bundle entries. After removing an engine entry
  point, run `pnpm build:engine` and `pnpm electron:compile`.
- Vitest's Vite environment supplies `import.meta.env` and similar; when desktop
  code is reused by a Node harness, import the harness's real entry point cold.
  Native ESM bindings can bypass a spy on a built-in module's default export.
- Darwin's `O_NOFOLLOW` and `O_NOFOLLOW_ANY` are mutually exclusive (`EINVAL`);
  a Linux pass cannot prove Darwin open flags.

## Dependencies and worktrees

- Setup must hydrate three dependency graphs: `sh scripts/dev-environment/hook.sh setup`
  (or `node scripts/dev-environment/dependencies.mjs --install`). Playwright-backed
  suites also need `npx playwright install chromium`.
- A worktree whose `node_modules` links into another checkout resolves that
  checkout's `@zeros/*` packages, and `pnpm install` there rewrites the other
  checkout's links. Give each worktree a real install
  (`CI=true pnpm install --offline --frozen-lockfile`) and check
  `readlink -f node_modules/@zeros/protocol`.
- After integrating a lockfile change, or after the host fast-forwards the
  workspace branch, run `pnpm install --frozen-lockfile` (and the control
  plane's): the old install otherwise surfaces as type errors in files you never
  touched, and `apps/cloud-worker/node_modules` keeps the old versions. An install
  with `--ignore-scripts` leaves `node-pty` unbuilt:
  `pnpm --dir apps/cloud-worker rebuild node-pty`.
- Qualify a frozen patch on its stated base in a separate worktree or projection,
  with dependency links bound to that tree; run `pnpm --dir apps/control-plane install`
  there too. Record the patch SHA-256 beside its evidence.
- Fresh Amazon Linux hosts need `make` and `gcc-c++` for native installs, and
  `/usr/bin/nc` for the SSH transport tests.
- `apps/marketing` is both a root workspace member and a standalone Cloudflare
  project. After changing its manifest, run `pnpm install --lockfile-only` at the
  root, then `pnpm exec pnpm --dir apps/marketing install --ignore-workspace --lockfile-only`.

## Permissions

- Run `pnpm test:git` under CI's `umask 022`. This sandbox defaults to 0002 and
  the Dev environment suites then refuse group-writable state. An executable
  checked out as 0775 stays wrong after changing the umask; restore 0755.
- This sandbox's user holds every capability, `CAP_DAC_OVERRIDE` included, so
  `chmod 000` does not make a file unreadable. Fail the reader itself (for
  example a `PATH` wrapper) or drop all capability sets.
- Harness input files must be regular files you own, mode 0600 and small.

## PostgreSQL

- Database-backed control-plane suites skip without `TEST_DATABASE_URL`. Use a
  TCP URL (`postgres://postgres:postgres@localhost:<port>/postgres`); the
  validators refuse `?host=` socket overrides.
- Give each concurrent agent its own PostgreSQL 18 server: migration 0004 creates
  a cluster-wide role with a check-then-create race. On Amazon Linux install
  `postgresql18-server` and `postgresql18-contrib` (migration 0001 needs
  `citext`); without sudo, signature-verified PGDG packages unpacked with
  `dpkg -x` work. A custom cluster also needs the `postgres` role.
- Never point an ad-hoc run at a database a running suite uses: global setup
  resets the schema. Rerun an overlapping failure alone first.
- Parallel schema resets on one server share its lock table. Size
  `max_locks_per_transaction` before sharding; `out of shared memory` at reset
  is a fixture failure. Start the server outside the verification-slot lock so
  it cannot inherit and hold that descriptor.
- CI's PostgreSQL runs in a service container: a test cannot signal or inspect
  its processes. Reproduce connection races at the protocol layer, such as an
  in-test TCP relay, and assert that the window was open.
- PostgreSQL timestamps keep microseconds that JavaScript `Date` drops.
  Compare round-tripped timestamp tokens at the token's precision.
- A clock in a `SELECT … FOR UPDATE` target list can be evaluated before the
  row-lock wait; read the clock outside the locked read. A failed `ROLLBACK`
  does not release a dedicated client: release or discard it in an inner
  `finally`.
- `CloudV2Store` prefixes every word of its RETURNING column constants with `w.`,
  so a cast such as `::text` there breaks every claim.
- A new advisory lock needs one `/* lock_purpose='…' */` tag registered in
  `ADVISORY_LOCK_PURPOSES`; only `src/database-lock-tags.test.ts` checks it.
  Added columns also need the control plane's `src/migrations.test.ts`.

## Browser, Vite and UI smoke

- Vite refuses private directories such as `.context`. Put a browser
  qualification checkout beside the main checkout instead.
- Root Vitest starts Vite servers on the same dependency cache as UI smoke. Run
  them in sequence, or in separate checkouts with separate `cacheDir`s; do not
  install dependencies or edit renderer files during a smoke run. Stale-module
  504s are failed runs.
- `pnpm test:ui-smoke` stops at the first scenario that throws. Confirm that
  failure on the base commit, then run the rest from an untracked copy of
  `scripts/` without it (registry and partition) and delete the copy.
  `scripts/ui-smoke/**` is a CI-definition path: add checks as modules called
  from an existing registered scenario.
- Playwright's `waitForFunction` treats a returned Promise as truthy; poll an
  awaited `page.evaluate`. After a hot update, a bare dynamic import can load a
  second store instance; inspect the stores the fixture exposes.
- Playwright init scripts also run inside sandboxed Design frames: seed
  `localStorage` only in the top-level window.
- Capture dimensions and visible text do not prove pixel fidelity. Decode the
  PNG and compare pixels outside short content, including transparency.
- Native IPC clones replies; a browser fixture that returns one mutable snapshot
  lets React bail out and hides updates. Simulated browser clocks survive
  navigation, and a fixture reset must leave the old document before clearing
  storage, or its unload handlers restore the old state.
- Native navigation drivers resolve a workspace's actual tab ID by type and
  assert activation; adding an existing tab does not activate it.

## Process, CI and delivery

- Long local batches die with the agent session unless detached. Run them with
  `setsid nohup` under a shared slot and append results to a summary file.
- Never list full process command lines or environments: agent launch arguments
  can carry session credentials. Use PIDs, names and working directories.
- pnpm installs share blocks through the store: measure reclaimed disk with
  `df`, and prune only your own scratch.
- Run merge tooling from a checkout at current `origin/main`. A held
  runtime-updater PR qualifies only when its tested merge commit's base parent
  is current `main`: merge `main` into it (never force-push the bot branch),
  rerun CI, and land other PRs after it.
- Adding or renaming a file under an audited directory such as `docs/` needs the
  expected list in `scripts/__tests__/repository-layout.test.ts`; `pnpm ci:plan`
  only selects the lane.
- The required PR secret scan reads every commit in the range. Rewrite the
  branch so no commit carries the value instead of adding a fix commit.
- Qualify a CLI by running the exact command advertised to agents from a task
  workspace (Node source, Bun source and the compiled executable); calling its
  handler misses dropped source entries and loaders.
- `Remaining full suite / tests-ui-smoke (2/3)` often runs about 20 minutes; it
  is not hung before about 30. Recurring infrastructure failures: Chromium
  `page.screenshot` "Unable to capture screenshot", a ui-smoke
  `design-frame-recovery` wait timeout, and `nodejs.org` ECONNRESET while
  better-sqlite3 installs. Rerun only the failed jobs once the run completes,
  and keep the original failure in the receipt.
- This token cannot read the code-scanning API (403). Gate merges on the
  `CodeQL` check run's title, "No new alerts in code changed by this pull
  request". Otherwise read its annotations (`gh api
  repos/Withso/zeros/check-runs/<id>/annotations`). A moved but unchanged line
  can report as new, so confirm it against the base before arming.
- Alpha's clock differs from this host by about 0.5 s. Compare time windows with
  documented bounds, never exact values.
