# S2. VM uplink protocol

Status: **FROZEN** · Contract ID `zeros-uplink` · Version `1.4.0` (additive;
see [Changelog](#changelog)) ·
Schema: [Draft schema: uplink text frames](#draft-schema-uplink-text-frames)

Draft 3 (freeze review): the `auth` and `relay` channels are per-connection
(unsequenced) and never replayed on resume; every connection, resumed or not,
starts with `auth.keys` and `auth.sync`, confirmed by the new `auth.applied`;
cross-instance uplink ownership; relay routing by verified identity only;
uplink teardown on authority loss; `4401` only on a definitive credential
rejection; resume tokens bound to the engine identity. Frozen as 1.0.0 on
2026-10-16 with no further changes.

One outbound WebSocket from each cloud engine to the `realtime` service
carries liveness, readiness, activity, credential-control revisions, epochs
and keys, turn notifications and relayed client sessions. It reduces routine
engine heartbeat POSTs and their per-beat database writes, the 500 ms
credential-control poll, the checkpoint-hint long-poll and the separate
relay socket pairs. Preview and PTY lanes stay on their current relay paths
in v1; they are scoped separately from the engine, control and event lanes
(see the resident outbound VM transport row in
[warm-pool](../warm-pool.md)).

## Purpose and principles

- **Outbound only.** The VM dials out; no inbound port is needed for the CP
  path. Direct client ingress (S3) is unchanged and optional.
- **One socket per engine instance.** A second uplink for the same
  `engineInstanceId` supersedes the first (close `4409`), but only under the
  bootId rule in [Supersede and the heartbeat
  credential](#supersede-and-the-heartbeat-credential).
- **State in memory, durable facts in the database.** Liveness and presence
  live in `realtime` memory; the database is written on transitions only.
- **Secrets never traverse `realtime`.** Frames carry revisions and
  identifiers. The engine fetches secret material (credential controls,
  repository credentials) from `api` with its engine capability (S1).
- **Ordered recovery.** After every (re)connect, resumed or not, the CP sends
  `auth.keys` and `auth.sync` first and nothing but `sys.*` frames until the
  engine confirms with `auth.applied` (S1 outage rule).

## Transport

| Item | Value |
| --- | --- |
| URL | `wss://<realtime-origin>/v1/uplink` (from the registration document, field `uplink.endpoint`, proposed additive) |
| Subprotocol | `Sec-WebSocket-Protocol: zeros-uplink.v1` (and `zeros-uplink.v2` when offered) |
| Authentication | `Authorization: Bearer zwh_…` on the upgrade, the engine's existing heartbeat credential (`apps/desktop/src/engine/cloud-runtime-registration.ts:29`, checked today by `agent-credential-routes.ts:185-208`). Checked **once per connection**, not per frame |
| Control frames | UTF-8 JSON text frames, ≤ 64 KiB |
| Relay data | Binary frames, ≤ 256 KiB each (layout below) |
| Compression | `permessage-deflate` off (CPU and memory predictability on the relay; see [relay capacity](../relay-capacity.md)) |

### Envelope (text frames)

```json
{ "t": "status.ready", "s": 42, "a": 17, "d": { } }
```

| Field | Meaning |
| --- | --- |
| `t` | Frame type, `<channel>.<name>`. Unknown types on an unsequenced channel are ignored; unknown sequenced types are acked and ignored. |
| `s` | Sequence number, present on **reliable** frames only. One monotonically increasing space per direction per connection lineage (survives resume). |
| `a` | Optional cumulative ack: highest contiguous `s` received from the peer. |
| `d` | Payload object, schema per type. |

### Binary relay frame

```
byte 0     version (0x01)
byte 1     kind: 0x01 data, 0x02 data-final (last chunk of a message)
bytes 2-3  flags (bit 0: message is binary on the client socket; else text)
bytes 4-7  relay channel ID (uint32, big-endian, assigned by relay.open)
bytes 8-   payload chunk
```

A client message larger than 256 KiB is split into chunks; the receiver
reassembles up to the existing 64 MiB message ceiling
([relay capacity](../relay-capacity.md)) and closes only that relay channel
(`relay.close`, `message_too_large`) if exceeded.

## Handshake and version negotiation

1. Engine → `sys.hello` (unsequenced):

   ```json
   { "t": "sys.hello", "d": {
       "protocol": { "min": 1, "max": 1 },
       "runtimeVersion": "4.x.y", "workspaceId": "…", "organizationId": "…",
       "generation": 7, "engineInstanceId": "…", "bootId": "…",
       "features": ["relay.v1", "turns.v1", "cap.v1"],
       "lastJournalSeq": 1203,
       "resume": { "token": "…", "lastReceivedSeq": 88 },
       "authCursor": "…" } }
   ```

2. CP verifies the credential, workspace, generation, engine instance and
   `bootId` against durable facts (one read; see the supersede rules below),
   then replies `sys.welcome` (unsequenced) with the chosen `protocol`, the
   intersected `features`, a new `resumeToken`, `resumed: true|false`,
   `pingIntervalMs` (default 20 000), and the lease deadline. A resume token
   is accepted only with the same credential, `engineInstanceId` and `bootId`
   it was issued to; it is a secret and is never logged.
3. CP sends `auth.keys`, then `auth.sync` with a fresh `syncId`, both
   unsequenced. The engine applies both (maximum merge, S1) and replies
   `auth.applied { syncId, authCursor }`. Until that reply, the CP sends only
   `sys.*` frames and the engine admits no new client sessions (direct or
   relay). The `auth` channel is per-connection state, not a log: if the
   connection drops first, the next connection sends a new `auth.sync` from
   the engine's last applied `authCursor`.
4. CP sends a fresh `auth.capability`. If `resumed: true`, both sides then
   retransmit their unacked reliable frames; otherwise both resync (below).
5. Normal traffic.

Version rule: `realtime` supports protocol N and N−1 during a rollout; the
engine sends its `min`/`max`; the CP picks the highest common version or
closes with `4426 protocol_unsupported`. Features are additive flags; neither
side sends a frame type behind a feature the other did not list. A feature
can also change behavior without a new frame type: `lease.v1` moves the
engine lease renewal onto the uplink ([Engine lease](#engine-lease-leasev1)).
`checkpoint.request` is sent only behind `checkpoint.v1`
([Checkpoint requests](#checkpoint-requests-checkpointv1)).

### Supersede and the heartbeat credential

The uplink authenticates with the heartbeat credential (`zwh_…`), which the
engine and agents on the VM can read (one trust domain per workspace; see
[security](../security.md)). A holder of that credential dialing in from
outside the VM must not be able to take over the engine identity, knock the
real engine offline and start receiving `relay.open` client sessions and
`auth.capability` engine tokens. Rules:

1. **Validation happens before any supersede.** A hello that fails any check
   is rejected without touching a live uplink.
2. **Supersede requires the registered `bootId`.** A new uplink supersedes an
   existing one only if `sys.hello.bootId` equals the `bootId` recorded for
   the current registration of that engine instance
   (`cloud_workspace_engine_instances.runtime_boot_id`,
   `apps/control-plane/migrations/0124_cloud_runtime_registry.sql:223`). A
   different `bootId` is accepted only when the CP itself recorded a fresh
   registration carrying it (the normal engine restart path). Otherwise the
   hello is rejected with `4403 uplink_forbidden`. A fresh registration
   requires the single-use setup grant (`zws_…`, consumed once at
   registration, `apps/control-plane/src/cloud-workspaces/setup-materials.ts:1413`
   → `apps/control-plane/src/cloud-workspaces/grants.ts:574`), never the
   heartbeat credential, so holding `zwh_…` alone cannot register a new
   `bootId`.
3. **Alert on bootId mismatch and on supersede churn.** A hello that
   authenticates with a valid credential but carries an unregistered `bootId`
   writes a security event and pages: it means the credential is in use
   somewhere the CP did not boot. More than 3 supersedes of one engine
   instance within 10 min, or a supersede from a different source address
   without an intervening `sys.drain`, also writes a security event: a
   leaked credential plus a leaked `bootId` shows up as a tug-of-war.
4. **The superseded engine re-verifies and reconnects.** On `4409
   uplink_superseded` the engine re-checks its registration authority (the
   existing registration read, then the track B authority cache) and
   reconnects with backoff instead of treating the close as terminal. If its
   registration is still current, its reconnect supersedes back under rule
   2; a hijacker without a registered `bootId` cannot hold the uplink.
5. `relay.open` and `auth.capability` are sent only on the uplink that
   passed rule 2 for the current registration.
6. **One owner across `realtime` instances.** The uplink-connected
   transition write records the owning `realtime` instance and a connection
   ID for the engine instance. An instance that holds an older uplink for the
   same engine instance learns of the new owner through a change
   notification and closes its uplink with `4409`. Relay admissions and
   pushes for a workspace are routed to the owning instance, never served
   from a stale one.
7. **Teardown on authority loss.** When the engine instance stops being
   current (a `wa` bump that retires it, a generation change, deletion, or
   credential revocation), `realtime` closes its uplink with `4403` and stops
   sending `relay.open` and `auth.capability` at once, without waiting for
   the engine to act on the pushed epochs. Each `auth.capability` is issued
   from current authority, not from the state at connect time.

`bootId` is not a secret (an on-VM agent can read it), so rule 2 primarily
stops **off-VM** use of a leaked credential, which is the new exposure S2
would otherwise add. For comparison: today the same credential already
allows reading credential controls and acting on the engine's boot routes
from anywhere (`agent-credential-routes.ts:185-208`), but it cannot receive
client sessions, because the current relay dials out to the VM's provider
endpoint (`runtime-bridge.ts:607-611`) instead of accepting an inbound
engine connection. Delivering client sessions and engine tokens to whoever
holds the uplink is what is new here, and rules 1–5 bound it. A later
contract version can bind the uplink to a VM-attested key instead of a
bearer credential (S2-Q8).

## Channels and frames

Direction: E = engine → CP, C = CP → engine. R = reliable (sequenced, acked,
replayed on resume), U = unsequenced: delivered in order within one
connection, never replayed on resume. The `auth` and `relay` channels are U
by design: `auth` state is re-sent on every connection, and relay channels do
not survive a reconnect.

| Channel | Type | Dir | Rel | Payload (summary) | Replaces |
| --- | --- | --- | --- | --- | --- |
| sys | `sys.hello` / `sys.welcome` | E / C | U | Handshake above | Registration-time lease setup |
| sys | `sys.ping` / `sys.pong` | E / C | U | `{ ts }` every ~20 s; the pong echoes `ts` and carries the current lease deadline `leaseExpiresAtMs` | Heartbeat POST every 10 s, `cloud-runtime-registration.ts:997-1106` (with `lease.v1`, a lease renewal every 5 min) |
| sys | `sys.ack` | both | U | `{ a }` standalone ack when no other frame is due (≤ 250 ms delay) | — |
| sys | `sys.drain` | C | U | `{ reconnectAfterMs, deadlineMs }` (both durations in ms) | — (new: graceful deploys) |
| sys | `sys.error` | both | U | `{ code, message, fatal }` | — |
| auth | `auth.sync` | C | U | `{ syncId, epochs: { wa, wr, members: {userId: me}, accounts: {userId: ac}, devices: {deviceId: dk} }, revocations, authCursor, complete }` for the S1 snapshot scope; `complete: true` marks a full snapshot (sent when the engine's cursor is older than the CP's retention) | — |
| auth | `auth.epochs` | C | U | Delta of the same shape + `authCursor` | Relay 5 s revalidation, client lease renewals |
| auth | `auth.applied` | E | U | `{ syncId, authCursor }` after applying a snapshot (with its `syncId`) or an epochs delta (without); `realtime` records `capability_revocation_push_ms` from it | — |
| auth | `auth.keys` | C | U | JWKS (`next`, `current`, `retiring`); replaces the engine's key set | — |
| auth | `auth.health_request` | E | U | `{ connectionId, syncId, challengeId, authCursor }` only with retained accepted work and `detached.v1` | — |
| auth | `auth.health` | C | U | `{ connectionId, syncId, challengeId, authCursor, healthy }` from a fresh shared authority observation | — |
| auth | `auth.health_lost` | C | U | `{ connectionId, syncId }` on known source failure | — |
| auth | `auth.capability` | C | U | Engine capability (S1) for `zeros:api`; on every connection after `auth.applied`, then at 60% lifetime | Actor-confirm renewal, `cloud-local-command-queue-boot.ts:380-396` |
| status | `status.ready` | E | R | `{ ready, phase, reason? }` on change | Ready inference from heartbeat/registration |
| status | `status.report` | E | R | Coalesced, latest-wins: `observedPorts`, runtime health, engine version | Heartbeat `observedPorts` field |
| activity | `activity.report` | E | R | Every 60 s and on edge: `{ clients, runningTurns, liveTerminals, lastInputAtMs, windowMs }` | Idle timers (track D input) |
| cred | `cred.revision` | C | R | `{ kind: "agent-controls" \| "repository", revision }` | 500 ms poll, `cloud-local-command-queue-boot.ts:323-358` |
| cred | `cred.ack` | E | R | `{ kind, revision, result: "applied" \| "failed", code? }` after fetching from `api` | — |
| checkpoint | `checkpoint.request` | C | R | `{ requestId, reason, deadlineAtMs }` (an absolute timestamp; durations use `…Ms`, timestamps use `…AtMs`), with `checkpoint.v1` only; a timing hint the engine answers with one heartbeat, which delivers the request | Checkpoint-hint long-poll, `checkpointHintLoop` in `cloud-runtime-registration.ts` |
| turns | `turns.event` | E | R | `{ journalSeq, chatId, turnId, state: started \| completed \| failed \| needs_attention \| interrupted, atMs, actorUserId? }` | Notification and presence inference from history mirror |
| turns | `turns.ack` | C | R | `{ journalSeq }` durable on the CP side | — |
| relay | `relay.open` | C | U | `{ channel, clientSessionId, capability, proof }` (the `engine` pair of the client's S3 `auth` frame, forwarded; PoP signed with `route: relay`) | Separate relay socket pair, `runtime-bridge.ts` |
| relay | `relay.accept` / `relay.reject` | E | U | `{ channel }` / `{ channel, code }` after S1 verification | — |
| relay | `relay.credit` | both | U | `{ channel, bytes }` | — |
| relay | `relay.close` | both | U | `{ channel, code, reason }` | — |

### Relay channels and flow control

- `realtime` assigns a `channel` (uint32, unique per uplink) per client
  session. `realtime` first verifies the client's `zeros:realtime`
  capability and proof (S1), then forwards the client's `zeros:engine`
  capability and its proof in `relay.open`. The engine verifies them
  locally (S1) and replies `relay.accept` or `relay.reject`.
- **Routing by verified identity only.** `realtime` selects the uplink from
  the verified `zeros:realtime` capability (`wsp`, `gen`, and `ein` when
  present) and forwards only to an uplink whose authenticated workspace,
  generation and engine instance match. It never routes by a workspace,
  user or chat ID named in an engine payload (`turns.event`,
  `activity.report`): those are data about the uplink's own workspace, and
  notifications built from them go only to accounts with access to that
  workspace.
- **End to end after admission.** `realtime` terminates only the client's
  first `auth` frame (S3), turning it into `relay.open`. After
  `relay.accept`, the engine sends `auth.ok` inside the channel, and every
  later frame, including `auth.renew` and `auth.renewed`, travels inside the
  channel between client and engine, exactly as on the direct route.
  `realtime` does not parse channel data and does not renew its own
  `zeros:realtime` token in band: that token gates admission only. Afterwards
  `realtime` closes the channel on a pushed revocation that affects the
  session, and the engine closes it when its `zeros:engine` token expires
  unrenewed.
- Credit-based flow control per channel and direction: initial window
  1 MiB; the receiver grants more with `relay.credit` once half is consumed.
  A sender with no credit stops reading from its source socket. This keeps a
  slow client from stalling other channels or control frames.
- Control frames (`sys`, `auth`) are never blocked behind relay data: the
  sender drains control frames before relay chunks when both are queued.
- Relay channels do **not** survive an uplink resume. On uplink loss the
  client sessions see their relay closed and reconnect (S3), while direct
  connections are unaffected.

### Reliable delivery, acks and resume

- Each side keeps unacked reliable frames in an outbound buffer bounded to
  2 MiB or 2 000 frames. Overflow closes with `4429 backpressure`; the peer
  reconnects and resumes or resyncs.
- `realtime` keeps the CP-side buffer for 120 s after a disconnect, keyed by
  `resumeToken`, in memory on the instance that owned the uplink. If the
  engine reconnects to another instance (deploy, failover) or after 120 s,
  `sys.welcome.resumed = false` and both sides resync after the `auth`
  exchange of the [handshake](#handshake-and-version-negotiation), which
  happens on every connection:
  - CP sends current `cred.revision` values and, with `checkpoint.v1`,
    a `checkpoint.request` for every queued request (at every gate open,
    resumed or not).
  - Engine re-sends `status.ready`, `status.report`, `activity.report`, and
    `turns.event` from the last `turns.ack` (`lastJournalSeq` in hello).
- Every reliable frame type is idempotent by content (revisions, journal
  sequence, request IDs), so duplicates after resume are harmless. `auth.*`
  and `relay.*` frames are never in a resume buffer, so a resume can neither
  re-deliver a stale engine token nor replay a client's `relay.open` proof.

### Drain

On deploy, `realtime` sends `sys.drain` to each uplink with a randomized
`reconnectAfterMs` (0–10 s) and a `deadlineMs` (30 s). The engine opens a new
uplink (with `resume`) before closing the old one; the new uplink supersedes
the old (`4409`). Relay channels on the draining instance are closed with
`relay.close { code: "draining" }` so clients re-route.

## Liveness, presence and database writes

- Engine sends `sys.ping` every `pingIntervalMs` (20 s). `realtime` marks the
  engine offline after 2 missed intervals plus 5 s (45 s) or immediately on a
  clean close.
- Liveness, readiness and activity are kept in `realtime` memory and served
  to `api` and workers through an in-process view and a small internal read
  endpoint (track C).
- Database writes happen only on transitions: uplink connected, ready
  changed, uplink lost (`cloud_workspace_engine_instances.last_heartbeat_at`
  and lease), plus a coarse watermark at most every 5 min so drift and
  cleanup jobs can still reason about stale engines if `realtime` itself is
  down. This replaces the per-beat `FOR UPDATE` on the workspace row and
  `UPDATE cloud_workspace_engine_instances` at
  `apps/control-plane/src/cloud-workspaces/setup-materials.ts:1536-1599`
  (the update itself is at `setup-materials.ts:1570`).
- Lease: with `lease.v1` the durable lease is renewed when the gate opens
  and on every watermark, and `sys.welcome` and `sys.pong` report it
  ([Engine lease](#engine-lease-leasev1)); without it the HTTP heartbeat
  renews the lease and the uplink only reports what it read. An engine that
  loses the uplink keeps working until the lease deadline (decision G:
  never stop on an unknown error).

### Accepted work push health (`detached.v1`)

The engine offers this feature only after CP acknowledges
`x-zeros-cloud-accepted-work: 1` on the qualified v4 boot registration. CP
persists that support on the exact engine instance; S3 advertises it as
`connect.runtimeBinding.acceptedWorkVersion: 1` only with current boot/writer
and funding authority. Selection requires the organization's `capabilities`,
`realtime_uplink`, `credential_push`, `turn_journal` and `detached_turns`
flags. All remain off by default. The protocol major remains 1; omission
keeps the previous runtime and client behavior.

`sys.welcome` supplies a fresh UUID `connectionId`. With retained accepted
work, the engine sends at most one `auth.health_request` at a time, no more
frequently than every 5 s. Each request has a fresh UUID `challengeId` and
pins the current connection, `syncId`, applied `authCursor` and local auth
revision. The window ends 10 s after the engine's monotonic request start;
receiving a late reply never extends that window. No work means no health
timer or additional source observation.

`realtime` coalesces requests into process-wide observations at most once
per 5 s. Each positive response observes sources after its challenge arrived:
the event feed and committed unpublished backlog, target snapshots and
revocations, keyring and rollout flags must all be current. Auth ACKs must
be complete on the same connection. A request arriving during a read waits
for a newer observation. A hung observation is bounded to 5 s and occupies
its one flight until it actually settles. Known source loss immediately
sends `auth.health_lost`; frames are never replayed after reconnect.

The engine applies positive health in its serialized auth chain, after all
earlier keys/epochs/revocations have been durably applied, and rejects a
changed connection, sync, cursor or revision. Pongs, HTTP API success,
lease renewal and cached auth readiness cannot substitute for this proof.

Only the exact durably accepted owner command can continue after its original
client capability expiry. Known push loss after that expiry ends it
immediately; loss before expiry permits at most the original expiry unless
a fresh current-connection sync/challenge restores authority first. Silent
failure is bounded by the 10 s challenge window. Original finite provider
expiry, engine/writer/funding authority, signing-key removal and S1 revocations
still end the work. Context proofs stay independently bounded to 10 s. No
accepted principal can accept another command, renew a client, mint a generic
grant or revive closed work; ordinary S1 rules are unchanged.

### Engine lease (`lease.v1`)

The engine lease (`cloud_workspace_engine_instances.lease_expires_at`) is
the engine's durable authority deadline. An engine that cannot renew it
gives up its authority when it ends, and engine health stops a workspace
whose ready engine's lease lapsed. Without `lease.v1` only the HTTP
heartbeat renews it, by 90 s every 10 s, so a control-plane or database
outage longer than about 90 s lapses the lease of every healthy engine.
With `lease.v1` the uplink renews a lease long enough for the S1 outage
rule:

- **Negotiation.** The engine offers `lease.v1` and `exit.report.v1` in
  `sys.hello` only when its actual supervisor armed an exit report for this
  exact launch ([Supervisor exit withdrawal](#supervisor-exit-withdrawal-exitreportv1)).
  `realtime` requires both declarations and selects `lease.v1` only while the organization's `engine_lease_over_uplink`
  rollout flag is on (that flag requires `realtime_uplink`). A flag change
  closes the affected uplinks with `1001 features_changed`, and the redial
  renegotiates.
- **Renewal.** A renewal moves the lease to the later of its current value
  and now + 36 min, and records the time as the engine's last heartbeat.
  `realtime` renews once the gate opens (with the first `auth.capability`
  after `auth.applied`) unless more than 31 min remain, as after a drain
  redial, and then on every 5 min watermark. When an outage begins, about
  31 min or more of lease therefore remain, so an outage of up to 30 min
  (the S1 outage rule; the outage drill runs 10 min) lets no lease lapse.
- **Never revived.** A renewal applies only to a lease that has not lapsed,
  under the authority conditions every engine request meets, plus the
  current credential, `bootId`, a `ready` engine instance and no final
  checkpoint. Only a fresh registration creates a lease.
- **Refused or unavailable.** A refused renewal is an authority loss: the
  uplink closes with `4403`. A renewal that cannot complete (database slow
  or down) leaves the uplink open, and the next watermark retries.
- **Report.** `leaseExpiresAtMs` in `sys.welcome` and in every `sys.pong`
  is the latest lease `realtime` knows for the connection, and it never
  moves back. The engine raises its own lease to a reported value only
  from its current connection, only while its own lease has not lapsed,
  and never past 36 min after it sent the frame being answered (the hello,
  or the ping whose `ts` the pong echoes).
- **HTTP heartbeat fallback.** The heartbeat stays and never shortens a
  lease: it moves the lease to the later of its current value and
  now + 90 s. While the current uplink renews the lease (gate open,
  `lease.v1` negotiated), the engine skips a periodic beat that carries
  nothing: no first or changed port scan, no repository credential
  refresh, no redelivered checkpoint request, a checkpoint-hint wait that
  is answering or a `checkpoint.v1` push with an API observation less than
  60 s old in place of it, and more than
  25 min of lease left. A beat requested out of cadence (by a checkpoint
  hint, a pushed `checkpoint.request`, a `4409` re-verification or a
  `4401` or `4403` park) is always sent. When the uplink is lost, the
  periodic beats resume at their normal cadence. A failed beat retries
  every 5 s only in the last 2 min of the lease; earlier it backs off 5,
  10, 20 and 40 s, then retries every 60 s.
- **No shortening on loss.** A lost uplink does not shorten the lease: an
  ingress or network outage looks like many lost uplinks, and decision G
  never stops a workspace on an unknown error. A positively observed child
  exit has a separate withdrawal path. If that supervisor or the API is
  unavailable, existing lease expiry and provider recovery still apply.

### Supervisor exit withdrawal (`exit.report.v1`)

The root supervisor arms a private retry record before launching the engine
and passes a nonsecret `ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64` marker only to
that launch. The engine checks its exact organization, workspace, generation,
instance, setup/enrollment fence, runtime, boot and supervisor session before
offering `lease.v1`. An updated engine under an older supervisor therefore
keeps the HTTP lease, including when talking to an older CP.

The supervisor observes its original child's unexpected `exit`, including
exit code zero and exit before the launch ACK. It reports once and drains
the original kernel workload scope through its serialized retirement path;
it never restarts the engine or replays work. A commanded retirement is marked
immediately before signalling, after custody and preparation checks. A refused
signal leaves reporting armed. A late old-child event cannot drain a successor.

`POST /internal/v1/cloud-workspaces/engine/exited` uses the original engine's
`zwb_…` bridge secret. This is authenticated voluntary withdrawal, not remote
attestation of process death, and grants no new access. The closed JSON body is
`version: 1`, `audience: "zeros-cloud-engine-exit-v1"`,
`reason: "unexpected_exit"`, `reportId`, `organizationId`, `workspaceId`,
`generation`, `engineInstanceId`, `setupRunId`, `executionFence`, `runtimeId`,
`bootId` and `supervisorSessionId`. UUIDs are canonical lowercase. For a runtime
handoff, the existing wire keys `setupRunId` and `executionFence` identify the
original enrollment ID and sequence. The API verifies every stored binding
and the bridge-secret hash under organization → workspace locks. The exact
ACK is `{ version: 1, audience: "zeros-cloud-engine-exit-v1", accepted: true,
reportId, engineInstanceId }`.

An exact historical retry is acknowledged without touching a successor.
An active setup, replacement or runtime transition retains its lifecycle
owner; only the reported engine is revoked. For the current ready engine,
the API admits the existing safe Stop without waiting for lease expiry.
A Stop/Archive waiting for capture keeps its intent and receives an audited
`stop_unsealed` outcome. An uncommitted Delete/Rebuild fails with
`engine_exited` and admits a separate safe source Stop. A committed final
capture, an accepted delete requiring no capture, or an already dispatched
operation keeps its accepted semantics. Neither the report nor Stop admission
proves provider retirement, releases a credit reservation, or authorizes data
purge. No checkpoint is fabricated or restored automatically.

The report endpoint is derived from the trusted HTTPS registration origin;
redirects are refused. A root-owned mode-0600 journal in canonical mode-0700
`/run/zeros` retains at most 16 reports / 64 KiB. It reserves a slot before
advertising support and never evicts an unacknowledged exit to arm a launch.
Requests are single flight, time out after 10 s and retry with jitter up to
30 s. Restart replays only recorded positive exits; an armed record or missing
process memory is not death evidence. An unsafe or full journal withholds
the declaration, preserving the legacy lease.

`exit.report.v1` and `checkpoint.fallback.v1` are prerequisite declarations,
not selected features in `sys.welcome`. Dotted names preserve the original
S2 hello grammar on old CPs. New CPs withhold the corresponding optimization
from old engines. Deployment still requires the API, realtime and actual
supervisor to support this contract before enabling the flags; see
[rollout flags](../rollout-flags.md).

### Checkpoint requests (`checkpoint.v1`)

A checkpoint request (`workspace_checkpoint_requests`) is delivered, fenced
and acknowledged only through the HTTP heartbeat. Without `checkpoint.v1`
the engine learns that one is queued from its checkpoint-hint wait, a 25 s
long-poll that reads the database every 5 s (about 0.24 transactions/s per
running engine). With `checkpoint.v1` `realtime` tells the engine instead:

- **Negotiation.** The engine offers `checkpoint.v1` and
  `checkpoint.fallback.v1` in `sys.hello`. `realtime` requires the fallback
  declaration and selects `checkpoint.v1` only while the organization's `checkpoint_push`
  rollout flag is on (that flag requires `realtime_uplink`). A flag change
  closes the affected uplinks with `1001 features_changed`, and the redial
  renegotiates.
- **Push.** `realtime` sends one `checkpoint.request` for each queued,
  unexpired request of the uplink's exact workspace, organization and
  generation, oldest first and at most eight per read. It reads when the
  gate opens (resumed or not), when a request is queued for that workspace
  generation (`zeros_cloud_checkpoint_request`, the checkpoint-hint
  notification), after its notification listener reconnects, every 5 s
  while that listener is not current, and every 30 s otherwise. One
  statement reads up to 500 uplinks of an instance. A failed read is
  retried on the next 5 s tick, never at once. A request stays queued until
  a heartbeat delivers it, so later reads push it again.
- **Timing only.** The frame grants nothing. The engine answers it with one
  heartbeat, which fetches, fences and acknowledges the request exactly as
  before, so a stale, duplicate or foreign frame costs one beat at most. A
  malformed frame closes the uplink with `4400 frame_invalid`; one on a
  connection that did not negotiate the feature is acked and ignored.
- **Hint wait.** While the current uplink pushes (gate open,
  `checkpoint.v1` negotiated) the engine sends no checkpoint-hint wait. It
  re-checks when the push starts or ends and at least every 30 s, so the
  wait resumes the moment the uplink is lost and its first read sees a
  request queued meanwhile.
- **Independent API watchdog.** While push is active, the heartbeat scheduler
  allows at most 60 s since the monotonic request-start of its last validated
  successful API heartbeat before another API observation is due. An open
  socket, cached pong, lease report or repeated push callback never refreshes
  it. Optional port discovery is bounded to 1 s, retains at most one read in
  flight and discards late results. With a healthy API and its existing 15 s
  HTTP bound, silent-push discovery takes at most 76 s, leaving 224 s of a
  newly queued five-minute capture window. This is a discovery budget, not an
  upload-completion guarantee. API failures retain the heartbeat's bounded
  retry backoff and granted lease; they cannot create a zero-delay retry loop.

### Control-plane idle stop (`idle.v1`)

An engine that offers `idle.v1` sends `activity.report` once the gate opens,
every 60 s and on an edge. `windowMs` is how long the engine has observed no
activity by its own busy rules (capped at 1 h); the counts are admitted
clients with a live presence lease, running turns and terminals with recent
input. `realtime` selects the feature while the organization's
`cp_idle_stop` flag is on. While all three counts are 0 and `windowMs > 0`,
`realtime` treats the engine as quiet since the report's receipt time minus
`windowMs`; 10 min later, on an open uplink, it runs the idle-stop
transaction (authority, engine age, durable work) with the uplink's
credential, which queues an idle checkpoint request delivered as any other.
The engine runs its own idle preparation for that request and cancels it
(`workspace_active`) unless it has itself been quiet for 10 min. Unknown
activity, a lost uplink or an unavailable database never stops a workspace;
a declined or failed request retries after 15 s doubling to 120 s. While
`idle.v1` is active the engine's own idle timer observes but never
initiates; it resumes when the uplink is gone. No frame or schema change.

## Lifetimes and limits

| Item | Value |
| --- | --- |
| Ping interval | 20 s (CP may set 10–30 s) |
| Offline detection | 45 s |
| Resume buffer retention | 120 s |
| Outbound reliable buffer | 2 MiB / 2 000 frames |
| Control frame | ≤ 64 KiB |
| Relay chunk | ≤ 256 KiB; message ≤ 64 MiB |
| Relay initial window | 1 MiB per channel per direction |
| Reconnect backoff (engine) | Full jitter, 250 ms base, 30 s cap; reset after 60 s connected |
| Engine capability | 300 s, pushed at 60% |
| Engine lease (`lease.v1`) | 36 min from each renewal; renewed at gate open (when 31 min or less remain) and every 5 min |

## Error and close codes

| Close | Code string | Meaning | Engine action |
| --- | --- | --- | --- |
| 1000 | `normal` | Clean close | Reconnect only if still running |
| 1001 | `going_away` | Process exit, or `features_changed`: a rollout flag changed the negotiated features | Reconnect with backoff; the redial renegotiates |
| 4400 | `frame_invalid` | Schema or size violation | Report; reconnect with backoff |
| 4401 | `uplink_unauthenticated` | Credential definitively invalid or expired. Sent only when the durable read succeeded and rejected the credential; a verification that could not complete (database slow or down) closes with `1011` instead | Stop reconnecting; existing authority-loss path |
| 1011 | `internal_error` | `realtime` could not complete verification | Reconnect with backoff |
| 4403 | `uplink_forbidden` | Generation, engine instance or `bootId` not current, or a `lease.v1` renewal was refused | Existing authority-loss path; never retry with the same identity |
| 4404 | `uplink_disabled` | Rollout flag off for this organization | Park; the HTTP heartbeat and the credential poll continue; re-dial only after a new registration advertisement carries the endpoint again |
| 4408 | `ping_timeout` | Missed pings | Reconnect |
| 4409 | `uplink_superseded` | A newer uplink with the registered `bootId` took over | Re-verify registration authority, then reconnect with backoff; use the authority-loss path only if the registration is no longer current |
| 4426 | `protocol_unsupported` | No common version | Report; keep running until lease deadline |
| 4429 | `backpressure` | Buffer overflow | Reconnect with resume |
| 4503 | `draining` | Instance draining | Reconnect after `reconnectAfterMs` |

`sys.error` codes for non-fatal errors: `frame_unknown_channel`,
`relay_channel_unknown`, `cred_fetch_failed`, `turn_journal_gap`.

## Failure and outage behavior

| Failure | Behavior |
| --- | --- |
| Uplink down, `api` up | Engine keeps running; direct client sessions continue under S1 normal rules (5 min worst case, renewed in band from REST-issued tokens); after 30 s down the engine obtains engine tokens through the S1 REST fallback, so credential reads, history mirroring and checkpoints keep working; it refetches the JWKS at least every 5 min. With `lease.v1` the periodic HTTP heartbeat resumes at its next tick and keeps the lease from lapsing; with `checkpoint.v1` the checkpoint-hint wait resumes at once |
| `realtime` up, database down | Hellos that cannot be verified close with `1011`, never `4401`/`4403`; established uplinks stay open |
| `realtime` and `api` down (full CP outage) | S1 outage rule: pre-outage sessions up to 30 min; no new sessions; agents keep running until the lease deadline; turn events buffer in the journal. With `lease.v1` about 31 min or more of lease remain when the outage begins, so an outage of up to 30 min lets no lease lapse; without it the lease lapses after about 90 s |
| `realtime` redeploy | Drain, reconnect, resume or resync; relay clients re-route |
| Engine restart (same generation) | New `bootId`, recorded by a fresh registration; resume rejected (`resumed: false`); full resync |
| Superseded uplink (4409) | Re-verify registration, reconnect; a matching `bootId` supersedes back, an alert fires otherwise |
| Engine dies while its VM keeps running | With an armed supervisor and available API, the positive exit withdraws that exact engine and admits safe Stop immediately, or leaves an accepted lifecycle owner in control. Unfinished capture is recorded as unsealed; no restart, restore, billing settlement or purge is inferred. If reporting is unavailable, existing lease expiry remains the fallback (up to 36 min). Uplink loss alone never shortens the lease. |
| Realtime's pool fails while API works | Cached pongs may continue, but do not refresh checkpoint freshness. The independent API watchdog discovers queued capture within the 76 s healthy-API budget, even while the push feature remains active. |
| Database slow or down | `realtime` keeps uplinks and liveness in memory; transition writes retry with jitter through a bounded queue; no uplink is closed because a write failed; a `lease.v1` renewal that cannot complete is retried at the next watermark; a failed `checkpoint.v1` read is retried on the next 5 s tick |

## Code paths this replaces

| Current path | Replacement | Track |
| --- | --- | --- |
| Engine heartbeat timer, `apps/desktop/src/engine/cloud-runtime-registration.ts:997-1106`; default 10 s, `apps/control-plane/src/cloud-workspaces/engine-heartbeat.ts:6-8` | `sys.ping` + `status.report` | C |
| Heartbeat DB writes, `apps/control-plane/src/cloud-workspaces/setup-materials.ts:1536-1599` | Transition writes + 5 min watermark | C |
| Credential-control poll every 500 ms, `apps/desktop/src/engine/cloud-local-command-queue-boot.ts:323-358`; endpoint `agent-credential-routes.ts:203` | `cred.revision` push, fetch, `cred.ack` | C |
| Checkpoint-hint long-poll (25 s hold), `checkpointHintLoop` in `cloud-runtime-registration.ts` | `checkpoint.request` (`checkpoint.v1`) | C |
| Relay socket pairs and revalidation, `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts:351,753-794` | Relay channels over the uplink | C |
| Actor-confirm and warm-context renewals, `cloud-local-command-queue-boot.ts:380-435` | `auth.capability` | B, C |

## Local impact

None. The uplink client is a cloud-only engine module started only when the
engine boots in cloud mode from `ZEROS_CLOUD_RUNTIME_B64`
(`apps/desktop/src/engine/cloud-runtime-registration.ts:24,370`). The Local
engine on the Mac never dials `realtime`, and `pnpm electron:local` cannot
obtain a registration document (`scripts/electron-local.mjs:54-82`).

## Open questions

| # | Question | Recommendation | Answer (freeze review) |
| --- | --- | --- | --- |
| S2-Q1 | JSON for everything, or a binary encoding for control frames? | JSON text for control (debuggable, schema-validated, low rate); binary only for relay data. | Accepted. |
| S2-Q2 | One sequence space per direction, or per channel? | One per direction; channels are few and ordering across `auth` and other frames matters for recovery. | Accepted, for the reliable channels only. `auth` and `relay` are unsequenced per-connection channels; `auth` ordering is enforced by the `auth.applied` gate, which a cumulative ack could not do across a resume gap. |
| S2-Q3 | Resume across `realtime` instances (shared buffer in Redis or the DB)? | No in v1: resync is cheap and fully idempotent. Revisit if resync load shows up in measurements. | Accepted. |
| S2-Q4 | Keep the HTTP heartbeat as a fallback during rollout? | Yes, behind the per-org flag, for one release; the engine uses it only when `sys.welcome` was never received. Delete it at the end of the slice. | Accepted. Amended in 1.2.0: the heartbeat stays as the fallback lease renewal and for what only it carries today (port scans, repository credential refreshes, checkpoint request delivery); with `lease.v1` the engine skips a periodic beat that carries nothing ([Engine lease](#engine-lease-leasev1)), and with `checkpoint.v1` a pushed `checkpoint.request` asks for the beat that delivers it. |
| S2-Q5 | Should repository credentials move from the heartbeat response to the uplink? | Revision over the uplink, secret fetched from `api` with the engine token; secrets never pass through `realtime`. | Accepted. |
| S2-Q6 | Watermark write interval | 5 min; drift jobs already tolerate minutes. | Accepted. |
| S2-Q7 | Permessage-deflate | Off in v1; measure relay CPU first. | Accepted. |
| S2-Q8 | Bind the uplink to a VM-attested key instead of the bearer heartbeat credential? | Later. v1 keeps the existing credential plus the bootId rules; an attested key needs provider support work that is not on the critical path. | Accepted, with the supersede-churn alert (rule 3) as the v1 detection for a leaked credential plus `bootId`. |
| S2-Q9 | Preview and PTY lanes on the uplink? | Not in v1; they keep their current relay paths ([warm-pool](../warm-pool.md) scopes them separately). | Accepted. |

## Draft schema: uplink text frames

JSON Schema 2020-12 for every uplink text frame. Binary relay chunks are
specified in [Binary relay frame](#binary-relay-frame). This sketch is a
review aid until freeze; the frozen source of truth will be Zod in
`packages/protocol`.

<!-- contract-schema: s2-uplink-frames (json) -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://zeros.dev/schemas/cloud-contracts/s2-uplink-frames.schema.json",
  "title": "Zeros VM uplink (S2) text frames",
  "description": "FROZEN 1.0.0. Reference sketch of uplink JSON text frames. Binary relay chunks are specified in s2-uplink.md. Receivers ignore unknown payload fields; frame types outside this list are handled by the unknown-type rule in s2-uplink.md.",
  "oneOf": [
    { "$ref": "#/$defs/sys.hello" },
    { "$ref": "#/$defs/sys.welcome" },
    { "$ref": "#/$defs/sys.ping" },
    { "$ref": "#/$defs/sys.pong" },
    { "$ref": "#/$defs/sys.ack" },
    { "$ref": "#/$defs/sys.drain" },
    { "$ref": "#/$defs/sys.error" },
    { "$ref": "#/$defs/auth.sync" },
    { "$ref": "#/$defs/auth.epochs" },
    { "$ref": "#/$defs/auth.applied" },
    { "$ref": "#/$defs/auth.health_request" },
    { "$ref": "#/$defs/auth.health" },
    { "$ref": "#/$defs/auth.health_lost" },
    { "$ref": "#/$defs/auth.keys" },
    { "$ref": "#/$defs/auth.capability" },
    { "$ref": "#/$defs/status.ready" },
    { "$ref": "#/$defs/status.report" },
    { "$ref": "#/$defs/activity.report" },
    { "$ref": "#/$defs/cred.revision" },
    { "$ref": "#/$defs/cred.ack" },
    { "$ref": "#/$defs/checkpoint.request" },
    { "$ref": "#/$defs/turns.event" },
    { "$ref": "#/$defs/turns.ack" },
    { "$ref": "#/$defs/relay.open" },
    { "$ref": "#/$defs/relay.accept" },
    { "$ref": "#/$defs/relay.reject" },
    { "$ref": "#/$defs/relay.credit" },
    { "$ref": "#/$defs/relay.close" }
  ],
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "seq": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "epoch": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
    "timestampMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "cursor": { "type": "string", "minLength": 1, "maxLength": 256 },
    "code": { "type": "string", "pattern": "^[a-z][a-z0-9_]{2,63}$" },
    "channel": { "type": "integer", "minimum": 1, "maximum": 4294967295 },
    "versionRange": {
      "type": "object",
      "required": ["min", "max"],
      "properties": {
        "min": { "type": "integer", "minimum": 1 },
        "max": { "type": "integer", "minimum": 1 }
      }
    },
    "unreliable": {
      "type": "object",
      "required": ["t", "d"],
      "not": { "required": ["s"] },
      "properties": { "a": { "$ref": "#/$defs/seq" } }
    },
    "reliable": {
      "type": "object",
      "required": ["t", "s", "d"],
      "properties": { "s": { "$ref": "#/$defs/seq" }, "a": { "$ref": "#/$defs/seq" } }
    },
    "epochSet": {
      "type": "object",
      "properties": {
        "wa": { "$ref": "#/$defs/epoch" },
        "wr": { "$ref": "#/$defs/epoch" },
        "members": { "type": "object", "maxProperties": 10000, "additionalProperties": { "$ref": "#/$defs/epoch" } },
        "accounts": { "type": "object", "maxProperties": 10000, "additionalProperties": { "$ref": "#/$defs/epoch" } },
        "devices": { "type": "object", "maxProperties": 10000, "additionalProperties": { "$ref": "#/$defs/epoch" } }
      }
    },
    "revocations": {
      "type": "array",
      "maxItems": 10000,
      "items": {
        "type": "object",
        "required": ["kind", "id", "until"],
        "properties": {
          "kind": { "enum": ["session", "device"] },
          "id": { "$ref": "#/$defs/uuid" },
          "until": { "$ref": "#/$defs/timestampMs" }
        }
      }
    },
    "jwk": {
      "type": "object",
      "required": ["kty", "crv", "x", "kid", "use", "alg"],
      "properties": {
        "kty": { "const": "OKP" },
        "crv": { "const": "Ed25519" },
        "x": { "type": "string", "pattern": "^[A-Za-z0-9_-]{43}$" },
        "kid": { "type": "string", "maxLength": 64 },
        "use": { "const": "sig" },
        "alg": { "const": "EdDSA" },
        "zeros_state": { "enum": ["next", "current", "retiring"] }
      }
    },
    "sys.hello": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "sys.hello" },
        "d": {
          "type": "object",
          "required": ["protocol", "runtimeVersion", "workspaceId", "organizationId", "generation", "engineInstanceId", "bootId", "features", "lastJournalSeq"],
          "properties": {
            "protocol": { "$ref": "#/$defs/versionRange" },
            "runtimeVersion": { "type": "string", "minLength": 1, "maxLength": 64 },
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "organizationId": { "$ref": "#/$defs/uuid" },
            "generation": { "type": "integer", "minimum": 1 },
            "engineInstanceId": { "$ref": "#/$defs/uuid" },
            "bootId": { "$ref": "#/$defs/uuid" },
            "features": { "type": "array", "maxItems": 64, "uniqueItems": true, "items": { "type": "string", "pattern": "^[a-z][a-z0-9.]{1,47}$" } },
            "lastJournalSeq": { "$ref": "#/$defs/seq" },
            "resume": {
              "type": "object",
              "required": ["token", "lastReceivedSeq"],
              "properties": {
                "token": { "type": "string", "minLength": 16, "maxLength": 512 },
                "lastReceivedSeq": { "$ref": "#/$defs/seq" }
              }
            },
            "authCursor": { "$ref": "#/$defs/cursor" }
          }
        }
      }
    },
    "sys.welcome": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "sys.welcome" },
        "d": {
          "type": "object",
          "required": ["protocol", "features", "resumeToken", "resumed", "pingIntervalMs", "leaseExpiresAtMs"],
          "properties": {
            "protocol": { "type": "integer", "minimum": 1 },
            "connectionId": { "$ref": "#/$defs/uuid" },
            "features": { "type": "array", "maxItems": 64, "uniqueItems": true, "items": { "type": "string" } },
            "resumeToken": { "type": "string", "minLength": 16, "maxLength": 512 },
            "resumed": { "type": "boolean" },
            "pingIntervalMs": { "type": "integer", "minimum": 10000, "maximum": 30000 },
            "leaseExpiresAtMs": { "$ref": "#/$defs/timestampMs" }
          }
        }
      }
    },
    "sys.ping": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": { "t": { "const": "sys.ping" }, "d": { "type": "object", "required": ["ts"], "properties": { "ts": { "$ref": "#/$defs/timestampMs" } } } }
    },
    "sys.pong": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "sys.pong" },
        "d": { "type": "object", "required": ["ts"], "properties": { "ts": { "$ref": "#/$defs/timestampMs" }, "leaseExpiresAtMs": { "$ref": "#/$defs/timestampMs" } } }
      }
    },
    "sys.ack": {
      "type": "object",
      "required": ["t", "a"],
      "not": { "required": ["s"] },
      "properties": { "t": { "const": "sys.ack" }, "a": { "$ref": "#/$defs/seq" }, "d": { "type": "object", "maxProperties": 0 } }
    },
    "sys.drain": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "sys.drain" },
        "d": {
          "type": "object",
          "required": ["reconnectAfterMs", "deadlineMs"],
          "properties": {
            "reconnectAfterMs": { "type": "integer", "minimum": 0, "maximum": 60000 },
            "deadlineMs": { "type": "integer", "minimum": 1000, "maximum": 120000 }
          }
        }
      }
    },
    "sys.error": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "sys.error" },
        "d": {
          "type": "object",
          "required": ["code", "message", "fatal"],
          "properties": {
            "code": { "$ref": "#/$defs/code" },
            "message": { "type": "string", "maxLength": 512 },
            "fatal": { "type": "boolean" }
          }
        }
      }
    },
    "auth.sync": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "auth.sync" },
        "d": {
          "type": "object",
          "required": ["syncId", "epochs", "revocations", "authCursor", "complete"],
          "properties": {
            "syncId": { "$ref": "#/$defs/uuid" },
            "epochs": { "allOf": [{ "$ref": "#/$defs/epochSet" }], "required": ["wa", "wr"] },
            "revocations": { "$ref": "#/$defs/revocations" },
            "authCursor": { "$ref": "#/$defs/cursor" },
            "complete": { "type": "boolean", "description": "True when this is a full snapshot rather than a delta since the engine's authCursor." }
          }
        }
      }
    },
    "auth.epochs": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "auth.epochs" },
        "d": {
          "type": "object",
          "required": ["epochs", "revocations", "authCursor"],
          "properties": {
            "epochs": { "$ref": "#/$defs/epochSet" },
            "revocations": { "$ref": "#/$defs/revocations" },
            "authCursor": { "$ref": "#/$defs/cursor" }
          }
        }
      }
    },
    "auth.health_request": {
      "allOf": [
        {
          "$ref": "#/$defs/unreliable"
        }
      ],
      "properties": {
        "t": {
          "const": "auth.health_request"
        },
        "d": {
          "type": "object",
          "required": [
            "connectionId",
            "syncId",
            "challengeId",
            "authCursor"
          ],
          "properties": {
            "connectionId": {
              "$ref": "#/$defs/uuid"
            },
            "syncId": {
              "$ref": "#/$defs/uuid"
            },
            "challengeId": {
              "$ref": "#/$defs/uuid"
            },
            "authCursor": {
              "$ref": "#/$defs/cursor"
            }
          }
        }
      }
    },
    "auth.health": {
      "allOf": [
        {
          "$ref": "#/$defs/unreliable"
        }
      ],
      "properties": {
        "t": {
          "const": "auth.health"
        },
        "d": {
          "type": "object",
          "required": [
            "connectionId",
            "syncId",
            "challengeId",
            "authCursor",
            "healthy"
          ],
          "properties": {
            "connectionId": {
              "$ref": "#/$defs/uuid"
            },
            "syncId": {
              "$ref": "#/$defs/uuid"
            },
            "challengeId": {
              "$ref": "#/$defs/uuid"
            },
            "authCursor": {
              "$ref": "#/$defs/cursor"
            },
            "healthy": {
              "type": "boolean"
            }
          }
        }
      }
    },
    "auth.health_lost": {
      "allOf": [
        {
          "$ref": "#/$defs/unreliable"
        }
      ],
      "properties": {
        "t": {
          "const": "auth.health_lost"
        },
        "d": {
          "type": "object",
          "required": [
            "connectionId",
            "syncId"
          ],
          "properties": {
            "connectionId": {
              "$ref": "#/$defs/uuid"
            },
            "syncId": {
              "$ref": "#/$defs/uuid"
            }
          }
        }
      }
    },
    "auth.applied": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "auth.applied" },
        "d": {
          "type": "object",
          "required": ["authCursor"],
          "properties": {
            "syncId": { "$ref": "#/$defs/uuid", "description": "Present when confirming an auth.sync; absent when confirming an auth.epochs delta." },
            "authCursor": { "$ref": "#/$defs/cursor" }
          }
        }
      }
    },
    "auth.keys": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "auth.keys" },
        "d": {
          "type": "object",
          "required": ["keys"],
          "properties": { "keys": { "type": "array", "minItems": 1, "maxItems": 3, "items": { "$ref": "#/$defs/jwk" } } }
        }
      }
    },
    "auth.capability": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "auth.capability" },
        "d": {
          "type": "object",
          "required": ["audience", "token", "expiresAtMs"],
          "properties": {
            "audience": { "const": "zeros:api" },
            "token": { "type": "string", "minLength": 32, "maxLength": 4096, "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" },
            "expiresAtMs": { "$ref": "#/$defs/timestampMs" }
          }
        }
      }
    },
    "status.ready": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "status.ready" },
        "d": {
          "type": "object",
          "required": ["ready", "phase"],
          "properties": {
            "ready": { "type": "boolean" },
            "phase": { "enum": ["starting", "preparing", "ready", "degraded", "stopping"] },
            "reason": { "$ref": "#/$defs/code" }
          }
        }
      }
    },
    "status.report": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "status.report" },
        "d": {
          "type": "object",
          "required": ["engineVersion"],
          "properties": {
            "engineVersion": { "type": "string", "maxLength": 64 },
            "health": { "enum": ["ok", "degraded"] },
            "observedPorts": {
              "type": "array",
              "maxItems": 256,
              "items": {
                "type": "object",
                "required": ["port"],
                "properties": { "port": { "type": "integer", "minimum": 1, "maximum": 65535 }, "protocol": { "enum": ["http", "tcp"] } }
              }
            }
          }
        }
      }
    },
    "activity.report": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "activity.report" },
        "d": {
          "type": "object",
          "required": ["clients", "runningTurns", "liveTerminals", "windowMs"],
          "properties": {
            "clients": { "type": "integer", "minimum": 0, "maximum": 10000 },
            "runningTurns": { "type": "integer", "minimum": 0, "maximum": 10000 },
            "liveTerminals": { "type": "integer", "minimum": 0, "maximum": 10000 },
            "lastInputAtMs": { "$ref": "#/$defs/timestampMs" },
            "windowMs": { "type": "integer", "minimum": 0, "maximum": 3600000 }
          }
        }
      }
    },
    "cred.revision": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "cred.revision" },
        "d": {
          "type": "object",
          "required": ["kind", "revision"],
          "properties": { "kind": { "enum": ["agent-controls", "repository"] }, "revision": { "$ref": "#/$defs/seq" } }
        }
      }
    },
    "cred.ack": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "cred.ack" },
        "d": {
          "type": "object",
          "required": ["kind", "revision", "result"],
          "properties": {
            "kind": { "enum": ["agent-controls", "repository"] },
            "revision": { "$ref": "#/$defs/seq" },
            "result": { "enum": ["applied", "failed"] },
            "code": { "$ref": "#/$defs/code" }
          }
        }
      }
    },
    "checkpoint.request": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "checkpoint.request" },
        "d": {
          "type": "object",
          "required": ["requestId", "reason", "deadlineAtMs"],
          "properties": {
            "requestId": { "$ref": "#/$defs/uuid" },
            "reason": { "$ref": "#/$defs/code" },
            "deadlineAtMs": { "$ref": "#/$defs/timestampMs" }
          }
        }
      }
    },
    "turns.event": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "turns.event" },
        "d": {
          "type": "object",
          "required": ["journalSeq", "chatId", "turnId", "state", "atMs"],
          "properties": {
            "journalSeq": { "$ref": "#/$defs/seq" },
            "chatId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
            "turnId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
            "state": { "enum": ["started", "completed", "failed", "needs_attention", "interrupted"] },
            "actorUserId": { "$ref": "#/$defs/uuid" },
            "atMs": { "$ref": "#/$defs/timestampMs" }
          }
        }
      }
    },
    "turns.ack": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "turns.ack" },
        "d": { "type": "object", "required": ["journalSeq"], "properties": { "journalSeq": { "$ref": "#/$defs/seq" } } }
      }
    },
    "relay.open": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "relay.open" },
        "d": {
          "type": "object",
          "required": ["channel", "clientSessionId", "capability", "proof"],
          "properties": {
            "channel": { "$ref": "#/$defs/channel" },
            "clientSessionId": { "$ref": "#/$defs/uuid" },
            "capability": { "type": "string", "minLength": 32, "maxLength": 4096 },
            "proof": {
              "type": "object",
              "required": ["timestampMs", "nonce", "signature"],
              "properties": {
                "timestampMs": { "$ref": "#/$defs/timestampMs" },
                "nonce": { "type": "string", "pattern": "^[A-Za-z0-9_-]{22}$" },
                "signature": { "type": "string", "pattern": "^[A-Za-z0-9_-]{86}$" }
              }
            }
          }
        }
      }
    },
    "relay.accept": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "relay.accept" },
        "d": { "type": "object", "required": ["channel"], "properties": { "channel": { "$ref": "#/$defs/channel" } } }
      }
    },
    "relay.reject": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "relay.reject" },
        "d": { "type": "object", "required": ["channel", "code"], "properties": { "channel": { "$ref": "#/$defs/channel" }, "code": { "$ref": "#/$defs/code" } } }
      }
    },
    "relay.credit": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "relay.credit" },
        "d": {
          "type": "object",
          "required": ["channel", "bytes"],
          "properties": { "channel": { "$ref": "#/$defs/channel" }, "bytes": { "type": "integer", "minimum": 1, "maximum": 67108864 } }
        }
      }
    },
    "relay.close": {
      "allOf": [{ "$ref": "#/$defs/unreliable" }],
      "properties": {
        "t": { "const": "relay.close" },
        "d": {
          "type": "object",
          "required": ["channel", "code"],
          "properties": {
            "channel": { "$ref": "#/$defs/channel" },
            "code": { "$ref": "#/$defs/code" },
            "reason": { "type": "string", "maxLength": 256 }
          }
        }
      }
    }
  },
  "examples": [
    { "t": "sys.ping", "d": { "ts": 1792000000000 } },
    { "t": "sys.pong", "d": { "ts": 1792000000000, "leaseExpiresAtMs": 1792002160000 } },
    { "t": "auth.epochs", "a": 4, "d": { "epochs": { "members": { "11111111-1111-4111-8111-111111111111": 6 } }, "revocations": [], "authCursor": "c-1042" } },
    { "t": "auth.applied", "d": { "syncId": "88888888-8888-4888-8888-888888888888", "authCursor": "c-1042" } },
    { "t": "cred.revision", "s": 10, "d": { "kind": "agent-controls", "revision": 31 } },
    { "t": "relay.credit", "d": { "channel": 3, "bytes": 524288 } }
  ]
}
```

## Changelog

- **1.4.0** (2026-10-18, additive): add qualified `detached.v1`, per-connection
  challenged authority health and optional welcome `connectionId`. Only exact
  accepted owner work can outlive its original client token under current
  push authority. Provider and context deadlines remain independent; S1 and
  protocol major 1 are unchanged.

- **1.3.0** (2026-10-18, additive): require `exit.report.v1` before granting
  `lease.v1`, with exact supervisor exit withdrawal through the API; require
  `checkpoint.fallback.v1` before granting `checkpoint.v1`, with a 60 s
  independent API heartbeat watchdog. Old engines and old supervisors retain
  their legacy paths. Both rollout flags remain off pending qualification.
- **1.2.0** (2026-10-18, additive): added the `lease.v1` feature
  ([Engine lease](#engine-lease-leasev1)). Negotiated only while the
  organization's `engine_lease_over_uplink` flag is on, it has `realtime`
  renew the durable engine lease to 36 min when the gate opens and on every
  5 min watermark. A refused renewal closes `4403`, an unavailable one
  keeps the uplink open, and a lapsed lease is never revived. The HTTP
  heartbeat never shortens a lease, and the engine skips periodic beats
  that carry nothing, so a control-plane outage of up to 30 min lets no
  lease lapse. No frame or schema change: `sys.welcome` and `sys.pong`
  already carried `leaseExpiresAtMs`. Also recorded that `1001` carries
  `features_changed` when a rollout flag changes the negotiated features.
  Also added the `checkpoint.v1` feature
  ([Checkpoint requests](#checkpoint-requests-checkpointv1)). Negotiated
  only while the organization's `checkpoint_push` flag is on, it has
  `realtime` push every queued, unexpired checkpoint request of the
  engine's exact workspace and generation as `checkpoint.request` (a timing
  hint: delivery stays on the heartbeat), and the engine pauses its
  checkpoint-hint wait while the push is active. No schema change: the
  frame was already defined; it is now sent only behind `checkpoint.v1`.
  Also added the `idle.v1` feature
  ([Control-plane idle stop](#control-plane-idle-stop-idlev1)), negotiated
  while `cp_idle_stop` is on: `realtime` requests the idle stop from
  `activity.report`, and the engine still proves idleness.
  Also added the `turns.v1` feature (rollout flag `turn_journal`): the
  journal is one contiguous sequence per engine instance and boot, numbered
  from 1; a new writer renumbers its predecessor's unacknowledged entries.
  `turns.ack` is cumulative. `sys.error turn_journal_gap` carries
  `expectedJournalSeq`; the engine resends from it, and resends from its ack
  after 60 s without ack progress. `lastJournalSeq` is the engine's persisted
  ack (informational).
- **1.1.0** (2026-10-16, additive): added close `4404 uplink_disabled` —
  the rollout flag is off for the organization; the engine parks, the HTTP
  heartbeat and the credential poll continue, and the engine re-dials only
  after a new registration advertisement carries the endpoint again. Also
  recorded that `sys.error` may carry a `channel` hint, which the frozen
  unknown-field rule (receivers ignore unknown payload fields) already
  permits.
