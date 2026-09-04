# Zeros browser service

Zeros provides browser hosting and UI around provider-native browser
capabilities. It does not expose one Zeros browser tool set to every agent.
Codex uses OpenAI's official bundled Browser plugin and app-server IAB
protocol, Claude uses Anthropic's official Claude-in-Chrome integration, and
Cursor receives no browser integration because its current SDK has no native
browser contract. There is no Zeros browser MCP fallback.

## Ownership and identity

The service receives only Zeros identities:

| Identity                   | Owner               | Lifetime                 | Browser use                                                 |
| -------------------------- | ------------------- | ------------------------ | ----------------------------------------------------------- |
| `workspaceId`              | Zeros               | durable                  | scopes the workspace and upload root                        |
| `conversationId`           | Zeros               | durable                  | owns one browser resource                                   |
| `browserSessionId`         | Zeros main process  | one app-service lifetime | opaque browser lease handle                                 |
| `executionId`              | Zeros engine        | one live agent execution | never a browser key                                         |
| `ProviderBinding.resumeId` | Codex/Claude/Cursor | provider-defined         | Codex only: maps native IAB traffic; never owns the browser |

Acquiring again for the same workspace and conversation returns the same
process-local browser session. Agent restart, provider resume, and provider
switch therefore do not change browser ownership. Deleting the Zeros
conversation detaches its browser resource; ending an execution does not.
If the engine restarted and lost its process-local binding map, deletion uses
the durable owner release route so the opaque record is still closed.
After an app restart the same durable owner acquires a newly minted opaque
browser session because isolated Chromium profile data is intentionally
ephemeral.

The workspace path is upload-boundary metadata, not identity. If restore moves
the same `workspaceId` to a new on-disk path, reacquisition keeps the browser
session and replaces its canonical upload root with the engine-authoritative
workspace path. A different `workspaceId` always receives a different browser
resource.

## Process boundary

Electron main owns Chromium `WebContentsView` instances and exposes a small
loopback HTTP service to the engine. The service binds to `127.0.0.1` on a
random port and requires a random per-boot bearer token. Main starts it before
the engine, couriers the endpoint and token only into the engine process, and
clears both on shutdown. Provider subprocesses and renderer code never receive
the credential. Renderer IPC receives only bounded state events and an opaque
`browserSessionId`; privileged attach/control handlers also verify that the
caller is the current trusted Zeros window.

The loopback engine/main contract is versioned independently at
`@zeros/protocol/browser-tools`. Its provider-native product lifecycle has
three operations:

1. acquire an opaque session for `{ workspaceId, conversationId,
workspaceRoot }`;
2. register a native Codex thread with that opaque browser session and settle a
   terminal app-server turn so an unfinalized native batch is handed back
   safely; and
3. release the opaque record by durable workspace/conversation owner when its
   conversation is deleted.

The package also retains an internal semantic executor schema for trusted
browser chrome, compatibility tests, and old persisted transcript decoding.
That schema is not advertised to Codex, Claude, Cursor, or future providers.

Requests and responses are bounded. Actions for one browser session are
serialized, while different conversations may run independently. The service
keeps at most eight sessions and evicts the least recently used inactive record
when that bound is reached. A page visibly attached to the Browser tab is not
idle and remains available for user handoff; an unattached, inactive lease is
reclaimed after 20 minutes.

## Provider-native contracts

### Codex

Codex receives exactly one browser surface: OpenAI's bundled Browser plugin.
For a browser-enabled thread, Zeros sends the app-server config override
`plugins.browser@openai-bundled.enabled = true`. The plugin's official tool
dependency is OpenAI's `node_repl` MCP server, so Zeros registers the verified
official executable as `node_repl` and the chat receives its native `js` tool.
Zeros sends no `zeros_browser` dynamic-tool namespace, no Zeros-authored
browser MCP registration, and no primitive click/snapshot tool definitions.

The public `@openai/codex` CLI package does not currently ship the separate
desktop `cua_node` runtime. At thread boot, Zeros locates an installed official
ChatGPT/Codex Desktop `cua_node` bundle (or a future packaged copy), follows its
manifest-declared executable/module paths, locates the cached
`browser@openai-bundled` plugin, and hashes `scripts/browser-client.mjs` into
`NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`. It replaces any user-configured MCP
entry named `node_repl` with that verified registration. If the official runtime,
plugin manifest, trusted Browser client, Codex executable, architecture, or
platform does not match, Browser use fails closed for that thread; the normal
Codex agent remains available and no Zeros browser tools are substituted.

Local Code threads run natively, so on macOS the official Browser helper can
install its mandatory Seatbelt profile normally. Autonomous Design agents do
not receive a browser capability: their ZSR profile exposes only the scoped
Design API endpoint. Qualified cloud deployments retain their own capability
matrix. Runtime discovery failures leave the ordinary Codex Code session
usable; Zeros never substitutes a custom browser surface.

After `thread/start` or `thread/resume` returns the native thread id, the engine
registers `{ nativeSessionId, browserSessionId }` with the authenticated
loopback service. The Electron main process exposes a private socket under
`/tmp/codex-browser-use` on macOS/Linux (a named pipe on Windows), using the
length-prefixed JSON-RPC protocol expected by Codex's Browser plugin. The
socket and its parent directory are current-user-only, every session-bound
request must carry the registered app-server session and turn ids, tab ids are
checked against the exact conversation lease, and CDP events are sent only to
the owning socket.
The official client's metadata-free `ping` is answered as a data-free transport
probe. Its metadata-free `focusTab` may inherit identity only from the last
successfully authenticated request on that same private socket; no other
sessionless method receives that exception.

The official Browser skill therefore produces the same batched
`node_repl.js` calls as Codex itself: titles such as “Browse nammatn.in” wrap a
sequence of Playwright/CDP actions, and native result metadata continues to
carry `codex/browserUse` and `codex/toolSurface`. Zeros does not render every
snapshot, click, and scroll as a separate MCP call. It merely implements the
plugin's IAB backend methods (`getInfo`, tab creation/listing/claim, targeted
CDP execution/events, pointer movement, finalize, and turn end) against the
conversation's existing `WebContentsView`.

For explicit interactive website prompts, the adapter also passes the verified
plugin skill as app-server's typed `{ type: "skill", name, path }` user input
alongside its `$control-in-app-browser` marker. App-server therefore injects
the exact installed `SKILL.md`; the model does not search the filesystem or
construct a versioned plugin-cache path (and cannot accidentally look beneath
an unrelated bundled plugin such as Sites).

The transcript nests consecutive native browser calls inside one Browser
activity row. Child completion does not close that row because app-server can
append another native batch on the next stream update. It remains **Browsing**
until a later narration, final output, permission/question, or unrelated tool
closes the chronological batch; only then does it become
**Used the browser** (or **Browser use failed** when every child failed). This
boundary rule prevents a completed child from producing a
Browsing → Used → Browsing label flash.

`markDeliverable` / `markHandoff` and `finalizeTabs` both participate in the
official retention contract. A marked or explicitly kept deliverable/handoff tab
loses its debugger, cursor, working treatment, and agent ownership, then
becomes the normal user-controlled Browser tab without navigation or reload.
An explicit empty keep list closes the page. The current official IAB client
does not emit its optional `turnEnded` event, and a Node REPL timeout/kernel
reset can bypass `finalizeTabs`. Zeros therefore treats terminal app-server
turn completion as an authenticated fallback: the engine posts the registered
native thread and opaque browser ids back to main, which blocks late commands
from that completed turn and performs the same safe handoff. The socket
`turnEnded` handler remains compatible with official backends that do emit it.
`getUserTabs` returns the live WebContents id as a string because the current
official IAB claim command validates that field as a positive integer before it
sends `claimUserTab`. The native session binding, current conversation lease,
actor, and exact live tab id are all rechecked at the host, so a later native
call can resume the retained page without crossing conversations. Stop blocks
Browser work for the rest of the same Codex turn and hands the current page to
the user, but it does not call app-server `turn/interrupt`: Codex can still
write its chat response, and a later turn may claim that retained page.

When Browser use is unavailable, the same per-thread key is explicitly false,
so Codex cannot select a Browser skill with no matching IAB host. The override
is thread-local and never changes the user's global Codex configuration.

### Claude

Claude receives no Zeros tools. When enabled, the Agent SDK options contain
`extraArgs: { chrome: null }`, the SDK representation of Claude Code's official
`--chrome` flag. When disabled, Zeros sends the explicit inverse
`extraArgs: { "no-chrome": null }`; omitting both would allow Claude Code's
user-level “enabled by default” preference to override the Zeros switch.
Claude-in-Chrome requires a compatible Claude Code runtime, a supported
external Chromium-family browser, Anthropic's official browser extension at
version 1.0.36 or newer, an eligible direct Anthropic plan, and Claude Code
OAuth login. API-key, setup-token, Bedrock, Vertex, and Foundry sessions cannot
use this integration. It is not supported in WSL.

Zeros links directly to Anthropic's official Chrome Web Store listing and
setup/troubleshooting documentation. It does not bundle, sideload, modify, or
pretend to own the extension. Claude Code installs its native-messaging host on
first enable, detects compatible external browsers, opens new tabs in the
user's existing browser profile, and owns reconnect/setup state. Chrome may
need to be restarted after first setup; the provider's `/chrome` command is the
authoritative connection and browser-selection diagnostic in an interactive
Claude Code terminal. The Agent SDK's headless host API does not expose that
interactive `/chrome` command as a stable Zeros control, so an unavailable
extension fails over through Claude Code rather than through a Zeros-authored
browser implementation. Zeros also does not opt into Claude Code's native
install-dialog kinds: the CLI streams setup phases such as installation,
connection, and recovery, while the public Agent SDK callback exposes only the
current request payload. Settings therefore owns the stable setup entry points
and Claude Code remains the source of connection truth.

Claude's `mcp__claude-in-chrome__*` calls remain provider-native tool calls.
Zeros recognizes that exact prefix only for presentation, groups consecutive
calls as Browser activity, and never classifies an unrelated MCP server as
browser use. Navigation, reading, clicking, typing, scrolling, screenshots,
tab operations, console/network inspection, JavaScript, uploads, and GIF
capture receive bounded semantic labels; typed values are not placed in those
labels. The external tab is not mirrored into the Zeros Browser workbench.

Claude Code and the extension own site permissions. When the SDK asks Zeros to
render one of those decisions, Zeros preserves the provider's exact Allow,
Deny, and optional “all actions on this host for this session” choices. The
domain choice accepts only a validated `ClaudeInChromeDomain` session rule,
never rewrites it into `.claude/settings.local.json`, never offers it when a
user/organization ask rule requires every action to prompt, and fails closed on
malformed or mixed suggestions. Extension-level site access remains an
independent browser control.

Uploads remain constrained by Claude Code's own contract: paths must be files
Claude can already read, each upload totals at most 10 MB, and files with
multiple hard links are rejected. Browser modal dialogs can block subsequent
automation until dismissed, and the extension service worker can disconnect;
users recover those provider-owned cases through `/chrome` → Reconnect
extension or by restarting the browser/Claude session.

### Cursor and future agents

The current Cursor SDK exposes no native browser-use API, so Zeros passes no
browser custom tools and creates no browser session for Cursor. Future adapters
may opt in only when their official SDK/app-server exposes a native browser
contract. The durable Zeros contract for such an adapter is ownership and UI
lifecycle. `BROWSER_TOOL_DEFINITIONS` is an internal compatibility manifest
and must not be translated into another provider-specific MCP/custom-tool shim.

## Isolation and policy

Each lease uses a fresh in-memory Electron partition with an in-memory cache,
Chromium sandboxing enabled, context isolation enabled, Node integration off,
web security on, insecure mixed execution disabled, and popups denied. The
cache prevents Chromium `ERR_CACHE_MISS` failures for ordinary fonts and
redirects, but neither it nor cookies persist across a service/conversation
close. The agent-facing `close` tool is deliberately a **handoff**: it removes
agent decoration and control while preserving the current page, history,
cookies, and scroll position for the user. Durable owner release, Browser use
disable, idle eviction, renderer crash, trusted-surface revocation, and app
shutdown remain the destructive lease boundaries.

The page is created once as a detachable native view. While no matching
workbench tab is visible it lives in a hidden parking window. Activating the
conversation-owned Browser tab moves that exact view into the renderer-owned
rectangle; it does not load a lookalike iframe or copy state. The agent and
user therefore share one DOM, URL, history, cookie jar, and page lifecycle.
Resizing the visible workbench never lets an agent-requested viewport move the
native guest over app chrome. Host attachment scales CSS coordinates through
the app's current zoom, rejects out-of-window bounds, serializes attach/detach
transitions, and temporarily reparks the guest while a renderer dialog, alert,
menu, listbox, popover, tooltip, hover card, resize hint, or toast crosses its
rectangle. Shared overlay primitives publish their opening intent before their
portal mounts, so the retained compositor capture replaces the native child
before the overlay's first paint rather than one frame afterward. Those intents
are identity-counted: a tooltip, nested menu, or toast closing cannot reattach
the native child while another trusted portal is still open.

Collapsing the workbench while Codex owns the page—or beginning Browser work
while the workbench is already collapsed—rehosts that same view in a
responsive picture-in-picture surface. PiP size and controls are a Zeros host
concern—Codex app-server has no PiP geometry API. The compact card fits the
last full Browser viewport aspect into a bounded fraction of the available
workspace instead of using one fixed thumbnail size. Electron applies a
uniform page zoom so the native PiP
keeps that full desktop CSS viewport rather than forcing a tiny mobile reflow.
Its top controls reveal as an overlay on hover; because
native WebContentsView children always composite above React, Zeros captures
the current frame before briefly parking the native child so controls never
reserve page space. Native guest hover is published to the renderer because
WebContentsView events do not bubble through React.
Minus hides and detaches the PiP, Expand activates the owning Browser tab and
restores the workbench, and the icon-only Stop action revokes the native turn.
No second page is created. The native guest stays live outside hover/overlay
composition; a bounded current-frame capture is only the temporary backing
while trusted React controls must paint above it.

Semantic element references are valid only for the latest snapshot. Each ref
contains the snapshot's random scope (for example,
`b1_0123456789abcdef01234567`), and each snapshot rotates the corresponding
host-only DOM marker namespace and removes the old markers. A numeric position
cannot therefore be reused against a later DOM walk, and stale refs or
pre-seeded marker collisions fail instead of selecting an unrelated element.

Zeros never exposes raw CDP as an agent tool. Codex's official Browser plugin
does use CDP behind its private IAB socket; the host scopes every command and
event to the registered conversation and exact WebContents. Full/developer CDP
is reported as disabled. File paths, bearer credentials, renderer IPC, other
tabs, and host-computer control are absent from that protocol. The retained
legacy semantic executor remains internal to trusted browser-chrome controls
and tests; provider adapters do not advertise it.

Safety follows the native owner. Codex's Browser skill and app-server MCP
elicitation flow own origin consent plus semantic confirmation for downloads,
uploads, raw CDP, history, and other protected browser operations; those
requests stay inline in the owning chat. Claude and its browser extension own
the corresponding external-Chrome flow. In addition, the Zeros Electron host
independently gates boundaries it can enforce authoritatively:

- cross-site navigation for the legacy trusted semantic executor when no
  provider-native origin gate owns the tab;
- downloads; and
- browser/device permissions requested by the in-app Chromium session.

An explicit Codex navigation, redirect, or page-authored top-level navigation
is URL-policy, site-status, and origin-consent checked by OpenAI's Browser
plugin before/while it is lowered to IAB/CDP. During that authenticated native
turn, Electron defers origin prompts to the official plugin rather than stacking
a second Zeros permission card. If a site immediately redirects between its
apex and `www` host, one explicit approval is reused only for that pair and
only within that same Browser turn; a different scheme, port, arbitrary
subdomain, or later turn still asks through the provider. A host-created
browser/device-permission scope may likewise be allowed for a site. These Zeros
grants remain scoped to the opaque browser session, origin, category, and exact
scope; provider-native Codex decisions remain provider-owned. Closing the
trusted Zeros window revokes host grants, denies pending host work, and
destroys every live page lease (while retaining each opaque conversation-owned
record), so a hidden page cannot retain device or network activity without a
confirmation surface. Missing renderer, queue overflow, timeout, malformed
response, and session teardown all fail closed.

Codex MCP approvals use the same inline composer slot as other blocking input,
but render as direct one-click decisions instead of a selectable question plus
a second Submit action. The card preserves the provider's exact `accept`,
`persist: session`, `persist: always`, decline, and cancel response semantics;
only the presentation labels are adapted (for example, Browser origin access
offers Allow once, Deny, and the provider-supported persistent choice).

For Codex downloads, the official Browser plugin first obtains its native MCP
elicitation approval and then calls IAB `allowDownload(tabId, url)`. Zeros
stores that exact normalized URL as a one-shot authorization for the matching
Electron download, so the user sees one inline approval rather than two. A
different URL, a later download, or a non-Codex download still enters the host
confirmation path.

Confirmation requests carry their durable workspace and conversation owners.
The renderer places them in the exact conversation's existing
`PermissionCard`, replacing that chat's composer; there is no browser popup or
window-global dialog. A provider-native permission already at that chat's queue
head wins, then the browser request appears. The native page stays visibly
attached beside the chat, while Electron's input lock prevents it from
intercepting the trusted Allow/Deny interaction. Subscribe-then-snapshot
hydration recovers a pending card across renderer startup; a settlement
tombstone removes a request that timed out or resolved during that race. A
malformed, overflowed, timed-out, unmounted, or stale request is denied.

Native Codex navigation, reading, clicking, typing, scrolling, and capture are
classified from the IAB/CDP method into safe high-level presentation labels.
The page receives a compact black/white agent arrow with a subtle violet-blue
glow/click pulse and persistent cyan working treatment for the full
provider-owned browser interval. The site's native cursor is hidden while that
ownership is active so two pointers never overlap. The ordinary Browser header
does not change, and the previous bottom “Agent working” footer is absent; the
working tab pill shimmers left-to-right and owns an icon-only Stop action.
Because the native guest sits above React, only the visual treatment is
injected into the page, while the real interaction lock stays in Electron: page
mouse/keyboard input and Browser chrome are blocked for the whole native
Browser turn, not merely one primitive call. Stop invalidates browser ownership
for the current provider turn, stops navigation and active downloads, dismisses
only a blocking Browser-use approval if present, and releases the page to the
user. It does not call app-server `turn/interrupt`, so the surrounding Codex
chat turn may handle the stopped Browser tool and continue. Once Codex finalizes
or the turn ends, the decoration disappears and the same page remains directly
interactive.

Chromium may report `net::ERR_ABORTED` when a requested page successfully
redirects and supersedes the original navigation. Zeros waits for any guarded
redirect approval and a bounded usable-document commit, then suppresses that
one false error only when the live HTTP(S) document is different from both the
source and requested URL. An unchanged page, denial, timeout, or another error
such as `ERR_BLOCKED_BY_CLIENT` remains a genuine failed child action.

Codex dispatches trusted input through its Browser plugin and the IAB CDP
channel. The host raises `agentInputDepth` around those commands so Electron's
own input observer does not mistake the visible agent cursor for user takeover.
For the legacy semantic executor, page-authored cross-site main-frame
navigation still passes through the Zeros website-opening policy. Under native
Codex ownership the official plugin owns that origin gate; subframes are never
promoted into prompt storms by Zeros.

The pointer and working tint are cosmetic and contain no typed value. There is
no page-gesture takeover: the lock does not expire between native batches, so a
direct click or keystroke is refused rather than reassigning the controller.
Ownership returns only through native finalize/turnEnded, Stop, or the semantic
`close` tool. In the retained trusted semantic executor used by browser chrome
and compatibility tests, one of those handoffs landing while a click, type, or
upload is being inspected, staged, or confirmed aborts the mutation and
requires a fresh snapshot. Type and upload
also recheck the target's tag, input type, accessible label, visibility, and
position after an approval pause, closing a page-mutation race. That executor
is not exposed to Codex, Claude, or Cursor. The pointer can be disabled
independently. Page favicons are fetched through the isolated session, decoded
and normalized to bounded PNG data URLs when raster, or admitted as bounded,
passive SVG data only after active-content validation, origin-bound in the
renderer cache, and used in Browser chrome, the workbench tab, and page-action
transcript rows without making a tracking request from the privileged
renderer. Fetch redirects are manual, HTTP(S)-only, and bounded; favicon
acceptance follows that validated request chain because Electron's net-backed
fetch does not provide a reliable response URL. Same-origin route changes
retain confirmed artwork; cross-origin navigation clears it before the next
page can paint. Capability bootstrap and
final handoff rows use the Browser-use cursor glyph because they are not
website interactions.

User-created Browser tabs use renderer iframes rather than an agent lease, but
follow the same visual-identity contract. Electron main reads the named child
frame's bounded `link[rel~=icon]` declarations, validates and fetches those
candidates (including CDN-hosted artwork) plus conventional origin paths, and
publishes the normalized icon through an exact-frame event. A bounded
origin-aware renderer cache feeds both the ordinary omnibox and tab pill,
retains artwork for same-origin routes, clears before cross-origin navigation,
and rejects late A-after-B results. Data URLs are not persisted in workbench
localStorage.

The ordinary iframe deck keeps a bounded renderer-wide working set mounted.
MRU order selects eviction only; render order remains stable so switching
Browser tabs never moves an existing iframe node. Chromium reloads a nested
browsing context when its iframe is physically moved, even if React preserves
the component key, so this invariant is what retains page JavaScript, form
input, media, and scroll through A → B → A. Hidden frames remain inert,
accessibility-hidden, pointer-disabled, and invisible. Closing or bounded MRU
eviction still destroys the frame intentionally. Address, Back, Forward, and
Reload controls target the existing named Chromium frame in Electron, so Back
and Forward traverse live page history without replacing the iframe. Hard
Reload remains an intentional cache-clearing reload.

Page titles are similarly host-stabilized. Navigation keeps the last confirmed
document title until Chromium has stopped loading and its explicit title has
settled; transient hostname/default-title events are never persisted into the
workbench tab. This avoids a one-frame site-name flash between two real page
titles without delaying URL, favicon, loading, or live-page updates.

Agent-owned Browser tabs dispatch trusted address, Back, Forward, and Reload
controls directly to their current native WebContents. Ordinary tabs dispatch
the same fixed actions to their exact named WebFrameMain. In both cases URL,
loading, and history state then arrive through exact-frame/session events; they
never wait for the agent-only semantic snapshot pipeline. A valid address
submission blurs the omnibox immediately, while invalid input remains focused
for correction.

The internal semantic executor's classification is defense in depth, not a
semantic proof of arbitrary page JavaScript. DOM structure catches form
submissions and bounded heuristics recognize common account, payment, publish,
destructive, and send controls, but native Codex CDP traffic does not claim to
pass through that classifier: OpenAI's Browser skill owns its semantic policy.
Any page event can itself initiate network activity. This is why this phase has
no shared authenticated profile, blocks popups and host-computer control, and
gives every conversation an ephemeral isolated profile. A future stronger
host policy may confirm every mutation or interpose at the network layer
without changing the Zeros identity or adapter contract.

## Artifacts and settings

Screenshots and JSON traces are stored below the channel/instance-specific
Zeros data directory in `browser-artifacts/`. Diagnostic URLs drop credentials,
queries, and fragments. Trace, console, network, download, annotation, and
response collections are bounded.

The durable setting belongs to the engine settings model, not renderer
`localStorage`:

```toml
[browser]
enabled = true
codex_enabled = true
claude_enabled = false
provider = "isolated"
auto_open = true
show_agent_cursor = true
navigation_approval = "always-ask"
```

`browser` is user/managed-only and is rejected from committed, repo-local, and
workspace-local files so a cloned repository cannot enable or replace a
privileged browser backend. `isolated` is the only provider in this phase.

The compact controls appear under Settings → Agents → Browser. Its Browser use
section has separate Codex and Claude labels. Codex exposes enablement,
automatic reveal, and website-opening approval. Claude exposes its independent
official Chrome-integration switch. The agent pointer remains enabled by
default but is not presented as a setting. Claude's external signed-in Chrome
integration is explicit opt-in. The legacy `enabled` leaf remains a Codex
compatibility fallback and a managed fail-closed master disable, but legacy
enablement never opts Claude into Chrome.

`navigation_approval` accepts `always-ask` (the default) or `always-allow`.
This website-opening preference never applies to consequential actions.

For Codex, with `auto_open = true`, the first valid HTTP(S) navigation for the
active conversation activates its Browser workbench tab and reveals the
workbench unless the user has explicitly collapsed that column; in the latter
case the column stays collapsed and the live PiP appears instead.
Existing tabs update without repeated focus changes. Background conversations
receive/update their own scoped tab but never steal the current workspace or
tab. With auto-open disabled, the tab is added in the background and remains
available for explicit selection. Opaque process session ids are never written
to workbench persistence; tabs are restored by durable `conversationId` and
bind to the latest live session event. The first-open intent survives chat
hydration without carrying stale activity state, and deleting a conversation
atomically removes every workbench tab it owns.

Closing a conversation-owned Browser tab is an explicit native close
transaction, not a renderer-only tab removal. Main destroys the matching
ephemeral lease and publishes `closed`; this prevents the still-authoritative
session snapshot from recreating the tab on the next workspace state edge.

Main defers live state delivery until the current renderer is ready and stamps
deferred events with a renderer epoch, so a reload cannot replay an old attach
or confirmation into a replacement document. The renderer subscribes before
reading a bounded authoritative session snapshot, retains latest state plus an
unresolved first-open intent per conversation while chats hydrate, then routes
it as soon as its durable owner appears. This closes the missed-startup-event
race that previously left the Browser tab closed while Codex was already
working.

The Codex host-side enable switch applies immediately: disabling Browser use rejects
new and queued IAB work and closes active isolated pages. The official Browser
plugin and its verified `node_repl` registration are app-server/thread boot
capabilities. When Browser use changes from off to on, Zeros queues each live
native Codex execution for a guarded refresh: it waits for the exact chat to be
idle with no queued sends, closes only that ephemeral app-server execution, and
resumes the same durable `ProviderBinding.resumeId` with Browser enabled. A send
that arrives during the close acknowledgement waits behind the warming slot; a
replacement execution that wins the race is never overwritten. A full desktop
relaunch or later normal thread resume remains an equivalent recovery. Zeros
never substitutes a cold conversation or a custom browser tool.

Claude's enablement is also process-scoped. On either Claude switch edge,
Zeros queues each live native Claude execution until it is idle with no queued
sends, closes only that ephemeral SDK execution, and resumes the same durable
Claude conversation with explicit `--chrome` or `--no-chrome`. Rapid setting
changes carry revisions so an older close/resume cannot consume a newer edge.
New or currently unbound sessions read the latest setting at normal boot and
again immediately before their first query, closing the warm-session race. A
failed policy read disables external Chrome for that query generation without
blocking the ordinary Claude turn. Zeros never interrupts an active Claude turn
to apply the toggle.

## Deliberate exclusions

Zeros does not implement a browser MCP server, Cursor custom browser tools,
shared-profile attachment for Codex, cloud browsers, system-computer control,
raw developer CDP, or a Zeros-authored replacement Browser skill. Codex's
official bundled plugin and Claude's official extension remain provider-owned.
This is browser use—not unrestricted control of the user's Mac. Broader
capabilities require separate product and trust-model decisions.
