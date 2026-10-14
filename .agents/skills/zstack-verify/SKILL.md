---
name: zstack-verify
description: "Choose and run the right checks for a Zeros change, Local and cloud: adjacent Vitest suites, required static gates, UI smoke, platform-only checks, and live Alpha verification with the zeros-dev harness. Includes evidence rules and known gotchas."
---

<!-- GENERATED from agents/zstack/skills/zstack-verify/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-verify

## Pick checks from the diff

Always run the adjacent suites for the files you changed, then the static
gates: `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git` (filtered to the touched area), `pnpm check:secrets`.

| Touched | Also run |
|---|---|
| Renderer UI, styling or tokens | `pnpm check:ui`; after a token or contrast change, `pnpm design:docs` |
| Composer, overlay, focus or popover | `pnpm test:ui-smoke`. Label the PR `ci:ui-smoke`. |
| Performance-sensitive UI | exact-key and race tests, `pnpm build:ui` |
| Electron IPC or preload | `pnpm check:preload` and the relevant Electron tests |
| `apps/control-plane/` | `pnpm test:control-plane`, `pnpm --dir apps/control-plane typecheck` |
| `.github/workflows/` | `pnpm check:actions` (owner merge required) |
| Migrations, packaging, protocol or deploy paths | the matching `check:*` scripts in `package.json` |
| Runtime dependencies or packaged assets | `pnpm check:licenses` |
| Engine lifecycle | `pnpm smoke:engine`, on macOS only |

CI's full root and control-plane suites are the authority. Locally, run the
adjacent suites plus the gates above; don't wait on a full local run before
handing off. Preview the CI lanes with `pnpm ci:plan`.

## Live cloud checks on Alpha

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

## Evidence rules

- Report counts, for example "adjacent 130/130 across 11 suites". Name what you
  did not run and why.
- A retry never relabels the original failure. Record both results.
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
