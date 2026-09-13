# Personal settings and customization

Personal organization settings belong to the device, independently of sign-in.
Settings resolve from user defaults through repository defaults to private workspace overrides:

| Owner      | File                                         | Applies to                                     |
| ---------- | -------------------------------------------- | ---------------------------------------------- |
| User       | `~/.zeros/settings.toml`                     | All local repositories                         |
| Repository | `<main-checkout>/.zeros/settings.local.toml` | That repository and its linked local worktrees |
| Workspace  | `<worktree>/.zeros/settings.toml`            | Only that checkout                             |

Stable, beta, and development retain separate user directories (`.zeros`,
`.zeros-beta`, `.zeros-dev`). `ZEROS_USER_SETTINGS_DIR` remains the test/runtime
override. Existing managed policy and cloud organization compatibility are
separate; this change does not introduce team settings for Personal.

## Migration and Git exclusion

`settings/personal-repo.ts` resolves Git's main-checkout identity. The main
checkout's old `.zeros/settings.toml` is migration input only, never an active
shared layer.
The migration copies previously supported scripts, Git defaults, prompts, and
Design settings, overlays existing personal values, and records
`settings_version = 2` in the local file. That marker prevents deleted overrides
from returning after a branch switch. Old files remain recovery copies; Zeros
does not delete tracked files or change the repository's shared `.gitignore`.

Existing worktree overrides retain their workspace owner and are never merged
into the main checkout. Newly created worktrees, including the existing-branch/PR flow, get
an empty, excluded override file. Existing private worktree `settings.local.toml`
files are renamed without changing their contents. If a branch still tracks
the old shared `settings.toml`, the workspace uses `settings.local.toml` as a
private fallback. Tracked files are never overwritten or hidden using index
flags. If both private filenames already exist, Zeros reports the conflict
and leaves both files intact for consolidation. Unset keys continue to inherit future changes
to repository and user settings. Deleting an override restores inheritance.
Setup, Run, Archive, prompts, Git defaults, Design pointers, and direct MCP
configuration resolve against the actual checkout. Files to copy and workspace
storage location remain repository/user concerns; account/authentication and
application preferences remain user concerns. MCP composes by server name;
`enabled = false` shadows an inherited direct server. Gateway OAuth/header
backends remain user-scoped because the gateway itself is global.

Malformed input is reported instead of overwritten. The active shared repo
layer is removed; existing legacy files are migration/recovery input only.

The engine establishes `/.zeros/settings.local.toml` in
Git's **local** `info/exclude` before writing (or `/.zeros/settings.toml`
for workspace overrides), then verifies `git check-ignore`.
It refuses tracked personal files and repository rules that defeat exclusion.
It never silently stages/untracks files. Git integrations reject legacy branch
changes that would overwrite an existing ignored private settings file. Those
overrides must be preserved outside the checkout before integrating the legacy
branch and restored to its private fallback afterward. Symbolic links in the writable settings
path are refused. Structured and raw saves use a temporary file, mode `0600`,
and rename; existing comments and unknown keys survive structured edits.

The serialized `repo` bridge name remains a compatibility alias for
`repo-local`. `workspace-local` addresses the actual checkout (including calls
from a subdirectory). Repository settings UI edits defaults; users can edit the
workspace file in their editor. The generated workspace JSON schema documents
its supported keys. The watcher observes main and workspace files separately,
prunes removed owners, and scopes Design reconciliation to affected workspaces.

Workspace settings never enter archive Git snapshots, including snapshots that
force-add provisioned directories. Archive preserves their exact text in a
private companion under the engine's local data directory; restore puts it
back without overwriting a file already restored and subsequently edited.
Permanent deletion removes the companion. These files are not cloud/team state.

Legacy localStorage scripts migrate to setup and named `scripts.run_actions`;
all run commands are retained. Existing TOML choices win. Malformed files are
retried instead of marking migration complete.

## Preference owners

`[preferences]` in user TOML owns appearance, enabled agents, experimental and
internal switches, terminal-agent definitions/defaults and analytics choices. Internal switches still require the existing
staff gate. `[models]` and `[providers]` are also user-only TOML sections. Provider
authentication method, executable override, and gateway URL belong here; API
keys remain in the OS secret store. `[github]` account selection and browser
policy are user-only. Repository and worktree schemas exclude account fields.

Browser storage is a synchronous cache for app startup, with a durable outbox
for unacknowledged preference edits. The first migration merges under existing
file choices; `preferences_version = 1` prevents deleted choices from being
reimported. File edits hydrate subscribed stores. A response from an earlier
save cannot overwrite a newer pending edit. Preference sync runs only against
the local desktop engine; remote settings reads omit the personal table.

Models and provider preferences use the same acknowledged-save ownership.
`agent_preferences_version = 1` records their one-time browser import. Each
outbox item addresses one TOML field; the engine merges that field into the
latest file without replacing sibling controls or unknown text. Failed saves
remain pending through reconnects and app restarts and retry with bounded
backoff. External file edits and deletions replace confirmed caches, with newer
pending edits overlaid until acknowledged. Before deriving local provider
credentials, the renderer waits for this sync. Local executable and gateway
configuration are read by the engine directly from TOML, so an older browser
cache cannot override a manual file edit.

Repository and worktree resolution use a supported-key allowlist. Unsupported
top-level and nested fields remain in the original TOML for round-trip
compatibility but are excluded from effective settings and produce warnings.
Both raw and structured saves validate Design paths and stable IDs against the
actual checkout, including prospective paths, spelling, links and overlaps.

Codex memory switches in Settings explicitly identify their native ownership:
they use Codex's `config/batchWrite` API and affect Codex outside Zeros. Memory
content and reset operations remain in Codex's native storage, separate from
Zeros user TOML.

Chats, workspace records, navigation selections, drafts, panel layout, and
caches retain their existing database/browser owners. Credentials remain in
the OS secret store/provider authentication stores. They are not consolidated
into TOML or copied from native configuration by inventory reads.

## Tracked Design metadata

Each Design folder carries a tracked `design.toml` with its stable ID, frame
geometry, titles, kinds and Foundation metadata. Commit it together with the
source and short `rules.md` ownership instructions. Code agents may read the
folder but cannot mutate it through generic Code operations. `.zeros/` holds
private state and is ignored by default.

Personal selection uses `[design] directory_id`; legacy `directory` paths remain
readable. Each checkout resolves the ID from its own folder manifests. Deleting
`.zeros/` loses the private selection, but Design folders are still discoverable.
Settings can also adopt an existing folder and recover metadata saved in Git.
Older central registry/JSON layouts remain readable and migrate through the
Design API without changing IDs or document values. See
[Design workspace](design-workspace.md) for migration and Git behavior.

## Customize

| Category | Provider tabs                | Creation in Zeros |
| -------- | ---------------------------- | ----------------- |
| MCP      | Zeros, Claude, Codex, Cursor | Zeros only        |
| Skills   | Zeros, Claude, Codex, Cursor | Zeros only        |
| Plugins  | Claude, Codex, Cursor        | None              |
| Apps     | Claude, Codex, Cursor        | None              |

Native inventory is read-only and preserves source ownership:

- Codex uses `plugin/installed` for local and remote marketplace installations,
  `app/list` for accessible account apps, and `app/installed` for enabled/callable
  runtime state. These reads start no conversation. Available apps have callable
  tools; disabled, unverified, and unavailable entries remain distinguishable.
  Normal chats preserve the native `codex_apps` bridge. Tool-free title threads
  still disable it. Provider auth, tool policies, and Zeros approvals remain in
  force; this change does not force-enable native-disabled apps.
- Claude account connectors are read through `query.mcpServerStatus()` on an
  existing session, including explicit needs-auth status. Browsing inventory
  never starts a query or widens its settings. There is no standalone account
  inventory here: automatic cloud connectors can remain excluded by the current
  strict MCP policy. Local installation records show downloaded marketplace
  plugins, including components, without executing them.
- Cursor exposes no separate cloud app/plugin inventory through the integrated
  SDK. Local declarations and materialized plugin packages are shown with that
  limitation. Cache discoveries are **Found on disk**, never proof of active
  installation. Features confined to a native app are not advertised as callable.

Native MCP outside the Codex account bridge retains its existing adapter scope.
Inventory visibility does not enable a plugin, import native permissions,
change hooks, copy credentials, or mutate native configuration. Claude/Cursor
settings sources are unchanged. This is not a blanket isolation of preexisting
native policy: a provider's enforced restrictions can still apply.

Provider failures fall back to local declarations. Partial refreshes retain
previous exact-scope entries, label retained availability as unverified, and
show the provider warning. A later complete inventory can remove stale entries.

Zeros skills live in `<user-settings-dir>/skills/<name>/SKILL.md` or the main
checkout's locally excluded `.zeros/skills/<name>/SKILL.md`. Repository skills
override same-named user skills. A bounded description/path index reaches all
harnesses through the common session instruction path. The agent reads the
skill when relevant using its existing tools and permissions. New sessions
discover changes; skill edits compare full-file revisions before saving or
removing, and removal retains supporting files.

Customize reads share a bounded cache by connection, scope, category, and
provider. Refresh keeps confirmed results, provider/category intent warms the
destination, and a form's scope identity prevents drafts moving between repos.
