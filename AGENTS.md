# Zeros repository guide for coding agents

These instructions apply to the entire repository. Read and follow
[RULES.md](RULES.md) before changing code.

## Working method

- Treat `docs/` as durable engineering guidance. Code, tests, schemas, and this
  guide remain authoritative when prose and behavior disagree.
- Trace imports, call sites, persistence keys, IPC names, environment names,
  deep links, and packaging paths before moving or renaming anything.
- Preserve runtime behavior and serialized compatibility unless a migration is
  explicitly part of the request. Coordinate-era identifiers may remain when
  they are persisted or externally observable; document them as compatibility
  contracts instead of silently renaming them.
- Keep changes scoped. Do not reformat or rewrite unrelated user work.
- For a bug, add a failing regression test first, implement the fix, and retain
  the test.
- Run adjacent Vitest suites after each meaningful edit, not only at handoff.

## Renderer invariants

- Treat native, bridge, Git, database, and remote reads as keyed server state.
  Share requests and retain the last confirmed exact-key snapshot during
  revalidation.
- Compute All, Uncommitted, Staged, and Unstaged Git views from their own
  comparisons; porcelain status only enriches them. The Changes badge is the
  All Changes total. An `AD` path contributes `0/0/1/1` respectively.
- A target-branch picker changes metadata only. Rebase, merge, and autostash are
  separate explicit actions.
- Publish route and destination identity atomically. Restore durable selections
  synchronously by semantic owner, then validate, bound, and prune them.
- Deleting an owner prunes normalized descendant cwd keys without crossing a
  separately registered, more-specific nested owner.
- Warm likely destinations on pointer or focus intent; click handlers do not
  await data.
- Retained hidden surfaces must be bounded and inert, with active-only effects,
  shortcuts, focus, measurement, and polling gated off.
- Keep hot selector and collection references stable. Do not hide a data
  waterfall behind a fade, skeleton, spinner, or timeout.
- Internal-only runtime surfaces must use `useInternalFeatureActive(...)`, not a
  raw flag, and may attach hotkeys only while that gate is active.

For renderer state, navigation, loading, tabs, panels, or list work, also read
`docs/ui-interaction-performance.md` when it is present.

## Verification

Before handoff, run `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git`, `pnpm check:secrets`, and every applicable `check:*` command.
Additional requirements:

- Performance-sensitive UI: exact-key/race tests and `pnpm build:ui`.
- Composer, overlay, focus, or popover: `pnpm test:ui-smoke`.
- Electron IPC/preload: `pnpm check:preload` and relevant Electron tests.
- Engine lifecycle: `pnpm smoke:engine` on macOS.
- `apps/control-plane/`: `pnpm test:control-plane` and
  `pnpm --dir apps/control-plane typecheck`.
- `.github/workflows/`: `pnpm check:actions`.
- Database migrations, packaging, protocols, or deploy paths: run the matching
  migration, packaging, protocol, or web-deploy checks from `package.json`.
- Runtime dependencies, generated code, or packaged assets:
  `pnpm check:licenses`.

Never claim a platform-only check passed when it was not run on that platform.
