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
- A Zeros `design.toml` registers a Design directory. Local Code and Design
  use the same normal provider Read/Write/Edit/patch/shell tools and permissions.
  The Design tag means edit Design source by default; a frame attached in Code
  context means implement application code from that reference. Explicit user
  instructions take precedence; mixed work needs no mode switch. Read `rules.md`,
  preserve stable frame IDs, and re-read changed files before editing.
- Frames contain HTML, CSS, supported local assets and CSS keyframes/transitions.
  Authored JavaScript, event handlers, framework runtimes and TSX do not execute.
  Shell/Node/Python may generate supported source. App implementation from a
  frame follows that application's runtime conventions. Live Code layers are deferred.
- Native edits save directly into the checkout; no Design apply/import/publish
  is required. DesignDraftStore supplies checked transactions for the canvas and
  optional semantic tools; it is not another authored copy. Use the native
  verification command supplied in frame context to validate, capture a PNG or
  open the HTTP preview. Inspect PNGs with the ordinary image tool. Use only
  browsers the provider actually exposes, and preserve its URL/origin policy.
- Use Zeros Settings/lifecycle operations to create, migrate, rename or remove
  registration and generated rules. Existing manifest/canvas conflicts can be
  repaired in shared Files or normal source tools. Saving never stages or commits.
  Local managed Git integrates Code and Design together; conflicts pause the
  canvas until shared source resolution/continue or abort completes. Provider
  permissions and Plan remain unchanged. Cloud retains API authoring for now.
- Commit each Design folder with its `design.toml`, `canvas.json`, `rules.md` and
  referenced source. Authorized managed Git operations may include both Code
  and Design. Saving never implicitly stages or commits. `.zeros/` is private
  local state, ignored by default. Private `[design] directory_id` selects the
  active folder; legacy directory pointers, inline manifest documents,
  `.zeros/design-dir.toml`, `.zeros/design/` metadata and `.zeros-canvas.json`
  remain readable. Explicit Design authoring upgrades them recoverably.

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

For renderer UI, styling, tokens, or colors, read `docs/design-system.md`
first; its agent brief is mirrored into the generated `zeros-ui` skills for
Claude, Codex, and Cursor. For Design work, read `docs/design-mode-roadmap.md`,
the single Design architecture, implementation and future-phase reference.
For renderer state, navigation, loading, tabs, panels, or list work, also read
`docs/ui-interaction-performance.md` when it is present.
For provider event handling or tool transcript UI, also read
`docs/agent-tool-presentation.md`.

## Agent credentials

- Live checks use the gitignored `.env.agent` at the repository root; its
  template is `.env.agent.example`, and Conductor copies it into new
  workspaces. It holds Alpha and test credentials only: never add Beta or
  Production keys.
- Run `pnpm agent:check` to verify it read-only. Never print, log, commit or
  echo a credential value, including in command arguments and test output.
- Commits and pull requests use the workspace's own Git and GitHub identity,
  so authorship stays with whoever is working; the `Co-Authored-By` trailer
  records the agent. Never author a commit as `zeros-agent[bot]`. Use the bot
  only for automation that is not a person's work: merging a green pull
  request (`pnpm agent:gh pr merge …`), cutting a release branch
  (`pnpm agent:git push origin <sha>:refs/heads/release/X.Y.Z`), and
  dispatching or rerunning release workflows (`pnpm agent:gh …`).
  `pnpm agent:github:check` verifies access without printing a token. The App
  reaches this repository only; its key stays outside the repository
  (`ZEROS_AGENT_GITHUB_APP_B64` from Conductor in cloud workspaces,
  `~/.zeros-dev/agent-github-app.json` on the Mac). Without it, use the
  workspace's own identity for those steps too.

## Verification

Before handoff, run `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git`, `pnpm check:secrets`, and every applicable `check:*` command.
Additional requirements:

- UI or styling: `pnpm check:ui` fails on classes that compile to nothing, new
  design-system policy findings, and stale generated design docs. After a token
  or contrast-contract change run `pnpm design:docs`; never raise
  `styles/policy/ui-debt.json` to pass.
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
