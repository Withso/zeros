# Zeros settings.toml — Architecture Audit & Conductor Comparison

**Date:** 2026-06-20
**Scope:** How Zeros' layered settings work today (user / repo / repo-local scoping, physical paths, dev vs prod, wiring to agents, secrets, UI), benchmarked against Conductor, with improvement recommendations. Foundation for the unified-MCP work (the MCP registry will live here).

---

## TL;DR — direct answers

- **Your mental model is right.** Conductor's `<repo>/.conductor/settings.toml` (committed) = repo settings, materialized in every workspace via git checkout. `<repo>/.conductor/settings.local.toml` = per-machine, gitignored. `~/.conductor/settings.toml` = user settings. **Zeros copies this model faithfully** — same three scopes, just `.zeros/` instead of `.conductor/` and `~/.zeros/` instead of `~/.conductor/`.
- **Repo is the finest grain in BOTH tools — there is NO per-workspace settings layer.** All worktrees of a repo share the committed `.zeros/settings.toml` (via git; can differ per branch) plus each checkout's own gitignored `.local.toml`. "Settings for one workspace alone" is **not** a feature either product has today — it's a genuine gap/opportunity (see §8).
- **The settings.toml foundation is solid and mature** (zod schemas, deep-merge, per-leaf provenance, atomic writes, universal bridge, remote-redaction, file watcher, ~1100 tests). The MCP registry should slot straight into it as `[mcp.servers.*]`.
- **One security must for MCP:** stdio MCP servers run arbitrary commands — same RCE class as `scripts` — so they must join the remote-write denylist + spawn-hazard filter (§9).

---

## 1. The layer model (Zeros)

Precedence, weakest → strongest: **default < user < repo < repo-local < managed**. (`src/engine/settings/resolve.ts:106-131`.)

| Layer          | File                                | Scope                                                                     | Git                            | Can hold user-only keys?                                      |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| **default**    | (built-in)                          | fallback (`git.remote=origin`, `base_branch=main`, `run_mode=concurrent`) | —                              | —                                                             |
| **user**       | `~/.zeros/settings.toml`            | all repos, this machine                                                   | untracked                      | ✅ yes (`models`, `workspaces`, `tool_approvals_enabled`)     |
| **repo**       | `<repo>/.zeros/settings.toml`       | the repo, all worktrees                                                   | **committed**                  | ❌ rejected by sanitizer                                      |
| **repo-local** | `<repo>/.zeros/settings.local.toml` | the repo, this machine                                                    | **gitignored** (auto-appended) | partial (`workspaces` ok; `models`/`tool_approvals` rejected) |
| **managed**    | `~/.zeros/settings.managed.toml`    | MDM / IT policy                                                           | untracked                      | ✅ (read-only stub in v1)                                     |

**Merge semantics** (`resolve.ts:77-101`): tables **deep-merge per-key**; scalars **and arrays** are **whole-replaced** by the stronger layer. Dangerous keys (`__proto__`/`constructor`/`prototype`) dropped (proto-pollution guard). Unknown keys **preserved** (forward-compat). Every winning leaf records a **provenance** entry (`sources["git.remote"]="repo"`) so the UI can show where a value came from.

**Schema** (`src/engine/settings/schema.ts`, zod): `repoSettingsSchema` = `{scripts, git, env, env_files, providers, prompts}`; `userSettingsSchema` extends it with `{models, workspaces, tool_approvals_enabled}`; `managed` = alias of user. Published as JSON-schema to `zeros.build/schemas/*` via `pnpm schemas:build` (`scripts/build-settings-schemas.ts`) for editor autocomplete.

---

## 2. Where everything physically lives (and dev vs prod)

Dev mode is gated by `ZEROS_DEV=1` (`src/engine/runtime.ts:22` `isDevRuntime()`), set by the `electron:dev` scripts and re-asserted in `electron/main.ts`.

| What                                       | Prod                                            | Dev                          | Dev-isolated?       |
| ------------------------------------------ | ----------------------------------------------- | ---------------------------- | ------------------- |
| Electron app / userData                    | `Zeros` → `~/Library/Application Support/Zeros` | `Zeros Dev` → `…/Zeros Dev`  | ✅                  |
| Engine app-data (DB, identity, sessions)   | `~/Library/Application Support/com.zeros/`      | `com.zeros.dev/`             | ✅                  |
| Engine-owned SQLite                        | `…/com.zeros/zeros.db`                          | `…/com.zeros.dev/zeros.db`   | ✅                  |
| **User settings**                          | `~/.zeros/settings.toml`                        | `~/.zeros-dev/settings.toml` | ✅                  |
| Managed settings                           | `~/.zeros/settings.managed.toml`                | `~/.zeros-dev/…`             | ✅                  |
| **Repo settings (shared)**                 | `<repo>/.zeros/settings.toml`                   | **same**                     | ❌ **not isolated** |
| **Repo settings (local)**                  | `<repo>/.zeros/settings.local.toml`             | **same**                     | ❌ **not isolated** |
| Visible worktrees root                     | `~/zeros/workspaces/`                           | `~/zeros-dev/workspaces/`    | ✅                  |
| Relay identity (keypair/server-id/devices) | `…/com.zeros/`                                  | `…/com.zeros.dev/`           | ✅                  |
| Logs                                       | `~/Library/Logs/Zeros/`                         | `…/Zeros Dev/`               | ✅                  |
| Engine ports                               | Stable 24193–24200; Beta 24203–24210            | 24293–24300                  | ✅                  |

Path code: `src/engine/db/paths.ts:33-101`, `src/engine/settings/files.ts:32-51`, `src/engine/git/state.ts:56-73`. Overrides exist: `ZEROS_DATA_DIR`, `ZEROS_USER_SETTINGS_DIR`.

**Two findings worth noting:**

1. **Repo settings are NOT dev-isolated** — `<repo>/.zeros/` is the same path in both modes (by design: committed + team-shared can't be per-mode). Consequence: a dev engine and a packaged Zeros opened on the same repo see identical _repo_ settings (user-layer settings ARE isolated). Relevant for MCP: a _repo-layer_ MCP experiment would bleed dev↔prod; a _user-layer_ one wouldn't.
2. **Dev-suffix naming is inconsistent:** `com.zeros.dev` (dot) vs `~/.zeros-dev` (hyphen) vs `~/zeros-dev` (hyphen). Cosmetic, but confusing when eyeballing `~`.

---

## 3. Scoping — user vs repo vs workspace (the central question)

**The finest grain is the REPO, not the workspace/worktree.** This remains the locked settings-layer decision.

- Each worktree resolves the REPO layer from **its own checkout's** `.zeros/settings.toml`. Because that file is committed, every worktree on a branch has the same copy (git) — but branches can diverge, so two worktrees on different branches _can_ see different repo settings.
- `settings.local.toml` is **gitignored**, so it's physically per-checkout, but conceptually it's "this machine's override for this repo."
- The **Settings UI always edits the root checkout's** repo file (an uncommitted change the user reviews + commits), while **agents resolve settings from their own worktree cwd** at spawn (`gateway.ts` → `mergeSpawnEnv(cwd, …)` → `opSettingsResolve(cwd)`).
- **There is no per-workspace settings layer.** All worktrees of a repo share repo + repo-local. This is identical to Conductor (§7).

---

## 4. How it's wired

**Read/resolve:** `settings.resolve(repoRoot?)` → `{effective, sources, warnings}`; `settings.read(layer, repoRoot?)` → one raw layer; `settings.write(layer, patch, repoRoot?)` → atomic read-modify-write (tmp+rename, refuses to clobber malformed files, null-deletes keys). All on the **universal bridge** (`src/engine/workspace/service.ts:924-1006`) so web/CLI get them too, not just Electron-IPC.

**No engine cache:** every resolve is a fresh disk read; every agent spawn re-resolves from the worktree cwd. A 3s **stat-poll watcher** (`watch.ts`, mtime+size guard — no phantom FSEvents) broadcasts `DB_CHANGED{kinds:["settings"]}` on real change; UIs refetch. (A long-running agent does NOT hot-reload mid-session — by design.)

**Settings → agent env** (`spawn-env.ts`, `provider-env.ts`): at spawn, the resolved `[env]` table + parsed `env_files` are merged **under** the caller/session env (keychain secrets + per-session knobs win), then repo-local `[providers.<agent>]` overrides (`base_url` from repo-local only; validated `executable_path`) layer **on top**, then `ZEROS_WORKTREE_PATH` is stamped last.

**Remote (relay) policy:** reads are redaction-masked (secret-shaped env _values_ → `<redacted>`); writes are allowed for paired devices **except** `scripts` / `providers` / `env_files` (shell-exec / RCE vectors), and secret-shaped env _names_ are refused. The **spawn-time hazard filter** (`env-names.ts` `spawnEnvNameHazard`) is the real backstop — it drops code-injection / credential-redirect / secret-shaped names even from a hostile committed `.zeros/settings.toml`.

---

## 5. Secrets today

**No secret VALUES live in settings.toml.** Pattern:

- **Keychain (`safeStorage`)** holds provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`); the renderer couriers them per-session into the spawn env.
- **Env** (`ZEROS_GITHUB_TOKEN`, `ZEROS_LOCAL_WS_TOKEN`) for server/CI paths, seeded at engine boot.
- TOML stores env-var **names** + non-secret values only; the spawn filter + remote redaction enforce hygiene.
- **Gap:** the keychain→engine bridge is incomplete (Phase 4 deferred) — user-level secrets are still renderer-couriered. MCP secrets will follow this same pattern initially.

---

## 6. The UI

`src/zeros/panels/settings-page.tsx` with a **User / Repo segmented toggle** (`settings:active-section` persisted; encodes `user:<section>` or `repo:<projectId>:<section>`). Shared primitives in `src/zeros/settings/settings-ui.tsx`; bridge hooks in `use-settings.ts`. De-carded/flat, Zeros-Foundation tokens.

- **User sections:** General, Account, Providers, Appearance, Privacy, Remote Access.
- **Repo sections (per opened repo):** Providers, Environment, Git, Scripts, Paths, Remote Access.
- **Provenance is shown** — `SourceTag` ("Default"/"User"/"Repo"/"This Mac"/"Managed") + `InheritedGroup` with Override/Reset. *(The MDM layer's chip read "Org" when this audit was written; it was relabeled "Managed" on 2026-07-25, when a separate cloud **"Team"** layer chip was added — see [teams.md](teams.md).)*
- **No repo-local toggle** — the repo-local layer is used silently (only for `workspaces.path`). No MCP UI exists yet.

A future **"Settings → User → MCP Servers"** section (and repo override) drops cleanly into this IA using the existing `SettingsList`/`SettingsRow`/`SourceTag`/`InheritedGroup` primitives.

---

## 7. Conductor comparison

| Dimension                                | Conductor                                                                 | Zeros                                                  | Match?              |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| User settings                            | `~/.conductor/settings.toml`                                              | `~/.zeros/settings.toml`                               | ✅                  |
| Repo (committed)                         | `<repo>/.conductor/settings.toml`                                         | `<repo>/.zeros/settings.toml`                          | ✅                  |
| Repo-local (gitignored)                  | `<repo>/.conductor/settings.local.toml`                                   | `<repo>/.zeros/settings.local.toml`                    | ✅                  |
| Managed (MDM / IT policy)                | `~/.conductor/settings.managed.toml`                                      | `~/.zeros/settings.managed.toml` (stub)                | ✅ (ours is a stub) |
| Precedence                               | managed > repo-local > repo > user > default                              | managed > repo-local > repo > user > default           | ✅ identical        |
| Per-workspace layer                      | **none** (repo = finest grain)                                            | **none** (repo = finest grain)                         | ✅ identical        |
| Format                                   | TOML (+ legacy JSON read)                                                 | TOML                                                   | ✅                  |
| User-only keys ignored in repo files     | yes (`models`, `tool_approvals`, workspace location)                      | yes (`models`, `workspaces`, `tool_approvals_enabled`) | ✅                  |
| Seed gitignored files into new worktrees | **"Files to copy"** (`.worktreeinclude` > `file_include_globs` > `.env*`) | **none**                                               | ❌ Zeros lacks this |

**Verdict:** Zeros is a faithful clone of Conductor's settings model. The one capability Conductor has that Zeros lacks is **"Files to copy"** — seeding gitignored files (e.g. `.env`, and crucially `.zeros/settings.local.toml`) into each new worktree at creation. Without it, a new Zeros worktree starts with no `settings.local.toml` (and no `.env`) until re-created.

---

## 8. What to improve / change

**P1 — settings-foundation gaps that matter for MCP & secrets:**

1. ✅ **"Files to copy" (Conductor parity) — SHIPPED 2026-06-20.** New `src/engine/git/files-to-copy.ts` (`resolveFilesToCopy`) seeds gitignored files into each new worktree. Pattern precedence: repo-root `.worktreeinclude` (gitignore syntax) > repo `file_include_globs` setting (new schema key) > default `.env*`. Git does the matching (`git ls-files -o -i --exclude-standard -- :(glob)…`), so only files that are BOTH gitignored AND match are copied. Wired via a best-effort `seedPaths` in setup-hooks (a missing seed warns, never fails the create); LOCAL creates only (remote skipped, like `setupCommand`). 7 unit tests; 235 git tests green.
2. ◑ **Give the repo-local layer a real UI.** ✅ DONE for **MCP** — the repo MCP section exposes **Shared / This Mac / This Workspace** layers, so the "This Mac" (repo-local) scope is first-class there. Still 🔜 for general repo-local **env/secrets** (only `workspaces.path` + MCP are surfaced today).

**P2 — hygiene:** 3. ⚠️ **Standardize the dev suffix** (`com.zeros.dev` vs `.zeros-dev` vs `zeros-dev`) — **recommend leaving as-is.** The two families are each internally consistent (bundle-id dot vs dotfile hyphen); a rename orphans existing dev data and needs a migration, for a purely cosmetic gain. Documented here instead. 4. ⏳ **Comment-preserving writes (D10).** `smol-toml` re-serialization strips comments on RMW; deferred BY DESIGN (AI/UI is the primary writer). Reversing needs a format-preserving TOML library (toml-patch / @taplo/lib / @ltd/j-toml) + careful corruption testing — a focused, separate change, not a hygiene one-liner. 5. ✅ **Committed `[env]` credential-redirect guard → repo-local-only — SHIPPED 2026-06-20.** `spawn-env.ts` is now provenance-aware: credential-redirect env names (gateway base-URL / proxy / CA bundle) are HONORED from the trusted machine-owner layers (user / repo-local / managed) but still DROPPED from the COMMITTED `repo` layer (the hostile-clone vector) — mirroring `provider-env.ts`'s repo-local `base_url`. Code-injection + secret-shaped names stay dropped from every layer; env_files stay strict. 4 new spawn-env tests.

**P3 — bigger / future:** 6. **Per-workspace settings** (neither tool has this). If we want "settings for one workspace alone" (e.g. a workspace-specific MCP server or env), add a per-worktree override — either lean on the already-per-checkout `.local.toml`, or add a `workspace_settings_overrides` column in `zeros.db` (higher precedence than repo-local). A real differentiator if built. 7. **Decide repo-settings dev-isolation** — currently dev & prod share `<repo>/.zeros/`. Probably leave as-is (committed = shared) but document it. 8. **Wire the managed layer** when enterprise matters (currently a resolver-aware stub).

---

## 9. MCP implications (how the registry slots in)

> **✅ Update (2026-06-20):** the unified-MCP work below has SHIPPED end-to-end — registry in the layered settings.toml (`[[mcp.servers]]`), the committed-repo stdio RCE gate, keychain-backed stdio secrets, the Settings → MCP panel (user + per-repo Shared/This Mac/This Workspace), the Adopt/Import wizard, and the **in-engine OAuth gateway** ("authenticate once", tokens persisted to safeStorage). The predictions below proved accurate. Detail: `docs/mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md` (its Appendices A–F absorbed the former `unified-mcp-config-research-2026-06-20.md`).

1. **Store the MCP registry as `[mcp.servers.<name>]` in the SAME layered settings.toml** — it inherits merge, provenance, deep-merge, the universal bridge, remote-redaction, and the watcher for free. Put `mcp` in **`repoSettingsSchema`** (the shared base, not user-only) so it layers across user + repo + repo-local automatically — exactly the "configure once" + "repo can ship its own servers" model.
2. **SECURITY MUST:** a stdio MCP server runs an arbitrary `command` — the same RCE class as `scripts`. So:
   - add `mcp` (at least stdio `command`/`args`) to the **remote-write denylist** (`REMOTE_WRITE_DENYLIST`), and
   - route MCP `env`/`command` through the **spawn-hazard filter** so a hostile committed `.zeros/settings.toml` can't inject a malicious stdio server.
3. **MCP secrets** reuse the keychain-reference pattern (value in keychain, env-var name in TOML) — riding the same (still renderer-couriered) path as provider API keys until the keychain→engine bridge lands.
4. **UI:** a "Settings → User → MCP Servers" section + a repo-level "MCP" subsection, built from the existing settings primitives with `SourceTag` provenance ("From User" / "From Repo") and `InheritedGroup` for overrides.

This means the unified-MCP Phase 1 is **almost entirely "fill in the schema + adapters + a UI section"** — the persistence, layering, provenance, bridge, and security scaffolding already exist.

---

## Appendix — key files

`src/engine/settings/`: `schema.ts` (zod + sanitize) · `files.ts` (paths + TOML I/O + atomic write + .gitignore append) · `resolve.ts` (merge + provenance) · `ops.ts` (bridge ops + remote denylist/masking) · `watch.ts` (3s stat-poll) · `env-names.ts` (hazard classes) · `spawn-env.ts` + `provider-env.ts` (agent env composition) · `__tests__/` (merge/precedence/sanitize/provenance). Paths: `src/engine/db/paths.ts`, `src/engine/runtime.ts`, `src/engine/git/state.ts`. UI: `src/zeros/panels/settings-page.tsx`, `src/zeros/settings/{settings-ui,use-settings}.ts(x)`.
