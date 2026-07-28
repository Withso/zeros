# Environment vault — Keychain-only env vars (2026-07-16)

Decision record for the environment-variable security model that replaces the
settings-file `[env]` editing UI. Companion to
`docs/home-tab-and-settings-ia-2026-07-15.md` (H1 repo page).

## Decision

Every environment variable managed in the UI — Settings → Environment (user
scope) and a repo page's Environment tab (repo scope) — is stored **only** in
the encrypted secret store (Electron safeStorage; "the Keychain" to users).
Nothing is written to `settings.toml` or `settings.local.toml`, not even a
sentinel-marked name. There is no lock/unlock concept: every value is always
encrypted at rest.

Rationale (user decision, 2026-07-16):

- Env vars are **personal, per-machine** config (API tokens for Cloudflare-type
  agent use cases, local tool config) — never team config. A settings file,
  even the gitignored local one, is plaintext on disk and one accidental
  commit/copy away from leaking.
- One storage story is simpler to use and to reason about than
  plain-vs-locked. "Where does my token live?" has exactly one answer.

## Storage

One JSON map per scope in the encrypted secret store (`secrets.json`,
safeStorage-encrypted values, atomic writes + cross-process lock):

| scope | account | reaches |
|---|---|---|
| user | `envvault::user` | every agent, every project, this Mac |
| repo | `envvault::repo::<repoRoot>` | agents in any worktree of that repo |

- Payload: `{"version":1,"vars":{"NAME":"value"}}`. An empty map deletes the
  account.
- `<repoRoot>` is the MAIN checkout's absolute path, normalized by
  `normalizeProjectRoot` — the same key the settings layers use, so every
  worktree shares the repo scope. Moving a repo on disk re-keys the scope
  (documented limitation; the vars simply need re-adding).
- The renderer keychain allowlist (`electron/keychain-accounts.ts`) grants the
  `envvault::` prefix.

## How agents see the vars

At spawn/resume, the renderer composes the caller env it hands the engine:

```
{ ...mcpSecretEnv, ...envVaultEnv(user ⊂ repo), ...providerEnv, ...sessionEnv }
```

- `envVaultEnv` = user scope overlaid by repo scope (repo — more specific —
  wins on a name collision).
- The repo scope for a cwd resolves via `findProjectForFolder` (covers the
  primary checkout, subdirectories, Zeros-managed worktrees via the path slug,
  and adopted foreign worktrees), with the bridge workspace list as fallback —
  so **all worktrees of a repo receive the repo's vars**.
- Caller env wins over everything the engine derives from settings files
  (`mergeSpawnEnv` merges file env UNDER it), and provider/session env wins
  over the vault, so a vault var can never hijack provider routing or
  per-session knobs.
- The agent's process env simply contains the values; every command, dev
  server, or script the agent runs inherits them. The vault protects secrets
  **at rest**, not from the agent — agents are meant to use these values.

## Name hygiene

- Names must match `[A-Za-z_][A-Za-z0-9_]*`.
- Code-injection names (`NODE_OPTIONS`, `PATH`, `DYLD_*`/`LD_*`,
  `GIT_CONFIG*`, … — the engine's `isDangerousEnvName`, single source of
  truth) are refused at write time and dropped at read time (defense in depth:
  a hand-edited `secrets.json` must not become an injection vector).
- Secret-shaped names are the point of the vault — allowed.
- Credential-redirect names (`HTTP_PROXY`, `ANTHROPIC_BASE_URL`, …) are
  allowed: both scopes are typed by the machine owner in the local UI — the
  same trust the engine already grants the user / repo-local settings layers.
  The hostile-clone vector doesn't exist here because nothing is read from the
  repo's files.
- Repo scope refuses a name already set at user scope (the UI has no override
  concept — inherited user vars are read-only on the repo page). If a
  collision exists anyway (added at user scope later), the courier
  deterministically lets the repo value win.

## No migration (decided 2026-07-16)

The vault shipped before any release carried the legacy lock/`[env]`-editing
UI, so there is nothing to migrate — the legacy path was removed outright
instead of migrated:

- `env-vault-migrate.ts` (settings `[env]` → vault mover) and
  `env-secrets.ts` (the `${zeros.secret}` sentinel courier over per-name
  `env::<NAME>` accounts) are deleted, along with the `env::` grant in the
  renderer keychain allowlist.
- Spawn composes `mcpSecretEnv` + `envVaultEnv` + provider/session env only.
- A hand-written `${zeros.secret}` sentinel in a settings file stays inert:
  the engine's spawn-env skips sentinels, and the UI masks them as `••••`.

## What stays file-based (deliberately)

- **Revised 2026-07-17 (repo-file slimming):** repo-scoped settings files
  (`<repo>/.zeros/settings.toml`, `settings.local.toml`, a worktree's own
  local file) no longer carry `env` / `env_files` AT ALL — the sanitizer
  drops those keys from repo layers with a warning, so a hand-committed
  `[env]` in a repo file is inert (and a hostile clone can't plant env at
  all). The USER file's `[env]` / `env_files` (plus team/managed policy)
  still resolve through the engine's hazard-filtered `spawn-env.ts` — the
  escape hatch for headless/cron spawns that have no renderer to courier
  vault values. The UI shows those as read-only inherited rows.
- Known limitation (unchanged from the legacy lock): vault values are
  couriered by the renderer, so a fully headless spawn (cron/relay with no
  desktop app running) does not receive them — same as provider keys and MCP
  secrets today.

## UI contract (revised 2026-07-16, row redesign)

- No lock toggle, no lock icons anywhere. No Override on inherited rows.
  Sentinels never render — a file-inherited secret shows `••••` presence-only
  (no reveal, no copy: the real value isn't readable in the renderer).
- Variables render as read-only single rows in a card (`--bg1-highlight`
  fill, `--border1` frame + hairline dividers): mono NAME · an eye toggle
  that reveals/hides the value · the value itself, masked as `••••••••`
  until revealed, click-to-copy with a "Copy" tooltip and a "Copied NAME"
  toast · pencil · trash. Rows are NEVER editable in place — the pencil
  reopens the Add dialog pre-filled (edit mode), the trash deletes
  immediately (a whole-map vault write).
- Reveal/copy/edit is the one place a stored value renders, on explicit
  user action only — the vault protects secrets AT REST, and the machine
  owner reading their own Keychain-backed value is in-model (the Keychain
  already granted this process the read).
- Empty state: "No variables." — nothing else. There is no section-level
  Save any more; every mutation persists immediately through the dialog or
  the trash.
- Repo page lists user-scope vault vars under **"Inherited from User
  config"**, read-only (reveal + copy, no pencil/trash), in the same row
  design. A user var shadowed by a repo var of the same name is hidden there
  (repo wins at spawn) and is not treated as reserved — the dialog edits the
  repo entry. File-based `[env]` entries whose provenance is the user layer
  join that group; entries from team/managed policy stay under "From settings
  files (read-only)" (repo files can't carry env since 2026-07-17). Provider
  API keys remain presence-only rows managed in Settings → Agent providers.

### Add / Edit variable dialog (2026-07-16)

Adding goes through a centered **Add variable** dialog
(`add-env-variable-dialog.tsx`) instead of inline empty rows; the pencil on
a row reopens the same dialog as **Edit variable**, pre-filled with the
stored name and value (saving under a new name renames — the old key is
deleted via `renamedFrom`):

- Name + Value fields, Cancel / Save; below Value, a `--fg2` description —
  "Paste a block of KEY=VALUE to add multiple variables". There is NO
  separate paste box (removed 2026-07-16): the Name/Value fields themselves
  detect pasted blocks, and in bulk mode the dialog surface keeps accepting
  pastes (another block appends to the list).
- Pasting a block (a whole .env works — comments, blank lines, and prose in
  between are ignored; grammar in `env-paste.ts` mirrors dotenv: `export`
  prefix, quoted + multi-line quoted values, inline comments, last repeat
  wins) replaces the Name/Value fields with the parsed **Variables** list and
  count; pairs that overwrite a stored variable are tagged "replaces stored".
  A bulk Save never uses what was typed in Name — the paste is the newer
  intent — but **Clear** returns to the fields with the typed text restored.
- A single pasted `KEY=VALUE` fills the Name/Value fields instead; the VALUE
  field refuses base64-with-`=`-padding lookalikes so a real value is never
  hijacked.
- Save persists immediately to the scope's vault (merged over the stored
  map) and reports the count.
- Nothing is skipped silently: vault-refused (code-injection) names and —
  on a repo page — names already set at the user scope are called out under
  the fields.
- A failed Keychain read disables editing ("Couldn't read the Keychain")
  instead of rendering an empty editor: saves write the WHOLE scope map, so
  editing over a failed read would wipe the stored variables. The spawn
  courier keeps its degrade-to-`{}` behavior (an agent always spawns).
