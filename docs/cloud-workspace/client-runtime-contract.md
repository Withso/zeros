# Cloud client and runtime contract

This contract governs the backend expansion after the original cloud foundation.
Implementation and live qualification are tracked separately in the roadmap.
Native mobile remains deferred. The desktop Create page and workspace catalog
now route cloud workspaces through the same conversation and workbench surfaces.

## Identity and placement

- New Organization workspaces are cloud-owned; Personal stays local. The local
  create, branch adoption and worktree adoption paths reject Organization
  ownership before changing the filesystem. Legacy rows remain recoverable.
- One cloud workspace has one provider allocation and one writable execution
  authority. A fenced replacement may temporarily retain an old allocation for
  cleanup, but never introduces a second writer.
- A workspace, conversation, execution, device, connection and provider resource
  have separate identities. Opening another device subscribes to existing work.
- Multiple devices of the authorized owner do not imply Organization multiplayer.
- The managed provider default applies only when no provider connection is
  selected. An explicit customer connection determines its provider independently.
- Generations retain their exact provider connection and credential version.
  Changing a default never migrates an existing workspace or redirects cleanup.

## Portable client boundary

### Desktop routing and presentation

`WorkspaceRuntimeClient` retains the local engine and independently keyed cloud
connections. Renderer workspace identities are `cloud://<organization>/<workspace>`;
conversation/execution/terminal identities use `cloud:<organization>:<workspace>:<id>`.
These are device UI keys, never remote filesystem paths. Only protocol envelope
identities cross this mapping boundary; tool payloads, provider resume bindings,
file contents and patches remain opaque. Switching focus cannot retarget a
pending request. Retired connections and account changes reject late results.

Create captures the selected Organization, GitHub installation, repository,
remote ref and idempotency key. Ownership determines placement: Personal creates
locally and Organizations create in cloud, with no Local/Cloud picker or local
fallback when cloud is unavailable. Switching owners cannot carry a request into another
Organization, and does not discard the composer's draft. Personal does not
request cloud admission or capability data. If creation finishes after an
owner switch, confirmation updates the original Organization's catalog and
leaves navigation and the draft in place. Local-only refs and mismatched fork remotes stay
unavailable with an inline explanation. Discovery uses the authorized paginated
catalog. Cloud chat snapshots are bounded and account-scoped; they are excluded
from the legacy local cache and restored only after access is confirmed. A
worker chat snapshot and tombstones are read before mirroring device chat edits.
That confirmation is required for each exact normalized cloud owner, including
chats opened below its checkout root. An unconfirmed cached cloud row can remain
visible while loading, but cannot be uploaded as an authoritative replacement.
Local chat mirroring does not wait for cloud confirmation. Logically deleted or
deleting owners are removed from discovery and read admission immediately;
pending provider storage cleanup does not keep them navigable.

The fixed cloud details button and details popover identify the execution host.
Chat/tool transcripts, Files, Changes, Review and PR controls keep
their existing renderers and receive the selected workspace's backend data.
The popover displays configured capacities; no utilization or cost is inferred.

PR creation preflight and composer PR suggestions carry the selected workspace
identity through the same bridge. Remote discovery derives the repository from
that registered checkout; caller-supplied origins cannot redirect its credentials.
The Local create-from picker still accepts a repository origin before a worktree
exists. Composer results are bounded exact-checkout/origin snapshots: a late
response cannot populate another workspace, reconnect retains confirmed rows,
hidden pickers do no background work, and account changes erase cloud results.

Terminals use the same xterm view, primary tabs, sidebar and docked panel. A cloud
icon identifies their workspace location, including while a Run action is busy.
Discovery and attach-only Run checks query that workspace's terminal registry;
creation, input, resize, output and close retain its scoped session identity.
The worker resolves the real checkout directory and owns the shell process.
Visible terminals reattach after cloud reconnection and replace their screen
from the worker snapshot. Hidden terminals defer that work until reveal; healthy
workspace switches retain the grid and selection without replay. A missing or
exited session is not automatically restarted by reconnection; a failed registry
read is unavailable data and does not discard the last confirmed terminal list.

Cloud session attachment adapts the existing session UI to durable conversations
and commands. Sending requires an existing, unexpired workspace/model credential
delegation; local provider credentials and executable overrides are never read
for cloud session admission. Command IDs derive from durable user-message IDs,
so retrying an unknown acknowledgement does not duplicate a command. Stop uses
the backend conversation queue. Credential authorization, current conversation
metadata and queue reads run concurrently; all must succeed before queue mutation.
Cancellation or denied authorization cannot enqueue work. Ordered event replay retains native tool IDs and
snapshot attachment restores pending permission/question controls and confirmed
agent capabilities into the same session store, without starting provider work.
Replacing a transport retains bounded conversation selections for that exact
workspace and signed-in account. It does not retain execution IDs, credentials,
pending command promises or permission authority. Fresh admission and snapshot
reads restore those controls. A missing attachment rejects a prompt before it
can fall through to the native session protocol; account reset and access
revocation discard the retained selections.

Organization provider settings select a cloud workspace and use the worker's
agent registry plus the credential API. Saving a cloud API key or Claude setup
token is explicit; authorizing selected models creates a seven-day grant for
the signed-in user and selected workspace. Disconnect revokes those grants,
leaving other workspaces and local provider credentials untouched. Native
subscription login continues to belong to Personal until a cloud account-login
flow is qualified. Max and Ultra effort selections retain the same command and
provider semantics as the existing composer. Model IDs retain native context
suffixes such as `[1m]` through delegation, command admission and private execution.
Migration `0105_cloud_agent_model_context.sql` widens the lease constraint while
retaining the 256-character bound and rejecting arbitrary bracket syntax.

The worker registers its primary checkout as the compatibility ID `local-main`,
with its attested cloud UUID and Organization. Its target branch, view mode and
PR metadata join the durable record projection and survive worker replacement.

Saved conversation reads use the authenticated control-plane history endpoints
(`/history/chats`, `/history/messages/:chat`, and `/history/search`) under the exact Organization and
workspace. They read the normalized durable record projection without engine
admission or compute, including while a worker is stopped or archived. Every
page checks current actor access; multi-page chat metadata pins its projection
revision. Message windows retain normalized tool payloads and the opening prompt
of a turn where it fits the bounded window. Database indexes, row limits and byte
limits bound reads before payloads reach the API process.

The renderer uses the existing chat and transcript surfaces for these reads.
Its bounded, account-scoped cache deduplicates exact workspace/window requests,
retains confirmed metadata during refresh and rejects responses after account
replacement or access withdrawal. Live database events invalidate the matching
workspace; confirmed data nudges retry a failed cold transcript without requiring
a VM connection. Execution, edits and terminal operations still use the worker.
The durable projection can lag an active stream until synchronization completes;
live streamed state remains authoritative in the open conversation.
An already connected worker supplies its current normalized message window;
history reads never connect or wake a stopped VM. Runtime and control-plane
windows have separate cache identities. Before applying a delayed history read,
compare the captured transcript and execution as well as the current status:
a complete turn can occur while a read is pending. This race guard applies to
both Local and cloud transcripts.
Accepted cloud commands outlive desktop transports. Reopening subscribes and
loads the same durable conversation; it does not resend its prompt. Retiring a
completed or explicitly stopped per-command provider process is expected
cleanup and must not report a lost conversation. Unexpected process failures
and unproven retirement still use normal failure and authority-loss handling.
Archive, wake and delete use control-plane lifecycle operations. The existing
deployment, entitlement and provider qualification gates remain authoritative;
desktop wiring is not evidence of live macOS/provider qualification.

### Cloud workspace idle and wake

A workspace stays active while any admitted device is using it or any workload
remains: running/queued/dispatching turns, preparations, approvals/questions,
background tasks, an active goal, Setup/Run scripts, a terminal foreground or
detached user process, an SSH session, or recent terminal input/forwarding and
preview traffic. **Recent workload input/traffic means the last ten minutes.**
An interactive terminal shell at its prompt alone is idle; foreground groups,
detached children and suspended processes remain work. Kernel inspection fails
closed and never reads process arguments or environments. The quiet interval
starts after these guards clear and lasts ten minutes before checkpoint + stop.
Existing control-plane workload/authority guards still apply, including the
bounded lifetime of outstanding human-service grants.

User presence requires a selected cloud workspace, a signed-in/admitted client,
a visible and focused app window, and keyboard/pointer/scroll input in the last
fifteen minutes. Settings and other app controls count for the selected workspace.
Main reports screen lock and system suspend; either withdraws presence. The
client renews `cloudPresence.update` over the existing `WORKSPACE_REQUEST` bridge
every sixty seconds and immediately when presence returns. The engine uses a
ninety-second monotonic receipt lease, rechecks admission and rate limits by the
server-asserted account/device across reconnects. Any device, including a viewer,
can hold a running workspace awake. Payloads contain only a strict `present`
boolean; clients cannot supply identity or time. Presence uses an existing
connected admission, never acquires compute and never wakes a stopped VM.

Trusted key presses, pointer down, wheel/input and composer clicks/typing anywhere
in the app automatically wake its selected sleeping workspace through the same
explicit open/send path. Hover, programmatic focus/scroll, polling, catalog/PR
refresh, history hydration, presence-free heartbeats and completed transcripts
are not activity or wake intent. Another workspace's sidebar row owns its own
navigation and cannot wake the previous selection. Hidden retained surfaces have
no presence or wake controller. Archived/deleting/deleted workspaces never wake.
Prompters with `canWrite` may wake, matching existing run authorization; viewers
may not. A wake shares in-flight admission with sends. Cloud submissions enter
the existing editable FIFO immediately and show **Waiting for agent** above the
composer while compute, history or the agent session becomes ready. Multiple
messages retain order, rich documents and attachment sources; edit/remove remain
available before dispatch. Files resolve after fresh admission, then the stable
message identity is promoted exactly once. Removing a message, Stop, changing
account/workspace identity or closing its chat fences late readiness. A terminal
cause or a three-minute readiness bound leaves the messages queued with a clear
inline error and explicit retry, without an error toast or a stopped-turn pill.
A closed admission refusal before provider execution restores the same editable
row and retains its elapsed readiness budget. Terminal admission causes use the
existing model/credential recovery actions inside that card. An ambiguous
dispatch result stays in the conversation for review and is never auto-replayed.
An explicit retry after a durable terminal admission refusal renews only that
refused delivery identity; automatic readiness retries keep their existing ID.
A later Stop ends the wake intent; readiness retries cannot start it again.
An explicit Stop in this app window invalidates older interaction gestures and
pending automatic wakes. A gesture after that request may resume the workspace;
the Stop click itself cannot be reused to undo its request.
Expected waits suppress the composer's sleep notice. These queued drafts belong
to the renderer's existing pending-send lifetime, rather than a durable server
queue; Local submissions keep their existing pipeline and presentation.
Runtime upgrades are selected by the server's existing wake/start lifecycle;
replacement-engine admission precedes delivery of the queued prompt.
Automatic interaction wakes add the optional `reason: "interaction"` body field
to that same `/wake` request. Shared sends and uncertain retries retain the
initiating reason and lifecycle identity; ordinary explicit wakes keep their
existing empty body. No server-side interaction backoff is added in this Alpha
change.

Presence cancels an uncommitted idle stop through the existing cancellation
transaction and a final pre-commit `stillIdle` check. A gesture on a lagging ready
snapshot retains a two-minute intent across publication of a committed stop,
then wakes once; navigation, hiding or losing focus cancels that local intent.
Automatic wake attempts are debounced for thirty seconds and limited to one per
five minutes per app window and canonical workspace when the document carries a
stop error/incident, even after a failed attempt. Cross-device backoff is deferred
and can use the optional interaction reason without a client change.
The shared workbench banner and composer show “Sleeping — resumes when
you continue” for clean stops; incident stops retain their public reason. Local
workspaces and serialized lifecycle/command identities are unchanged.

### Network contracts

Cloud control uses authenticated, versioned network contracts. Core creation,
conversation, approval, file, Git and Design operations must work without
Electron, a local engine, an SSH executable or a desktop filesystem path.
The client operating system is independent of the execution operating system.

The control plane authorizes every operation and subscription against current
workspace/Organization/device authority. Engine mutations bind the current
execution fence. Provider administrative credentials stay outside clients and
guest workloads. SSH and local replicas remain optional client capabilities.

Request, response, error, event and snapshot schemas must be usable by native
and web clients. Document the compatibility window and negotiate capabilities;
an accepted wire version alone does not qualify an optional capture/runtime tool.

### Engine liveness and recovery

An engine heartbeat can extend only a currently live, unrevoked lease for the
current generation. A late heartbeat cannot revive expired authority. Lease
expiry immediately denies new runtime authority; background reconciliation then
retires grants and queues compute Stop for a formerly ready or busy workspace.
This applies to managed and customer providers independently of the deployment's
managed default. Setup has its own bounded deadline and retry policy.

Stopping a lost engine does not fabricate a final checkpoint or restart its
commands. Explicit recovery uses the last verified durable checkpoint and a new
generation. Dispatched commands with unknown outcomes retain their payload and
an uncertain receipt; their queue stays paused. Clients must present that state
and require an explicit new user decision before continuing work.

### Agent authentication boundary

Cloud UI attachments do not issue direct `AGENT_NEW_SESSION` provider execution.
The admitted command worker supplies the selected provider's delegated model
credential to its execution environment.
The cloud environment filter rejects host-authority and process-injection
variables. It does not hide an admitted model key from that tenant's agent.
Credentials are not durable prompt fields, replay events, checkpoint content,
or data returned to another device. A second authorized device can attach to
the running native session without receiving its credentials.

After allocation loss, restored native conversation history is independent of
authentication. Fresh provider execution requires supported authentication again.
The backend provides owner-scoped encrypted provider credentials and explicit
workspace/member/model delegations through `/v1/cloud-agent-credentials`. Native
Codex cache import and serialized subscription renewal are implemented; access
material alone reaches a currently authorized execution. Desktop subscription
files are never copied implicitly or shared between independent refresh writers.
See [agent authentication](agent-authentication-and-language-tools.md). Deployed
account-connection qualification and redistribution review remain separate
release gates. The [organization setup UI](organization-setup.md) connects
private agent accounts and GitHub installations before allocating a VM.

## Commands and decisions

Persist command identity and payload hash before dispatch. Reusing an idempotency
key with different semantics is a conflict. Record the accepting execution/turn
and reconcile retries; a lost acknowledgement is not permission to repeat an
external side effect.

Follow-up queues, Stop state and pending decisions are backend-owned. Stop pauses
dispatch and preserves pending order. Editing a queued message or receiving an
old completion does not resume it. Preserve the existing explicit-send ordering.

Approval/question responses bind the exact request, execution and revision.
Only one valid response settles a decision. An authorized second device can
observe and answer a pending decision without becoming a second engine owner.
Expired, canceled and superseded requests cannot authorize new work.

The same conversation and provider binding serve Code and Design. Mode updates
compare the expected revision and refresh execution instructions. Local native
Design authoring does not relax cloud API authoring or lifecycle-owned
registration. Missing cloud tool admission never enables native fallback.

### Implemented command transport

Protocol 19 advertises `cloud.commands.v1` on `ENGINE_READY` only when the
engine is registered with the control plane. The authenticated workspace bridge
exposes these operations (the desktop creation UI is separate):

- `cloudCommands.createConversation`: takes `conversationId`, `workspaceId`,
  `agentId` and optional model/effort/title. The engine resolves the workspace
  path and creates the chat. Reusing an identity for another owner is rejected.
- `cloudCommands.conversation`: returns the opaque workspace identity, selected
  agent, current authoring mode and its revision.
- `cloudCommands.setMode`: takes `conversationId`, `mode` and mandatory
  `expectedRevision`. A stale revision fails before changing mode.
- `cloudCommands.request`: takes one `request` from the shared
  `@zeros/protocol/cloud-commands` contract: snapshot, read one command, mutate
  the queue, or Stop. Client requests cannot claim or settle commands.

Enqueue/edit/remove/pause/resume mutations carry a UUID operation identity and
expected queue revision. Each prompt has a distinct UUID command identity and
stable user-message identity. Prompt content, agent and mode revision are
persisted before claim. A user-message identity cannot be dispatched again via
a different command identity. Editing preserves it. Credentials, environment,
working directory and execution selectors are absent from the prompt contract;
normal agent session admission owns those decisions.

Stop has a UUID identity and no expected revision: completion or concurrent
enqueue must not make Stop stale. It pauses pending work before cancellation.
Replaying an acknowledged Stop does not cancel a newer turn. Claim/settle writes
require the exact live engine fence. Engine replacement pauses queued work and
marks any dispatched outcome uncertain. Inspecting an uncertain command returns
its retained payload; no timer automatically replays it. Lost settlement
responses retry only the same receipt, never the provider prompt. Historical
mutation retries resolve before checking today's authoring mode. New stale-mode
requests are rejected. A terminal receipt waits for a fresh durable transcript
sync; joining an older in-flight heartbeat sync is insufficient.

The engine creates a claim UUID before sending a claim. If the reply is lost,
it retries that same UUID and execution binding before dispatching anything.
A terminal replay returns no new command. Pending claims and terminal receipts
share a bounded dispatch capacity, including repeated reads of empty conversations
during a control-plane outage.

The current bounds are 32 pending commands per workspace, 192 KiB per mutation,
64 MiB retained prompt payloads, 100,000 command identities, and 200,000 operation
receipts. A snapshot includes pending entries and the last 50 payload-free
receipts. Exact command reads recover older receipts. Stop remains available if
receipt capacity is exhausted; Resume/new mutations are then rejected. These
metadata bounds are independent of attachment/object storage limits.

Queue changes emit a `DB_CHANGED` chat invalidation. Terminal prompt responses
carry the command identity as `requestId` and broadcast to authorized devices.
The desktop consumes those responses through ordered event replay and matches
the command, conversation, provider and known execution before settling its
prompt request. A matching terminal turn also clears the optimistic pending
turn atomically with its status, so a completed answer cannot restart its live
timer while retirement is pending. Durable command reads remain the fallback
when the terminal frame is lost. Native completion and durable retirement are
distinct facts: the UI can accept the next message immediately, while the server
still serializes its execution behind proven cleanup and transcript durability.
Receipts retry autonomously after temporary persistence failures. Transcript
sync commits its captured revision even while newer tokens remain dirty; it
does not require a quiet agent. A previously admitted, still authorized device
retains reads and Stop during temporary record lag. New prompt claims wait for
durability to recover.

The engine retains one bounded record projection (at most 16,384 entities and
32 MiB), keyed by backend origin, organization, workspace, generation and engine
instance. Each sync authenticates a head read before reusing an identical
revision. Exact append receipts advance that snapshot; lost acknowledgements,
unconfirmed revision ranges and external revisions require reconciliation.
This avoids downloading the same ten-entity pages after every short turn while
preserving authority checks, remote deletions and the terminal durability gate.

### Durable approvals and steering

`cloud.actions.v1` adds `cloudActions.request` with `submit` and exact operation
`read`, using `@zeros/protocol/cloud-actions`. Each UUID operation binds a
conversation, execution, native request identity, action kind and payload hash.
Steering also carries the expected accepting turn and stable user-message id.
Clients cannot create claims or terminal outcomes. Existing permission/question
frames and steering messages use this service when running on a registered
cloud engine; their message/attempt ids are the receipt identities.

The control plane records `dispatching` before the engine invokes a callback.
Only one action can claim an execution's native request. An identical retry
reads the original receipt; changed content conflicts. A timeout between claim
and delivery never authorizes another callback. Such uncertainty returns
`interrupted`, and an engine replacement marks unresolved receipts `uncertain`.
Known terminal outcomes retry autonomously without replaying the native action.
`delivered` means the native resolver accepted the response, not that the tool
finished successfully. A resolver that has expired reports `interrupted`.

Receipts retain identities, hashes and outcomes, without answer/prompt contents.
They are bounded to 100,000 per workspace; the engine bounds simultaneous and
unsettled actions to 64. Reads and Stop stay available at action capacity. This
implementation has database and engine regression coverage; exact-image live
qualification remains a separate release gate.

### Human Design capture

`design.capture` accepts the registered `workspaceId`, `frame`, exact
`expectedRevision` and bounded viewport dimensions. It uses the authorized
Design read lease and the qualified capture worker, and returns only the revision,
PNG metadata and base64 bytes. A changed revision, unsupported dimensions or an
oversized image fails without returning host paths or capture credentials. Cloud
clients do not need a desktop browser or Electron to request this operation.

### Native checkpoint recovery

The [native checkpoint format](checkpoint-native-format.md) preserves Git state,
allowlisted agent histories, private Design state and attachments independently
of provider snapshots. Restore format negotiation prevents older runtimes from
silently dropping native state. A restored process does not resume an uncertain
agent command automatically.

### Authenticated previews

Native desktop Browser, Run and agent previews use the existing
`POST .../access/previews` HTTP/HMR grant with `native:true`, `port` (logical
display metadata), `expiresInMinutes` and an optional
`target:{executionId,portId}`. Native issuance is engineering-staff-only and
requires the current Ed25519 device proof. Its `preview.issue` payload is
`{organizationId,workspaceId,port,target:null|{executionId,portId},expiresInMinutes,idempotencyKey}`.
Migration 0130 adds nullable `preview_target`, `preview_device_id` and
`preview_device_key_version`; legacy scalar grants keep their existing shape.
Both public preview routing and runtime admission check the native device's
current trusted key. Device rotation/revocation, actor changes, expired grants,
engine authority loss and generation retirement deny requests and renewals.
The authoritative generation's provider and accepted runtime pin determine
whether a scalar preview requires native device admission, even when the caller
omits `native` and `target`. Only a verified legacy Daytona generation without
a v4 pin retains the proof-free scalar exception. Existing unbound native
grants fail at ingress and runtime admission and must be issued again.

The optional `AGENT_BOUNDARY_PORT_OPENED.nativeTarget` carries the same opaque
execution/listener identity. On v4 the native factory returns bearer-free
logical URLs with that target. v1–v3 retain the signed-link factory; local
execution retains its ZSR factory. The runtime resolves opaque identity from
the current execution boundary, connects only to its actual loopback mapping,
and checks that mapping during every short HTTP/HMR lease. A missing or changed
listener fails closed; the display port never selects an agent socket.
Browser uses the engine's native target response to choose admission; legacy
signed navigations retain their existing factory. A restored legacy source
without exact execution/listener identity cannot admit a native target by
display port. Open the current published listener to create that identity.
The optional wire field preserves the existing protocol range. Older runtimes
that cannot interpret opaque targets reject admission rather than selecting a
scalar listener. Deploy the control plane and a qualified E2 runtime before
running native agent acceptance.

Electron's `browser:open-cloud-preview` accepts an optional opaque `target`
beside workspace, logical port, frame name and exact account/device context.
Only the owned main renderer may invoke it. The Browser mounts a blank frame
first; after grant issuance, main must find the original frame object and its
still-current admission request before installing the capability. Replacement,
revoke, hidden-tab cleanup and account/device changes fence pending responses.
Native navigation and renewal replace history inside that admitted iframe;
they never remount it and transfer authority to a new frame.
Only origin/expiry/access ID return to renderer code. Capability headers stay
bound to that exact iframe's ancestry; ordinary renderer fetches and external
browsers receive no authority.
Header injection covers HTTPS and WSS. Secure WebSocket origins normalize to
their equivalent HTTPS origin while preserving the exact host, port and frame
ancestry; sibling frames never inherit HMR authority.

Native preview surfaces use `useInternalFeatureActive("cloudComputerV2")`.
Browser, Run and agent admission also require the exact workspace's confirmed
`capabilities.canEdit === true`. They subscribe to that cached authority;
missing or denied capabilities retire the grant and cancel admission retries.
The tab retains its semantic workspace and opaque listener identity; human and
agent tabs with equal display URLs remain separate. Native origins are volatile.
Active visible frames re-admit five minutes before the 30-minute grant expires;
hidden frames retire access and do no renewal work. On return they re-admit
their exact target. A stale response revokes its own grant without replacing
a successor. The last same-key page remains visible during revalidation.
Run addresses resolve through the owning Browser's native human-port admission.
Agent buttons and transcript links carry the exact current execution/port ID.
Unavailable cloud-local links never open a coincidental Mac-local service.
Cloud Browser address entry, empty-tab entry and toolbar history publish logical
tab state before admission. History retains logical URLs and opaque owners,
not grant origins. Only the admitted HTTPS URL navigates the frame; back,
forward and reload re-admit their destination without requesting Mac loopback.
Trusted page links and SPA navigation also enter this logical history, retaining
the opaque owner and translating the current admitted origin to localhost.
Path changes retain their current grant; renewal uses the latest logical URL.
Leaving the preview origin clears preview ownership and resumes ordinary URL
persistence and reload for the external page.

See [native preview acceptance](native-preview-acceptance.md) for the signed Mac
Alpha procedure and its C5/B8/B10 prerequisite boundary.

Runtime service admission can request `relativeLease: true`. The control plane
then includes a `leaseDurationMs` of at most ten seconds. The runtime anchors that
duration to the beginning of its request and rejects responses that arrive after
the deadline. This prevents host clock skew from granting extra access or rejecting
every short preview lease. Legacy callers retain the original absolute-expiry
response shape; the optional field is sent only when requested.

The public preview host accepts HTTP requests and WebSocket upgrades with the
owner-issued `x-zeros-preview-capability`. The control plane checks current paid,
workspace, provider and account authority, then resolves the provider endpoint.
Only the upstream connection receives its service header. The VM gateway checks
its own current engine authority and the Zeros preview grant before connecting
to an allowed application port.

WebSocket streams preserve application subprotocols such as `vite-hmr`. Leases
expire within ten seconds and are renewed while connected; failed or hung
renewal closes the stream. Socket lifetime, concurrent admission, frame size and
buffered data are bounded. Public preview connections share the per-grant request
budget with HTTP requests. Clients should reconnect after a stream or lifetime
limit. Provider raw application listeners, public DNS/TLS and actual development
servers still require exact-image live qualification.

### Implemented incremental replay transport

Protocol 20 additionally advertises `cloud.events.v1` on a registered cloud
engine. `cloudEvents.request` accepts a conversation `snapshot` request or a
`replay` request containing `{ streamId, sequence }`. Subscribe to the workspace
bridge before requesting a snapshot. Buffer incoming frames, install the
snapshot, discard buffered sequences at or below its cursor, then replay/apply
later sequences in order. Never resubmit commands during this process.
A live frame can open another gap while a replay page is pending; drain that
gap before declaring catch-up complete, even if the older page reached its own
head. A superseded engine's late replay result or error cannot reset the current
engine cursor. Neither case may require another live frame to unblock output.

The stream identity is the engine instance UUID. Mandatory agent updates,
permission/question requests and settlements, terminal prompt receipts, and
database invalidations receive a sequence once before fan-out. A conversation
snapshot copies its normalized message window, authoring mode, active turn and
pending interactions synchronously at that cursor, then waits for journal
commit. Queue, files, Git and Design keep their independent exact-key reads and
revisions; revalidate them on attach and on their invalidations. Older transcript
pages remain available through the existing message-window API.

The producer flushes batches every 100 ms, at most 128 events / 1 MiB, with one
in-flight batch and exact-batch retry after lost acknowledgements. A command's
terminal receipt also waits for event flush. Direct live frames are provisional
until flush; a snapshot/replay response covers committed data. Control-plane
retention is bounded to 10,000 events and 16 MiB of encoded frames per workspace.
The engine's pending journal is bounded to 8,192 events / 8 MiB. Exhausting that
pending bound fences execution instead of silently losing mandatory events.

Frames above 256 KiB remain available live and in normalized state. Their journal
entry marks `requiresSnapshot`, and replay returns `event_snapshot_required`.
Conversation snapshots are bounded to 4 MiB. Expired cursors return
`event_cursor_expired`; engine replacement returns `event_stream_changed`. All
three require a new snapshot. Terminal byte streams use the existing bounded
terminal mirror/reconnect path, so terminal floods do not consume this journal.
Native decision callbacks use their separate durable action receipts;
journaling UI events alone never authorizes execution. Live multi-device and
recovery qualification must cover the exact deployed image before release.

## Live subscriptions

Active authorized clients receive incremental agent/tool output, queue and
approval changes, mode revisions, file/Git/Design changes, subscribed terminals,
and workspace lifecycle updates.

- Establish a snapshot plus cursor without a gap before live delivery.
- Scope sequence/revision identity to the stream and execution authority.
- Normalize output once and fan out to authorized subscriptions.
- Persist replayable changes in bounded batches; distinguish provisional output
  from confirmed durable data and reconcile it after interruption.
- Bound frame size, subscriber count, buffered bytes/events and replay retention.
  A slow subscriber cannot block execution or other clients. Overflow requires
  explicit resnapshot/replay, never silent loss of required events.
- Apply deltas and exact-key invalidation, not full transcript/repository reloads
  per token. Preserve dirty local editor buffers during remote changes.
- Reconnect never resends a prompt, starts a second execution or revives a stale
  generation. Expired cursors require a coherent current snapshot.
- Separate terminal input/resize authority from observation.

Device UI layout, selection and unsent drafts are not workspace authority.
Disconnecting or suspending a client does not cancel cloud execution.
Mobile notifications are optional attention signals; correctness relies on
durable state and reconnect. Revocation removes that device's authority while
preserving other authorized devices' access.

## Recovery

Worker file layout version 3 stores the host repository at
`/srv/zeros/files/workspace` and projects the allowlisted `/srv/zeros/files`
directory into the engine as `/srv/zeros`. The logical repository and persisted
checkpoint path remain `/srv/zeros/workspace`. The engine-private sibling
`attachment-staging` has mode 0700 and shares that mount, allowing atomic rename
without exposing partial uploads to workspace commands. Linux temporary-directory
selection checks both the device and mount ID: separate bind mounts can report
the same device and still reject rename with `EXDEV`. Host setup uses the physical
repository path before the engine view exists. Existing immutable worker images
retain their layout until an explicit replacement or recovery operation.

A versioned checkpoint names consistent repository content, safe Git/index state,
chat/turn/mode records, command receipts, supported harness continuation files,
Design journals/receipts, and attachment/artifact manifests. Ignored paths are
not implicitly durable; each namespace has an explicit producer and inclusion
policy. Never copy an entire engine or provider home directory.

Restore validates hashes, schemas, owner/path rebinding and generation authority.
Portable checkpoints do not preserve process RAM. Unsupported native resume must
produce an explicit continuation outcome. Unknown side effects remain uncertain.
Forks get fresh workspace identities and credentials; replicas remain receive-only.

## Portable runtime ingress

Engine admission can include an additive `bridgeUrl` pointing to
`/v1/cloud-workspaces/bridge`. Actor-aware runtimes use a one-use `zwa_` grant;
legacy untouched owner-only runtimes retain `zws_` compatibility. Carry the grant in
`x-zeros-cloud-token`, or browser WebSocket subprotocols `zeros-v1` and
`zeros-cloud-token.<base64url(grant)>`. Query-string credentials are rejected.
The exact engine consumes admission; the coordinator relay only authenticates
and forwards frames. Provider preview secrets stay in the coordinator.

Portable admission requires a trusted registered device and a one-use Ed25519
proof for `engine.connect`, signing `{ organizationId, workspaceId }` with the
existing `zeros-cloud-device-proof-v1` canonical format. The five
`x-zeros-device-*` headers carry the device id, key version, timestamp, nonce,
and signature. An account bearer alone cannot mint a portable connection grant.
Devices may identify as macOS, Windows, Linux, iOS, iPadOS, Android, or web;
platform never grants authority. This registry support does not ship those apps.

Established relays and engines revalidate account, organization, device trust
and key version, generation, engine lease, and grant authority every five
seconds, with a hard ten-second renewal deadline. Engine enforcement also
covers direct provider connections. Renewal checks a previously consumed grant;
it neither consumes a fresh grant nor writes an audit event on every tick.
The admission expiry limits new connections; device and account revocation
still apply throughout an established connection. A late verification reply
cannot reopen a closed connection. Historical unbound SSH admission remains
readable behind its separate deployment configuration, and cannot enter the
portable relay. Roll out the matching attested engine and coordinator together.

A disconnect closes transport and never replays a prompt or cancels admitted
work. The measured 2 GiB relay profile defaults to 64 connections per process,
ten writer connections and ten separately counted Read-only connections per
workspace, 32 pending admissions, an unchanged 64 MiB message ceiling, a 256 MiB
shared inbound assembly budget, and a 128 MiB aggregate outbound reservation
budget. Assemblers allocate lazily and large messages reserve shared capacity
from their frame headers. Admission attempts have a two-per-second token bucket
whose burst is the larger of 32 and the configured instance connection ceiling,
allowing a bounded reconnect wave. See [relay capacity](relay-capacity.md) for
validated variables, local load evidence, 2/8 GiB sizing and replica caveats.

Boat exposes only the authenticated engine listener. Private HTTP previews pass
an existing Zeros preview grant to that listener; the engine revalidates it with
the coordinator and forwards only to the admitted loopback application port.
Internal ports and protocol upgrades are rejected. Requests, responses,
concurrency and authorization lifetimes are bounded. General TCP/SSH forwarding
requires its own qualified runtime service and is not implied by HTTP previews.

The qualified cloud primary checkout uses its existing opaque `local-main`
identity for Design initialization and API authoring. It needs no second local
worktree database row. This authority is supplied by immutable worker admission;
remote requests cannot enable it on a local desktop.

Ordinary workspace deletion waits for the final durable checkpoint. An explicit
`DELETE` body `{ "discardUncheckpointed": true }` discards that requirement for
unrecoverable or disposable workspaces. It retains owner/organization checks,
access revocation, auditing and confirmed provider cleanup. Its idempotency
digest differs from ordinary deletion, and unknown request fields are rejected.

## Acceptance gates

Both managed and customer-provider paths must pass:

1. unauthorized create/subscription rejection before external side effects;
2. one shared Code/Design conversation without a desktop process;
3. two simultaneous clients receiving incremental updates and a third joining
   mid-turn without a snapshot/stream gap;
4. duplicate send, approval, Stop, reconnect and stale-generation races;
5. slow-subscriber, network partition, stream restart and revoked-device tests;
6. full-allocation loss and recovery of declared supported state;
7. measured latency, bounded memory, resource usage and verified deletion.

Headless conformance establishes backend behavior. Native apps still require
their own UI, auth/storage integration and platform qualification.


## Native human SSH, SFTP and port streams

The qualified Linux worker advertises `cloud.services.v1`. The control plane
issues native access independently of provider SSH administration APIs:

- `POST /v1/organizations/:organization/cloud-workspaces/:workspace/runtime/services`
  accepts `{kind:"ssh"|"tunnel", remotePort?:number, expiresInMinutes?:number}`.
  Send an account bearer, an `Idempotency-Key`, and the existing signed device
  proof headers. The proof action is `runtime-service.issue`; its canonical
  payload contains `organizationId`, `workspaceId`, `kind`, `remotePort` (null
  for SSH), `expiresInMinutes` (default 15), and `idempotencyKey`.
- The one-time response contains grant identity and a `transport` with a WSS
  URL, `capability`, `headerName:"x-zeros-runtime-service"`, and
  `protocol:"zeros.service.v1"`. Connect with that header; browser clients offer
  `zeros.service.v1` and `zeros.authorization.<capability>` as subprotocols.
  Only the public protocol is selected. Capabilities never belong in URLs.
- `GET /v1/cloud-workspaces/services/:kind/:grant` with the same capability header
  checks current grant, device, actor, epoch and engine authority without opening
  a provider/application connection or consuming a relay slot. Its noncacheable
  response is `{expiresAtMs:number}` (at most ten seconds of authority), or 401.
  This route uses native capability authentication, independently of account JWTs.
- The first text frame is a version-1 introduction. For SSH it includes the
  ephemeral Ed25519 `publicKey` and unprefixed SHA-256/base64 `hostKeySha256`;
  verify the SSH host key against this authenticated introduction and use the
  fixed username `zeros`. Subsequent frames are binary SSH bytes. Shell, exec,
  PTY resizing, stderr/exit status, and SFTP use the same unprivileged identity.
  SSH forwarding and environment injection are refused; forwarding instead
  needs a separate port-scoped tunnel grant. Tunnel introductions contain only
  `{version:1,kind:"tunnel"}` followed by binary application bytes.
- `DELETE .../runtime/services/:grant` revokes one grant for the authenticated
  owning account, including after workspace stop or device retirement.

Grants last 1–30 minutes, bind one exact device key, engine instance, generation
and authority epoch, and are checked again within 10 seconds independently of
traffic. The public relay rechecks after resolving a provider endpoint. An
expired engine, retired generation, lost seat, revoked connection, rotated or
revoked device, or final lifecycle checkpoint invalidates admission. Token
hashes persist; a lost issuance response requires a new idempotency key. At
most 16 eligible, unexpired grants for the current engine exist per workspace, the worker admits eight streams,
and each SSH stream admits four concurrent channels. Transfers have 64 KiB
runtime frames, a 256 MiB limit in each direction and a 30-minute connection
limit; clients explicitly reconnect when a limit is reached.

Each SSH worker runs in a separate PID namespace with privilege elevation
disabled and no effective capabilities. Connection retirement kills detached
shell descendants as well. Final checkpoints close new service admission and
wait for active SSH namespaces to drain before capturing files. An unconfirmed
drain retires engine authority; it cannot publish a successful checkpoint.
The provider routing credential stays in the control-plane relay. Provider
legacy SSH grants do not authorize these native workload services.

### Desktop native access

Electron main implements native service admission and transport in
`cloud-runtime-service-client.ts` and `cloud-runtime-service-transport.ts`.
The existing SSH copy, Terminal and tunnel IPC names now use these native
services. Provider SSH remains a distinct compatibility path for legacy engine
dispatch; a refused native service never falls back to provider administration.
The main process signs the exact device proof, validates the returned workspace,
device, service, port and expiry, and accepts only the exact control-plane WSS
service URL. Account replacement and local device-key rotation fence pending
admissions. The backend remains authoritative for generation, epoch, engine,
membership and device revocation; the introduction does not invent those fields.

SSH uses macOS's OpenSSH and `/usr/bin/nc -U` through a private, single-use Unix
socket. A copied command contains only the path to a private OpenSSH config.
Connecting that socket opens the authenticated WSS stream on demand, validates
the introduction's Ed25519 encoding and fingerprint, and writes its public key
before releasing SSH handshake bytes. OpenSSH independently enforces the pin
with `StrictHostKeyChecking yes`. Delaying WSS admission until command use avoids
consuming the worker's ten-second SSH handshake deadline while the user copies
the command. Each new SSH/SFTP connection needs a new command; there is no
persistent SSH host alias or connection multiplexing. Terminal launch uses a
private `.command` wrapper. The service capability never enters these files,
argv, the clipboard, the renderer or a child environment. Config/key/socket
files are removed on close, expiry or account retirement, and are never resumed
as authority after app restart. IDE actions remain unavailable until their actual
connection and forwarding sequence is qualified.

Port forwarding binds only the requested Mac `127.0.0.1` application port.
Each local connection opens a native binary stream under the same port-scoped
grant; listener collisions fail visibly and cannot displace another listener.
The client splits writes at the 64 KiB frame boundary, honors backpressure and
limits each forward to four concurrent connections, matching the relay. Excess
clients, including relay 429 responses, are refused individually. It rejects remote port 22222 and the
default engine port 39393 before signing; the backend also rejects configured
engine/service ports. Non-capacity admission failures close the local listener.
An independent read-only check renews listener authority at most every five
seconds, including while idle. Revocation or failure to revalidate within the
existing ten-second bound closes the listener and retires its broker row;
ordinary application EOF leaves it available. Older control planes without the
authority-check route fail closed. No wake,
retry, persisted config or account change silently reissues service authority.

Closing an SSH connection or explicitly closing a forwarding listener stops
local access and deletes only its exact grant, using the issuing account.
Sibling grants (including other devices) are unaffected. Failed retirement in
the current session remains visible as **Retry close**, including admission
whose local bind failed. Account retirement attempts cleanup with the original
account token; if offline cleanup cannot complete, backend expiry still bounds
the abandoned grant. Unused copied commands and idle forwarding listeners hold
their fifteen-minute grant until closed or expired and can therefore delay idle
sleep. The user must close them when finished.

The workspace details controls require
`useInternalFeatureActive("cloudComputerV2")`, a running workspace, the native
desktop bridge, and `capabilities.canEdit === true`. `canEdit` is optional for
mixed-version documents and fails closed when absent. Read-only
`cloud_workspace_access_context` / `cloud_workspace_access_list` return safe
metadata only. Their bounded renderer caches include account epoch, broker
authority, device/key version, organization and workspace. Pointer/focus intent
warms metadata without issuing grants; same-key refresh retains confirmed rows;
hidden surfaces do not poll. Staff actions return the captured authority context
to main so a stale click cannot issue into a replacement account or device.

Local tests cover real OpenSSH exec/SFTP, key mismatch, framing, authority races,
cleanup and the staff UI. They do not qualify a signed Mac build against a v4
template workspace. Run the [Mac Alpha acceptance procedure](native-access-acceptance.md)
after the template, wake and persistence prerequisites have been qualified.
