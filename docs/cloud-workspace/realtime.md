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

`apps/control-plane/src/realtime/uplink-server.ts` implements the frozen S2
contract (`contracts/s2-uplink.md`, 1.0.0) at `/v1/uplink`. It is mounted
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
- **Admission.** One consistent authority read
  (`readCurrentCloudEngineAuthority`) checks the heartbeat credential,
  workspace, generation and engine instance, and compares the hello's
  `bootId` with `cloud_workspace_engine_instances.runtime_boot_id`. Close
  codes: `4401` only when the read succeeded and no engine holds the
  credential; `4403` for a stale engine or an unregistered `bootId`;
  `1011` when the read could not complete.
- **Handshake.** `sys.welcome`, then `auth.keys` and `auth.sync` with a fresh
  `syncId`. Until the engine's `auth.applied` the server sends only `sys.*`
  frames; reliable frames queued meanwhile are held. It then sends an
  `auth.capability` issued by `api` from current authority, retransmits
  unacknowledged reliable frames on a resume, and lets feature modules
  resync. Epoch deltas confirmed by `auth.applied` record
  `capability_revocation_push_ms`.
- **Teardown.** Authority is re-read every 60 s and at once on a
  `zeros_cloud_engine_uplink_authority` notification (engine state,
  revocation, credential or final checkpoint changes; workspace generation,
  desired state, deletion, status liveness or authority epoch changes). A
  loss closes with `4403`. An unavailable database never closes an
  established uplink.
- **Ownership.** Presence lives in memory. `cloud_workspace_engine_uplinks`
  (migration 0151) is written only on connect, readiness change and loss,
  plus a 5 min watermark, through a bounded coalescing retry queue. Each
  write carries a connection ID; a connect never overwrites a newer one.
  "Newer" is a deterministic order on unsynchronized replica clocks: the
  later `connected_at` wins, and a same-millisecond tie (or skew within the
  connect gap) breaks by connection ID, in both the in-memory owner rule
  and the presence upsert fence. A new owner row notifies
  `zeros_cloud_engine_uplink_owner`, and an instance holding an older
  uplink closes it with `4409`. After a listener reconnect every owned
  uplink re-reads its owner and authority.
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
  the engine's 500 ms credential-control poll while the uplink is up
  (P0.10 C01). At the gate it pushes the boot binding's current desired
  revision (the contract's resync rule), and a trigger on
  `cloud_agent_boot_bindings.desired_cache_revision` (migration 0154)
  notifies every bump, routed to the owning instance over
  `zeros_cloud_agent_credential_revision`. The notification is only a hint:
  the engine's exchange re-reads authority. `cred.ack` (`applied`/`failed`)
  arrives over the reliable channel; a lost notification while the listener
  was down is repaired at the next gate open.
- **Lease.** The HTTP heartbeat still owns the engine lease in this release;
  the uplink reports the lease it read in `sys.welcome` and `sys.pong`.

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
- **Credential push.** The engine offers `cred.v1`; a pushed `cred.revision`
  runs the same credential-controls exchange the poll runs (coalesced to
  the latest revision per kind while one is in flight) and is answered with
  `cred.ack`. The poll stays as the fallback: 500 ms while the uplink's
  gate is closed, a 30 s safety cadence once it is open
  (`controlsPollIntervalMs` in `cloud-local-command-queue-boot.ts`).

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
