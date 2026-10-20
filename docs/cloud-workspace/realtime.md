# Realtime service

The control plane runs as one image with explicit process roles. `realtime`
is the role that terminates long-lived WebSockets: today's client relay
(`/v1/cloud-workspaces/bridge`), preview and runtime-service sockets, and,
behind per-organization rollout flags, the VM uplink (S2) and the device
stream (S3). Contracts: [S2](contracts/s2-uplink.md),
[S3](contracts/s3-client-contract.md).

Local workspaces are unaffected: nothing here runs on the Mac, and a Local
engine never constructs the uplink client.

## Process roles

`CONTROL_PLANE_PROCESS_ROLE` chooses what a process starts. With no setting
the process is `combined` and behaves exactly as before.

| Role | HTTP routes | WebSocket upgrades | Durable workers | Database pools |
| --- | --- | --- | --- | --- |
| `combined` (default) | all | all | all enabled queues | API, worker, listener |
| `api` | all | all (today's relays) | none | API, listener |
| `realtime` | `/healthz` and release readiness only | all | none | API-class (`zeros-realtime`), listener |
| `worker` | `/healthz` and release readiness only | none | all enabled queues | worker, listener |

- `api` keeps serving today's relay sockets so existing clients, whose relay
  URL is the API origin, keep working when an operator splits roles. Moving
  the relay to the realtime origin is a later client-routing change.
- `realtime` builds the same cloud services as `api` for admission
  (provider resolver, client admission, preview and runtime-service access)
  but mounts no API routes, holds no checkpoint-hint waits, runs no GitHub
  read cache and starts no queue consumer. Its pool uses the API deadlines
  (one-second acquire, five-second statements).
- New uplink and device-stream servers start only in `combined` and
  `realtime` processes, and only when configured (see below).

## Graceful drain

`CONTROL_PLANE_DRAIN_SECONDS` (0–120, default 0) sets the SIGTERM drain
window. With 0, shutdown closes every socket at once, as before.

With a window, on SIGTERM the process:

1. refuses new upgrades immediately (the replacement instance takes them);
2. stops background workers as before;
3. closes each admitted relay with `1012` at a random moment inside the
   window, so clients reconnect to the replacement gradually instead of in
   one wave; every relay keeps forwarding until its own moment;
4. sends `sys.drain` to uplinks and `drain` to device streams (when those
   are enabled) with a randomized `reconnectAfterMs`, then closes what
   remains at the deadline with `4503 draining`;
5. closes the HTTP server and the pools once sessions are gone or the window
   plus a short grace has passed. The hard exit deadline is the window plus
   15 seconds.

HTTP keeps serving during the window. Clients already treat a relay close
as a reconnect (`apps/desktop/src/renderer/platform/bridge/runtime-client.ts`),
so a drained relay session reconnects through the normal ladder.

## Resume tokens and the resume buffer

Decision D8: reliable frames are kept in memory for 120 s after an uplink
disconnects, keyed by an opaque resume token
(`apps/control-plane/src/realtime/resume.ts`).

- A token is 32 random bytes (base64url), single-use, bound to the
  connection identity (the heartbeat credential's digest, organization,
  workspace, generation, engine instance and boot ID), stored only as a
  SHA-256 digest, never logged, and rotated on every `sys.welcome`.
- Only sequenced frames (those carrying `s`) are buffered. `sys.*`,
  `auth.*` and `relay.*` frames are unsequenced, per connection, and never
  replayed.
- Each direction has one sequence space per lineage. Unacknowledged frames
  are bounded to 2 MiB or 2 000 frames; overflow closes with
  `4429 backpressure`.
- A token that is unknown (another instance, a restart), expired, for
  another identity or malformed yields `resumed: false`, and both sides
  resync idempotently. A token for a lineage that is still open supersedes
  it: this is how an engine reconnects before closing the old uplink during
  a drain.

## Engine uplink server

`apps/control-plane/src/realtime/uplink-server.ts` implements the S2
contract (`contracts/s2-uplink.md`, 1.2.0) at `/v1/uplink`. It is mounted
only in `realtime` and `combined` processes, and only once the capability
authority supplies keys, epochs and engine tokens
(`realtime/uplink-auth-source.ts`; until then the uplink stays unmounted).

- **Rollout.** A hello is admitted only while the organization's
  `realtime_uplink` flag is on ([rollout flags](rollout-flags.md)). Turning
  the flag off closes that organization's open uplinks with `4404`; engines
  then keep the HTTP heartbeat and the credential poll, which stay in
  place. Rollback limitation: a `4404`-parked engine does not re-dial on
  its own — the advertisement arrives with registration, so a parked engine
  picks the endpoint up again only at its next restart or re-registration
  (the heartbeat itself never carries it).
- **Pre-authentication limits.** Before any credential check an upgrade
  spends a token from its source address's bucket (100 burst, 30 per
  second, at most 64 sockets awaiting their welcome) and from a
  process-wide ceiling (500 burst, 500 per second, 256 handshakes in
  flight). The source is a present `X-Real-IP`, else `CF-Connecting-IP`,
  else the socket peer; a value that does not parse as an IP shares one
  `unknown` bucket. This is the rule of the HTTP engine paths' pre-auth
  limits (`client-address.ts`). One source flooding shaped tokens therefore
  spends only its own budget; refusals are `429` or `503`.
- **Admission.** One consistent authority read
  (`readCurrentCloudEngineAuthority`) checks the heartbeat credential,
  workspace, generation and engine instance, and compares the hello's
  `bootId` with `cloud_workspace_engine_instances.runtime_boot_id`. Close
  codes: `4401` only when the read succeeded and no engine holds the
  credential; `4403` for a stale engine or an unregistered `bootId`;
  `1011` when the read could not complete. A rejection tells "unknown" from
  "stale" with one more statement in the same transaction, so a rejected
  hello costs one transaction. The read always goes to SQL, never the
  in-process authority cache (`authority_cache_enforce`): a
  notification-driven recheck may run before the cache's invalidation for
  the same commit lands.
- **Handshake.** `sys.welcome`, then `auth.keys` and `auth.sync` with a fresh
  `syncId`. Until the engine's `auth.applied` the server sends only `sys.*`
  frames; reliable frames queued meanwhile are held. It then sends an
  `auth.capability` issued by `api` from current authority, retransmits
  unacknowledged reliable frames on a resume, and lets feature modules
  resync. Epoch deltas confirmed by `auth.applied` record
  `capability_revocation_push_ms`. The engine has 10 s
  (`UPLINK_AUTH_APPLIED_TIMEOUT_MS`) from `auth.sync` to `auth.applied`;
  its durable auth sink must settle `auth.keys` plus `auth.sync` within
  that bound, or the uplink closes `4400` and the redial waits the same way.
  At most 1 000 epoch deltas may be held or await `auth.applied`; past that
  the uplink closes `4429` and resyncs from the snapshot on the redial.
- **Oversized `auth.sync` (interim).** The engine closes `4400` on any text
  frame above 64 KiB, and S2 1.2.0 cannot split `auth.sync`; an
  organization-shared workspace with roughly 500 principals crosses it. Until
  the contract owner decides on split frames (end of Wave 1) the server
  refuses to send any oversized frame: it closes `1011`
  (`auth_sync_too_large` or `outbound_frame_too_large`), counts it under
  `counters.closed` and logs one `[realtime]` line with the frame type and
  size only. The engine answers `1011` with its full-jitter backoff (30 s
  cap) instead of a tight `4400` loop, and stays on the 5 s empty credential-control
  poll. Pending acknowledgements retain their 500 ms handshake cadence.
- **Teardown.** Authority is re-read every 60 s and at once on a
  `zeros_cloud_engine_uplink_authority` notification (engine state,
  revocation, credential or final checkpoint changes; workspace generation,
  desired state, deletion, status liveness or authority epoch changes). A
  loss closes with `4403`. A `lease.v1` uplink skips the 60 s re-read while
  the notification listener is current (from its ready until it is
  unavailable or stops): every notified change still re-reads it at once,
  and its lease renewal re-checks authority every 5 min. An unavailable
  database never closes an established uplink. A notification that arrives
  while a re-read is in flight runs one more re-read after it, and a hello
  whose read overlapped a notification for its engine or workspace re-reads
  once it owns the engine, so a revocation committed after a read's snapshot
  is never dropped. During
  a drain the instance keeps its uplink `LISTEN` until the uplink server
  closes, so engines still on it keep pushes and teardown.
- **Ownership.** Presence lives in memory. `cloud_workspace_engine_uplinks`
  (migration 0150) is written only on connect, readiness change and loss,
  plus a 5 min watermark, through a bounded coalescing retry queue that
  rotates connections fairly. Readiness writes are rate-limited per uplink
  (a burst of three, then one per 2 s, the latest state winning). Each
  write carries a connection ID; a connect never overwrites a newer one.
  "Newer" is a deterministic order on unsynchronized replica clocks: the
  later `connected_at` wins, and a same-millisecond tie (or skew within the
  connect gap) breaks by connection ID, in both the in-memory owner rule
  and the presence upsert fence. A new owner row notifies
  `zeros_cloud_engine_uplink_owner`, and an instance holding an older
  uplink closes it with `4409`. After a listener reconnect every owned
  uplink re-reads its owner and authority. With one replica (below) the
  clock order cannot misfire; above one, replica clocks must agree to well
  under the reconnect gap (seconds, NTP-disciplined), or a replica ahead by
  more fences the true newer owner's writes and its row reads
  `disconnected` while it is connected. Nothing reads the rows yet.
- **Framing.** Control frames are UTF-8 JSON text capped at 64 KiB; relay
  data travels in binary frames (8-byte header, then a chunk of at most
  256 KiB), never base64 in `d`, so the socket payload ceiling is
  `UPLINK_MAX_BINARY_FRAME_BYTES`. A chunk for a channel no extension
  claims gets a non-fatal `sys.error relay_channel_unknown`; malformed
  headers close with `4400`.
- **Security events.** An unregistered `bootId`, more than 3 supersedes of
  one engine instance in 10 min, or a supersede from another source address
  without an intervening `sys.drain` writes `security.uplink_*` to the
  organization's audit log and logs a `[security]` line for paging. These
  are operator events, not the client-delivered `security_events` outbox.
- **Credential push.** The `cred.v1` extension (`uplink-cred.ts`) replaces
  the engine's 5 s empty credential-control poll while the uplink is up
  (P0.10 C01). At the gate it pushes the boot binding's current desired
  revision (the contract's resync rule), and a trigger on
  `cloud_agent_boot_bindings.desired_cache_revision` (migration 0153)
  notifies every bump, routed to the owning instance over
  `zeros_cloud_agent_credential_revision`. The notification is only a hint:
  the engine's exchange re-reads authority. `cred.ack` (`applied`/`failed`)
  arrives over the reliable channel. A bump committed while the listener
  was down never notifies; it is repaired both at the next gate open and,
  for engines whose gate is already open, when the listener is ready again:
  `onReady` reads the current revisions of every owned `cred.v1` uplink in
  one system statement and pushes them (the engine acks a revision it
  already applied without an exchange). While the listener session is down
  the engines stay `established` and fall back to the 30 s safety poll, so a
  bump lands within 30 s in the worst case; the `[realtime]` unavailable
  line marks the window. `cred.v1` is negotiated only while the
  organization's `credential_push` flag is on; a flip closes the affected
  uplinks with `1001 features_changed`, and the re-dial (resuming the
  lineage) renegotiates, so turning the flag off returns those engines to
  the 5 s empty poll without parking them. Only `agent-controls` has a
  revision source today: the CP has no `repository` revision, so it never
  pushes that kind, and repository credentials keep arriving on the HTTP
  heartbeat response (`repositoryCredential`) unchanged. The engine acks any
  `repository` push `failed`/`cred_kind_unsupported` without calling its
  handler or recording the revision, so adding the kind later is an
  explicit signal, never a silent swallow.
- **Revocation push (S-3).** `capability-revocation-push.ts` consumes the
  process's security-event feed, which it shares with the device stream.
  Migration 0155 writes a `capability.epochs_changed` row in the same
  transaction as every epoch bump (member epochs, `users.auth_revision`,
  device key version or revocation, workspace authority epoch and access
  revision). Clients never see that kind, because `listSecurityEvents`
  filters it out. For each event the producer finds the owned uplinks of
  affected workspaces whose organization has `capabilities` on. It re-reads
  their current epochs and revocations from `auth.snapshot` (never from the
  event payload) and pushes `auth.epochs`, so `capability_revocation_push_ms`
  runs from the event's `created_at`. On a feed `gap` it re-reads every
  owned uplink. It sends `capability.revoked` to device streams only for
  epoch events: the device stream already re-checks the account, session,
  organization and workspace authorization kinds itself. It reads nothing
  while no organization has `capabilities` on, resolves the workspaces of
  every user named in a batch with one query, and retries a failed pass as
  a full re-read of every owned uplink after 1 s, doubling to 30 s while
  reads keep failing.
- **Lease (`lease.v1`).** `uplink-lease.ts` renews the engine lease of an
  uplink that negotiated `lease.v1` (S2 1.3.0). The engine offers it only
  with an exact armed-supervisor declaration, `exit.report.v1`; the server
  requires that declaration and the organization's `engine_lease_over_uplink`
  flag is on ([rollout flags](rollout-flags.md)), and a flip closes the
  affected uplinks with `1001 features_changed`. The server renews once the
  gate opens, unless more than 31 min remain (a drain redial), and on each
  5 min watermark tick. One system transaction sets a 2 s `lock_timeout`,
  takes the authority fence every engine mutation takes
  (`assertCurrentCloudEngineAuthority`), then moves `lease_expires_at` to
  `greatest(lease_expires_at, now + 36 min)` and sets `last_heartbeat_at`
  on the engine row that still matches the credential hash and
  `runtime_boot_id`, is `ready`, unrevoked and without a final checkpoint,
  and whose lease has not lapsed. It writes no other column, so the
  authority-cache, engine-health and uplink-teardown triggers stay silent
  (engine health reschedules itself to the new expiry when it runs). A
  refusal closes `4403`; a renewal that fails (the lock timeout included)
  keeps the uplink open until the next tick. The in-memory lease only moves
  later and is what `sys.welcome` and `sys.pong` report. The HTTP
  heartbeat (`setup-materials.ts`) moves the lease to
  `greatest(lease_expires_at, now + 90 s)`, so it never shortens an
  uplink-renewed lease. Without `lease.v1` the HTTP heartbeat owns the
  lease and the uplink reports the lease it read. A lost uplink never
  shortens the lease (decision G). An armed supervisor reports a positive
  child exit through `POST /internal/v1/cloud-workspaces/engine/exited`,
  authenticated with that engine's original bridge secret. The API revokes
  the exact launch and admits safe Stop, or retains its existing lifecycle
  owner. It does not infer provider retirement, billing settlement or a
  completed checkpoint. If reporting is unavailable, lease expiry remains
  the fallback. The [S2 withdrawal contract](contracts/s2-uplink.md#supervisor-exit-withdrawal-exitreportv1)
  defines journal custody, setup/enrollment fences and lifecycle overlaps.
- **Checkpoint requests (`checkpoint.v1`).** `uplink-checkpoint.ts` pushes
  queued checkpoint requests to an uplink that negotiated `checkpoint.v1`
  (S2 1.3.0), selected only with the engine's `checkpoint.fallback.v1`
  declaration and the organization's `checkpoint_push` flag on; a flip
  closes the affected uplinks with `1001 features_changed`. One
  system statement (`withSystemStatement`) reads the queued, unexpired
  requests of each uplink's exact workspace, organization and generation,
  oldest first and at most eight per uplink, for up to 500 uplinks at a
  time, and `realtime` sends each as a reliable `checkpoint.request`. It
  reads an uplink when its gate opens, when
  `zeros_cloud_checkpoint_request` names its workspace and generation,
  when the notification listener is ready again (every owned uplink), on
  each 5 s tick while that listener is not current, and every 30 s
  otherwise, which bounds a missed notification on a silently dead LISTEN
  connection. Reads are single-flight and batched; a failed read leaves the
  uplinks pending for the next tick and never retries at once. The frame is
  only a hint: the engine fetches, fences and acknowledges the request
  through its heartbeat as before, so the push writes nothing and a
  foreign or stale frame costs one heartbeat. Without `checkpoint.v1` the
  engine keeps its checkpoint-hint long-poll on `api`.
- **Idle stop (`idle.v1`).** `uplink-idle.ts` decides an idle stop for an
  uplink that negotiated `idle.v1` (S2 1.2.0), selected while the
  organization's `cp_idle_stop` flag is on ([rollout flags](rollout-flags.md))
  and the server has an idle store. `UplinkIdleDecision` takes each
  `activity.report`: with all three counts 0 and `windowMs > 0` the quiet
  start is the receipt time minus `windowMs`, and the request is due 10 min
  after it. A busy report, a restarted quiet window, a closed uplink or no
  report at all cancels or prevents it, so unknown activity never stops a
  workspace. `DatabaseUplinkIdleStopStore` runs the HTTP idle-stop
  transaction (`DatabaseCloudIdleStop.request`) with the uplink's own
  identity and token, one call in flight, and maps the outcome to
  `requested`, `declined`, `unavailable` or `authority`. Declined or
  unavailable retries back off 15 s, doubling to 120 s; requested waits one
  full interval; authority re-checks the uplink and stops retrying.

## Turn journal (`turns.v1`)

`uplink-turns.ts` stores the engine's turn journal (S2 1.2.0). The uplink
negotiates `turns.v1` while the organization's `turn_journal` flag is on,
which requires `realtime_uplink` ([rollout flags](rollout-flags.md)). Each
`turns.event` is one turn transition the engine committed locally
(`started`, `completed`, `failed`, `needs_attention` or `interrupted`).
Migration 0156 stores it in `cloud_workspace_turn_events`, one row per
engine instance, boot and `journal_seq`, with the chat and turn identifiers
and the state. No prompt, result or other content is stored. The table is
system-only with forced row security. Rows are never pruned yet: they are
deleted only with their workspace (a follow-up).

- **Storage.** A frame is handled in receive order and stored only once the
  previous sequence of its boot is stored, so each boot's journal is
  contiguous from 1. A sequence at or below the stored high-water mark is a
  duplicate: it is acked again and stores nothing. A sequence beyond the
  next one is a gap: it is refused with one non-fatal
  `sys.error turn_journal_gap` carrying `expectedJournalSeq` per session and
  expected value, and nothing is acked. The engine resends from there. An
  unreachable database stores and acks nothing; the engine's stall resend
  repairs it. `turns.ack` is cumulative.
- **Rate bound.** An uplink may store 128 events at once and 10 per second
  after that: a token bucket that starts full at 128 and refills at 10 per
  second. Frames beyond the bucket, or beyond 128 waiting for the store, are
  dropped unacked. The engine keeps at most 64 unacked and a turn makes two
  or three transitions, so only a misbehaving engine reaches the bound. A
  dropped frame is repaired by the engine's gap or stall resend.
- **Notifications.** A stored `completed`, `failed` or `needs_attention`
  notifies `turn.completed`, `turn.failed` or `turn.needs_attention` in the
  same transaction, but only for the first such transition of its workspace,
  chat, turn and state. It is sent with `pg_notify` on
  `zeros_cloud_turn_notifications`, which every realtime instance listens
  on; each instance delivers it to the device sessions of the workspace's
  current holders. The title carries no content. `started` and `interrupted`
  notify nothing. A notice is best effort: one sent while the listener is
  down is not replayed.

## Device stream server

`apps/control-plane/src/realtime/device-stream-server.ts` serves the S3
device stream (`s3-client-contract.md` Part 2) on `/v1/device-stream`. It
mounts in `realtime` and `combined` processes once any organization has the
`device_stream` flag on; until then there is no socket, feed or LISTEN, the
upgrade answers 404 and clients keep polling. An account streams only while
an organization it belongs to (as a member, or through a live guest grant)
has the flag on: otherwise `POST /v1/device-sessions` answers 404 and a
hello closes `4404`. Every catalog re-read refreshes that set, so turning
the flag off for the organization, or leaving it, closes the account's
streams with `4404` without resume and drops its parked device sessions.

- **Tickets.** `POST /v1/device-sessions` (api; device proof action
  `device-session.create` over `{ deviceSessionId }`, 30/min per account,
  `Cache-Control: no-store`) issues a `zds_` ticket valid 60 s. Only its
  SHA-256 is stored, in `cloud_device_sessions` (migration 0154; forced RLS,
  system only, cascading from the account and the device). The request may
  name an existing `deviceSessionId`: the same account, CP session and
  device keep it and get a new ticket, which replaces any outstanding one.
  Realtime consumes the ticket with one conditional `UPDATE` in the
  database, so a ticket is single-use across instances; a reused, expired or
  no-longer-authorized ticket closes `4401`. The device session lives 24 h
  after its last ticket; at most 20 per account are kept.
- **Frames.** `hello` within 10 s (else `4408`), a common contract major
  (else `4426`), then `ready`. Client frames are capped at 4 KiB (hello
  96 KiB) and 20/s after a burst of 40 (`4429`); an unknown client frame
  type gets a non-fatal `error frame_unknown`. `heartbeat` every 20 s; a
  socket that answers no WebSocket ping for 45 s closes `4408`.
- **Catalog source.** Every `catalog.changed` and `lifecycle.changed` is the
  diff between a re-read of the account's catalog (the exact
  `GET /v1/cloud-workspaces` access set) and what that device session was
  last told. Re-reads are triggered by the `zeros_cloud_workspace_catalog`
  NOTIFY (migration 0154: every committed `cloud_workspaces.version`
  change, insert and hard delete) and by the security-event feed:
  `workspace.authorization_changed` (that workspace),
  `organization.authorization_changed` and `organization.access_revoked`
  (the organization's connected accounts), `account.*` (that account, and
  the accounts viewing a workspace it owns: the owner's Pro status and staff
  allowance decide `canStart` for every viewer).
  Hints carry ids only. Every listener ready (the first one too, since
  streams are admitted before LISTEN is up) and every feed gap re-reads
  every connected account and re-checks every device session. Re-reads are
  coalesced (25 ms) with four accounts in flight; one read covers up to
  1,000 workspaces, a targeted re-read of more is split into reads of at
  most 1,000 ids, and a truncated read never infers a removal. Reads are
  numbered as they start, and a re-read applies only to device sessions
  whose baseline read started before it, so a read already in flight never
  hands a newer session older access.
- **Fan-out.** A workspace's frames go only to device sessions whose last
  re-read contained it. Losing access (or deletion) sends
  `capability.revoked { scope: "workspace" }`, then one
  `catalog.changed { op: "remove" }`, and nothing further for it. An
  upsert is sent when the workspace's `version` grows, or at the same
  `version` when the document differs from the last one sent, ignoring the
  timestamps that move on their own (`lastObservedAt`, `updatedAt`,
  `generation.lastObservedAt`). That is how the viewer's `actorRole` and
  `capabilities` (including `canStart` and `startUnavailableReason`) reach
  the stream after a role or allowance change (S3-Q8, S3 1.1.0). The
  comparison uses a digest of the last document sent, computed once per read
  row. `lifecycle.changed` still needs a `version` bump. Changes that
  publish no event (allowance funding, an entitlement reaching its end)
  arrive with the account's next re-read.
- **catalogVersion.** The global `cloud_catalog_version_seq` position (read
  before the rows), so it is monotonic per account; frames carry the
  maximum seen by that device session. The REST catalog returns the same
  value. Membership changes do not draw from the sequence. Sequences are not
  transactional: a position can include a change whose transaction has not
  committed, so a snapshot at version N need not contain every change up to
  N. It is a watermark, not a snapshot point; nothing filters by it, and
  clients order and deduplicate by each workspace's `version` only.
- **Resume.** Resumable frames (`catalog.changed`, `lifecycle.changed`,
  `notification`, `capability.revoked`) carry `c = <lineage>.<seq>` and are
  kept for 10 minutes per device session (at most 1,000 frames or 1 MiB;
  `ack` trims, at most once per second). A disconnected device session is
  parked on this instance for 10 minutes; at the 50,000-session cap the one
  parked longest is dropped first, and a connected one never is. A resume
  from a cursor still held replays the missed frames, `capability.revoked`
  first, then re-reads the catalog. Its `ready.cursor` is the resume
  position, and revocations sent ahead of their order carry that position
  as `c`, so a client that drops mid-replay and resumes from the last `c`
  it received gets the rest again. Another lineage (another instance or a
  restart) gets `ready { resumed: false }` + `catalog.reset instance_changed`;
  a cursor older than the retained frames gets `resume_expired`.
- **Authority.** Device sessions are re-checked every 60 s and on
  `account.*` / `session.revoked`: an expired device session, a revoked
  account, device or CP session sends `capability.revoked` with scope
  `session` / `account` / `device`, drops the device session (no resume)
  and closes `4401`.
- **Presence.** `presence.set` is held in memory on this instance only and
  shared as `presence.changed` (latest wins, not resumable, 256 members)
  with device sessions that hold the workspace, only while the
  organization's `presence_in_memory` flag is on. Presence is not shared
  across realtime instances yet.
- **Producers.** `publishNotification`, `revokeCapabilities` and
  `pushCapabilityRenewal` (for `attach`ed runtime sessions) are the entry
  points for notification and capability producers; none is wired in this
  release (notifications arrive with Tracks D/E, capability renewal and
  revocation with Track B's S-3 producer), so no `notification` or
  `capability.renewed` frame is sent yet.
- **Drain.** The C0 staggered drain sends `drain { reconnectAfterMs }`
  (0-5 s) and closes `4503`.
- **Local.** Only cloud workspaces exist in the catalog the stream reads;
  no desktop code opens the stream
  (`device-stream-local-boundary.test.ts`).
## Engine uplink client

`apps/desktop/src/engine/cloud-engine-uplink.ts` is the engine side of S2.
Only a cloud engine constructs it, and only when the control plane
advertised an endpoint: registration sends the opt-in header
`x-zeros-cloud-engine-uplink: 1`, and the registration and
runtime-registration responses carry `uplink: { endpoint }` only for an
opted-in engine whose organization's `realtime_uplink` flag is on
(`internal-routes.ts`; the endpoint comes from `CLOUD_WORKSPACE_REALTIME_URL`,
a credential-free `https`/`wss` origin normalized to `wss://…/v1/uplink`).
The response body stays byte-compatible for older engines and older control
planes in both directions. Local placements never dial: without a cloud
registration there is no uplink client at all.

- **Lifecycle.** The client starts after durable registration
  (`zeros-engine.ts`) with the heartbeat credential as its bearer token and
  stops before the registration stops. `sys.hello` offers the applied
  `authCursor` and, after an unclean loss, the resume token with the
  acknowledged sequence; a `resumed: false` welcome starts a fresh lineage
  and feature modules resync instead.
- **Reconnects.** Every loss that is not terminal redials with full-jitter
  backoff (250 ms base doubling to a 30 s cap, floored at 100 ms so a zero
  jitter draw never spins, reset after 60 s connected). Terminal closes park
  the client without redialing: `4401`/`4403` (credential or identity
  definitively rejected), `4404` (rollout flag off), `4426` (no common
  protocol). `4409` (superseded) first re-verifies registration authority
  through an immediate heartbeat, then redials fresh.
- **Drain.** On `sys.drain` the engine dials a replacement — offering the
  live connection's resume token — before the old uplink's deadline, keeps
  the old one until the replacement is welcomed, and retries a refused or
  lost replacement while the drained uplink is still open.
- **Auth.** `auth.keys`/`auth.sync`/`auth.epochs` drive the frozen S1
  application points on an in-memory state (maximum-merge epochs, unioned
  revocations, latest capability); the shared verifier (track B) binds
  signature checks to that state. `engine_uplink_hello_ms` and
  `engine_uplink_auth_apply_ms` are recorded per connect.
- **Engine token renewal.** `realtime` pushes a fresh `auth.capability` at
  60% of the token's lifetime. `EngineCapabilityAuth`
  (`cloud-capability-auth.ts`) keeps the later-expiring of the tokens it
  holds. When the uplink has been down for 30 s (startup counts as down),
  it asks `api` directly once the held token reaches 80% of its lifetime,
  or at once if it holds none. That request is
  `POST /internal/v2/cloud-workspaces/engine/capability` with the heartbeat
  credential and the registered `bootId`, sent at most once a minute, and
  it stops as soon as the uplink is up again.
- **In-band client renewal.** `handleInBandAuth` handles one text message
  of an admitted client session. A message with a top-level `t` and no
  `type` is a handshake frame. Only `auth.renew` is accepted, it must be
  16 KiB or smaller, and it is validated strictly. A valid renewal swaps
  the session's token and returns an `auth.renewed` reply carrying the new
  `expiresAtMs`. A failed renewal closes the session with its S1 socket
  code; a malformed frame closes it with `4400`. A session that is not
  renewed closes with `capability_expired` at `exp`. Direct `zeros-cap.v1`
  sessions reach this path; relay sessions do not yet (track C5).
- **Direct runtime handshake (S3 Part 3).** `CloudTransport` treats an
  upgrade that offers `zeros-cap.v1` once and carries no bearer (no
  `x-zeros-cloud-token` header, `zeros-cloud-token.*` subprotocol or
  `token` parameter) as a capability upgrade. Until `auth.ok` the socket
  counts as a pending upgrade against `maxConnections`, may send one `auth`
  text frame within the handshake timeout, and is not read past 64 KiB.
  `EngineCapabilityAuth.authenticateRuntimeClient` verifies the capability,
  has `api` admit its actor (below) and opens the verifier session; the
  engine then sends `auth.ok`, and only then does the socket join the
  engine, as the admitted actor, whose lease renews with the returned
  renewal token like a redeemed grant. A handoff fence or shutdown refuses
  sockets still waiting (`1013 runtime_unavailable`, `1001`). An engine
  without a verifier (no advertised uplink) selects `zeros-v1` for an offer
  that names it and closes `1000 legacy`, so the SDK falls back to its
  grant. Sessions the verifier closes (an epoch raise, a revocation or
  `exp`) close with their S1 socket codes.
- **Client admission.**
  `POST /internal/v2/cloud-workspaces/engine/capability-admission`
  (`internal-routes.ts`, `DatabaseCloudWorkspaceActorSessionService.admitCapability`)
  turns a client's `zeros:engine` capability, which the engine verified,
  into an actor session. The engine sends the token, its proof and the route
  it arrived on, with its heartbeat credential. `api` verifies the token
  again (signature, placement, `ws:read`, and proof of possession in a
  replay window of its own), then requires the token's authority epoch,
  access revision, member epoch, account auth revision, device key, source
  session and role to be current. A token issued before a revocation, role
  change or key change is therefore refused even inside its lifetime. The
  session is recorded already consumed, so it can never be redeemed as a
  grant or open a relay. The engine renews it with the returned
  `renewalToken` like a redeemed grant, under the same checks and the same
  limit of 100 live sessions per workspace. An organization with
  `capabilities` off gets `401 cloud_actor_admission_rejected` before any
  SQL; an issuer outage answers `503 capability_issuer_unavailable`. On the
  direct route the engine calls it for every `auth` frame it verified
  (`CloudRuntimeRegistration.admitCapabilityClient`), behind the same
  engine gates as a redeemed grant, and requires the returned account,
  device and role to be the capability's own. A refusal (any 4xx other
  than 408 and 429, or a `200` that fails the response schema) closes
  the socket `4403 capability_revoked`. Anything not answered, there or
  by the engine's own gates, closes it `1013 capability_issuer_unavailable`
  so the client retries. Relay sessions keep the client-admission call
  until the relay route moves onto the uplink (C5).
- **Credential push.** The engine offers `cred.v1`; a pushed `cred.revision`
  runs the same credential-controls exchange the poll runs (coalesced to
  the latest revision per kind while one is in flight) and is answered with
  `cred.ack`. Empty exchanges poll every 5 s while the uplink's gate is
  closed and every 30 s once it is open. An outstanding acknowledgement
  retains its 500 ms handshake cadence (`controlsPollIntervalMs` in
  `cloud-local-command-queue-boot.ts`). Pushes still trigger an immediate
  exchange; none of these cadences extend authority or revocation deadlines.
- **Lease (`lease.v1`).** Registration offers `lease.v1` with
  `exit.report.v1` only when its actual supervisor armed this exact launch.
  A new engine under an old supervisor omits both and keeps HTTP renewal.
  The client
  passes on, through `onLease`, the lease in the current connection's
  welcome (with the hello's send time) and in each pong that echoes one of
  its last four pings (with that ping's send time).
  `CloudRuntimeRegistration.adoptUplinkLease` raises the registration's
  lease to at most that send time + 36 min and never revives a lapsed one.
  While `leaseActive` holds (current connection welcomed, gate open,
  `lease.v1` negotiated), the periodic heartbeat skips a beat that would
  carry nothing (the S2 rule) and still runs the durable-record sync on its
  cadence. A heartbeat response may now carry a lease up to 37 min out;
  the engine stores at most the request's send time + 36 min. A failed beat
  retries every 5 s only in the last 2 min of the lease, and otherwise
  backs off to a 60 s cap. A `4401` or `4403` park asks for an immediate
  heartbeat, so the engine checks its authority over HTTP at once instead
  of on the next beat the long lease would allow.
- **Checkpoint requests (`checkpoint.v1`).** The engine also offers
  `checkpoint.v1`. A `checkpoint.request` on a connection that negotiated
  it is checked against the S2 schema (a lowercase UUID `requestId`, a
  `code`-shaped `reason`, a non-negative safe-integer `deadlineAtMs`;
  anything else closes `4400 frame_invalid`) and asks for an immediate
  heartbeat (`CloudRuntimeRegistration.checkpointRequested`); the frame's
  fields are never used as the directive. While `checkpointPushActive`
  holds (current connection welcomed, gate open, `checkpoint.v1`
  negotiated), the checkpoint-hint wait sends nothing, and the skip rule
  counts the push in place of an answering hint wait only while the last
  successful API heartbeat's monotonic request-start is less than 60 s old.
  The same heartbeat scheduler caps that silence; pongs, lease reports and
  push callbacks cannot reset it. Optional port discovery has a 1 s bound
  and at most one underlying read, with late results discarded. Together
  with the 15 s HTTP bound, a healthy API discovers a request within 76 s
  even when realtime's pool fails. Capture/upload must still finish within
  the request's original deadline. Failure keeps the existing bounded
  heartbeat backoff and lease. The engine declares this behavior with
  `checkpoint.fallback.v1`. Each flip of
  `checkpointPushActive` wakes the paused wait
  (`uplinkCheckpointPushChanged`), and it re-checks every 30 s regardless,
  so the long-poll resumes, with a fresh backoff, as soon as the uplink is
  lost.
- **Idle stop (`idle.v1`).** The engine also offers `idle.v1`. While
  `idleActive` holds (current connection welcomed, gate open, `idle.v1`
  negotiated), `reportActivity` sends `activity.report` when the gate opens,
  every 60 s and on an edge (quiet began or ended, or a quiet window
  restarted), with the counts clamped to the schema. The scheduler keeps
  observing but never initiates (`delegated`). An idle directive delivered
  with no engine idle reservation runs `CloudIdleStopScheduler.delegate`,
  which refuses unless the engine has itself been quiet for 10 min (5 s
  slack) and is not busy; a refused or failed delegated stop cancels the
  request. Once the uplink is gone, the scheduler initiates on its next
  15 s tick.

## Railway configuration (planned)

This repository does not create or change Railway services. The realtime
service, when an operator adds it, uses:

| Setting | Value |
| --- | --- |
| Image and start command | Same as the control-plane service |
| `CONTROL_PLANE_PROCESS_ROLE` | `realtime` |
| `CONTROL_PLANE_DRAIN_SECONDS` | `30` |
| `CLOUD_WORKSPACE_REALTIME_URL` (also set on the `api` service, which advertises) | the service's credential-free public origin, e.g. `https://realtime.example.com` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | at least the drain window plus 15 (`45`), so SIGKILL never cuts the drain short |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | long enough for the replacement to pass `/healthz` before the old instance is signalled |
| `DATABASE_MIGRATIONS_ON_BOOT` | `false`; the API service owns boot migrations |
| Other variables | Shared with the API service (database, auth, cloud configuration) |
| Health check | `/healthz` |
| Replicas | One until relay and uplink routing are instance-aware |

The existing service can adopt `CONTROL_PLANE_DRAIN_SECONDS` and the matching
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` without a role change.
