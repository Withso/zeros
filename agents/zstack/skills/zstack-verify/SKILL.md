---
name: zstack-verify
description: "Choose and run the right checks for a Zeros change, Local and cloud: adjacent Vitest suites, required static gates, UI smoke, platform-only checks, and live Alpha verification with the zeros-dev harness. Includes evidence rules and known gotchas."
globs: "**"
---

# zstack-verify

## Pick checks from the diff

Always run the adjacent suites for the files you changed, then the static
gates: `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git` (filtered to the touched area), `pnpm check:secrets`.

| Touched | Also run |
|---|---|
| Renderer UI, styling or tokens | `pnpm check:ui`; after a token or contrast change, `pnpm design:docs` |
| Frames in `Zeros - Design/` | `design validate` and `design capture` from the frame context, then inspect the PNG. Add `--theme light` to capture Light; the default is the Dark theme. |
| Composer, overlay, focus or popover | `pnpm test:ui-smoke`. Label the PR `ci:ui-smoke`. |
| Performance-sensitive UI | exact-key and race tests, `pnpm build:ui` |
| Electron IPC or preload | `pnpm check:preload` and the relevant Electron tests |
| `apps/control-plane/` | `pnpm test:control-plane`, `pnpm --dir apps/control-plane typecheck` |
| `.github/workflows/` | `pnpm check:actions` (owner merge required) |
| Migrations, packaging, protocol or deploy paths | the matching `check:*` scripts in `package.json` |
| Runtime dependencies or packaged assets | `pnpm check:licenses` |
| Engine lifecycle | `pnpm smoke:engine`, on macOS only |
| Control-plane concurrency, locks or transactions | Label the PR `ci:control-plane-db`. PR CI is path-selected, and without the label the full CP database lane runs only after merge, where a timing race turns `main` red. |

CI's full root and control-plane suites are the authority. Locally, run the
adjacent suites plus the gates above; don't wait on a full local run before
handing off. Preview the CI lanes with `pnpm ci:plan`.

The selector can do this bookkeeping:

```sh
node scripts/zstack/verify.mjs plan --test path/to/adjacent.test.ts
node scripts/zstack/verify.mjs run --test path/to/adjacent.test.ts --execute --receipt /private/scratch/verify.json
```

Record `--mode single-session --agent <model>`, or `--mode master-subagents
--agent <model> --master <model>`, on the command. The selector uses the shared
CI registry; unknown CI command text is deferred, never executed as shell.
An incomplete diff or missing adjacent suite blocks execution. A source change
during verification invalidates the receipt. The local receipt is unsigned
engineering evidence; CI is still the merge authority.

`node scripts/zstack/verify.mjs local-ui` plans the existing Linux app driver.
Add `--execute --receipt <file>` to run it, optionally with `--shard 1/3`.
Remaining shards and macOS proof remain unverified. See `agents/zstack/tools.md`
for limits and the closed error codes.

## Live cloud checks on Alpha

For the canary, `node scripts/zstack/verify.mjs cloud-dispatch --source <sha>`
plans a dispatch of the existing main-only hourly workflow. Explicit execution
uses the existing automation identity; it reports `dispatch_requested`, never
a pass. Use `cloud-status --source <sha> --execute --receipt <file>` to observe
the newest completed trusted run at that exact source, including the executed
lifecycle and two-hour freshness limit. A newer active run does not erase
completed evidence. `cloud-health` delegates to zeros-dev's Alpha health check;
it cannot prove a workspace lifecycle. These commands use the task's existing
Alpha authorization and never copy model keys into the checkout.

Use the zeros-dev harness against the fixed Alpha fixture (`docs/zeros-dev.md`):

```sh
pnpm exec tsx scripts/zeros-dev/cli.ts login
pnpm exec tsx scripts/zeros-dev/cli.ts whoami
pnpm exec tsx scripts/zeros-dev/cli.ts computer build --wait
pnpm exec tsx scripts/zeros-dev/cli.ts repo ensure
pnpm exec tsx scripts/zeros-dev/cli.ts workspace create --wait
```

Then run `terminal run`, `workspace stop` and `workspace resume` with
`--run <id>`, and finish with `cleanup --run <id> --apply`.

- Agent prompts against real providers run in CI, where the dedicated test
  keys live. Trigger that workflow; never copy provider keys into `.env.agent`.
- Every live run leaves a signed receipt. Report the failing stage and its
  closed code, never raw provider output.
- A lifecycle run counts only once stop and resume both pass; create alone
  hid a resume loop.
- Scripted live runs stop at the first failed stage. Capture server-side
  state (database rows, control-plane logs, the failing attempt) before any
  cleanup; never chain cleanup unconditionally after a failure.

## Evidence rules

- Report counts, for example "adjacent 130/130 across 11 suites". Name what you
  did not run and why.
- A retry never relabels the original failure. Record both results.
- Every time in a record, plan or report comes from a clock read (`date -u`),
  never an estimate.
- Don't claim macOS-only checks from Linux.

## Gotchas already paid for

- A pipe through `sed`/`grep` buffers output. Use `sed -u` or
  `--line-buffered` when a later step needs a line immediately, such as a URL
  the owner must open.
- Time windows: tolerate clock skew between this host and Alpha (about 0.5 s
  observed). Compare against the documented bound, never an exact value.
- Harness input files must be regular files you own, mode 0600 and small.
- When a check fails, first rule out whether the environment changed under you
  (PATH tools, database encoding, a disk precondition) before blaming the code.
- A workspace whose setup ran only `pnpm install` fails `pnpm typecheck` in
  `apps/control-plane` with missing modules. `scripts/dev-environment/hook.sh setup`
  installs all three dependency graphs, as `.conductor/settings.toml` does.
  Playwright-backed Design suites also need `npx playwright install chromium`.
  Before blaming your diff for a red local run, rerun the failing files in a
  clean checkout of your base commit. A base worktree at another path changes
  path- and Git-dependent suites; for an exact comparison, swap only your
  changed source files back to the base revision in the same checkout, compare
  failing test names, then rerun every differing test in isolation. macOS
  cannot run the `/proc`-based portable cloud fixtures at all.
- `pnpm typecheck` keeps incremental state in `node_modules/.cache/zeros-typecheck`.
  An error in a file you did not touch may be stale state: confirm with
  `tsc --noEmit -p tsconfig.typecheck.json --incremental false` before chasing it.
- `pnpm test:ui-smoke` stops at the first scenario that throws, so one base
  failure hides every later scenario. Confirm the failure on the base commit,
  then run the rest from an untracked copy of `scripts/` without that scenario
  (registry and partition), with the affected scenarios in one shard; delete
  the copy afterwards.
- `pnpm check:runtime-skew` reads its pinned commits from local Git objects
  with `git --no-lazy-fetch`, which needs Git 2.44 or later. A shallow clone,
  or Git 2.43 (Ubuntu 24.04), reports `runtime_skew_source_unavailable`. Fetch
  full history and check `git --version` before suspecting the pins.
- Database-backed control-plane suites skip without `TEST_DATABASE_URL`. Give
  each concurrent agent its own PostgreSQL 18 server, not only its own
  database: migration 0004 creates the cluster-wide `zeros_app` role with a
  check-then-create race. Without Docker or sudo, signature-verified PGDG
  packages unpacked with `dpkg -x` run as an unprivileged user.
