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

The private settings rule applies to personal configuration, not authored
Design state. `.zeros/design-dir.toml` records stable directory IDs and paths;
`.zeros/design/<id>/document.json` records frame geometry, titles, kinds and the
Foundation manifest. These files are versioned with Design source. Personal
selection uses `[design] directory_id`; legacy `directory` remains readable.
Each worktree resolves its ID against its own registry. A missing or conflicting
mapping pauses Design edits instead of selecting another document. See
[Design workspace](design-workspace.md) for migration and Git behavior.

## Customize

Customize currently shows only **Zeros-managed MCP servers and skills**, at
user and repository scopes. Provider tabs and Apps/Plugins inventory views are
deferred. Stored provider selections are bounded to a supported Zeros category
before rendering, so they cannot trigger hidden native discovery.

The backend retains read-only provider inventory with source ownership:

- Codex uses `plugin/installed` for local and remote marketplace installations,
  `app/list` for accessible account apps, and `app/installed` for enabled/callable
  runtime state. `skills/list` reads effective skills; `config/read` and bounded
  `plugin/read` calls read native and installed plugin MCP declarations.
  These reads start no conversation. Available apps have callable
  tools; disabled, unverified, and unavailable entries remain distinguishable.
  Normal chats preserve the native `codex_apps` bridge. Tool-free title threads
  still disable it. Provider auth, tool policies, and Zeros approvals remain in
  force; this change does not force-enable native-disabled apps.
- Claude uses a disposable SDK query inside the provider utility boundary, with
  no prompt, no transcript persistence, no model turn, no tools, and hooks
  disabled. `mcpServerStatus`, `reloadSkills`, and `reloadPlugins` report that
  query's inventory. MCP discovery may connect configured native servers so the
  provider can report account connectors. Skill/plugin reads retain strict MCP
  scoping. Organization policy and native configuration remain authoritative;
  the SDK has no separate inventory of every cloud-only Claude extension.
- Cursor exposes no separate cloud app/plugin inventory through the integrated
  SDK. Local declarations and materialized plugin packages are shown with that
  limitation. Cache discoveries are **Found on disk**, never proof of active
  installation. This includes `plugins/local` development packages and declared
  plugin component paths within their package. Features confined to a native
  app are not advertised as callable.

Local MCP requires **Customize → MCP → Import**, including local HTTP
configuration and MCP contributed by local plugin packages. Supported account
connections load automatically under provider policy: Codex retains account
plugins and `codex_apps`; Claude retains subscription-connector discovery.
Claude/Cursor SDK settings-source switches also exclude coupled local
settings/rules/plugins. Cursor dashboard connections require Cursor-hosted
execution. The composer **Tools** popover reports actual session connections;
Cursor's SDK cannot verify MCP status or launch MCP OAuth, and Claude exposes
status but no SDK OAuth launcher. Codex offers its supported browser action.
See [extension-discovery.md](extension-discovery.md) for source selection,
status/auth boundaries, remote limitations, and the host opt-out.
Inventory reads themselves do not change native configuration or permissions.

Local declarations and provider results are composed, even when a provider
returns a complete empty list. Source completeness is explicit: unavailable
account enumeration never means the account has no extensions. Partial refreshes
retain only entries from the failed source and a verified matching identity;
confirmed local deletions still disappear when an account lookup fails. A new
provider runtime has a new identity, so its failed lookup cannot resurrect old
account entries. Authentication changes also advance the renderer cache owner.

Claude and Codex offer **Account**, **CLI**, and **API** in the **Configure Claude/Codex**
dialog in Settings → Providers. **Custom Providers (Coming soon)** is disabled.
Cursor offers Account and API. Account and CLI both use subscription credentials;
API uses only the selected saved API key. The connection row reports
**Connected via subscription**, **Connected via API**, or an existing gateway's
name. Choosing a method cancels any pending browser ceremony and closes the
inline login terminal before applying the new authentication preference.

Account opens the device-owned browser flow. Claude uses the bundled Code
runtime's `auth login --claudeai`; **Use a sign-in code** reveals its optional
manual callback fallback. Codex uses an authentication-only app-server connection
(`account/login/start` with `type: "chatgpt"`). Neither creates a chat nor sends a
model prompt. Selecting CLI reveals **Open terminal**; only that button starts
the inline terminal. Browser ceremonies and provider login
terminals expire after five minutes; bounded renderer IPC waits also recover if a
native response is lost. New accounts use separate native credential profiles. **Add account** keeps the
current selection until sign-in succeeds; the account picker selects one saved
account. CLI uses the separately managed device login. Existing device logins are
retained as a **Device account** for compatibility. Their existing `auth = "cli"`
setting remains the serialized subscription selection. The native encrypted
account store owns Account versus CLI selection; the device-local
`providers:subscription-entry:<provider>` key supplies a synchronous UI fallback.
See [provider accounts](provider-accounts.md) for isolation and switching details.

A chat authentication failure renders a product notice outside agent output and
turn footers. **Sign in** publishes Settings → Providers and the exact provider
tab before navigation; it never starts authentication from chat. The notice does
not infer successful sign-in from credential presence or offer a special retry
button. After signing in, the user sends a new message or types “Continue” in the
normal composer. The earlier prompt stays in the same chat and becomes **Agent
stopped** with its normal footer as soon as the new message appears. A blocked
user message carries optional `authRecovery.text` metadata so its expanded prompt
survives reload; attachment bytes remain in the context graph. Consecutive blocked
prompts (including older transcripts identified by their authentication failure)
and their available attachments accompany the next normal send as prior
context, because a prompt blocked before dispatch may not exist in provider
history. Subsequent sends do not replay them again.
This is an additive JSON transcript field under the existing message payload;
older clients ignore it, so it does not require a protocol-version bump.
The new send has its own turn ID. Admission restarts the ephemeral execution with
the selected credentials and resumes the existing provider conversation without
resetting files or deleting the earlier prompt. If the provider starts an empty
session, the next send includes a bounded replay of the prior conversation.
Queued messages are excluded from that replay. No prompt is sent automatically
after login. Registry refreshes preserve actual authentication rejections until
the selected credentials change or a prompt succeeds; a presence-only probe
cannot erase a provider rejection just because Settings refreshed.

Cursor uses the bundled SDK's browser login. Its resulting expiring credential is stored in Electron's encrypted
store, in the main-only `provider-accounts-cursor` account. The legacy
`cursor-subscription` credential remains readable for existing device accounts. Status responses expose
identity metadata, never that credential. The engine receives provider
credentials over private stdin at boot and after changes; user/managed auth
settings select the credential at each launch, including local headless work.
Cursor persists the explicit new choice as `auth = "subscription"`; legacy
Cursor `cli` values continue to select the prior API-key behavior. Disconnect
and expiry cannot silently select a different API key. No desktop credential
is automatically sent to a cloud workspace.

Zeros skills live in `<user-settings-dir>/skills/<name>/SKILL.md` or the main
checkout's locally excluded `.zeros/skills/<name>/SKILL.md`. Repository skills
override same-named user skills. A bounded description/path index reaches all
harnesses through the common session instruction path. The agent reads the
skill when relevant using its existing tools and permissions. New sessions
discover changes; skill edits compare full-file revisions before saving or
removing, and removal retains supporting files.

Customize reads share a bounded cache by connection, authentication revision,
scope, category, and provider. Refresh keeps confirmed results, category intent warms the
destination, and a form's scope identity prevents drafts moving between repos.

See [extension discovery](extension-discovery.md) for provider capabilities,
research sources, and the distinction between discovery and cloud execution.
