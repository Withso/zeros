# Extension discovery and account connections

The local machine, provider account, and active provider session are separate
owners. An MCP server can run remotely while its declaration is a local file.
Apps connect external services; plugins are packages that may contain skills,
MCP declarations, hooks, commands, and other provider-specific components.
Signing into the same account on two machines does not synchronize their local
declarations or guarantee identical effective inventories.

Customize currently exposes only Zeros-managed MCP servers and skills. Provider
inventory endpoints remain available to engine callers for future UI work;
browsing Customize does not start native account discovery. Legacy selections
for provider inventories restore synchronously to a Zeros category.

## Provider contracts

Audited against the repository pins on 2026-09-10: Codex protocol 0.153.4,
Claude Agent SDK 0.3.261, and Cursor SDK 1.0.31. The installed SDK declarations
and generated protocol are the implementation authority.

| Provider | Supported discovery                                                                                                            | External limit                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Local declarations plus app-server apps, installed marketplaces/plugins, effective skills, and installed plugin MCP components | Accessible, enabled, and callable are different states. Results reflect current account, policy, configuration, and scope.                                                         |
| Claude   | Local declarations plus MCP status, skills, and plugins from an admitted temporary SDK session                                 | Session inventory is filtered; Claude web-only skills/plugins/apps have no standalone account-wide SDK listing. A missing connector can also mean a pending or failed cloud fetch. |
| Cursor   | Local MCP/skills and cached/development plugin packages; SDK browser authentication                                            | The public SDK has no account-wide MCP/app/plugin/skill inventory endpoint. Browser login does not create one.                                                                     |

Primary research references:

- [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server):
  app access and installed runtime information are separate reads. The plugin
  surface is still evolving; unsupported methods degrade to explicit partial
  discovery and local results.
- [Claude MCP documentation](https://code.claude.com/docs/en/mcp): account
  connectors require the active Claude subscription authentication method and
  remain subject to connector controls and managed policy. An API key or a
  setup-token does not grant the same connector inventory.
- [Claude SDK plugins](https://code.claude.com/docs/en/agent-sdk/plugins):
  packages loaded in a session are distinct from a catalogue of everything
  available through a web account.
- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): browser login
  mints an expiring user API key. Settings sources and available integrations
  differ between SDK local and hosted cloud agents. The public SDK exposes
  authentication and agent operations, not an account extension listing.

## Native session execution

Ordinary chats connect the Zeros registry and supported account extensions.
Local MCP declarations require **Customize → MCP → Import** first. HTTP is a
transport, not account provenance: an HTTPS endpoint in a local configuration
file still requires import. Provider and organization disable policies remain
in force; Zeros does not rewrite the user's native configuration files.

- Claude uses `settingSources: []` with non-strict MCP discovery in Code chats.
  This excludes user/project MCP declarations while leaving the runtime's
  independent claude.ai subscription connector discovery enabled. The SDK
  couples these disk sources with local settings/plugins/rules; those sources
  are consequently excluded too. Zeros instructions, imported MCP and Zeros
  skills remain injected. There is no complete API for loading all extensions
  attached to a Claude web account. Strict MCP configuration is retained for
  restricted actors and tool-free helpers.
  Claude Code's **bundled** skills are separate from those filesystem settings
  sources: the runtime still supplies them with `settingSources: []`. Zeros
  reads the supported command list and skill names over the control connection
  before the first prompt. Opening the `/` picker prepares that connection
  through normal chat admission and shares the Tools cache. The picker updates
  as capabilities arrive; query generations and command revisions reject stale
  results after restart or a newer provider push. Provider feature gates still
  decide which bundled commands are available. Skills present only in Claude's
  web environment are not automatically installed in Claude Code.
- Cursor uses `local.settingSources: ["team"]` for ordinary Code chats. This
  enables the SDK's team rules and dashboard-managed skills path without
  enabling the `project`, `user`, or `plugins` MCP sources. Only inline,
  admitted Zeros MCP connects. The source selection is captured at admission
  and reused for prewarm, create, resume, fallback, and mode rebuild. Restricted
  actors and the host account opt-out use `[]`. Local rules/skills/plugins
  remain coupled to the excluded disk/plugin sources. Dashboard
  account MCP is a **Cursor-hosted agent** capability; subscription sign-in
  does not deliver it to SDK local mode, including local mode inside a Zeros
  cloud workspace. Zeros does not silently transfer chats to Cursor hosting.
- Codex disables effective local `mcp_servers` declarations before starting or
  resuming the thread, preserving imported name collisions and transport
  validation. MCP from local plugin packages is excluded too. Provider plugin
  provenance (`remotePluginId` or remote source), rather than download location,
  distinguishes account packages. Account plugins and `codex_apps` stay enabled
  subject to provider settings. A local declaration that shadows `codex_apps`
  still requires import. If provenance is unavailable, disk plugin MCP
  is suppressed; if the effective MCP config cannot be read, admission fails
  without starting a thread and disposes the runtime. The separate native
  Browser host continues to control its bundled browser plugin.

  Codex Desktop's bundled computer/browser runtime also reports a local source.
  Verified `openai-bundled` runtime materializations in the selected Codex home
  are preserved without admitting user-authored MCPs. See
  [native computer use](native-computer-use.md) for provenance, profile, approval,
  artwork and macOS setup contracts.

`ZEROS_NATIVE_MCP_PASSTHROUGH=0` remains a host opt-out for native account loading;
it no longer enables ambient local MCP. Restricted actors keep only their
admitted MCP registry. No provider account credentials or local MCP secrets are
copied to a cloud workspace by these controls.

### Source ownership and component loading

Ownership and component type are separate decisions. Local MCP configuration
requires import; that requirement does not inherently exclude rules, skills,
or the rest of a plugin. A downloaded marketplace package can still represent
an account installation, and an HTTPS MCP declared in a local file still
represents local configuration. A provider web application's saved content
is not necessarily synchronized to its coding SDK.

Codex already offers the needed per-MCP controls while preserving native
instruction and skill loading. Claude's account connector discovery remains
independent of `settingSources: []`; its managed policy tier also remains in
force. The pinned Claude SDK additionally supports `skipMcpDiscovery` on an
explicit `plugins` entry, preserving that package's skills/hooks/agents/commands
while skipping its `.mcp.json` and manifest MCP declarations. Zeros does not
yet use that path for automatic native plugin loading: it is not an account
plugin inventory or a blanket switch for all local sources, and subagent MCP
frontmatter requires separate review before enabling those components.

Cursor's `team` source provides partial separation for team content. The pinned
SDK still has no public MCP-only exclusion option for its `project`, `user`,
or `plugins` source. Preserving all their non-MCP components requires a separate
component-loading integration; simply enabling those sources violates the
local MCP import contract. No full automatic inheritance of every cloud
rule/skill/plugin is claimed for either Claude or Cursor.

## Composer Tools

The bottom-right composer Tools button shows collapsed, independently
expandable Plugins, Apps, and MCPs groups only when they contain reported
entries. Empty groups are omitted, including unsupported or not-yet-reported
categories. When all groups are empty, the popup says "No tools reported for
this session"; a pending discovery retains loading feedback. Refresh remains
available. An omitted category is not proof that the account has no extensions.
Counts describe the inventory reported for this execution; an unsupported
inventory with retained entries displays a dash, not zero.
Partial counts have an asterisk and can include retained, unverified entries.
Expanded rows show only a name and a status icon or supported authentication
action, without descriptions or inline status labels. Enabled/loaded plugins
and available/connected tools receive a tick; unavailable states receive an
error icon. The underlying status is retained in accessible names and short
hover titles. Refresh uses `--fg2`. Authenticate is an unpadded text action with
no hover background; its color starts at `--blue-fg` and increases only HSL
lightness by ten percentage points on hover, derived from the active theme.
Plugins can
contain apps and MCPs, so category counts overlap and must not be summed as a
unique tool total. Skills are not MCP connection receipts. The Customize page
continues to manage Zeros MCP and skills only.

Codex reads `app/installed` with the current `threadId` for installed app
membership and effective `enabled`/`callable` state. Bounded `app/read` batches
provide names and plugin relationships only; directory/catalogue entries never
become installed apps. `plugin/installed` uses the admitted session cwd and
reports workspace installation/enablement, not exact-thread loaded-plugin
receipts. A plugin's tick represents Enabled or Loaded, as exposed in its
accessible status; it does not assert that its components are connected.
Separate `mcpServerStatus/list` receipts determine MCP
connection status. `codex_apps` remains their shared MCP bridge, with individual
apps in Apps. A missing or failing bridge cannot make apps appear available;
an imported local namesake is never treated as that account bridge. Native
totals may include unimported local MCPs that this execution excludes.

Claude Apps reuses verified account connector membership and status from the
same MCP read, retaining provider provenance rather than guessing from names
or URLs. Plugins uses the live query's `system/init` loaded-plugin receipt,
when available. Before that receipt its empty group is omitted; Tools does not
submit a prompt or invoke the mutating `reloadPlugins()` method to obtain it.
The receipt belongs to the Query and ends when that connection is recreated.
Cursor and older engines without plugin/app inventory omit those empty groups
while preserving their supported MCP rows. Rechecked against Cursor SDK 1.0.31
and its current documentation on 2026-09-13: account login does not expose
dashboard MCP to local SDK execution, and the public API has no account
app/plugin inventory. Hiding empty categories does not change these execution
limits or automatically enable excluded local sources.

MCP startup and reconnect failures are connection state shown in Tools, not
chat events. Codex `mcpServer/startupStatus/updated` notifications never create
transcript warnings, including while a prompt is running or Tools is polling.
Errors returned by actual `mcpToolCall` items remain visible on those tool
calls; explicit MCP sign-in failures and unrelated agent errors remain visible.
Turn grouping also omits legacy `mcp_startup_status` notices without deleting
their persisted records or counting them as events or leading system turns.

Opening Tools prepares the chat through its normal, single-flight admission
path, including authentication, environment, and execution boundaries. The
popover stays open as the new execution arrives. Refresh retries admission
when needed and reloads the tool snapshot; neither action submits a message.

The opt-in `tools.session.inventory` operation carries grouped inventory;
`tools.session.list` retains its strict legacy connection-only response. Both
check the exact admitted provider/execution/cwd, call the adapter's
`sessionTools` capability, and check the route again after the read. A new
renderer falls back to the legacy operation only when the engine explicitly
does not support inventory, scoped to that bridge connection identity. Provider,
authentication and transport errors do not trigger compatibility fallback.
Local callers may send that exact chat cwd (including plain folders and
worktree subdirectories); it is not interpreted as a workspace database id.
Remote callers still resolve authorized opaque workspace ids. This path grants
no generic filesystem access and cannot select a different session directory.
Codex uses `mcpServerStatus/list` with `threadId`. Claude opens its normal Query
control connection when absent, then reads `mcpServerStatus`, without a prompt
or tool call. It preserves any existing live query and its staged settings;
unused control connections follow idle teardown and reopen on demand. Claude's
account metadata can explain a missing subscription login or incompatible
authentication. A successful web login is separate from the Code runtime's
active login. Empty account connector status remains partial because the SDK
does not report whether cloud discovery is complete. Bounded, best-effort
account reads never discard confirmed imported MCP connections and expose no
account identity. Restricted sessions do not request account diagnostics.

Claude's pinned runtime also returns directory connectors the account has never
connected. Its SDK status response omits the eligibility metadata, so Tools and
connector discovery additionally read the runtime's versioned
`GET https://api.anthropic.com/v1/mcp_servers?limit=1000` endpoint with the
`mcp-servers-2025-12-04` beta header in the trusted engine. This is a compatibility
integration with the pinned runtime, not a public account inventory SDK.
Stable connector IDs join account membership to session status; names, URLs,
and a `needs-auth` status cannot establish membership. The provider's explicit
`never_connected_no_auto_connect` entries are excluded. Connected account
services retain pending, authentication, and failure states in Tools.

The membership reader captures the live query's native credential namespace,
shares concurrent requests, and revalidates on Refresh. A missing selected
profile never falls back to another login. Credentials, connector URLs, and raw
provider responses remain outside renderer results. A bounded lookup failure
retains that query's verified connections and reports partial discovery;
unclassified failures do not become speculative connector rows. Unknown API
shapes and truncated catalogues remain partial. The cache ends with the query,
so a replacement query or account does not inherit its membership.

`claude-in-chrome` is Claude Code's native browser MCP, controlled by the existing
**Use Claude Code with Chrome** preference (`--chrome` / `--no-chrome`). It is
separate from the claude.ai connector catalogue and remains visible when the
runtime loads it. Changing that creation-time flag takes effect when the query
is recreated at the normal session boundary.

Cursor has no public
MCP connection-status API, so its rows show an Error with an explanation that
status could not be verified; configured does not receive a connection tick.
Provider errors, tool schemas, URLs, headers and credentials are excluded from
the status result.

Import is configuration adoption: the user selects discovered local MCP
declarations, and Zeros copies them into its own registry. They then execute as
Zeros-managed servers across providers. The source files remain provider-owned;
provider login grants are not copied with a URL. Discovery includes Codex
project configuration and its active `CODEX_HOME`, alongside Claude and Cursor
local declarations. This is independent of native settings-source loading:
those SDK switches currently bundle MCP with other native content, which is
why disabling those sources also excludes their local rules/skills/plugins.
Cursor team rules/managed skills and Claude's supported account connectors
have separate paths. Zeros instructions and imported content remain available.

For Cursor local execution, the existing Zeros MCP gateway is the supported
common connection path: configure a remote service and its Zeros-owned grant,
then inject that server into Cursor just like other providers. Cursor-dashboard
OAuth grants are not exportable through the public SDK. Inheriting those grants
directly requires a Cursor-hosted agent; the SDK does not expose only its hosted
connector layer as an MCP proxy for local runs. Linking a team server to a
Cursor marketplace distributes configuration, not a grant to Zeros. See the
[SDK source rules](https://cursor.com/docs/sdk/typescript#mcp-servers) and
[cloud MCP contract](https://cursor.com/docs/cloud-agent/capabilities).

`tools.session.authenticate` is an explicit local action. Codex rechecks the
same thread's `authenticationRequired`/`notLoggedIn` status before starting
`mcpServer/oauth/login`. The renderer opens only the validated HTTP(S) URL
returned by that action, and rejects a late result after navigation or an
account/connection change. Concurrent clicks share an engine flight. Claude and
Cursor expose no supported SDK MCP OAuth launcher, so no button is invented.
Native OAuth's host-loopback callback is not forwarded to remote renderers;
remote status strips that action from both legacy and grouped entries. Apps
and Plugins never offer an MCP authentication action. Zeros gateway-managed OAuth retains its
separate existing Customize/headless authentication flow.

The renderer cache is bounded and keyed by bridge execution identity, connection
epoch, provider-auth revision, workspace, provider, and session. Intent warming
and opening share requests. Refresh keeps confirmed rows; missing entries in a
partial category become unverified, while a complete category removes missing
entries independently of failures in other categories. Unchanged row, group,
and snapshot references are retained. Only an open, active, visible
popover polls; hidden retained chats release the overlay and stop work.
Claude and Cursor title helpers explicitly use empty tool and settings-source
lists; Claude also disables hooks, native MCP, and transcript persistence. Codex
title threads retain their separate MCP-disable configuration.

## Ownership and completeness

`ExtensionInventory.sources` reports local/account/session ownership and a
complete, partial, unsupported, needs-auth, or requires-session state.
`ExtensionEntry.sourceId` links an entry to that owner. These are additive wire
fields. Source ownership does not assert that an extension is portable or its
tools are callable. IDs are namespaced while composing local/provider results;
provider-confirmed file entries replace matching local file observations.

The engine always retains independently discovered local declarations.
Unavailable methods and failed requests have different source states. A failed
source can retain prior entries only under a matching verified identity;
successfully scanned sources can confirm deletions independently. New native
runtime snapshots deliberately use distinct opaque identities. The renderer
also keys by authentication revision so late pre-switch reads cannot populate
the selected account's view. Ordinary refresh retains the same-key snapshot.

Local scans bound file sizes, entry counts, and directory traversal. Native
credentials and server command/header/env values are not returned by inventory.
Declared custom plugin component paths must remain inside the package, including
after resolving symlinks. Native read errors and scan limits mark results partial.

Personal provider reads use a neutral utility directory instead of accidentally
inheriting the current repository. Discovery uses a different directory from
authentication probes, whose cleanup must not race an inventory query.
Repository reads use the authorized repository
scope and may include inherited provider settings. Claude discovery starts no
model turn and disables hooks; MCP status discovery can initialize configured
MCP processes/connections inside the existing execution boundary. It does not
call tools or change an existing conversation. Its connected servers are shown
as configured, since another conversation can apply different permissions.

## Browser subscription authentication

Settings → Providers → Connect → Account uses the native `provider_subscription`
command for Claude, Codex and Cursor. Chat's Sign in action navigates to the
matching provider tab; authentication starts only in Settings. The command accepts
only a provider and a closed action schema. It accepts a bounded Claude code only
for the matching live attempt; executable paths, environments, authorization
URLs and workspace paths are not renderer inputs. Status/events contain account
metadata, attempt IDs and monotonic revisions, never OAuth URLs, codes or tokens.
The device cache orders notifications and request responses by revision, shares
concurrent clicks, rejoins a native attempt after renderer reload, and performs
no hidden-surface polling. The Account panel owns the optional code/cancel UI;
CLI uses a separate inline terminal. Both have a five-minute sign-in deadline,
and renderer IPC waits are bounded if native acknowledgements are lost.

Claude invokes the pinned native `auth login --claudeai` command with piped
stdio, opens the official authorization URL in the system browser, and supports
the CLI's pasted-code fallback. Completion requires a successful command and a
subscription result from `auth status --json`. This is the full native account
login, not `setup-token`. Codex starts an auth-only app-server, initializes the
protocol, requests `account/login/start` with `type: "chatgpt"`, correlates
`account/login/completed` by login ID, and confirms `account/read`. No thread,
model turn, repository trust prompt or tool execution is involved. Both keep
credentials in their provider-owned native stores, including configured profile
roots. Account checks do not promise that every connector grant is healthy;
Tools still obtains connection state from the session runtime.

Electron resolves the same staged runtimes as agent execution, honoring only
device/managed executable overrides. Auth children use a private application
directory and a minimal environment preserving native profiles and proxy/cert
settings. API keys, model-only tokens and preload-injection variables are not
inherited. Browser destinations are restricted to the pinned providers' HTTPS
authorization routes. Subprocess groups and callback listeners are reaped after
completion, cancellation, timeout or app quit. A replacement waits for the old
attempt to drain. Cancellation never logs out a previously working account and
cannot undo a credential-store commit that already occurred in the provider.

Claude/Codex keep their serialized `cli` preference for both Account and CLI;
the connection row reports Connected via subscription.
Their native stores remain shared with standalone Code/Codex. Signing in on the
desktop does not grant or copy credentials to a cloud workspace.

## Cursor authentication and local automation

The compatibility `cursor_subscription` command retains its closed action schema
and status, connect, cancel and disconnect operations. The shared subscription
controller delegates to the same native credential owner. Electron runs only the SDK's
browser authentication API, fixes the official authentication origins, suppresses
authorization URL logging, and stores the result with safeStorage. The credential
slot is absent from the renderer keychain allowlist. Browser attempts deduplicate,
expire after three minutes, and reject late completion after cancellation or
replacement. Failed replacement preserves the previous credential.

The new explicit Cursor auth selection is persisted as `subscription`; legacy
Cursor `cli` values retain their old API-key meaning. Pasted API keys and browser
credentials occupy separate slots. Expiry/disconnect never falls back from a
selected browser account to a pasted or inherited key. SDK logout is local-only:
revoke the minted credential in Cursor's dashboard to invalidate it remotely.

Electron seeds supported provider API keys and the Cursor browser credential
over the private parent pipe. The local engine validates and holds the working
projection in memory. User/managed settings select the credential at spawn, so
inventory and local automation can work without renderer credential reads.
Inventory responses and ordinary bridge events contain no credentials. Existing
sessions retain their original authentication until recreated.

## Cloud execution boundary

Discovery is not deployment. Local paths, stdio servers, native credential
stores, executable dependencies, and interactive app UI cannot be assumed to
exist in a cloud workspace. This change does not project desktop credentials to
cloud workers or install packages there. Future cloud execution needs an explicit
provider-supported account grant, organization policy, workspace installation,
credential lifetime, and capability check. An unsupported account inventory must
remain visible as such to automations; it must never become an authoritative
empty account or a promise of runnable tools.

## Verification

Regression coverage includes account/cache races, source-specific deletions,
Cursor auth migration and credential selection, expiry, cancel/late completion,
provider-error redaction, local plugin paths, MCP/skill/plugin discovery, and
partial provider responses. The installed Claude SDK's three control reads were
also exercised in a temporary unauthenticated configuration without a prompt.
The installed Claude runtime connected to two temporary user/project MCP
fixtures with native settings sources, then connected to neither with the new
session policy. Neither run submitted a prompt or invoked a tool. Composer
browser coverage verifies collapsed groups and counts, keyboard expansion,
compact name/status rows, accessible availability versus enablement, action
colors, unknown inventory, refresh, browser authentication,
account-switch races, Escape focus, chat isolation, and hidden-surface polling.
Real provider-account inventories and the macOS browser/safeStorage flow require
signed-in desktop validation; unauthenticated Linux checks cannot certify them.
The bundled Claude runtime was additionally checked with empty native settings
sources: supported commands and skills were available over control reads,
without a prompt, tool invocation, or loading either local MCP fixture. Regression
tests cover early command discovery, stale query results, missing account auth,
and account/bridge/owner changes during admission. Browser coverage verifies
that a bundled skill appears in an already open `/` picker without submitting.
Native execution tests also cover ordinary-chat defaults, the explicit legacy
opt-out, scoped actors, tool-free title helpers, Cursor mode rebuilds, and the
Zeros-only Customize scope with no hidden native discovery. Cursor team-source
tests cover startup, prewarm, reopen, missing-agent recovery, imported MCP,
and admission-time source selection across mode rebuilds in both opt-out
directions. These verify SDK options, not a signed-in team's live inventory.
