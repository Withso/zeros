---
name: zstack-verify
description: "Choose and run the right checks for a Zeros change, Local and cloud: adjacent Vitest suites, required static gates, UI smoke, platform-only checks, and live Alpha verification with the cloud v2 gate0 probe. Includes evidence rules and where the environment gotchas live."
---

<!-- GENERATED from agents/zstack/skills/zstack-verify/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-verify

## Pick checks from the diff

Run the whole test directories you touched, then the static gates:
`pnpm typecheck`, `pnpm lint`, `pnpm check:ui`, `pnpm test:git` (filtered to the
touched area, under `umask 022`) and `pnpm check:secrets`.

| Touched | Also run |
|---|---|
| Renderer UI, styling or tokens | `pnpm check:ui`; after a token or contrast change, `pnpm design:docs` |
| Frames in `Zeros - Design/` | `design validate` and `design capture` from the frame context, then inspect the PNG. Add `--theme light` for Light; the default is Dark. |
| Composer, overlay, focus or popover | `pnpm test:ui-smoke`. Label the PR `ci:ui-smoke`. |
| Performance-sensitive UI | exact-key and race tests, `pnpm build:ui` |
| Electron IPC or preload | `pnpm check:preload` and the relevant Electron tests |
| `apps/control-plane/` | `pnpm test:control-plane`, `pnpm --dir apps/control-plane typecheck` |
| Control-plane concurrency, locks or transactions | Label the PR `ci:control-plane-db`: without it the full database lane runs only after merge, where a timing race turns `main` red. |
| `.github/workflows/` | `pnpm check:actions` (owner merge required) |
| Migrations, packaging, protocol or deploy paths | the matching `check:*` scripts in `package.json` |
| Runtime dependencies or packaged assets | `pnpm check:licenses` |
| Agent runtime pins (Codex, Claude, Cursor SDK/CLI) | Move Local and `apps/cloud-worker` to the same exact version in one PR, with the worker's `VERSIONS` and `CURSOR_VERSION`; run `scripts/__tests__/agent-runtime-pin-parity.test.ts`, the cloud-worker suite and `pnpm check:licenses` (owner merge: lockfile) |
| `zeros-engine.ts` dispatch, or an object the engine constructs | the whole `apps/desktop/src/engine/__tests__/` and `apps/desktop/electron/__tests__/` directories |
| A wire or shared helper used across features | the whole root suite: coupled suites fail far from the edit |
| Engine lifecycle | `pnpm smoke:engine`, on macOS only |

CI's full root and control-plane suites are the authority. Locally, run the
adjacent suites and the gates above; don't wait on a full local run before
handing off. Preview the CI lanes with `pnpm ci:plan`.

The selector does this bookkeeping:

```sh
node scripts/zstack/verify.mjs plan --test path/to/adjacent.test.ts
node scripts/zstack/verify.mjs run --test path/to/adjacent.test.ts --execute --receipt /private/scratch/verify.json
```

Record `--mode single-session --agent <model>`, or `--mode master-subagents
--agent <model> --master <model>`. The selector uses the shared CI registry;
unknown CI command text is deferred, never executed as shell. An incomplete diff
or missing adjacent suite blocks execution, and a source change during
verification invalidates the receipt. The receipt is unsigned engineering
evidence; CI is still the merge authority. `node scripts/zstack/verify.mjs local-ui`
plans the Linux app driver (`--execute --receipt <file>`, optionally
`--shard 1/3`); remaining shards and macOS proof stay unverified. See
`agents/zstack/tools.md`.

## Live cloud checks on Alpha

Cloud workspaces run one Boat VM each. Before a live run, pass the offline
suites: `pnpm --dir apps/cloud-worker test`, `pnpm test:control-plane` with real
PostgreSQL, and the shared renderer suites under `platform/bridge`. The branch's
live proof is the isolated local stack and gate0 probe:

```sh
pnpm electron:cloud --headless --runtime <runtime-sha256>
pnpm --dir apps/control-plane cloud-v2:gate0 --local --runtime <runtime-sha256>
```

- Run it only with the task's cloud-provider authorization, against this
  checkout's backend whose `CLOUD_V2_RUNTIME_SHA256` matches `--runtime`
  (`electron:cloud` takes `--runtime` or `ZEROS_CLOUD_V2_RUNTIME_SHA256`). No
  Railway service or PlanetScale branch is created; see `docs/electron-cloud.md`.
- It creates one disposable workspace from the existing Cloud Computer, runs
  native Claude, Codex and Cursor turns and terminal, file and Git round trips,
  reads the mirrored history while the VM is stopped, wakes it once, then
  deletes it. Pass `--keep` only when you will delete the workspace yourself.
- It starts a real VM: run it once per tested change, never in a loop. It
  reports only the failing stage; capture the control-plane logs and the
  workspace row through the API before any cleanup.
- Provider keys stay in `.env.agent` (Alpha and test only) or Actions; never
  copy them into the checkout or into output.
- Run a control-plane-generated VM script (runtime install, checkpoint,
  restore) on the real Boat image once: one throwaway VM from the Alpha Cloud
  Computer, no storage writes, deleted afterwards. Local tests run this host's
  Git, tar and coreutils, not the image's. Ad-hoc probes that reuse
  `createGithubAppJwt` must pass `clientId`.

## Evidence rules

Principle 16 applies to every claim.

- Report counts ("adjacent 130/130 across 11 suites") and name what you did not
  run and why. A retry never relabels the original failure; record both.
- Native rendering performance needs the physical GPU footprint and the whole
  owned app/engine process set through cold loading, zoom, capture, hidden
  return and owner switching. RSS, JS heap and source/image budgets miss
  graphics allocations; missing readings fail the run. For Design, run
  `pnpm check:design-performance` and the native workload in
  `agents/zstack/playbooks/performance.md`.
- Exercise streamed media through the production Electron protocol with a
  large indexed file and a distant seek. Before reclaiming attachment recovery
  bytes, test concurrent source owners and the cloud checkpoint/restore path.
- A remote-command timeout leaves execution unknown. Recover the run marker,
  process status and a fresh report before relaunching.
- Every time in a record comes from a clock read: write it with
  `$(date -u +%H:%M)` inside the command that appends it.
- Don't claim macOS-only checks from Linux.

## When a check fails

Read `agents/zstack/gotchas.md` before chasing a failure your diff does not
explain: it lists the shell, Git, Node, dependency, permission, PostgreSQL,
browser and CI facts that have already cost a loop.
