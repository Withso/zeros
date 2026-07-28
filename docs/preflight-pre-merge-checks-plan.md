# Preflight — Pre-merge Checks Plan for Zeros

> Single source of truth for what gates a merge to `main`. `main` is production; merge = ship to a public multi-user beta. This doc defines every check, its tier, exact command, what it covers, and a phased rollout.

## Executive summary

Today the **entire** per-PR gate is **3 steps in one workflow** (`.github/workflows/test.yml`, the "Vitest suite" job): `pnpm check:preload`, `pnpm test:git`, `pnpm models:verify --strict`. That leaves a desktop app heading to public beta dangerously under-gated:

- **No TypeScript typecheck anywhere** — Vite (renderer), tsup (engine), and tsup (Electron main/preload) all strip types with esbuild and never type-check, yet `tsconfig` is `strict: true`. A type error in any of 1164 src files reaches `main` silently and only surfaces at runtime on a user's machine.
- **No lint** (the `react-hooks/rules-of-hooks` guard against the exact blank-screen crash this dev has shipped is unwired), **no format check**, **no build gate** (renderer/engine/electron-main/marketing/worker only build during a manual release).
- **No security or supply-chain gate** (no secret scan, no Electron-hardening guard, no Dependabot, no actionlint).
- **No migration safety guard** — the engine SQLite ladder (`src/engine/db/migrations.ts`, every user's only copy of their chats/workspaces) and the Supabase Postgres migrations have zero forward-only protection.
- **The React renderer, the Electron main process, and all packages are untested on PR** by design (`vitest.config.ts` covers only plain-TS helpers).
- **Branch protection is OFF** — nothing is actually a *required* status check, so even a red `Vitest suite` does not provably block merge today.

This plan closes those gaps with a named, tiered, phased gate.

---

## Implementation status — P0 + P1 landed, P2 scaffolded (2026-06-27)

**P0 and most of P1** are **implemented** in this branch and verified green locally (one pre-existing, unrelated flake aside — see note); the deterministic **P2** items are in too, and the secret/runner-gated ones are scaffolded skip-guarded. Workflows: `preflight.yml` (per-PR: `quality` · `test` · `build`), `lint-ci.yml` (actionlint), `codeql.yml`, `claude-review.yml`, `scheduled.yml`, plus `dependabot.yml`; `release.yml` gained a ship-guard step; `test.yml` was folded into preflight and removed.

**Landed & green:**
- **Typecheck** (new `pnpm typecheck` → `:app` / `:electron` / `:packages`). Added `@types/node@20` (was only transitive at 3 conflicting majors), `tsconfig.typecheck.json`, and `electron/tsconfig.typecheck.json`. This surfaced **3 real latent type bugs** that tsup/Vite never checked — all fixed: a Node-20 JWK typing in `src/engine/auth/verify-jwt.ts`, and `getPath("cache")` + a `BaseWindow.webContents` narrow in `electron/`. Marketing's `typecheck` was a false green (checked 0 files) → fixed to `tsc -b`.
- **Lint** (`pnpm lint`) — fixed the 1 `require-yield` error; 0 errors (13 intentional warnings remain, non-fatal by config).
- **Tests + guards** — `test:git`, `models:verify --strict`, `check:preload`, `check:cursor-asar`, plus new **`check:migrations`** (forward-only ladder guard, with a fresh-to-head + destructive-migration-7-with-data test in `src/engine/db/__tests__/migrations.test.ts`), **`check:secrets`** (dependency-free tracked-file scanner), and a **settings-schema regenerate-cleanly** step (regenerated the genuinely-stale committed schemas — `file_include_globs` + the `mcp.servers` block). Note: this gate runs the generator but does **not** byte-diff its output — zod v4's `z.toJSONSchema` is Node-version/platform-non-deterministic (verified across macOS Node 25 and Linux Node 20), so schema *validity* is enforced deterministically by the `static-configs-validity` test + PR diff review instead.
- **Build integrity** — `build:ui`, `build:engine`, `electron:compile`, and the bun **sidecar cross-compile** (ubuntu → macOS arm64).
- **LICENSE** file added (`package.json` claimed MIT with no license text).

**P1 — landed & green (blocking unless noted):**
- **Repo-specific guards** (all verified positive *and* negative): `check:vite-env` (prod VITE_* set wired into release.yml), `check:electron-hardening` (contextIsolation/sandbox/nav-guards/CSP/contextBridge can't regress), `check:codex-pin` (installed = pin = bindings = 0.139.0), `check:packaging-paths` (every electron-builder `from:`/icon/afterPack resolves; engine-binary name matches `build:sidecar`), `check:supabase-migrations` (Postgres naming + forward-only).
- **Build gate:** marketing site (`tsc -b && vite build`) — the public homepage's only build/type gate.
- **`lint-ci.yml`** (actionlint over all workflows; advisory for the introducing run, then blocking), **`dependabot.yml`** (security-updates only, so it doesn't fight Renovate), and a **`release.yml` ship-guard** (models:verify + cursor-asar + packaging-paths + vite-env + codex-pin + hardening on the only path that cuts a DMG).
- **Contract tests** (in `test:git`): `static-configs-validity` (ajv-validates `providers-v1` — which `models:verify` never checks — + JSON-parse smoke) and `agent-events-pii-contract` (mocks PostHog, drives every analytics emit with an adversarial path+email error, asserts only scalar metadata escapes).

**P2 — landed (advisory) + scaffolded:**
- Advisory steps: `check:ui` (RULES.md tokens — RED today, 28 legacy violations), `test:adapters` (offline translator fixtures — actually green, kept advisory per low marginal value), `check:protocol` (PROTOCOL_VERSION bump reminder), `format-check-changed`.
- `codeql.yml` (advisory SAST, PR + weekly; free on public repos), `claude-review.yml` (**inert until you add `ANTHROPIC_API_KEY`** — self-skips green), `scheduled.yml` (weekly + manual macOS: native-module ABI smoke + electron-builder pack smoke).

**Deliberate deviations from the plan above:**
- **`format-check-changed` is wired ADVISORY** (`continue-on-error`), not blocking — `verify-jwt.ts` alone would need ~141 lines of reformatting churn. It graduates to blocking after a one-time `prettier --write .` baseline (its own PR). New files in this change are already Prettier-clean.
- **Secret scan is a custom `scripts/check-secrets.mjs`**, not gitleaks — the gitleaks Action requires a `GITLEAKS_LICENSE` for org repos. The custom scanner is deterministic, green-on-day-one, and catches the specific high-risk tokens this repo handles; gitleaks/trufflehog entropy detection remains a P1 upgrade.
- **No standalone `LICENSE-exists` CI guard** — the file is the fix; a dedicated check is low-value per the maintenance principle.

**Deferred (need a decision, a secret, a baseline, or new product code) — see §Phased rollout / §Dropped:**
- **Whole-tree `format-check` blocking** — needs a one-time `prettier --write .` baseline commit (888 files); its own PR.
- **`app-launch-e2e-smoke`** — blocked on a net-new auth test-mode bypass in `auth-gate.tsx`.
- **`supabase-migration-lint-dryrun`** — needs `supabase init` + Docker-in-CI (the naming/forward-only guard above delivers the 80%).
- **Live `agents:smoke` in CI** — needs the agent CLIs installed + provider auth on the runner; stays a manual/local check.
- `lint-strict-no-warnings`, `coverage-report`, blocking `check:ui` — each needs a baseline pass first.

**Remaining user action (the keystone):** branch protection is still OFF — until it's on, none of these are *required*. After the first PR run, mark `quality`, `test`, `build` as required status checks on `main` (see §Branch protection).

**Note on the local test run:** `src/engine/git/__tests__/worktree.test.ts` (a worktree-fork integration test) fails on this machine's git 2.50.1 — it is **unmodified and not in this change's import graph**, and `test:git` is green-always in CI (ubuntu). Pre-existing, env-sensitive, unrelated.

---

## The check suite: **Preflight**

The whole pre-merge gate is named **Preflight**. Every check in this doc is a **Preflight check**. The model is simple:

> A PR cannot merge to `main` until every **blocking** Preflight check is green.

**Primary name: Preflight.** Alternates if you prefer: **Gatehouse** or **Customs**. Use "Preflight" throughout — the per-PR workflow becomes `preflight.yml`, the required status-check group is "Preflight", and the dev mental model is "run Preflight before you ship."

---

## How to read this

Every check carries one of three tiers:

| Tier | Badge | Meaning |
|------|-------|---------|
| **BLOCKING** | 🔴 | A required GitHub status check. **Red = no merge.** Must be fast, deterministic, secret-free (fork-safe), and green on `main` the day it is enabled. |
| **ADVISORY** | 🟡 | Runs on every PR, posts annotations/comments, **never blocks merge.** For high-value-but-noisy or not-yet-baselined checks. |
| **SCHEDULED** | 🔵 | Runs on a cron (e.g. nightly) and/or behind a PR label — **not per-PR.** For live-agent smokes, heavy macOS builds, full-history scans, and anything that needs secrets or minutes. |

Status-today values used below: **already-in-CI**, **script-exists-unwired** (a `package.json` script or `scripts/*.mjs` exists but no workflow runs it), **missing** (must be created).

---

## The checks

### 1. Type safety

> There is **zero** typechecking in CI today. This category is the single biggest cheap win. Prerequisite for the whole category: add `@types/node` as a direct devDep.

#### `add-types-node-dependency` — enabling prerequisite (not a check)
- **Tier:** 🔴 prerequisite · **Priority:** P0 · **Status:** missing
- **Command:** `pnpm add -D -w @types/node@^20` then verify with `pnpm why @types/node` showing a **direct** devDependency (not only the `@daytona/sdk` transitive chain).
- **Should do:** Pin Node typings deterministically for both the engine (`src/engine`) and the Electron main (`electron/`).
- **Does / will do:** Today `@types/node` is only transitive via `@daytona/sdk`'s OpenTelemetry chain at **three conflicting unpinned majors (20/22/25)**. `electron/tsconfig.json` declares `"types": ["node","electron"]` and **fails outright** with `TS2688 "Cannot find type definition file for 'node'"`. The engine portion of `src/` type-checks only against whatever pnpm happens to hoist.
- **Covers:** A Node-API type error that passes under one resolution and fails under another; makes `typecheck-electron` runnable at all and `typecheck-app`'s engine coverage real.
- **Runtime:** n/a (dependency change). · **Secrets:** none.
- **Caveat:** Pinning `@types/node@20` may surface a handful of latent Node-typing mismatches the floating version masked — that is exactly the bug class this should expose. Keep the major in lockstep with `package.json` engines (>=20) and the tsup target.
- **conductor.build:** none (enabler for `typecheck`).

#### `typecheck-app` — strict typecheck of all app source
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** missing
- **Command:** Create `tsconfig.typecheck.json` at repo root:
  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": {
      "noEmit": true,
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "target": "ES2022",
      "types": ["node"]
    },
    "include": ["src"]
  }
  ```
  Script: `"typecheck:app": "tsc --noEmit -p tsconfig.typecheck.json"`. Run via `pnpm typecheck:app`.
- **Should do:** Type-check the entire app under `src/` — React renderer (`src/zeros`, `src/shell`, `src/bridge`), the engine sidecar (`src/engine`), shared UI — against `strict: true`, without emitting.
- **Does / will do:** Catches every renderer + engine type error: bad props, wrong IPC/bridge payload shapes, null/undefined misuse, refactor call-site drift, enum/union drift, zod-vs-TS mismatch. None of these are caught today.
- **Covers:** The class of regression that currently reaches `main` 100% undetected because both bundlers esbuild-strip types.
- **Priority rationale:** `tsconfig.build.json` is a **build** config (emits, target ES2020, no `lib` override → false `.at()` errors). This needs a dedicated `tsconfig.typecheck.json` with `lib: ES2022` and `types: ["node"]` (else node `import`s silently resolve to `any` under `moduleResolution: bundler`, making the gate hollow on engine code).
- **Runtime:** ~20–40s cold on CI. · **Secrets:** none.
- **PREREQUISITE before it can go green:** fix the **2 real errors** this surfaces today, both in `src/zeros/agent/__tests__/models-catalog-validity.test.ts` (TS7016 implicit-any importing `scripts/models-verify.mjs` + TS7006 param `w`). Either fix them, add a `.d.ts`/`@ts-expect-error` for that `.mjs` import, or exclude `__tests__` from this gate.
- **conductor.build:** `typecheck`.

#### `typecheck-electron` — Electron main + preload typecheck
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** missing
- **Command:** `pnpm exec tsc --noEmit -p electron/tsconfig.json`; wire as `"typecheck:electron"`.
- **Should do:** Type-check the Electron main process + preload (`electron/**`, 37 files) against electron + node types.
- **Does / will do:** Catches IPC handler signature errors, preload `contextBridge` surface mistakes, `BrowserWindow`/`webPreferences` misuse, native-API misuse. tsup builds these with esbuild (no type check), so a main-process type bug ships and only manifests as a runtime crash or broken IPC channel.
- **Covers:** The privileged, security-sensitive trust boundary (preload allowlist, IPC) — a silent type error here is worse than in the renderer.
- **Runtime:** ~5–10s. · **Secrets:** none.
- **BLOCKED until `add-types-node-dependency` lands** — currently errors with `TS2688`. (electron tsconfig has `skipLibCheck: true`, so it passes once `@types/node` is direct.)
- **conductor.build:** `typecheck` (the main-process slice; conductor splits `build-main`/`typecheck`).

#### `typecheck-packages` — per-package typechecks
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:**
  ```
  "typecheck:packages": "pnpm --filter @zeros/core run typecheck && pnpm --filter @zeros/feedback-intercom-webhook run typecheck && pnpm --filter @zeros/marketing exec tsc -b"
  ```
- **Should do:** Run the existing per-package `tsc --noEmit` for `@zeros/core`, the feedback Cloudflare Worker, and `website/marketing`.
- **Does / will do:** Type-checks the shared wire protocol/zod/crypto (`@zeros/core`, consumed by engine + renderer + future web/mobile/CLI — a break cascades everywhere), the production Worker, and the marketing site. All three pass clean today; nothing runs them per-PR.
- **Covers:** A type regression in the bridge wire contract that silently breaks engine↔renderer↔web; the only type safety net for the Worker and marketing site (both deploy via Cloudflare with no other gate).
- **Runtime:** ~10–20s total. · **Secrets:** none.
- **FIX REQUIRED — marketing:** `@zeros/marketing`'s own `"typecheck": "tsc --noEmit"` against its solution-style root tsconfig (`files: []`, `references`) checks **ZERO source files** (verified `--listFiles` = 0 src) — a false green. Marketing **must** use `tsc -b` as shown. `@zeros/core` and the Worker are correct as-is (the Worker uses the webworker lib and does **not** need `@types/node`). Use `--filter` so the empty `website/web-app` scaffold (no `package.json`) is skipped cleanly.
- **conductor.build:** `typecheck` / `test-packages`.

#### `typecheck-aggregate` — single `pnpm typecheck` entrypoint
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `"typecheck": "pnpm typecheck:app && pnpm typecheck:electron && pnpm typecheck:packages"`. **Prefer separate CI steps (or a matrix)** over the `&&`-chained script so a failure tells you *which* surface broke and all three always run.
- **Should do:** One canonical entrypoint that contributors run locally, Renovate gates on, and the release workflow uses as a pre-build gate.
- **Does / will do:** Guarantees no TS surface is left ungated; today `pnpm typecheck` does not exist at the root at all.
- **Covers:** Closes the "a type error reaches `main` silently" hole end to end.
- **Runtime:** ~40–70s total (sub-minute). · **Secrets:** none.
- **Caveat:** `&&` short-circuits, hiding later failures — that is why separate CI steps are recommended. Wire after `typecheck:app`'s 2 errors and the marketing `tsc -b` fix land. Also add it to `release.yml` as a pre-build gate so a type error can never reach a packaged build.
- **conductor.build:** `typecheck`.

---

### 2. Lint & style

#### `lint` — ESLint over `src` + `electron`
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** `pnpm install --frozen-lockfile && pnpm lint` (= `eslint src electron`).
- **Should do:** Run the existing thin flat-config ESLint. Keystone rule: `react-hooks/rules-of-hooks: error`.
- **Does / will do:** Catches the blank-renderer class of bug — a hook declared after an early return changes the hook call-count across renders and crashes the whole React tree (cited as a real shipped incident in the config comment + project memory). Also unreachable generics, undefined globals, basic type-eslint footguns.
- **Covers:** For a public beta, a hooks-order crash = a blank app for **every** user. Cheapest highest-leverage guard for an Electron React app.
- **Runtime:** ~15–30s (after the shared `pnpm install`). · **Secrets:** none.
- **BLOCKER TO ENABLE AS-IS:** `pnpm lint` is **RED right now** — 1 error (`require-yield` on a legit no-yield async-generator test mock in `src/engine/agents/adapters/cursor-sdk/__tests__/session-supersede.test.ts:73`) + 13 warnings. Fix that one error (add a trailing `yield;`, an inline disable, or set `require-yield: off` in `eslint.config.mjs`) before making this a required check. Warnings don't fail eslint by default, so the 13 warns are fine. Note: lint covers **only** `src + electron`, not packages/website.
- **conductor.build:** `lint`.

#### `lint-strict-no-warnings` — fail on any warning
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** partial
- **Command:** `pnpm lint --max-warnings=0` (**NOT** `pnpm lint -- --max-warnings=0` — the `--` makes pnpm hand the flag to eslint as a file glob, failing with exit 2 "No files matching the pattern"; verified in-repo).
- **Should do:** Promote `exhaustive-deps`, `no-unused-vars`, `no-useless-escape`, `prefer-const` from advisory to blocking.
- **Does / will do:** Catches stale-closure bugs (missing effect deps), dead variables, accidental escapes — currently 13 live tolerated warnings.
- **Covers:** The drift the team currently allows.
- **Runtime:** ~15–30s. · **Secrets:** none.
- **Why advisory, not blocking:** The config author **deliberately** keeps `exhaustive-deps` at `warn` (documented legitimate stable-identity dep arrays; escaped-`$` in shell-setup). Forcing zero-warnings now blocks PRs on intentional patterns and "trains the dev to add `eslint-disable` comments rather than fix" — the exact failure mode the config warns against. Keep advisory until the 13 are triaged; consider dropping. Requires baseline to reach zero warnings AND the `lint` error fixed first.
- **conductor.build:** `lint`.

#### `check-ui-tokens` — RULES.md design-token guardrail
- **Tier:** 🟡 ADVISORY (→ BLOCKING after baseline) · **Priority:** P2 · **Status:** script-exists-unwired
- **Command:** `pnpm check:ui` (= `node scripts/check-ui-consistency.mjs`).
- **Should do:** Scan `src/**/*.{ts,tsx,css,js,jsx,mjs}` for design-token violations: raw hex, `rgba()` literals, off-scale font-size/radius/spacing, numeric z-index, Tailwind color utilities (`bg-red-500`), primitive-token leaks, web-font names, inline static visual styles.
- **Does / will do:** Enforces the project's `RULES.md` design discipline. Zero dependencies, ~2–5s. Has built-in `check:ui ignore-line (reason)` + `ignore-next` escape hatches.
- **Covers:** Visual/design-system regressions: hardcoded colors that ignore the theme system, off-scale spacing/radii, palette classes that bypass the token layer.
- **Runtime:** ~2–5s. · **Secrets:** none.
- **Why advisory first:** RED today — 28 violations across 7 files. Several are **legitimate and not realistically fixable**: `src/zeros/agent/agent-brands.ts` hardcodes canonical brand hex (`#D97757` Claude, `#10A37F`/`#0EA37F` OpenAI), `src/shell/column3-tabs/code-editor/theme.ts` + shiki syntax-color tables are inherently raw color values for a code theme, `src/zeros/ui/error-boundary.tsx` renders before the CSS-token tree mounts. Allowlist these (or mark with `ignore-line`) before flipping to blocking; until then it would block every PR for unrelated reasons.
- **conductor.build:** none (bespoke to Zeros' token discipline).

#### `lint-packages-website` — lint outside `src`/`electron`
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Decision: do NOT extend ESLint here.** No package has an eslint config or lint script, and typed-lint over packages needs per-package `tsconfig` in `parserOptions.project` — maintenance-heavy for thin value. Instead:
  1. Fold `packages/**` and `website/marketing/**` into the **changed-files Prettier gate** (`format-check-changed`, via its `packages/**` glob) — already covers style/format drift.
  2. For type safety, rely on `typecheck-packages` (each package's own `tsc`), which catches far more than lint.
- **Covers:** Style/format drift in shared protocol/crypto and the marketing site (no check touches them today). The prettier half is **already subsumed** by `format-check-changed`; the genuinely valuable adjacent check is the per-package typecheck above.
- **Note:** `website/web-app` is an empty scaffold (README + static HTML, no `package.json`) — nothing to lint; do not gate it. Excludes `apps/0colors` per instruction.

---

### 3. Format

> The tree has **888 files** failing `prettier --check` over `src + electron` alone (never run through this prettier config wholesale). A whole-tree blocking check would fail 100% of PRs on day one. The changed-files variant is the only feasible blocking gate.

#### `format-check-changed` — Prettier on the PR's own changed files
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:**
  ```bash
  git fetch origin main
  CHANGED=$(git diff --name-only --diff-filter=ACMR origin/main...HEAD -- 'src/**' 'electron/**' 'packages/**' '*.json' '*.mjs')
  [ -z "$CHANGED" ] || pnpm exec prettier --check $CHANGED
  ```
- **Should do:** Run `prettier --check` **only** on files the PR actually touched, so a PR fails only if **it** introduced drift — independent of the 888 pre-existing dirty files.
- **Does / will do:** Prevents NEW unformatted code landing while the legacy backlog is paid down incrementally. Steadily drags the tree toward clean.
- **Covers:** Whitespace/quote/semicolon/line-width drift and unsorted Tailwind class lists. Acute here because the agent and the dev edit the same files, so inconsistent formatting compounds merge-conflict churn.
- **Runtime:** ~5–15s. · **Secrets:** none (fork-safe).
- **Caveats:**
  - Needs full git history — `actions/checkout` with `fetch-depth: 0` (or the explicit `git fetch origin main` above). Shallow checkout breaks the diff base.
  - The `[ -z "$CHANGED" ]` empty-guard is **essential** (verified: on a no-changed-files branch, running `prettier --check` with no args would check the whole repo).
  - `--diff-filter=ACMR` excludes deletes (prettier won't error on removed files).
  - On the **push-to-main** event there is no meaningful `origin/main...HEAD` range — scope this job to PRs only.
  - `prettier --check` is per-file, not per-hunk: a PR editing a legacy-unformatted file is asked to reformat the **whole** file. Strongly recommended to land a one-time `prettier --write .` baseline first (own PR; collides with concurrent WIP, so do it deliberately).
- **conductor.build:** `format`.

#### `format-check` — whole-tree Prettier (deferred)
- **Tier:** 🟡 ADVISORY (until baselined) · **Priority:** P2 · **Status:** missing
- **Command:** New `"format:check": "prettier --check ."` (+ `"format": "prettier --write ."` + a new `.prettierignore` containing `dist*`, `binaries`, `node_modules`, `dist-engine`, `*.0c`, `pnpm-lock.yaml`, `apps/0colors`).
- **Should do:** Verify every committed file matches Prettier's canonical formatting.
- **Does / will do:** Same coverage as `format-check-changed` but whole-tree.
- **Covers:** All formatting drift at once.
- **Runtime:** ~10–20s. · **Secrets:** none.
- **HARD BLOCKER:** 888 files fail `prettier --check` over `src + electron`, +16 in `packages/core`, plus `scripts/*.mjs`. A whole-tree gate fails 100% of PRs on day one. `.prettierignore` is genuinely **missing** today (only `.prettierrc.json` exists, just the tailwind plugin); without it `prettier --check .` tries to format `dist*`/binaries (gitignore is **not** honored for an explicit `.` glob). Rollout: land one `prettier --write .` normalization commit, then flip to blocking. Until then, prefer `format-check-changed`. Keep `prettier` 3.8.3 + `prettier-plugin-tailwindcss` 0.8.0 pinned identically in CI and locally.
- **conductor.build:** `format`.

---

### 4. Tests

#### `test-engine` — the existing vitest suite
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** already-in-CI
- **Command:** `pnpm test:git` (= `vitest run --config vitest.config.ts`).
- **Should do:** Run the existing ~1574-test engine/helper suite.
- **Does / will do:** Covers engine git/worktree ops, SQLite migrations & universal-storage DB, agent adapter translators & gateway, settings TOML resolution, PTY/terminal store, crypto/transport, @-mention helpers, MCP panel helpers — the deepest, most valuable coverage in the repo.
- **Covers:** A regression in the engine (the bun sidecar that owns `zeros.db`, git worktrees, all three agent backends) silently corrupts every user's data/worktrees.
- **Runtime:** ~5 min unsplit on CI. · **Secrets:** none (fork-safe).
- **Caveats / honesty:**
  - **Do NOT shard now** — premature optimization; adds CI-config + result-merge surface for a suite that isn't documented as a per-PR bottleneck.
  - Known flake surface: temp git repos exhaust macOS file handles (mitigated by `maxForks: 4`); `src/engine/git/__tests__/worktree.test.ts` `restoreWorkspace` fork failed on a clean run — env-sensitive on git version/FS. Keep on `ubuntu-latest` (cheap), not macOS.
  - **This is necessary but far from sufficient:** `vitest.config.ts` deliberately includes only plain-TS-helper globs — the React renderer, Electron main, and live-agent paths are **not** covered. "test:git green" must not be mistaken for full coverage.
- **conductor.build:** `test-roundhouse` + `test-root` + `test-packages` (vitest already globs `packages/core/src/**/__tests__` — those run today; they are HAVE, not wire-up).

#### `test-adapters` — offline agent-stream translator contract
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** script-exists-unwired
- **Command:** `pnpm test:adapters` (= `node scripts/test-adapters.mjs`).
- **Should do:** Replay committed `scripts/fixtures/*.jsonl` agent streams through the matching translators (esbuild-compiled inline) and diff emitted `sessionUpdate` sequences against `*.expected.json`.
- **Does / will do:** Verified green, fully offline, deterministic, ~3–5s. When a vendor SDK ships a new event type, the translator's `onUnknown` fires and the expected output drifts, failing fast.
- **Covers:** Agent stream-json translation drift — the integration layer the unit suite covers thinly and live smoke covers expensively. Pairs with Renovate's weekly CLI bumps.
- **Runtime:** ~3–5s. · **Secrets:** none.
- **Why advisory (low marginal value):** `TRANSLATORS` has only ONE entry (`ClaudeStreamTranslator`, the legacy stream-json path). Codex uses `CodexAppServerTranslator` (covered by vitest); Cursor uses `@cursor/sdk` (no fixture). It guards exactly one thing: the legacy Claude translator's `onUnknown` drift. Near-zero cost so wiring is harmless; expand fixtures to Codex + Cursor to raise its value. Promote to blocking only if you want the Anthropic-event early-warning to hard-gate.
- **conductor.build:** none (offline adapter-contract piece).

#### `coverage-report` — engine coverage floor
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** Add devDep `@vitest/coverage-v8`; run `pnpm test:git --coverage` with `coverage.provider: 'v8'` and a LOW initial floor (e.g. lines 55–60% on `src/engine/**` only) in `vitest.config.ts`.
- **Should do:** Emit a coverage report for the engine suite; post the summary as a PR annotation.
- **Does / will do:** Makes "you added 400 untested lines" a visible signal — today that is invisible.
- **Covers:** A PR adding a new engine module (git op, DB migration, adapter) with no tests.
- **Runtime:** +20–40% to the engine suite when `--coverage` is on. · **Secrets:** none.
- **Caveats:** Never hard-block a merge on a coverage % for a solo dev. The include globs are narrow (engine only), so a coverage number is **not** an app-coverage signal and can lull you into thinking the untested renderer/main is covered. Measure the baseline first (no tooling installed yet); scope to `src/engine/**`, not the renderer (~0%). Consider printing coverage to the job summary with **no** threshold, or skipping until the test surface broadens.
- **conductor.build:** none (implicit in their test-* discipline).

#### `agents-smoke-scheduled` — live Claude/Codex/Cursor capability matrix
- **Tier:** 🔵 SCHEDULED · **Priority:** P2 · **Status:** script-exists-unwired
- **Command:** `pnpm agents:smoke` and `pnpm cursor:smoke` — nightly cron and/or behind a PR label (e.g. `run-agent-smoke`). **NEVER on every PR.**
- **Should do:** Spawn the REAL installed+authed CLIs and run a live matrix (spawn+prompt PINGOK, context recall, mid-turn cancel, teardown).
- **Does / will do:** Tests actual auth/wiring/401s, resume/context-loss per agent, cancel classification, and SDK runtime breakage after a Renovate CLI bump — "does the agent actually work right now against the live API."
- **Covers:** The thing no offline test can. Pair with Renovate: trigger on the weekly CLI-bump PR via label.
- **Runtime:** minutes; non-deterministic. · **Secrets:** **requires live provider auth** (ANTHROPIC/OpenAI/Cursor) + the CLIs installed+authed on the runner — unavailable to fork PRs, which is the core reason it must be scheduled.
- **Caveats:** Flaky by nature (network, model nondeterminism, quota). MUST be non-blocking; treat failures as "investigate," not "block." `cursor:smoke` is actually a module-resolution/asar guard (cheaper, more deterministic — could even run per-PR on macOS without keys), but keep the pair scheduled here. **Start with manual label-trigger before a nightly cron** (keeping bundled-CLI auth green is non-trivial).
- **conductor.build:** `vercel-sandbox-smoke`.

#### `app-launch-e2e-smoke` — real Electron boot
- **Tier:** 🔵 SCHEDULED · **Priority:** P2 · **Status:** missing · **feasible = NO (blocked)**
- **Command:** **BLOCKED until an auth test-mode exists.** Sequence: (1) add a guarded test-only bypass to `src/zeros/auth/auth-gate.tsx` (e.g. an injected `ZEROS_E2E`/main-process flag rendering the shell with a stub session) — none exists today (grep for `ZEROS_E2E`/`SKIP_AUTH`/`TEST_MODE` = zero hits); (2) then `e2e/app-launch.spec.ts` using `@playwright/test` `_electron.launch` against `dist-electron/main.cjs` (after `build:sidecar` + `electron:compile` + `build:ui`); (3) on a SEPARATE scheduled `macos-latest` job. `pnpm exec playwright test e2e/` once harness + bypass exist.
- **Should do:** Boot the real app once; assert the window renders and the engine comes online.
- **Does / will do:** Catches the blank-renderer / "Waiting for engine" / preload-bridge-broken total-launch failures unit tests can never see (hooks-order crash, `exposeInMainWorld` break, engine respawn loop).
- **Covers:** "Does it open" — the floor for a desktop app, currently unguarded (`@playwright/test` is a devDep but every e2e spec lives under the excluded `apps/0colors`).
- **Runtime:** ~1–2 min on macOS. · **Secrets:** none for a no-auth boot, but the mandatory-login wall blocks reaching the main window without the bypass.
- **Caveats:** Electron E2E is the flakiest tier; needs macOS runners (CI is ubuntu) + the heaviest build path. `feasible = false` until the auth bypass product code is written; revisit as P2 after. Never per-PR; never touch `apps/0colors`.
- **conductor.build:** `vercel-sandbox-smoke`.

#### `renderer-emit-no-pii-contract` — analytics scrub call-site guard
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** partial (folds into `test:git`)
- **Command:** `pnpm test:git` with a NEW test that imports `src/zeros/analytics/agent-events.ts` while **mocking** `./posthog` (`vi.mock`) so `capture()`/`captureException()` are spies — assert every emitted prop is enum/scalar metadata (no path/email/prompt/token), and feed a fake `Error` with a path/email to `captureException` asserting `scrubError` stripped it. Add an include glob `src/zeros/analytics/__tests__/**/*.test.ts` to `vitest.config.ts` (not matched today).
- **Should do:** Assert the renderer's analytics emit path never forwards user content — only scrubbed/enum metadata.
- **Does / will do:** Locks the EMIT sites (`agent-events.ts` builders + `scrubError` at `captureException`). `core`'s `scrub.test.ts` proves the primitive works in isolation but nothing proves the renderer actually CALLS it on every emit site.
- **Covers:** A future edit adding a raw `error.message`, file path, or chat snippet to a PostHog property — a privacy incident at beta scale. The PostHog contract is "metadata-only/anonymous."
- **Runtime:** <1s (inside the existing suite). · **Secrets:** none.
- **Caveat:** Do **NOT** import `posthog.ts` directly — it pulls `import.meta.env.*` (VITE_*), `posthog-js`, `../bridge/web-target`, `../../native/runtime`. Must mock `./posthog` and target the builders. Maintain as emit sites grow (that's the point).
- **conductor.build:** none.

---

### 5. Build integrity

> Every build runs **only** in the manual `release.yml` today, so a build-broken renderer/engine/main is mergeable and ships blank. All of these are cheap and ubuntu-runnable.

#### `build-renderer` — production vite build
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** `pnpm build:ui`.
- **Should do:** Run the production vite build of the renderer bundle, exactly as `release.yml` does; fail if rollup/esbuild can't assemble the module graph.
- **Does / will do:** Catches an unresolvable import, bad dynamic `import()`/worker format, broken `@/...` alias, CSP/index.html transform error, Tailwind/PostCSS failure, missing asset, or a dep that won't bundle under rollup (stricter than vite dev's esbuild).
- **Covers:** A renderer that doesn't build = a blank window for every user. Merge = ship.
- **Runtime:** ~33s clean on ubuntu (verified). Can be ~2–5 min on slower runners (shiki ships huge per-grammar chunks; main bundle ~3.2MB). · **Secrets:** **none to PASS** — absent VITE_* resolve to `''` and the build still succeeds (fork-safe). **Do NOT inject release VITE_* secrets into PR builds** — keep it a pure compile check.
- **Caveats:** Slowest build check; consider vite/rollup caching or a separate job so it doesn't serialize behind `test:git`. Rollup transpiles, not type-checks — pair with `typecheck`, don't rely on it for type safety. Chunk-size warning is non-fatal. `dist/` is gitignored (no tree-dirtying).
- **conductor.build:** `build-main`.

#### `build-engine-bundle` — tsup engine bundle
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** `pnpm build:engine` (`node scripts/codegen-codex.mjs && tsup` → `dist-engine/cli.js`).
- **Should do:** Run the engine codegen + tsup bundle exactly as the dev/release pipeline; fail if the CJS bundle can't assemble.
- **Does / will do:** Catches a bad import, an ESM/CJS boundary break (the config externalizes ESM-only octokit + toml-patch and native modules — a wrong import yields `ERR_REQUIRE_ESM` at app boot today), a missing external, or codegen drift. `codegen-codex` early-exits when the committed `generated/.version` matches the pin and degrades without cargo — **no Rust needed in CI**.
- **Covers:** A non-building engine = a dead app (every workspace/agent/terminal dead).
- **Runtime:** ~2–5s (verified ~2s). · **Secrets:** none.
- **Caveat:** tsup esbuild **strips types and does NOT type-check** (`dts: false`) — a real TS type error sails through. Complementary to `typecheck`, not redundant. `test:git` already imports most engine modules, so the marginal new coverage is "do the non-test-imported engine files still resolve + bundle."
- **conductor.build:** `build-sidecar`.

#### `build-electron-main` — tsup main + preload
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** `pnpm electron:compile` (`tsup --config electron/tsup.config.ts` → `dist-electron/main.cjs` + `preload.cjs`).
- **Should do:** Compile the Electron main + preload to CJS exactly as `release.yml` does.
- **Does / will do:** Catches a broken import in the main (window mgmt, IPC handlers, sidecar spawn, updater, cache relocation), a preload bundle error, or an ESM/CJS break.
- **Covers:** `main.cjs` is the app entry (`package.json` `main`). If it doesn't compile, the app won't launch at all. The entire `electron/` main is outside vitest scope, so a broken import there ships unnoticed today.
- **Runtime:** ~4s (verified 333ms actual). · **Secrets:** none.
- **Caveat:** Transpile-only (pairs with `typecheck`). The "import.meta not available with cjs" esbuild warning is pre-existing and non-fatal. Frame honestly as a "does the main process still bundle" smoke.
- **conductor.build:** `build-main`.

#### `build-sidecar-binary` — bun-compile the shipped engine binary
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** partial
- **Command:** `pnpm build:sidecar`. The script **hard-exits on non-darwin** (`process.platform !== 'darwin'`). Two options: **(a)** run on `macos-latest` (proves it *boots* too, matches the release path), or **(b)** add a CI-only `bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile binaries/zeros-engine-aarch64-apple-darwin` step on ubuntu (bun **cross-compiles** the 73MB macOS-arm64 binary from a non-target host in ~1.5s, verified).
- **Should do:** Bun-compile `src/cli.ts` into the single-file engine executable electron-builder bundles as `extraResources`, proving the shipped binary actually links.
- **Does / will do:** Catches the bun-compile path diverging from tsup: a module bun's bundler can't resolve, a native-module externalization the compile rejects, or a build the dev engine tolerates but the packaged single-file binary doesn't. This is the EXACT artifact in the DMG.
- **Covers:** Today this only builds on a manual release.
- **Runtime:** ~1.5–3s on ubuntu cross-compile (verified). · **Secrets:** none. Requires bun (`oven-sh/setup-bun@v2`, already in `release.yml`).
- **Caveat:** An arm64 binary cross-built on ubuntu **cannot be executed** there — option (b) is a LINK check only. For "merge == ship-to-Mac," **prefer `macos-latest`** so the gate matches production and proves boot, at ~10x ubuntu runner cost (compile itself is sub-second; install dominates). `binaries/` is gitignored (no drift). bun `--compile` embeds the bun runtime + bundled JS (the engine uses `bun:sqlite` at runtime; `better-sqlite3` is behind a runtime branch), so no native-addon resolution failures.
- **conductor.build:** `build-sidecar`.

#### `build-website-marketing` — marketing site build
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** `pnpm --filter @zeros/marketing build` (`tsc -b && vite build`). Path-filter to `website/marketing/**`.
- **Should do:** Build the marketing site (which DOES type-check via `tsc -b`, then `vite build`).
- **Does / will do:** It deploys via **Cloudflare Pages Git integration straight off `main` with no workflow gate**, so a build break ships a broken public homepage/changelog with no CI catch today. **This is the one build gate that actually catches type errors before merge.**
- **Covers:** The public face of the product; the repo memory notes a latent broken-import class here historically (dead `--background` token imports / uninstalled deps that silently broke the build).
- **Runtime:** ~9s (verified; `tsc -b` ~5s + vite ~4s). · **Secrets:** none.
- **Caveat:** Marketing is a SEPARATE vite (6.x) + tailwind (4.1.x) from the root (vite 7.x); `pnpm install` covers its node_modules (it's in the workspace). Gate **just the build** — no screenshot/visual check (too flaky to block). Path-filter so it's free on app-only PRs.
- **conductor.build:** none (loosely Vercel Preview).

#### `build-feedback-worker-dry-run` — wrangler dry-run
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** `cd packages/feedback-intercom-webhook && npx wrangler@4 deploy --dry-run --outdir /tmp/fb-worker-dry`. Path-filter to `packages/feedback-intercom-webhook/**`.
- **Should do:** Run wrangler's build/bundle in dry-run to confirm the Worker compiles and `wrangler.jsonc` is valid, without publishing.
- **Does / will do:** Catches a Worker that won't bundle or has an invalid config — currently NO build gate; it's deployed by a human via `wrangler deploy`.
- **Covers:** Bundle errors, bad bindings, config drift before a real deploy.
- **Runtime:** ~10–20s (npx cold-fetches `wrangler@4` first time; cache it). · **Secrets:** **none for `--dry-run`** (no token/account; exits before auth; fork-safe).
- **Caveat:** `--dry-run` esbuild-bundles but does NOT run full tsc — the worker's own `typecheck` script (covered by `typecheck-packages`) is the stronger, faster, fully-offline gate and should be primary; this is a secondary "config still valid" smoke. Worker changes rarely; advisory + path-filtered.
- **conductor.build:** loosely `validate`.

#### `electron-pack-smoke` — full electron-builder package
- **Tier:** 🔵 SCHEDULED · **Priority:** P2 · **Status:** partial
- **Command:** `pnpm electron:build` (= `build:sidecar` + `electron:compile` + `build:ui` + `electron-builder --config electron-builder.yml`). For a no-publish smoke: `pnpm exec electron-builder --config electron-builder.yml --publish never --dir`.
- **Should do:** Actually PACKAGE the app end-to-end on a macOS runner: rebuild native modules (node-pty, better-sqlite3) against Electron's ABI, run the `afterPack` ad-hoc-sign hook, produce/lay-out the `.app`.
- **Does / will do:** Catches packaging-only failures invisible to every other check: native-module ABI rebuild breakage (the `NODE_MODULE_VERSION` trap), missing `asarUnpack` globs for a lazy Cursor/PTY require, broken `extraResources` paths (sidecar binary name must match `to: zeros-engine`), `afterPack` failures, Info.plist/protocol-handler regressions.
- **Covers:** The ONLY check that proves the shipped artifact is real.
- **Runtime:** ~5–12 min on `macos-latest`. · **Secrets:** **none to PASS unsigned** (`identity: null` + ad-hoc `afterPack`; the hook self-skips on `CSC_LINK`, so it won't clobber a future Developer-ID signature). A future signed/notarized smoke needs `CSC_*`/`APPLE_*` and would block fork PRs.
- **Caveat:** Most expensive + flakiest (native rebuild + network for cached tooling). NOT per-PR. Largely re-covers `build-sidecar` + `electron:compile` + `build:ui`; the new signal is asar packing + `asarUnpack` glob + `afterPack` codesign (and `check:cursor-asar` already guards the asarUnpack closure separately). Run nightly + pre-release; it already runs inside `release.yml`.
- **conductor.build:** `build-main`.

#### `engine-sidecar-boot-smoke` — run the engine entry under bun
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** Per-PR (ubuntu): add a `ZEROS_ENGINE_SELFTEST=1` branch in `src/cli.ts` that statically imports the engine graph (`engine/index` + each adapter + db modules) then `process.exit(0)`, and run `ZEROS_ENGINE_SELFTEST=1 bun run src/cli.ts selftest`. Wire as `pnpm engine:boot-smoke`. Scheduled (macos): `pnpm build:sidecar && ./binaries/zeros-engine-aarch64-apple-darwin --help`.
- **Should do:** Actually RUN the engine entrypoint under bun (the production runtime) so a bun-incompatible import or top-level-await failure surfaces before merge.
- **Does / will do:** Catches the recurring "works under node, 0 bytes / throws under bun" family (node-pty under bun, `@cursor/sdk` http2 under bun, better-sqlite3 ops throw under bun). `build:sidecar` only COMPILES — bun's compiler does not execute module top-level code, so a runtime-fatal import passes the build and dies on first launch.
- **Covers:** The single most-recurring root cause in this codebase's memory.
- **Runtime:** ubuntu proxy ~3–5s; macOS full-binary boot ~10s. · **Secrets:** none for `--help`/`selftest` (exits before any agent spawn).
- **Caveat:** **`bare bun run src/cli.ts --help` is NOT sufficient** — `--help` returns at `cli.ts:148` BEFORE the dynamic `await import('./engine/index')` (`cli.ts:40`), loading only two trivial top-level imports, so it MISSES exactly the bun-incompatible-import class it targets. The selftest entry MUST import the adapter/db graph **eagerly**. Keep advisory until the selftest entry is proven stable. The ubuntu proxy won't catch macOS-only `dlopen` failures (needs the scheduled macOS run).
- **conductor.build:** `test-roundhouse`.

#### `native-module-electron-abi-smoke` — native addons under Electron ABI
- **Tier:** 🔵 SCHEDULED · **Priority:** P1 · **Status:** script-exists-unwired
- **Command:** On `macos-latest` (the only host with the real Electron ABI): `pnpm electron:rebuild` then `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "require('better-sqlite3')(':memory:').prepare('select 1').get(); require('node-pty')"` and assert exit 0. (`electron-rebuild-sqlite.cjs` already does a construct-DB load-test — lift that into a CI step.)
- **Should do:** Load the two native addons against Electron's actual `NODE_MODULE_VERSION` after `npmRebuild`, proving the packaged app won't hit an ABI-mismatch brick.
- **Does / will do:** Catches the documented "NODE_MODULE_VERSION 127≠130 → Couldn't create workspace" trap where `electron-rebuild` silently no-ops after a `pnpm install` and better-sqlite3 loads for host-node but throws under Electron.
- **Covers:** A packaged user can't run `electron-rebuild` to recover, so this bricks workspace creation in the shipped app.
- **Runtime:** ~2–4 min on macOS (from-source rebuild dominates). · **Secrets:** none.
- **Caveat:** `buildDependenciesFromSource: true` mitigates at pack time, but the failure mode (ABI mismatch silently accepted) is severe and recurring. macOS-runner cost → scheduled. Won't catch the Linux-CI `@parcel/watcher` self-register issue (already worked around in vitest forks config).
- **conductor.build:** none.

---

### 6. Repo-specific guards

#### `check-cursor-asar` — @cursor/sdk asarUnpack closure
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** script-exists-unwired
- **Command:** `pnpm check:cursor-asar` (= `node scripts/check-cursor-asar-unpack.mjs`).
- **Should do:** Load `@cursor/sdk`, walk `require.cache` to compute its real runtime `require()` closure (top-level package keys), and assert every package is covered by an `asarUnpack` glob in `electron-builder.yml`. Closure-but-not-unpacked = hard error (exit 1); unpacked-but-unused = warning (exit 0, with `ALLOW_UNUSED`).
- **Does / will do:** Catches the single most dangerous silent ship-breaker — the Cursor SDK host runs under `ELECTRON_RUN_AS_NODE` (asar disabled), so any package it `require()`s at load that isn't asar-unpacked throws `MODULE_NOT_FOUND` in the packaged DMG. Cursor is dead for every user with NO dev signal (unit tests mock the transport).
- **Covers:** Drift introduced by Renovate's weekly `@cursor/sdk` bump, by adding a dep, or by editing the `asarUnpack` list.
- **Runtime:** ~2–5s. · **Secrets:** none. (Requires `@cursor/sdk` + its native sqlite3 binding installed — true after `pnpm install --frozen-lockfile`; the SDK loads under plain Node, no Electron needed.)
- **Caveat:** PASSES on HEAD (9-package closure fully covered), so wiring blocking costs nothing today. Resolves the SDK from the installed copy — a Renovate bump that adds a transitive dep is exactly when this catches drift. A dep `require()`d only lazily during an authed run won't appear here (that's what `check-cursor-host-smoke` partially covers). **Also add this to per-PR `test.yml` — it is fast, secret-free, deterministic, and a drift silently bricks Cursor in the DMG.**
- **conductor.build:** none (custom-guard class, like `check-catalog`).

#### `check-cursor-host-smoke` — spawn the real Cursor host
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** script-exists-unwired
- **Command:** `pnpm cursor:smoke` (= `node scripts/cursor-host-smoke.mjs`).
- **Should do:** Spawn the real `cursor-host.cjs` subprocess exactly as the engine does, drive a minimal protocol round-trip (`ready` / `store.open` / `models.list`), and assert `ready` (not `fatal`) with no `MODULE_NOT_FOUND` on stderr.
- **Does / will do:** Proves `require(@cursor/sdk)` + its eager sqlite3 (bindings/file-uri-to-path native chain) + undici all resolve when the host actually executes — closes the "lazy `require()` at runtime" gap the static guard explicitly cannot cover.
- **Covers:** A missing module that only surfaces when the host runs. Uses `sk-smoke-invalid`; only module resolution must succeed, not the API call.
- **Runtime:** ~10–20s (subprocess + protocol round-trip). · **Secrets:** none.
- **Caveat:** Runs the host under plain `node`, NOT the packaged-app `ELECTRON_RUN_AS_NODE` against `app.asar.unpacked` — so it does NOT exercise the asar boundary and is a strictly weaker proxy than `check-cursor-asar` on that surface; it mostly adds lazy-require coverage. 20s subprocess spawn = mild flake risk for a blocker. Advisory.
- **conductor.build:** `vercel-sandbox-smoke`.

#### `check-settings-schema-drift` — published JSON-schemas vs zod
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** missing
- **Command:** `pnpm schemas:build && git diff --exit-code -- website/marketing/public/schemas/`.
- **Should do:** Re-run `scripts/build-settings-schemas.ts` (zod source `src/engine/settings/schema.ts` → `settings.schema.json` + `settings.repo.schema.json`) and fail if the regenerated files differ from committed. The committed files are published at `zeros.build/schemas/` and referenced by every `settings.toml`'s `$schema`.
- **Does / will do:** Catches schema drift between the engine's actual settings contract and the public JSON-schemas users' editors validate against.
- **Covers:** Stale `$schema` makes valid config look invalid (and invalid look valid) in a beta user's editor.
- **Runtime:** ~3–6s (tsx, already a devDep). · **Secrets:** none.
- **STRONG FINDING — RED on `main` right now:** the committed `settings.repo.schema.json` is **missing** `file_include_globs` and the **entire `mcp.servers` block** that the zod source already emits, plus `claude_code`/`codex` effort defaults and many descriptions. Fix-then-wire order: run `pnpm schemas:build`, **commit the regenerated schemas**, THEN add the blocking check (else CI is red on first run). Diff is sensitive to zod's JSON-schema serializer version — re-verify on zod bumps.
- **conductor.build:** none (their `validate` family).

#### `check-vite-secret-set-sync` — VITE_* wired into release.yml
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-vite-env-sync.mjs` (NEW). (1) collect `VITE_*` names from `src/` (`import.meta.env.VITE_*`); (2) assert each is documented in `.env.example`; (3) assert the **PROD_REQUIRED** subset (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_POSTHOG_KEY_PROD`, `VITE_FEEDBACK_URL`, `VITE_FEEDBACK_TOKEN`; optional-but-injected `VITE_POSTHOG_HOST`/`VITE_APP_BASE_URL`) is present in the `env:` block of `release.yml`'s `build:ui` step. Parse the YAML env block; **never read secret values**. Deliberately exclude dev-only (`VITE_POSTHOG_KEY_DEV`) and web-build-only (`VITE_ZEROS_TARGET`) via the allowlist.
- **Should do:** Make the prod VITE_ secret-set a first-class, reviewable invariant.
- **Does / will do:** Catches the exact production-build-shipped-broken bug — a VITE_ secret used by the app but NOT wired into `release.yml` ships a DMG without it → Supabase login throws at launch, analytics + feedback go dark, with no failing test. VITE_ values are inlined at BUILD time and `.env` is gitignored (absent in CI).
- **Covers:** The highest-severity, hardest-to-notice failure for a login-gated beta. Verified gap: `src` uses 8 VITE_ vars, `.env.example` documents 8, `release.yml` injects 7 (correctly omits the DEV key) — a naive equality check would false-positive, which is why the explicit allowlist is required.
- **Runtime:** <1s (pure string parse, zero deps). · **Secrets:** **none** (checks NAMES only, never values; fork-safe).
- **Caveat:** The PROD_REQUIRED allowlist must be hand-maintained when a genuinely new prod VITE_ var is added — that edit is the point (forces a conscious decision). Must NOT do naive set-equality.
- **conductor.build:** none.

#### `check-packaging-paths-exist` — electron-builder path resolution
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-packaging-paths.mjs` (NEW). Parse `electron-builder.yml`; assert every on-disk SOURCE path resolves: `extraResources[].from` (`src/engine/pty/pty-host.cjs`, `src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs`), `afterPack` (`./scripts/electron-after-pack.cjs`), `mac.icon` (`build/icons/icon.icns`), dmg layout. For the engine binary, assert the BUILD step's output name (from `scripts/build-sidecar.mjs`'s mapping) **byte-matches** the `extraResources` `from` — do NOT stat the gitignored binary. Exit 1 on any missing/renamed path. Wire as `pnpm check:packaging-paths`.
- **Should do:** Statically confirm every file path `electron-builder.yml` points at resolves, and the sidecar output name matches what packaging copies in.
- **Does / will do:** Catches a renamed/moved `cursor-host.cjs`/`pty-host.cjs`, missing `icon.icns`, an `afterPack` typo, or a `build:sidecar` output-name change that desyncs from `extraResources`. **electron-builder does NOT fail on an `extraResources` `from` that matches zero files** — the filter just yields nothing → a packaged `.app` that boots into a broken engine/PTY/Cursor with no compile error.
- **Covers:** The "packaged Cursor dead / engine silently exits with no log trail" class the memory documents. `check:cursor-asar` validates the require() CLOSURE but never that the host files themselves exist at the referenced paths.
- **Runtime:** <2s. · **Secrets:** none.
- **Caveat:** Tiny YAML parse; must tolerate the build-time-generated engine binary not existing pre-build (name-match against the build constant, don't fs-stat it). Pair with `release-pipeline-pre-gate` for full packaging coverage.
- **conductor.build:** none.

#### `check-codex-protocol-pin-sync` — Codex protocol triple
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-codex-pin-sync.mjs` (NEW). Assert three values agree: (a) installed `@openai/codex` version (`node -p "require('@openai/codex/package.json').version"`), (b) `package.json#codexProtocolVersion`, (c) `src/engine/agents/adapters/codex/generated/.version` (first non-comment line). Mismatch → exit 1 telling the dev to run `pnpm codegen:codex`. Wire as `pnpm check:codex-pin`. (The regen-and-`git diff` portion needs cargo+network → schedule that half separately.)
- **Should do:** Lock the Codex app-server protocol triple (installed CLI ↔ pin ↔ committed bindings) so they can't silently diverge.
- **Does / will do:** Catches a Renovate/manual bump of `@openai/codex` (renovate bumps it) **without** re-running `codegen:codex`: the committed bindings stay at the old protocol, `codegen-codex.mjs` early-exits because `.version` still matches the unchanged pin, and the app talks a stale protocol to a newer codex binary — a wire mismatch no typecheck/test catches (the bindings are internally self-consistent).
- **Covers:** The exact silent drift that ships a broken Codex agent. `models:verify` gates the Claude SDK version; there is NO equivalent for the Codex triple.
- **Runtime:** <2s for the triple-compare (offline). · **Secrets:** none.
- **Caveat:** Verified all three currently equal `0.139.0`; `generated/` is git-tracked. Keep the per-PR gate to the pure offline triple-compare; run the regen-diff only when `@openai/codex` or `codexProtocolVersion` changed (dep/path filter), as full regen needs cargo+network.
- **conductor.build:** `validate`.

#### `settings-and-catalog-parse-validity` — all static configs parse + validate
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** partial (folds into `test:git`)
- **Command:** Add as a Vitest test (`src/zeros/agent/__tests__/static-configs-validity.test.ts`) inside `test:git`, NOT a new `pnpm check:configs` step. PREREQ: add `ajv` + `ajv-formats` as **real** devDeps (currently only transitive in `.pnpm` — `require('ajv')` throws `MODULE_NOT_FOUND`). Test body: (1) Ajv (`strict:false`) + ajv-formats, compile `catalogs/providers-v1.schema.json`, validate `catalogs/providers-v1.json` (the real gap — `models:verify` never touches providers-v1); (2) `smol-toml` parse (a direct dep) committed `.conductor/*.toml` + `.zeros/*.toml` fixtures; (3) `JSON.parse` `renovate.json` + `website/marketing/public/schemas/*.json`; (4) `packages/feedback-intercom-webhook/wrangler.jsonc` via a **JSONC** parser (`jsonc-parser`/`strip-json-comments` — plain `JSON.parse` FAILS on its comments); `electron-builder.yml` via a **YAML** parser.
- **Should do:** Parse-and-schema-validate every static config the app/build reads at runtime.
- **Does / will do:** Catches a malformed `providers-v1.json` (only `models-v1` is strictly verified today), a settings default TOML the engine fails to parse at boot, a corrupt published settings JSON-schema, or an invalid `electron-builder.yml`/`wrangler.jsonc` — each hand-edited with no compiler, several loaded at startup so a break is a launch failure.
- **Covers:** The hand-maintained (not codegen) files; a trailing comma in one is a silent runtime break.
- **Runtime:** <2s (inside the existing suite). · **Secrets:** none.
- **Caveat:** `providers-v1` validates clean today, so the gate goes green now and only fails on future regressions. Use the correct parser per format (JSONC for wrangler, YAML for builder, TOML for settings). Overlaps slightly with `check-settings-schema-drift` (that checks DRIFT; this checks VALIDITY). Do NOT touch `apps/0colors`.
- **conductor.build:** `check-catalog`.

#### `wire-protocol-compat-guard` — PROTOCOL_VERSION bump reminder
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** Phase 1 (ship only this): a guard that `git diff`s `packages/core/src/{version.ts,messages.ts,agent-events.ts,agent-messages.ts,schemas.ts}` against `origin/main`; if ANY of the 4 schema files changed but `version.ts` `PROTOCOL_VERSION` did NOT, FAIL with a reminder to consider a bump. (Phase 2, the AST "removed/renamed/required-narrowed exported field" heuristic, stays out — too false-positive-prone.)
- **Should do:** Enforce the documented PROTOCOL_VERSION bump discipline so version-skewed phones/web/CLI reject cleanly instead of mis-parsing frames.
- **Does / will do:** Reminds you when a `@zeros/core` wire message shape changed without a version bump (the handshake only protects you if PROTOCOL_VERSION actually changed when the shape did).
- **Covers:** A field added/removed/renamed that a stale phone/web client (app-store review lag = guaranteed skew, per `version.ts`'s own comment) silently mis-decodes. Single-writer engine serves Mac/web/CLI/mobile over this exact wire.
- **Runtime:** <5s. · **Secrets:** none (needs `origin/main` → `fetch-depth: 0`).
- **Caveat:** The file-touch heuristic is coarse (a prompt-to-think, not a precise gate). Keep advisory; ship only the file-touch half. Verified all 5 files exist; `PROTOCOL_VERSION=2`/`MIN_SUPPORTED_PROTOCOL=2`.
- **conductor.build:** none.

---

### 7. Security & supply chain

> The app has ZERO security/supply-chain checks in CI today, while its Electron hardening (contextIsolation/sandbox/CSP/nav-guards) is correct — and unguarded against regression.

#### `secret-scan-gitleaks` — source secret scan (PR diff)
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `gitleaks/gitleaks-action@v2` (pinned) in a new `.github/workflows/security.yml` (PR + push), with a committed `.gitleaks.toml` whose `[allowlist]` **EXCLUDES `apps/0colors`** (and `node_modules`, `*.example`, `pnpm-lock.yaml`). Custom rules tuned for this repo: `phx_`/`phc_` (PostHog), `sb_secret_` (Supabase service key), `sk-ant-`/`sk-` (Anthropic/OpenAI), `ghp_`/`gho_`/`github_pat_` (GitHub PAT), `AKIA` (AWS).
- **Should do:** Scan the PR diff for committed secrets.
- **Does / will do:** Stops a real, present risk: `POSTHOG_PERSONAL_API_KEY` (`phx_` read/write) or any `sb_secret_`/provider key getting git-committed. `.env` is gitignored, but a dev/agent can `git add -f .env`, paste a key into a tracked file, or hardcode one.
- **Covers:** A desktop bundle ships to every user's machine; a leaked read/write PostHog or Supabase key in git history is account-takeover-grade and permanent.
- **Runtime:** 10–20s. · **Secrets:** none (`GITHUB_TOKEN` only; free; fork-safe).
- **Caveat (medium confidence — get the allowlist right):** A repo-wide scan is RED/noisy on **`apps/0colors`** (the one surface the user said to skip) — `git grep` for `sk-*`/JWT/`PRIVATE KEY` matched ONLY `apps/0colors/.../supabase/info.tsx` + a 0colors doc. The `.gitleaks.toml` MUST allowlist `apps/0colors` or first run fails on excluded code. `.env.example` placeholders + a `ghp_xxxx` placeholder in `github-section.tsx` must be allowlisted too. Use the pinned Action (gitleaks is NOT installed locally; the `dir`/`detect` subcommand form is version-dependent — the Action abstracts it).
- **conductor.build:** none (closest is their AI reviews).

#### `secret-scan-history-scheduled` — full git-history scan
- **Tier:** 🔵 SCHEDULED · **Priority:** P1 · **Status:** missing
- **Command:** Weekly cron + `workflow_dispatch`: `actions/checkout` with `fetch-depth: 0`, then `gitleaks/gitleaks-action@v2` (or `gitleaks detect --source . --redact --log-opts="--all"`) using the **same `.gitleaks.toml`** as the per-PR job.
- **Should do:** Scan the ENTIRE git history (425 commits, all branches), not just the PR diff.
- **Does / will do:** A secret committed historically then deleted later is invisible to a diff-only scan but still extractable. Establishes a known-clean baseline + re-checks weekly. (Probe confirms tracked files are clean today; only doc/placeholder hits.)
- **Covers:** Force-pushed or pre-gate leaks the diff scan missed.
- **Runtime:** 30–90s on 425 commits. · **Secrets:** none.
- **Caveat:** Only worthwhile **alongside** the per-PR gitleaks gate (else a fresh key leaks for up to a week). If a real historical secret is found: rotate the key (mandatory), optionally rewrite history; don't block PRs on history findings — surface as an issue/alert.
- **conductor.build:** none.

#### `electron-hardening-invariants` — assert the security posture
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-electron-hardening.mjs` (NEW). Parse `electron/main.ts` + `electron/preload.ts`; assert: `contextIsolation===true`, `nodeIntegration===false`, `sandbox===true` in every `BrowserWindow` `webPreferences`; preload uses only `contextBridge`/`ipcRenderer` (no `require('fs')`/`child_process`/`net` exposure); no `webSecurity:false`/`allowRunningInsecureContent:true`/`enableRemoteModule`; a `setWindowOpenHandler` + `will-navigate` guard exist; CSP injection present. Exit 1 on any violation. Wire as `pnpm check:electron-hardening`.
- **Should do:** Encode the already-correct posture (`main.ts:358-364`, nav guards, CSP) as a regression test.
- **Does / will do:** Prevents the classic Electron RCE chain from regressing — someone flips `sandbox:false`/`nodeIntegration:true` "to debug," adds a second `BrowserWindow` without the flags, removes the `will-navigate` guard, or sets `webSecurity:false`. These are one-line edits away.
- **Covers:** The highest-impact desktop vuln (renderer XSS → full RCE on the user's machine).
- **Runtime:** 1–3s (static scan, no build). · **Secrets:** none.
- **Caveat:** Posture is correct TODAY (verified) → the guard is cheap and stays green. Write the assertion against THIS codebase's exact shape (single window; CSP split across `vite.config.ts` + `main.ts`; `main.ts` **intentionally** strips `X-Frame-Options`/`frame-ancestors` via `installIframeHeaderStripping` and allows http/https in `frame-src` for browser-tab iframes) — keep the invariant set narrow (the 5–6 listed) so it doesn't fight the deliberate iframe design. Sits next to the existing `check:preload` guard.
- **conductor.build:** none (their `react-doctor` is renderer-only).

#### `dep-audit-high` — `pnpm audit` advisory
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** `pnpm audit --prod --audit-level=high`, with an allowlist (`scripts/audit-ignore.json` or `pnpm audit --ignore <id>`) for the known vendored-SDK transitive vulns. Run as a non-blocking comment on PRs that change `pnpm-lock.yaml`/`package.json`.
- **Should do:** Report prod-dependency advisories at high+ severity.
- **Does / will do:** Surfaces a newly-introduced vulnerable dep at the moment it enters the lockfile.
- **Covers:** Supply-chain regressions in first-party deps.
- **Runtime:** 5–15s (needs registry network). · **Secrets:** none.
- **Caveat (must be advisory):** `pnpm audit --prod` is already **55 vulns / 16 high**, and EVERY high path is transitive through vendored agent SDKs (`@cursor/sdk>sqlite3>tar`, `@cursor/sdk>@connectrpc>undici`, `@modelcontextprotocol/sdk>ajv/hono`) or pinned `react-router`/`ws` — none fixable without upstream SDK bumps Renovate already lands weekly. A blocking gate would be permanently red and trained-to-ignore. **Largely redundant with Dependabot — if Dependabot is enabled, consider dropping this** to avoid ignore-list maintenance.
- **conductor.build:** none.

#### `osv-dependabot-scheduled` — continuous advisory stream
- **Tier:** 🔵 SCHEDULED · **Priority:** P1 · **Status:** missing
- **Command:** Enable GitHub Dependabot alerts + security updates (`.github/dependabot.yml`, npm ecosystem, weekly, **security-updates only**) OR a scheduled `osv-scanner --lockfile=pnpm-lock.yaml`.
- **Should do:** Continuously cross-reference the committed lockfile against the OSV/GitHub Advisory DB; open alerts when a new CVE lands against an already-installed version (no lockfile change needed to be exposed).
- **Does / will do:** Fills the gap `pnpm audit`-on-PR misses — a dep you already ship becomes vulnerable AFTER merge.
- **Covers:** Native-module deps (electron, better-sqlite3, node-pty) whose CVEs actually matter for a packaged desktop app. **Best ROI of the supply-chain items: zero-maintenance once enabled, never blocks a PR.** Renovate today only bumps the 3 agent CLIs — there is currently NO automated security advisory stream.
- **Runtime:** n/a (platform) or ~10s for osv-scanner. · **Secrets:** none.
- **Caveat:** Dependabot + Renovate can both open dependency PRs — scope `dependabot.yml` to **security-updates only** (or alerts-only) so it doesn't fight Renovate. Expect initial alert noise from unfixable SDK transitives. **Prefer this over `dep-audit-high`.**
- **conductor.build:** none (platform-level).

#### `codeql-js-ts` — SAST taint analysis
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** `github/codeql-action` analyze, `languages: javascript-typescript`, query suite `security-extended`. New `.github/workflows/codeql.yml` — on PR + weekly.
- **Should do:** Static taint/dataflow for injection, path-traversal, prototype-pollution, unsafe-deserialization, command-injection, hardcoded-credential patterns.
- **Does / will do:** Catches taint flows from untrusted input (a relay/remote client, a malicious repo) to a process-spawn or fs sink. The engine spawns child processes (`pty-host.cjs`, `cursor-host.cjs`, codex), reads/writes by path with a hand-rolled `.env` deny-gate (`read-file.ts`), runs git, bridges renderer→main IPC.
- **Covers:** Command-injection/path-traversal/unsanitized-IPC-arg sinks unit tests won't — relevant as the app goes multi-user with a relay.
- **Runtime:** 3–8 min (autobuild + analyze). · **Secrets:** none (`security-events: write` on the default token).
- **Caveat:** Heaviest/slowest item, most false-positive triage. Keep scheduled + advisory, never blocking (a per-PR CodeQL gate adds 5–15 min + noisy alert churn). Lower priority than the source gitleaks gate, the electron-hardening guard, and Dependabot.
- **conductor.build:** partial — maps to their AI-review pair (`claude`/Greptile/`react-doctor`) as the deterministic counterpart.

#### `license-file-and-attribution` — LICENSE present + license scan
- **Tier:** 🔴 BLOCKING (part a) + 🔵 SCHEDULED (part b) · **Priority:** P1 · **Status:** missing
- **Command:**
  - **(a) BLOCKING:** `node scripts/check-license-present.mjs` asserting a top-level `LICENSE` file EXISTS and matches the SPDX id in `package.json` (`"license":"MIT"`). **Fails today — NO `LICENSE` file is committed.**
  - **(b) SCHEDULED:** `pnpm exec license-checker-rseidelsohn --production --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense;Python-2.0' --excludePackages '@withso/zeros'` to flag copyleft/unknown licenses entering the shipped binary's dep tree.
- **Should do:** Add the missing LICENSE gate + a scheduled copyleft scan.
- **Does / will do:** (a) `package.json` claims MIT but ships with no LICENSE text — a distribution/attribution defect for a public binary. (b) A transitive dep flipping to GPL/AGPL/SSPL/unknown in a binary distributed to many users = real legal exposure.
- **Covers:** A concrete legal/compliance gap distinct from CVE audits (`pnpm audit` covers vulns, not license terms).
- **Runtime:** present <1s; scan ~10–20s. · **Secrets:** none.
- **Caveat:** Split the tiers — the LICENSE-present check is a one-line blocking fix for a defect that exists right now; the dependency scan as a per-PR blocker is net-negative (pulls an uninstalled tool over the network every PR, slow on a large tree, drift only on dep change) → scheduled with an ignore-list.
- **conductor.build:** none.

#### `renderer-bundle-secret-guard` — no read/write key in the bundle
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** `node scripts/check-bundle-secrets.mjs` that **reuses the release `dist/`** (don't run a standalone `vite build` just for this — it adds ~2 min) and greps `dist/assets/*.js` ONLY for forbidden token prefixes (`sk-ant-`, `sk-`, `ghp_`, `gho_`, `github_pat_`, `phx_`, `sb_secret_`, service_role JWT patterns). Do NOT flag VITE_* values — `VITE_FEEDBACK_TOKEN` and the Supabase publishable/anon key are bundled BY DESIGN.
- **Should do:** Assert the shipped bundle contains no read/write secret prefix.
- **Does / will do:** Encodes the invariant that only VITE_-prefixed (RLS-gated / write-only) keys may reach client code. Today only Vite's default VITE_-only inlining protects this — undocumented-by-test.
- **Covers:** A stray `import.meta.env.POSTHOG_PERSONAL_API_KEY`, a `define()` leak, or a var renamed without the `VITE_` prefix shipping a `phx_`/`sb_secret_` key in the `file://` bundle (asar is not encryption — trivially readable on disk).
- **Runtime:** 0s reusing an artifact; ~60–120s if it builds its own. · **Secrets:** VITE_* optional (the grep only looks for FORBIDDEN tokens; empty values fine, fork-safe).
- **Caveat:** Blocking is too heavy — a per-PR `vite build` purely for a grep more than triples the gate, and the high-value secrets (`sk-ant-`, `ghp_`) are caught earlier + cheaper by `secret-scan-gitleaks` on SOURCE. Keep as a cheap advisory step appended to `release.yml`'s existing `build:ui`. Scope grep to JS chunks, not sourcemaps; anchor on key-VALUE prefixes.
- **conductor.build:** none.

---

### 8. Migrations & data safety

> Two migration surfaces, zero CI protection against the one mistake that corrupts existing users: editing/reordering an already-released migration.

#### `sqlite-migration-forward-only-guard` — append-only enforcement
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-migrations-forward-only.mjs` (NEW). At both `origin/main` and `HEAD`, **transpile+import** `src/engine/db/migrations.ts` and serialize `MIGRATIONS` to JSON of `{version,name,up}` (via tsx/esbuild), then assert every `(version,name,up)` on `main` is present-and-identical on `HEAD`, and `HEAD` only ADDS `version > max(main)`. Workflow needs `fetch-depth: 0` (or explicit `git fetch origin main`).
- **Should do:** Fail if any released migration's version, name, or `up` SQL was changed, reordered, or deleted — only brand-new, higher-versioned entries allowed.
- **Does / will do:** Catches the single most destructive class — silently editing migration N after users ran N. `runMigrations()` skips versions already in `schema_migrations`, so an edited old migration NEVER re-runs on existing users → their `zeros.db` permanently diverges from new installs → wrong-schema reads, FTS/trigger drift, unrecoverable loss of chats/transcripts.
- **Covers:** `zeros.db` is the sole copy of each beta user's chats/transcripts/workspaces/settings, on their Mac only. The file header already mandates append-only, but a solo dev rebasing/squashing can trivially violate it.
- **Runtime:** <3s. · **Secrets:** none (`fetch-depth: 0`).
- **Caveat:** **Implement via structural extraction (import+serialize), NOT byte-regex** — the `up` bodies are multi-line template-literal consts (`INITIAL_SCHEMA`, `MIGRATION_2_PROJECTS`, …) referenced from `MIGRATIONS`, so a naive regex won't capture them. Low false-positive once structural.
- **conductor.build:** `postgres-migration-guard` (same forward-only intent, SQLite side).

#### `sqlite-migration-sequence-lint` — structural shape (fold into db.test.ts)
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** Add assertions to the existing `src/engine/db/__tests__/db.test.ts` (NOT a new mjs/CI step): versions are `1..N` contiguous, unique, array index order matches ascending version, each entry has non-empty `name`+`up`, `latestSchemaVersion() === max(version)`.
- **Should do:** Statically validate the `MIGRATIONS[]` shape.
- **Does / will do:** Catches sequencing footguns the runner tolerates silently: a duplicate version (`INSERT OR IGNORE` → the second `up` runs but is never recorded → re-runs every boot → repeated CREATE/ALTER throws), a version gap, or an out-of-order entry.
- **Covers:** Copy-paste mistakes (two migrations both 17, or 16→18) at PR time rather than as a boot-loop on a user's machine.
- **Runtime:** <1s. · **Secrets:** none.
- **Caveat:** Redundant as a new gate — fold into `db.test.ts` (already in `test:git`). As a separate blocking script it is net maintenance with little marginal coverage over the forward-only guard.
- **conductor.build:** none.

#### `sqlite-migration-fresh-to-head-test` — clean-install ladder (extend db.test.ts)
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** partial
- **Command:** `pnpm test:git` — add the MISSING assertions to the existing `db.test.ts` (a standalone new file would duplicate ~90%). Open a fresh `:memory:` DB via `setZerosDbPathForTesting` + `openZerosDb` (runs the WHOLE ladder empty→head), assert `schema_migrations === [1..latestSchemaVersion()]`, assert all expected tables/indexes/FTS/triggers exist, then run `runMigrations` again and assert it is a no-op (idempotent).
- **Should do:** Boot a brand-new DB through the entire ladder, proving a clean install succeeds and is idempotent.
- **Does / will do:** Catches a new migration whose SQL is malformed, references a missing column/table, or breaks an FTS trigger — the "app won't open for a fresh install / new user" failure. The current `db.test.ts` hard-codes `[1..16]` and asserts only a final table set.
- **Covers:** New users can open the DB. Version-count-agnostic.
- **Runtime:** <1s (inside the existing suite). · **Secrets:** none.
- **Caveat:** Uses the Node (better-sqlite3) driver under vitest; bun-specific behavior isn't exercised, but the SQL is identical. Make it version-count-agnostic (drop the hardcoded `[1..16]`).
- **conductor.build:** `test-roundhouse`.

#### `sqlite-migration-upgrade-path-test` — existing-user upgrade with data
- **Tier:** 🔴 BLOCKING · **Priority:** P0 · **Status:** missing (folds into `test:git`)
- **Command:** `pnpm test:git` — new test. Seed `schema_migrations` with `MAX(version)=N-1` plus representative rows in the tables migration N touches, then call the REAL `runMigrations(db)` for the final hop and assert: the new migration applied, pre-existing rows survived intact, and any backfill (e.g. the v5 content backfill, v7 `backupNonEmptyV1Tables`) produced correct values.
- **Should do:** Simulate an EXISTING user upgrading — start from a populated older schema and run the newest migration on top, asserting no data loss + correct backfills.
- **Does / will do:** Catches the upgrade-only data-loss class a fresh→head test cannot see: an ALTER/DROP/backfill that works on an empty DB but loses/corrupts data when rows already exist (exactly what `backupNonEmptyV1Tables` was written to mitigate for v7, which DROPs sessions/messages/policies/workspaces and relies on a runtime backup).
- **Covers:** Where multi-user beta data actually gets destroyed. `MIGRATIONS` is exported and `runMigrations(db)` takes a Database, so this is genuinely testable. Today `db.test.ts` only asserts the end-state v16 schema + one v11 backfill — it does NOT test arbitrary N-1→N upgrade-with-data-survival.
- **Runtime:** <1s (inside the existing suite). · **Secrets:** none.
- **Caveat:** Seed-and-run-the-real-runner (don't hand-apply the sliced ladder — that re-implements and can drift from the runner). Bespoke seed per destructive migration is the cost; only needed for migrations that DROP/rewrite, not every additive ALTER.
- **conductor.build:** `test-roundhouse`.

#### `supabase-migration-naming-monotonic-guard` — Postgres filename + forward-only
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** `node scripts/check-supabase-migration-names.mjs` (NEW). Read `supabase/migrations/*.sql`; assert every filename matches `^[0-9]{14}_[a-z0-9_]+\.sql$`, timestamps are unique + strictly ascending in lexical order, and (forward-only) no migration filename/contents present on `origin/main` was modified — only newer-timestamped files added. `fetch-depth: 0`.
- **Should do:** Statically validate Supabase migration filenames + enforce forward-only on the Postgres side.
- **Does / will do:** Catches out-of-order/duplicate-timestamp migrations (`supabase db push` applies in lexical filename order — a wrong prefix runs at the wrong time) and silent edits to an already-pushed migration (push will NOT re-apply, mirroring the SQLite divergence risk server-side).
- **Covers:** Supabase is the auth source of truth for the beta; a bad migration there is a login outage for everyone. Pure Node, no Postgres, no Docker.
- **Runtime:** <2s. · **Secrets:** none (`fetch-depth: 0`).
- **Caveat:** Verified both existing files (`20260512000001_profiles.sql`, `20260513000001_consolidate_legacy.sql`) match the regex and are on `origin/main` — green today. Delivers most of the Supabase value without the Docker tax of the dry-run below.
- **conductor.build:** `postgres-migration-guard` (naming/forward-only half).

#### `supabase-migration-lint-dryrun` — replay against ephemeral Postgres
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** Changed-paths-gated (only when `supabase/migrations/**` changes): `supabase db lint --schema public` + a dry-run apply against ephemeral local Postgres (`supabase db start && supabase db reset`) via `supabase/setup-cli@v1`.
- **Should do:** Lint the Postgres SQL + replay the full migration set from empty against a disposable Postgres.
- **Does / will do:** Catches a broken migration (bad SQL, dropped-object reference, RLS/policy mistake) before `supabase db push` touches the live auth DB.
- **Covers:** A failed push could lock users out of sign-in.
- **Runtime:** ~60–120s (boots a Postgres container; only on supabase/** changes). · **Secrets:** none for the local dry-run.
- **Caveat:** Real prerequisites — NO `supabase/config.toml` committed (`supabase init` required first), the CLI is not on the runner, and `supabase db start` needs Docker-in-CI. A lot of infra for 2 rarely-touched files; the 80% value (naming + forward-only + ordering) is delivered by the guard above with zero Docker. The `.temp/project-ref` pointing at the old project (`qvayepdjxvkdeiczjzfj`) is irrelevant to a LOCAL ephemeral dry-run (no push/credentials). Advisory + changed-paths-gated; revisit as blocking only if the Supabase schema starts changing frequently.
- **conductor.build:** `postgres-migration-guard`.

---

### 9. CI infra & governance

#### `branch-protection-required-checks` — the keystone
- **Tier:** 🔴 BLOCKING (config, not a job) · **Priority:** P0 · **Status:** missing
- **Command:** GitHub Settings → Branches → ruleset on `main` (or `gh api -X PUT repos/iamarunrk/zeros/branches/main/protection ...`). Mark Required: **`Vitest suite`** (test.yml job `test`) **today**, and add each new check (`typecheck`, `lint`, `build-main`, `build-sidecar`, `check:ui`, `check:cursor-asar`) as it is wired green. Enable "Require a pull request before merging", "Require status checks to pass", "Require branches to be up to date".
- **Should do:** Turn the green workflows from advisory annotations into hard merge gates; activate `CODEOWNERS` for the closed-contract paths.
- **Does / will do:** Without this, **every other check in this audit is purely advisory** — a red CI run or an unreviewed change to a closed wire-contract can still merge. The single highest-leverage, zero-code change here.
- **Covers:** A red suite or a contract-breaking change reaching `main` (= shipped).
- **Runtime:** 0 (config). · **Secrets:** none (repo admin).
- **Solo-dev foot-guns (tune the toggles):** (1) Requiring checks that aren't wired yet **deadlocks all PRs** — only require `Vitest suite` today, add the rest as they land green. (2) "Require review from Code Owners" with a single-person `CODEOWNERS` blocks your own PRs — either skip it or keep admin bypass; require CODEOWNERS review only on the closed-contract paths (`src/zeros/bridge/agent-events.ts`, the adapter registry, catalogs). (3) "Do not allow bypassing" is the **wrong** default for a solo dev — allow admin bypass for the occasional flake/hotfix.
- **conductor.build:** none (this is the GitHub config behind all of conductor's required checks).

#### `validate-workflows` / `actionlint` — lint the workflow YAML
- **Tier:** 🔴 BLOCKING · **Priority:** P1 · **Status:** missing
- **Command:** New `.github/workflows/lint-ci.yml` running actionlint over `.github/workflows/*.yml` via the **pinned action** (`uses: rhysd/actionlint@<sha>`) — NOT a bare `actionlint` binary (not installed) and NOT `curl | bash`. Lint the whole dir (a rename can let a broken-but-unchanged file ride). Path-filter to `.github/workflows/**`.
- **Should do:** Lint Actions YAML for syntax errors, invalid `${{ }}` expressions, shell-injection-prone `run:` interpolations, bad action refs, deprecated actions, shellcheck on `run:` blocks.
- **Does / will do:** Catches silently-broken CI config — the worst failure mode for a repo whose merge gate IS the CI. `release.yml` has ~18 `run`/`uses` steps, interpolates `${{ steps.version.outputs.version }}` + `${{ secrets.* }}` into shell, and writes `package.json` via `node -e` — real shell-injection/expression surface in a privileged (`contents:write` + signing secrets) workflow.
- **Covers:** A typo making a job a no-op, a malformed expression skipping a step, a `release.yml` shell bug shipping a broken DMG.
- **Runtime:** ~15–30s. · **Secrets:** none.
- **Caveat:** Near-zero noise for 2 hand-edited files. Seed as advisory for the introducing PR (chicken-and-egg), then flip blocking after the first green run. Direct 1:1 with conductor.
- **conductor.build:** `validate-workflows`.

#### `changes-path-filter` — changed-paths enabler
- **Tier:** 🟡 ADVISORY (enabler, NOT a required check) · **Priority:** P2 · **Status:** missing
- **Command:** A lightweight first job using `dorny/paths-filter@v3` outputting booleans (`app`, `engine`, `marketing`, `webhook`, `workflows`, `migrations`, `docs-only`) consumed downstream via `if: needs.changes.outputs.<x> == 'true'`. Spec: `src/**` + `electron/**` → app/engine; `website/marketing/**` → marketing; `packages/feedback-intercom-webhook/**` → webhook; `supabase/migrations/**` + `src/engine/db/migrations.ts` → migrations; `.github/workflows/**` → workflows.
- **Should do:** Compute which areas a PR touches once, so heavy/area-specific jobs only run when their paths change.
- **Does / will do:** Makes it SAFE to add the heavier jobs (build-renderer, build-sidecar, marketing build) without paying for them on docs/comment PRs.
- **Covers:** Wasted runner minutes + slow feedback.
- **Runtime:** ~5–10s. · **Secrets:** none.
- **Caveat:** Produces ZERO value on its own (the per-PR gate is currently one job) — **land it only TOGETHER WITH the jobs it gates**, never standalone. Biggest trap: the GitHub "required check that gets skipped never reports → PR stuck forever" issue — keep the path-filter job itself always-run, make downstream heavy jobs advisory OR pair with an aggregating success job if any gated job is required. Do NOT make IT a required check.
- **conductor.build:** `changes`.

#### `release-pipeline-pre-gate` — harden the manual release gate
- **Tier:** 🔴 BLOCKING (on the release workflow) · **Priority:** P1 · **Status:** partial
- **Command:** Add two steps to `release.yml`'s `test` gate job (already `needs: test` on `pnpm test:git` + asserts `GITHUB_REF == refs/heads/main`): `pnpm check:cursor-asar` and `pnpm models:verify --strict`.
- **Should do:** Make the only path that produces a public `.dmg` maximally strict.
- **Does / will do:** Ensures a packaging-allowlist drift (= dead packaged Cursor) or invalid model catalog can't ship. `check:cursor-asar` specifically guards the packaged-Cursor-dead mode that ONLY manifests in the packaged app.
- **Covers:** Shipping a broken installer to beta users.
- **Runtime:** +~20s on the existing ubuntu gate job. · **Secrets:** none for the gate job.
- **Caveat:** Per-PR `test.yml` already runs `models:verify --strict`, so the release add is defense-in-depth mainly for `check:cursor-asar` (NOT in the per-PR gate today) — **also add `check:cursor-asar` to per-PR `test.yml`**.
- **conductor.build:** none directly (conductor gates per-PR; this is the manual ship gate).

#### `claude-pr-review` — advisory AI review
- **Tier:** 🟡 ADVISORY · **Priority:** P2 · **Status:** missing
- **Command:** New `.github/workflows/claude-review.yml` using `anthropics/claude-code-action@v1` on `pull_request` (and/or `@claude` issue-comment trigger), advisory-only (does not set a required status). Requires `ANTHROPIC_API_KEY` repo secret.
- **Should do:** Post an automated, advisory AI review per PR: correctness bugs, missing error handling, contract drift, security smells — inline, non-blocking.
- **Does / will do:** Fills the "second pair of eyes" gap a solo dev with no human reviewer structurally lacks (you can't meaningfully review your own PRs; `CODEOWNERS` can't fix that).
- **Covers:** The long tail of logic bugs no static check catches.
- **Runtime:** ~1–3 min, off the blocking path. · **Secrets:** `ANTHROPIC_API_KEY` + `GITHUB_TOKEN` (PR write). Fork PRs can't read secrets (fine for a solo/private repo).
- **Caveat:** Costs API tokens per PR (scope to non-draft or `@`-mention to control spend). MUST stay advisory (AI review is non-deterministic). To reuse the repo's own `/code-review` skill, **commit it into the repo** (e.g. `.claude/skills/`) — it lives only in the local agent env today. Verify the `@v1` pin + `ANTHROPIC_API_KEY` before merging the workflow, else every PR shows a red advisory job.
- **conductor.build:** `claude` (prefer the official Anthropic action over Greptile for stack alignment).

#### Governance conventions (record, don't build)
- **`ci-job-template-concurrency-cache`** — 🟡 advisory convention. Every new workflow MUST copy `test.yml`'s header: `concurrency: { group: <name>-${{ github.ref }}, cancel-in-progress: true }`, `pnpm/action-setup@v4` (no `with: version`), `actions/setup-node@v4` with `cache: pnpm`, `pnpm install --frozen-lockfile`. `test.yml`+`release.yml` already nail this. Record as a one-liner in a CONTRIBUTING/workflow doc; real enforcement is actionlint. Don't build a bespoke grep guard for a 2-workflow repo.
- **`macos-runner-cost-discipline`** — 🟡 advisory policy. Keep `macos-latest` OUT of the per-PR path (today: zero per-PR macOS minutes — a feature). Run any genuinely-macOS-only step on ubuntu where possible (bun cross-compile) and gate macOS-only steps behind the `changes` filter. Already satisfied; purely preventative.

---

## Proposed workflow file layout

```
.github/workflows/
  preflight.yml      # per-PR + push:main — the main blocking gate (ubuntu)
  build.yml          # per-PR build integrity (ubuntu), path-filtered
  security.yml       # per-PR gitleaks + electron-hardening (ubuntu); weekly history+codeql crons
  migrations.yml     # per-PR migration guards (ubuntu), path-filtered to migration files
  scheduled.yml      # nightly crons: agents-smoke, electron-pack-smoke, native-abi-smoke, secret-history (macos + ubuntu)
  test.yml           # KEEP — the existing Vitest suite (or fold its job into preflight.yml)
  release.yml        # KEEP — manual; add check:cursor-asar + models:verify to its gate
  lint-ci.yml        # actionlint, path-filtered to .github/workflows/**
  claude-review.yml  # advisory AI review
  codeql.yml         # advisory SAST, PR + weekly
```

**Fold into the existing `test.yml` (or a renamed `preflight.yml`) as added jobs/steps** (all ubuntu, no secrets, fast):
`typecheck:app`, `typecheck:electron`, `typecheck:packages` (3 steps), `lint`, `format-check-changed`, `check:cursor-asar`, `check:ui` (advisory), `check-settings-schema-drift`, `check-vite-env-sync`, `check-packaging-paths`, `check-codex-pin`, the new vitest tests (`settings-and-catalog-parse-validity`, `renderer-emit-no-pii-contract`, `sqlite-migration-*` — these need NO new CI wiring, just new test files under existing globs), `sqlite-migration-forward-only-guard`, `supabase-migration-naming-monotonic-guard`.

**New per-PR `build.yml`** (ubuntu, path-filtered via `changes`): `build-renderer`, `build-engine-bundle`, `build-electron-main`, `build-sidecar-binary` (cross-compile), `build-website-marketing` (marketing path only), `build-feedback-worker-dry-run` (webhook path only, advisory).

**New per-PR `security.yml`** (ubuntu): `secret-scan-gitleaks`, `electron-hardening-invariants`. Plus weekly crons for `secret-scan-history-scheduled` and (separate `codeql.yml`) CodeQL.

**Scheduled (`scheduled.yml`, nightly + label):** `agents-smoke-scheduled`, `electron-pack-smoke` (macos), `native-module-electron-abi-smoke` (macos), `engine-sidecar-boot-smoke` macOS half.

### Recommended per-PR DAG (all ubuntu unless noted)

```
changes (paths-filter) ─┬─> preflight: typecheck (3 steps) ─┐
                        ├─> preflight: lint                  │
                        ├─> preflight: format-changed        ├─> [required: "Preflight"]
                        ├─> preflight: test:git + new tests  │
                        ├─> preflight: repo-guards            │
                        ├─> security: gitleaks + hardening   │
                        ├─> build: renderer/engine/main/sidecar (if app)
                        ├─> build: marketing (if marketing)  
                        ├─> build: worker dry-run (if webhook, advisory)
                        ├─> migrations: forward-only + supabase-names (if migrations)
                        └─> lint-ci: actionlint (if workflows)

claude-review (advisory, off critical path) · codeql (advisory)
```

Heavy/secret/macOS jobs (`agents-smoke`, `electron-pack-smoke`, `native-abi-smoke`, `secret-history`) live only in `scheduled.yml`. Path-filtering keeps docs-only PRs to the cheap guards. Dependabot is a repo setting (no workflow).

---

## Phased rollout

### P0 — do first (the cheap, highest-leverage floor)

A short checklist you can execute next, in order:

1. **`pnpm add -D -w @types/node@^20`** (`add-types-node-dependency`) — unblocks both typechecks.
2. **Fix the 2 typecheck errors** in `src/zeros/agent/__tests__/models-catalog-validity.test.ts` and **the 1 lint error** in `cursor-sdk/__tests__/session-supersede.test.ts:73`.
3. **Add `tsconfig.typecheck.json`** + scripts `typecheck:app` / `typecheck:electron` / `typecheck:packages` (fix marketing to `tsc -b`) / aggregate `typecheck`.
4. **Run `pnpm schemas:build` and commit the regenerated `website/marketing/public/schemas/*.json`** (they are drifted today), then add `check-settings-schema-drift`.
5. **Add the migration safety tests** — `sqlite-migration-upgrade-path-test` + `sqlite-migration-fresh-to-head-test` assertions into `db.test.ts`, and the `sqlite-migration-forward-only-guard` script.
6. **Wire `check:cursor-asar` into the per-PR gate** (passes today; closes a silent DMG-bricking regression).
7. **Add the new jobs to `preflight.yml`/`test.yml`:** `typecheck` (3 steps), `lint`, `format-check-changed`, `build-renderer`, `build-engine-bundle`, `build-electron-main`, `build-sidecar-binary`, `secret-scan-gitleaks` (+ `.gitleaks.toml` allowlisting `apps/0colors`).
8. **Add the `LICENSE` file** + `check-license-present` (defect that exists right now).
9. **Turn on branch protection** (`branch-protection-required-checks`) requiring only `Vitest suite` at first, then add each P0 check as it goes green. Allow admin bypass.

### P1

`typecheck-aggregate` / `typecheck-packages` blocking · `build-website-marketing` · `check-vite-env-sync` · `check-packaging-paths` · `check-codex-pin` · `settings-and-catalog-parse-validity` · `renderer-emit-no-pii-contract` · `supabase-migration-naming-monotonic-guard` · `electron-hardening-invariants` · `actionlint`/`validate-workflows` · `release-pipeline-pre-gate` · `osv-dependabot-scheduled` (enable Dependabot security-updates) · `secret-scan-history-scheduled` · `native-module-electron-abi-smoke` (scheduled) · `agents-smoke-scheduled` (manual label first).

### P2

`check-ui-tokens` (after baselining the 7 files) → then blocking · `lint-strict-no-warnings` (after the 13 warnings are triaged; or drop) · `format-check` whole-tree (after a `prettier --write .` baseline) · `coverage-report` (advisory, engine only) · `test-adapters` (advisory) · `check-cursor-host-smoke` (advisory) · `engine-sidecar-boot-smoke` (after a real selftest entry) · `wire-protocol-compat-guard` (file-touch half only) · `dep-audit-high` (drop if Dependabot enabled) · `codeql-js-ts` (advisory) · `renderer-bundle-secret-guard` (append to release build) · `supabase-migration-lint-dryrun` (after `supabase init`) · `changes-path-filter` (with the jobs it gates) · `app-launch-e2e-smoke` (after an auth test-mode bypass is built) · `claude-pr-review`.

---

## Branch protection — exact required status checks

On `main`, mark these as **Required status checks** (add each only after it is wired green — requiring an unwired check deadlocks all PRs):

**Enable today:**
- `Vitest suite` (the existing `test.yml` job)

**Add as each lands green (P0/P1):**
- `typecheck` (or the 3 steps: `typecheck-app`, `typecheck-electron`, `typecheck-packages`)
- `lint`
- `format-check-changed`
- `build-renderer`, `build-engine-bundle`, `build-electron-main`, `build-sidecar-binary`
- `build-website-marketing` (marketing-path PRs)
- `check:cursor-asar`, `check-settings-schema-drift`, `check-vite-env-sync`, `check-packaging-paths`, `check-codex-pin`
- `secret-scan-gitleaks`, `electron-hardening-invariants`, `check-license-present`
- `sqlite-migration-forward-only-guard`, `supabase-migration-naming-monotonic-guard`
- `actionlint` (workflow-path PRs)

**Other settings:** Require a pull request before merging · Require branches to be up to date · **allow admin bypass** (solo dev needs an escape hatch for flakes/hotfixes) · **do NOT** enable "Require review from Code Owners" globally (single-person `CODEOWNERS` would block your own PRs). Scope CODEOWNERS review (if any) to the closed-contract paths only: `src/zeros/bridge/agent-events.ts`, the adapter registry, `catalogs/`. `CODEOWNERS` already exists (catch-all `@iamarunrk` + closed paths); its own header notes it is inert until "Require review from Code Owners" is on.

---

## conductor.build parity table

| conductor check | Zeros equivalent | Status |
|---|---|---|
| **lint** | `pnpm lint` (eslint src electron); fold packages/website into Prettier | **wire-up** (RED today: fix 1 `require-yield` error first) |
| **validate** (x2) | `check-codex-pin`, `settings-and-catalog-parse-validity`, `build-feedback-worker-dry-run` | **build-new** |
| **claude** (Claude Code review) | `claude-pr-review` (`anthropics/claude-code-action`) | **build-new** (advisory; commit `/code-review` skill to reuse it) |
| **delete** | — | **N/A** (conductor-internal workspace cleanup; no analogue) |
| **postgres-migration-guard** | `supabase-migration-naming-monotonic-guard` + `supabase-migration-lint-dryrun`; SQLite analogue = `sqlite-migration-forward-only-guard` | **build-new** |
| **changes** (changed-paths filter) | `changes-path-filter` (`dorny/paths-filter@v3`) | **build-new** (land with the jobs it gates) |
| **check-agents-md** | — | **N/A** (no `AGENTS.md`/`CLAUDE.md` committed to the repo) |
| **validate-workflows** (actionlint) | `actionlint`/`validate-workflows` | **build-new** (direct 1:1) |
| **format** | `format-check-changed` (whole-tree `format-check` deferred) | **build-new** |
| **build-main** | `build-electron-main` + `build-renderer` | **wire-up** (scripts exist, unwired) |
| **build-sidecar** | `build-sidecar-binary` + `build-engine-bundle` | **wire-up** |
| **test-root** | `test-engine` (`pnpm test:git`) | **have** (already in CI) |
| **test-packages** | `packages/core` `__tests__` globbed by `vitest.config.ts` | **have** (7+ live test files run today — NOT wire-up) |
| **test-roundhouse** (their engine) | `test-engine` engine suite + migration tests | **have / wire-up** (engine covered; migration upgrade tests are new) |
| **typecheck** | `typecheck` aggregate (app + electron + packages) | **build-new** (no root typecheck exists today; real error count is 2) |
| **build-rust-*** | — | **N/A** (no Rust; codex bindings are committed/codegen, no cargo in CI path) |
| **check-catalog** | `models:verify --strict` (have) + `settings-and-catalog-parse-validity` (providers-v1, new) | **have + build-new** |
| **build-workspace-server** | — | **N/A** (relay removed; desktop-only since the relay retirement) |
| **vercel-sandbox-smoke** | `agents-smoke-scheduled`, `app-launch-e2e-smoke`, `check-cursor-host-smoke` | **wire-up / build-new** (scheduled) |
| **react-doctor** | — | **N/A** (no equivalent; nearest is `lint` rules-of-hooks + `check:ui`) |
| **Greptile Review** | `claude-pr-review` (prefer Claude for stack alignment) | **build-new** (one AI review, not two) |
| **Vercel + Vercel Preview Comments** | — | **N/A** (marketing + web-app deploy via Cloudflare Pages Git; worker via Cloudflare Workers Builds — all out-of-band of GitHub Actions) |

---

## Explicitly dropped / deferred

| Item | Reason |
|---|---|
| **`renderer-component-tests`** | Genuine gap (the React tree is excluded by `vitest.config.ts`), but cannot be a meaningful gate until tests exist. Adding jsdom/testing-library now is net-negative (false safety + maintenance surface with no tests to run). **Roadmap item, not a CI check.** |
| **`no-dead-engine-css`** (`find-dead-engine-css`) | **Vestigial.** Verified the target surface is GONE: `src/zeros/engine/styles/` and `zeros-styles.ts` do not exist; the script's `existsSync` guards make it exit 0 unconditionally ("0 dead"). Wiring it adds a green check that proves nothing. Not even a `package.json` script. Remove or leave unwired. |
| **`app-launch-e2e-smoke`** | Deferred (`feasible=false` as-specified) — blocked on a net-new auth test-mode bypass in `auth-gate.tsx`. Revisit P2 after that lands. |
| **`lint-strict-no-warnings`**, **whole-tree `format-check`**, **`check-ui-tokens` blocking** | Deferred to P2 — each requires baselining the tree (fix warnings / `prettier --write .` / allowlist 7 token files) before it can block without failing every PR. |
| **`dep-audit-high`** | Likely redundant once Dependabot is enabled; keep advisory or drop to avoid ignore-list maintenance. |
| **`pinned-action-shas`**, **bespoke `ci-job-template` grep guard** | Net-negative for a 2-workflow repo using only first-party actions; record conventions in a doc, enforce via actionlint. |
| **`apps/0colors`** | **Excluded from ALL checks** per explicit instruction (own npm-workspaces setup, pending retirement, outside `pnpm-workspace.yaml`). Every guard/scan/build/lint above scopes it out (notably the `.gitleaks.toml` allowlist — it is the one surface with placeholder secrets). |

---

## Appendix: cost & maintenance

**Cost.** GitHub free-tier minutes are generous for a solo private repo, but **macOS runners bill at ~10x ubuntu**. Today per-PR macOS cost is zero — keep it that way: everything in the per-PR DAG runs on `ubuntu-latest` (the engine binary even cross-compiles there via bun), and the only macOS work (`electron-pack-smoke`, `native-module-electron-abi-smoke`, the full `release.yml` build, the macOS half of `build-sidecar`/`engine-boot-smoke`) lives in scheduled/manual workflows. Path-filtering via the `changes` job keeps docs-only and single-area PRs to the cheap guards. The whole per-PR ubuntu gate (typecheck + lint + format-changed + test:git + builds + guards) is sub-5-minutes and secret-free, so it is fork-safe and cheap to run on every push.

**Maintenance principle.** Keep **blocking** checks fast and deterministic — a blocking check that flakes trains you to ignore red and to merge anyway, which is worse than no check. Anything noisy, network-dependent, non-deterministic, secret-requiring, or not-yet-baselined stays **advisory** or **scheduled** until it is provably green and stable, then graduates to blocking. Every new blocking gate must be green on `main` the day it is enabled (several here — `lint`, `check:ui`, `check-settings-schema-drift`, whole-tree `format` — are RED today and must be reconciled first, as called out per-check above).
