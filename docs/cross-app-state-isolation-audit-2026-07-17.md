# Cross-App State Isolation — Audit & Repo-Settings Decision (2026-07-17)

> **DECISION UPDATE (same day, supersedes §3):** the app-scoped run-actions
> store described in §3 was built, shipped, and then **reverted** after a
> product decision: sharing repo settings across app installs for the same
> repo is the **intended** behavior — repo settings are repo config, like
> `.vscode/`. The final architecture instead moves scripts to the COMMITTED
> file: **setup / archive / run actions live in `<repo>/.zeros/settings.toml`
> only** (the Environment tab's Scripts + Run-actions editors write layer
> `"repo"`), the header button became "Open settings.toml", and the personal
> gitignored files (`settings.local.toml`, both repo-local and
> workspace-local) **no longer carry `[scripts]` at all** — a stale personal
> `[scripts]` is ignored with a warning so it can never shadow the committed
> file (repo-local outranks repo in the resolver merge). `settings.local.toml`
> remains for per-user keys only (workspaces path, git/prompt overrides). No
> data migration: stale `[scripts]` in local files stays on disk, inert.
> §§1–2 (mechanism analysis) and §§4–5 (the audit of OTHER shared state)
> remain fully valid — only §3's fix was reversed.

## Why this document exists

Repro that triggered it: run actions ("Run", "Testing") were added for a repo
in ONE Zeros app instance, and their Run tabs appeared in the terminal panel of
EVERY other instance that opened the same repo — another worktree's `zeros dev`
app, and (had it been checked) beta/stable too.

First hypothesis was localStorage/IndexedDB. **That was not the mechanism.**
The actions were found on disk in the target repo itself:

```
/Users/arunrajkumar/Documents/0kit/.zeros/settings.local.toml
  [scripts]
  run_actions = [{ id=…, name="Run", … }, { id=…, name="Testing", … }]
```

Every Zeros install on the machine that opens `0kit` reads that same file, so
"personal" repo settings were effectively machine-global. Final resolution:
that sharing is intended for repo settings, and scripts now live in the
COMMITTED `settings.toml` (see the decision update above). Everything else
found in the same class is catalogued below (§4).

## 1. The identity system (what isolation already exists)

Zeros already has a strong "each app is its own app" model — the leak class is
precisely the state that escapes it.

| Identity                                                                | Mechanism                                                                                                                    | Source                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Release channel (`dev` / `beta` / `stable`)                             | `ZEROS_CHANNEL` env, baked at build                                                                                          | `src/engine/runtime.ts:79`                           |
| App data dir (DB, Electron userData, engines, worktree seeds, sessions) | `zerosDataDir()` → `com.zeros[.dev\|.beta][.<slug>]` — per channel **and** per dev-worktree instance (`ZEROS_INSTANCE` slug) | `src/engine/db/paths.ts:97`                          |
| Engine ports                                                            | Disjoint Stable/Beta/Dev footprints + per-instance base-port override                                                        | `src/engine/runtime.ts`                              |
| User dot-dir                                                            | `~/.zeros` for Stable + Beta; `~/.zeros-dev` for Dev — packaged channels currently share it, **no instance slug**           | `src/engine/settings/files.ts:37`, `db/paths.ts:123` |
| Renderer storage (localStorage etc.)                                    | Follows Electron userData → per instance in the packaged/dev app                                                             | `electron/main.ts` userData redirect                 |

Two weaker roots exist alongside `zerosDataDir()`:

- `zerosStateRoot()` (`~/.zeros[-dev]`) — Dev/packaged-scoped, so Stable and
  Beta share `~/.zeros`, while all Dev worktree instances share
  `~/.zeros-dev`.
- **Repo-derived paths** (`<repo>/…`) — keyed only by the target repo, shared
  across **all channels and all instances**. This is where the run-actions
  leak lived.

## 2. Root cause of the run-actions leak

- The Run-actions editor (repo page → Environment) writes layer `repo-local`
  (`src/zeros/panels/repo-page.tsx:466`, `run-actions-section.tsx`).
- Layer `repo-local` = `<repo>/.zeros/settings.local.toml`
  (`src/engine/settings/files.ts:54`). Gitignored, but a real file in the repo
  working tree — read by every engine that resolves settings for that repo
  (`ops.ts opSettingsResolve`), regardless of channel or instance.
- The terminal panel (`use-run-control.ts`), the header Run split-button, and
  the engine's own run spawn (`workspace.startRun`, run-on-create) all read
  the resolved `scripts.run_actions` — so the tabs appeared everywhere.
- Why the _settings page_ could look empty in another instance while tabs
  showed: the page and the tabs read the same resolution, but each app
  instance has its own project registry — an instance can resolve a
  workspace's settings (tabs appear) without the repo page being pointed at
  the same entry the user checked.

## 3. ~~The fix — run actions are app-scoped~~ (REVERTED — see the decision update at the top)

Kept for the record: this design shipped and was reverted the same day in
favor of committed-repo scripts. What it did:

Run actions moved into an **app-scoped per-repo store** that lives with the
app's identity, not in the repo:

```
<zerosDataDir()>/repo-settings/<repoKey(mainRepoRoot)>/run-actions.toml
```

Since `zerosDataDir()` is already per-channel _and_ per-dev-instance, run
actions added in one app now exist only in that app. Pieces:

1. **`src/engine/settings/app-run-actions.ts`** (new) — path + read/write for
   the store. An existing file is authoritative even when the list is empty
   ("none configured"); a missing file falls back to layered resolution.
2. **`schema.ts sanitizeLayer`** — `scripts.run_actions` is dropped (with a
   warning) from the personal layers `repo-local` and `workspace-local`. The
   **committed** repo layer (`<repo>/.zeros/settings.toml`) still supports
   `[[scripts.run_actions]]` — that file is deliberately team-shared, like
   `.vscode/`. An app's own store overrides the committed list when present.
3. **`ops.ts`** —
   - `opSettingsResolve` overlays the store into `effective.scripts.run_actions`
     (keyed by the main repo root — the same root `useRunControl`,
     `workspace.startRun`, and run-on-create resolve with);
   - `opSettingsRead("repo-local")` reflects the store and hides any legacy
     list still sitting in the file;
   - `opSettingsWrite("repo-local")` routes a `scripts.run_actions` array to
     the store and **deletes the legacy copy from the in-repo file** (the leak
     source self-heals on the first save).
4. **`watch.ts`** — the store file joined the settings watcher, so a store
   write broadcasts `DB_CHANGED kinds:["settings"]` like any settings edit.
5. **Renderer: no changes.** The Run-actions editor and the terminal panel
   work through the same bridge ops as before.

Tests: `src/engine/settings/__tests__/app-run-actions.test.ts` — including
"two app data dirs see different actions for the same repo".

**Migration note:** legacy `run_actions` already in a repo's
`settings.local.toml` are no longer read anywhere (a resolve warning says so).
They were deliberately NOT auto-adopted — adopting on first resolve would copy
the same list into _every_ instance's store, recreating the leak one last
time. Re-add run actions once, in the app where you want them; the stale file
entry is deleted automatically on that first save.

## 4. Everything else in the same class (NOT fixed in this pass)

Ordered by how accidental/surprising the sharing is. "Scope" = who shares the
state.

### 4.1 Accidental / questionable

| #   | State                                                                                                                                                                | Location                                                                  | Scope                                                                                      | Assessment                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Remaining `repo-local` / `workspace-local` settings** — `workspaces.path`, git overrides, setup/archive scripts written personally, and any stale `env`/`mcp` keys | `<repo>/.zeros/settings.local.toml` (`settings/files.ts:54`, `ops.ts:85`) | All channels + all instances that open the repo                                            | **Same bug class as run actions.** Presented as "personal, this Mac", actually machine-global per repo. The 2026-07-17 slimming already stopped _reading_ `env`/`mcp` from repo files; the rest still resolves from here. Candidate systemic fix in §5. |
| 2   | **`.gitignore` mutation in the user's repo** — every repo-local write appends a `.zeros/settings.local.toml` ignore stanza                                           | `ops.ts ensureLocalSettingsIgnored` (`ops.ts:277-301`)                    | The target repo's _tracked_ `.gitignore` — committable, i.e. can leak to teammates via git | Reasonable intent, questionable side effect: the app edits a tracked file in the user's repo. Becomes unnecessary if #1 moves out of the repo.                                                                                                          |
| 3   | **Managed terminal ZDOTDIR + shared zsh history** — `setopt SHARE_HISTORY` in generated dotfiles                                                                     | `~/.zeros[-dev]/term-zdotdir/` (`engine/pty/shell-setup.ts:24,60-73`)     | All instances within a channel                                                             | Every dev worktree instance's PTYs share one dotfile set and one history stream. Deviates from the per-instance model; likely just needs `zerosStateRoot()` → per-instance dir, or per-instance history files.                                          |
| 4   | **Detach lock** — `{pid, workspaceId}` serializing detach operations                                                                                                 | `~/.zeros[-dev]/detach.lock` (`git/state.ts:102`, `git/detach.ts:85`)     | All instances within a channel                                                             | A detach in one dev instance contends the lock for all sibling instances. Possibly intended as machine-wide serialization; worth an explicit decision.                                                                                                  |
| 5   | **Legacy remnants** — `state.db`, legacy `worktrees/` root                                                                                                           | `~/.zeros[-dev]/` (`git/state.ts:72-100`)                                 | Channel                                                                                    | Superseded by `zeros.db` / new worktrees root; inert but still fallback-read. Candidate for removal.                                                                                                                                                    |

### 4.2 Intentional (documented or clearly by-design) — listed for completeness

| #   | State                                                                              | Location                                                                                                                       | Scope                          | Why it's intentional                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Committed repo settings                                                            | `<repo>/.zeros/settings.toml`                                                                                                  | Everyone (git)                 | Team config, the `.vscode` analogy. `.worktreeinclude` likewise (read-only).                                                                                                                                                             |
| 7   | Shared dev credentials                                                             | `zerosChannelDataDir()/secrets.json` via `ZEROS_SHARED_SECRETS_DIR` (`electron/main.ts:205`, `electron/secret-store.ts:26-39`) | All dev instances (channel)    | Documented "log in once, every worktree authed". `ZEROS_ISOLATE=1` opts out. Note: this means the **env Keychain vault** (`envvault::user`, `envvault::repo::<root>` — `env-vault.ts:56`) is also shared across dev instances, per repo. |
| 8   | safeStorage keychain key                                                           | macOS Keychain, named per channel ("Zeros" / "Zeros Dev" / "Zeros Beta") (`electron/main.ts:161-171`)                          | Machine (per channel)          | Required for #7.                                                                                                                                                                                                                         |
| 9   | User settings + user MCP servers + providers                                       | `~/.zeros[-dev]/settings.toml`                                                                                                 | All instances within a channel | The user layer is per-user by definition; channel split exists. (If per-instance user settings are ever wanted, this is the file.)                                                                                                       |
| 10  | Agent CLI state (`~/.claude`, `~/.codex`, `~/.cursor`) + MCP config adoption reads | vendor dirs (`agents/mcp-scan.ts:36`, `claude-binary.ts`, …)                                                                   | Machine-global                 | Vendor tools' own stores; read-only adoption. Unavoidable.                                                                                                                                                                               |
| 11  | Agent attachments in the workspace                                                 | `<cwd>/.context/attachments/…` + `*` gitignore (`electron/ipc/commands/agent-attachments.ts`)                                  | Anyone opening the worktree    | Attachments must be cwd-addressable for agents; `*` gitignore keeps git clean.                                                                                                                                                           |

### 4.3 Renderer browser storage — mostly fine, with caveats

In the packaged app and `electron:dev`, localStorage follows the per-instance
userData dir, so **none of it leaks across instances**. Caveats:

- **Shared-origin web/dev-server use**: if the renderer is ever served in a
  plain browser, ALL of it shares the origin. App-level keys (theme, enabled
  agents, panel widths, `zeros:terminal-panel:layout-v2`, …) would merge
  mostly benignly, but path-keyed maps would collide for two instances opening
  the same repo: `zeros:changes-scope:v1`, `zeros:viewed-files:v1`,
  `zeros:chat-panes:v1`, `zeros:terminal-panel:sessions`,
  `column3-tabs-by-scope-v1`, `repository-icons-v1`, `adopted-worktrees-v1`,
  `zeros:ui-state:v1` (absolute folder paths inside), plus the chats boot
  cache (`chats-v1*`). The PostHog anonymous id + analytics opt-out would also
  be conflated.
- **`src/native/settings.ts` (`zeros-` prefix) is localStorage**, despite the
  header comment promising an app-data swap — worth either doing the swap or
  fixing the comment.
- No IndexedDB is used anywhere (`src/native/storage.ts` is an empty
  placeholder).
- Migration guards (`settings:toml-migrated`, `env-vault:legacy-secrets-migrated`)
  are localStorage flags — per instance, so each new dev instance re-runs the
  (idempotent, merge-under) migrations. Correct but worth knowing.

## 5. Recommendations (future passes)

1. ~~Relocate the personal repo layers out of the repo~~ — **superseded by the
   decision update**: repo-derived paths sharing across installs is intended
   for repo settings. What remains worth deciding: `settings.local.toml` now
   carries only per-user keys (workspaces path, git/prompt overrides) — if
   those should ever be per-app rather than per-machine, the relocation
   (`repo-local` → `<zerosDataDir()>/repo-settings/<repoKey>/settings.local.toml`)
   is the mechanism, and `ensureLocalSettingsIgnored` (the `.gitignore`
   mutation, §4.1 #2) dies with it.
2. **Decide instance-scoping for `zerosStateRoot()` tenants** — term-zdotdir
   (shared zsh history) and detach.lock: either move under `zerosDataDir()`
   or document machine/channel-wide sharing as intended.
3. **Keep an isolation rule for new features**: any new persisted state must
   name its scope (app-instance / channel / machine / repo-committed) up
   front. The run-actions confusion happened because repo config was parked in
   a gitignored "personal" file — neither committed-and-shared nor app-local.
4. Optional cleanups: retire legacy `~/.zeros[-dev]/state.db` fallbacks; align
   the `native/settings.ts` comment with reality (or actually move it to
   app-data); consider a channel/instance-aware PostHog super-property so dev
   traffic is distinguishable.

## 6. Final state (after the decision update)

- Scripts (setup / archive / run actions) are edited into and resolved from
  the COMMITTED `<repo>/.zeros/settings.toml` only (`RepoDetail` passes
  `layer="repo"` to `ScriptsSection` + `RunActionsSection`); the repo page's
  header button reveals that file ("Open settings.toml"), seeding a
  commented scripts-contract template on first use.
- `sanitizeLayer` drops `[scripts]` from `repo-local` / `workspace-local`
  with a warning — a stale personal file can never shadow the committed one.
- No migration: legacy `[scripts]` in `settings.local.toml` files stays on
  disk, inert. Re-enter scripts once in the UI (they now save to
  `settings.toml`, shared by every install of the repo — the intended
  behavior).
- Verified: engine settings + workspace-ops + shell suites pass;
  `pnpm typecheck` clean; eslint clean.
