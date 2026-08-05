# Zeros development rules

These rules apply to maintainers, contributors, and automation. They protect
runtime compatibility, product quality, user data, and the public repository.

## 1. Preserve behavior and compatibility

- Refactors must keep features, UI, persisted state, wire contracts, release
  behavior, and packaging behavior unchanged unless the task explicitly changes
  them.
- Before moving or renaming code, map imports and every non-import reference:
  tests, scripts, configs, workflows, manifests, generated-code paths, dynamic
  imports, string-based registries, and documentation.
- Never rename a persisted key, database field, IPC method, protocol value,
  environment variable, deep-link scheme, CSS custom property, or DOM hook as a
  cosmetic cleanup. Add an explicit migration and compatibility test when a
  contract must change.
- A target-branch selection updates metadata only. Rebase, merge, autostash, and
  other history mutations require a separate explicit action.
- All, Uncommitted, Staged, and Unstaged Git rows and counts come from their own
  comparisons. Porcelain status may enrich those results but cannot define
  them. The Changes badge uses the All Changes total; an `AD` path contributes
  `0/0/1/1` respectively.
- Never discard, overwrite, or broadly reformat unrelated work in a dirty tree.

## 2. Repository boundaries

The top-level layout is intentional:

| Path                    | Responsibility                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/desktop/`         | Cross-platform desktop product (currently macOS): Electron main/preload, local engine, and React renderer |
| `apps/control-plane/`   | Railway-hosted API and database migrations                                                                |
| `apps/web/`             | Cloudflare Pages hub, auth handoff, and edge functions                                                    |
| `apps/marketing/`       | Public marketing site source assembled into the web deployment                                            |
| `apps/feedback-worker/` | Cloudflare Worker for authenticated feedback delivery                                                     |
| `packages/protocol/`    | Shared transport schemas, messages, validation, and redaction                                             |
| `catalogs/`             | Versioned provider/model catalog data and schemas                                                         |
| `scripts/`              | Repository-wide build, release, audit, and maintenance automation                                         |
| `styles/`               | Design tokens, cross-boundary CSS, and design reference artifacts                                         |
| `third_party/`          | Upstream license texts for copied, generated, and adapted source                                          |
| `docs/`                 | Durable public engineering contracts and contributor guidance                                             |

Do not create empty future-platform folders. Add `apps/ios`, `apps/android`, or
another deployable only when it contains a real build boundary and owner. Move
code into `packages/` only when a stable contract crosses application, process,
or deployment boundaries and has multiple independent consumers; otherwise keep
it with the app that owns it.

### Desktop boundaries

- `apps/desktop/electron/` owns windows, native OS integration, preload, IPC,
  updater, secrets, and process supervision.
- `apps/desktop/src/engine/` owns agents, Git, workspaces, PTY, local database,
  transport, and headless services.
- `apps/desktop/src/renderer/features/` owns product capabilities.
- `apps/desktop/src/renderer/shell/` composes the app chrome, conversation, and
  workbench surfaces.
- `apps/desktop/src/renderer/platform/` owns native/bridge and browser-platform
  boundaries.
- `apps/desktop/src/renderer/state/` owns cross-feature renderer state and
  lifecycle orchestration.
- `apps/desktop/src/renderer/shared/` owns feature-neutral UI, theme, and
  utilities. Shared code must not import a product feature or shell surface.

Keep feature-specific UI, state, tests, and supporting modules together. Use
lowercase kebab-case filenames that describe domain behavior
(`workbench-pane.tsx`, not a coordinate-based name). Use `index.ts` only as a
deliberate public barrel or where a deployment/runtime convention requires that
entrypoint name (for example Cloudflare Pages Functions). Do not hide ordinary
implementation in it. Prefer direct, explicit imports inside an app.

## 3. UI and styling

Zeros uses dense professional desktop chrome, a restrained accent, three text
tiers, a 4px spacing rhythm, and tonal borders. Existing visual behavior is a
contract: structural work must not alter it without explicit design approval.

### Tokens and cascade

- `styles/zeros-tokens.css` owns primitive values, Tailwind theme wiring, and
  the small core alias set exposed as utilities.
- `styles/semantic-tokens.css` owns feature-specific semantic aliases that
  reference those primitives.
- `styles/globals.css` is the ordered entrypoint for the focused modules in
  `styles/global/`. Its import order is a cascade contract.
- Components consume semantic tokens and shared primitives. Do not reference raw
  palette primitives from feature code.
- Do not add feature styling to a global stylesheet. Keep component-owned rules
  with the component or in a focused local stylesheet. A global rule is valid
  only when it must cross ownership boundaries, such as document defaults,
  Electron drag regions, runtime-generated markup, portal/vendor selectors,
  shared keyframes, or scrollbars.
- Prefer an existing semantic token. Add a new primitive and semantic alias only
  with its first real caller; do not create aliases for hypothetical use.

### Component rules

- Reuse primitives from `renderer/shared/ui/` for buttons, inputs, menus, tabs,
  dialogs, tooltips, badges, and other standard controls. Extend a primitive
  when behavior is genuinely shared; do not duplicate it in a feature.
- Use semantic CSS variables instead of raw hex, RGB(A), shadow, transition,
  typography, or global z-index values.
- Raw values are allowed only at real boundaries: runtime user colors,
  canvas/WebGL/library APIs that cannot resolve CSS variables, local stacking
  (`z-index: 1` or `2`), one-pixel geometry, and component-specific dimensions.
  Leave a short reason when the exception is not self-evident.
- Use CSS for visual hover and focus behavior. Inline styles are for dynamic
  runtime values, not static design declarations.
- Global overlays use the shared layer tokens and primitives. Never solve a
  stacking problem with an arbitrary high `z-index`.
- Controls use the established 24/28/32px desktop scale. Same-row controls
  match heights. Preserve accessible names, focus visibility, keyboard behavior,
  reduced-motion behavior, and inertness of hidden content.
- Run `pnpm check:ui` for every UI/style change and `pnpm build:ui` whenever the
  cascade, entrypoint, or renderer build could be affected.

## 4. Renderer state and interaction performance

- Publish route and destination identity in one state transition. Never render
  an incomplete destination and repair it in a later effect.
- Key every durable selection by its semantic owner (app, repository,
  workspace, or tab). Restore it synchronously on first render; validate it
  against an authoritative exact-key snapshot; bound storage; and prune it when
  its owner is removed. Modal and unsaved-draft state remains ephemeral.
- Owner deletion includes normalized descendant cwd keys but stops at a
  separately registered, more-specific nested owner.
- Treat native, bridge, Git, SQLite, and cloud reads as keyed server state.
  Deduplicate requests and retain the last successful same-key value during
  refresh. Never clear useful data merely because revalidation started.
- Warm likely destinations on pointer/focus intent. An urgent click handler must
  not await I/O, parsing, syntax highlighting, or hydration.
- Reuse aggregates instead of adding per-row requests. Keep Zustand selectors,
  collections, historical rows, and turns referentially stable when unchanged.
- Retain expensive UI only in an explicitly bounded cache. Hidden surfaces must
  be inert and must gate active-only effects, shortcuts, focus, measurement,
  and polling.
- Fix data waterfalls at their source. Do not add a fade, skeleton, spinner, or
  timeout to conceal one; delayed busy indicators are only for genuine cold
  loads.
- Test exact-key isolation, stale-response races, request deduplication,
  reference stability, bounded eviction, and A → B → A restoration across every
  affected owner boundary.

`docs/ui-interaction-performance.md` contains examples and deeper rationale.

## 5. Security and privacy

- Never commit credentials, tokens, private keys, session material, real user
  data, internal email addresses, private hostnames, or production database
  values. `.env` files remain untracked; `.env.example` contains placeholders
  and clearly labels values that are intentionally public.
- A `VITE_*` value is shipped to the renderer and is never a secret. Put secrets
  in the OS credential store or a server-side environment, with the narrowest
  viable lifetime and scope.
- Validate every IPC and network input at its trust boundary. Keep the preload
  allowlist narrow, do not expose generic filesystem/process execution, and
  normalize and authorize filesystem paths before access.
- Treat repositories, web pages, agent output, deep links, archive contents, and
  generated HTML as untrusted input. Preserve sandboxing, context isolation,
  navigation restrictions, sanitization, and workspace-root trust checks.
- Scrub tokens, credentials, prompts, source snippets, paths, and identity data
  before logs, analytics, feedback, errors, or diagnostics leave the machine.
  New event fields require a data-minimization review.
- Internal features must gate every runtime surface with
  `useInternalFeatureActive(...)` (staff authorization and the feature flag),
  and attach hotkeys only while authorized.
- Never weaken authentication, updater signing, release-channel isolation,
  database row-level authorization, or secret redaction to simplify a refactor.

## 6. Public-repository and legal hygiene

- Zeros code is licensed under the root MIT license. Keep package metadata on a
  valid SPDX identifier and preserve copyright/license notices.
- Record every bundled, copied, or generated third-party work and its applicable
  license in `THIRD-PARTY-NOTICES.md`; regenerate
  `THIRD-PARTY-LICENSES.txt` with `pnpm licenses:generate`. Preserve upstream
  NOTICE files and source headers when their licenses require it. Lockfiles
  identify exact resolved versions; a notice file does not replace license
  compliance.
- Do not copy code, assets, text, or designs from research projects. A public
  URL is not permission. Verify provenance and license before adding material.
- Keep generated or vendored code in an explicit directory with provenance,
  version/pin, regeneration instructions, and generated-file markings.
- Do not add a dependency whose license is missing, ambiguous, incompatible, or
  commercially restricted without maintainer review.
- Public code, comments, tests, docs, commits, releases, and workflow output must
  not expose secrets, personal data, internal operational details, or unrelated
  product comparisons. Product/vendor names are acceptable only where they are
  functionally required for an integration, attribution, compatibility contract,
  or user-facing capability.
- Security reports use the private process in `SECURITY.md`; never disclose an
  unpatched vulnerability in a public issue or log.

## 7. Tests and change discipline

- For a bug, first add a failing regression test (or smoke-harness assertion),
  then fix it, then retain the test.
- After each meaningful edit, run every nearby `__tests__/` suite. Before
  handoff, run the full local baseline: `pnpm typecheck`, `pnpm lint`,
  `pnpm check:ui`, `pnpm test:git`, and `pnpm check:secrets`.
- Run all applicable targeted gates:
  - UI interaction/overlay work: `pnpm test:ui-smoke` and `pnpm build:ui`.
  - Electron IPC/preload: `pnpm check:preload` and Electron tests.
  - Engine lifecycle: `pnpm smoke:engine` on macOS.
  - Control plane: `pnpm test:control-plane` and
    `pnpm --dir apps/control-plane typecheck`.
  - Workflows: `pnpm check:actions`.
  - Database, packaging, protocol, release, deep-link, or web-deploy changes:
    the matching `check:*` command in `package.json`.
  - Runtime dependencies, generated code, or packaged assets:
    `pnpm check:licenses`.
- A platform-specific gate that cannot run in the current environment is a
  documented follow-up, never a claimed pass.
- Update architecture and operator documentation in the same change when a
  boundary, command, deploy root, environment variable, or ownership rule moves.
