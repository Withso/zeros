# Cloud client and runtime contract

This contract governs the backend expansion after the original cloud foundation.
Implementation and live qualification are tracked separately in the roadmap.
Native mobile and cloud creation UI remain deferred.

## Identity and placement

- Cloud workspaces belong to eligible Organizations; Personal stays local.
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

Normal authenticated `AGENT_NEW_SESSION` and `AGENT_LOAD_SESSION` admission can
provide a selected provider's model credential in its session environment.
The cloud environment filter rejects host-authority and process-injection
variables. It does not hide an admitted model key from that tenant's agent.
Credentials are not durable prompt fields, replay events, checkpoint content,
or data returned to another device. A second authorized device can attach to
the running native session without receiving its credentials.

After allocation loss, restored native conversation history is independent of
authentication. Fresh provider execution requires supported authentication again.
The current backend does not automatically copy desktop subscription files,
refresh a cloud subscription from another device, or provide a provider-account
vault/rebinding API. Headless CLI login and private qualification transfers are
not evidence that a production account-connection flow is implemented. Agent
authentication, licensing and redistribution remain separate release gates.

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
Receipts retry autonomously after temporary persistence failures. Transcript
sync commits its captured revision even while newer tokens remain dirty; it
does not require a quiet agent. A previously admitted, still authorized device
retains reads and Stop during temporary record lag. New prompt claims wait for
durability to recover.

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
`/v1/cloud-workspaces/bridge`. Connect with the one-use `zws_` grant in
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
work. Limits per relay process are eight connections, four per workspace,
32 pending admissions, 64 MiB per frame, and 128 MiB aggregate queued output.
Admission attempts also have a global burst-32, two-per-second token bucket.
Budget at least 2 GiB per relay process for worst-case frame assembly; scale
replicas rather than increasing these limits without load evidence.

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

These are backend contracts. A future SSH ProxyCommand helper and each native
client must implement the authenticated introduction, framing, device proof
and explicit reconnect behavior before claiming client support.
