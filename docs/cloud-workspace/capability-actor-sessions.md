# Capability actor sessions

The control plane supports an opt-in `capability-session-v1` admission and
renewal boundary. This delivery ships disabled and changes no engine or client
timers. Enable it only after every CP reader and the exact qualified runtime
support the mode. Local Personal and organization-local paths are unchanged.

## Authority and compatibility

Migration 0165 adds `session_kind` to `cloud_workspace_actor_sessions`; existing
rows default to `legacy` with their bearer and 30-second renewal requirement.
Capability rows are born consumed, have no bearer hash, and expire at exactly
the accepted S1 token's signed `exp`. Their legacy auth fields are null and a
separate FK binds the source auth UUID. Frozen N-1 current, recorded and detached
SQL readers therefore refuse these rows even immediately after admission.

The immutable binding includes organization, workspace, generation, engine,
account, source session, device/key, role, scopes, epochs, fingerprint and route.
The original claims are stored without token bytes or PoP signatures. A renewal
may advance issuance time, JTI, expiry, signing key and revision; it cannot
transfer authority. The SQL trigger prevents kind changes, binding changes,
expiry rollback and resurrection of a revoked actor session.

All current-session readers use `cloud_workspace_actor_session_source_live`.
Capability rows require the operation's exact S1 scope, current source auth,
trusted device/key, role/fingerprint, epoch equality, live signing key, engine,
generation and strict signed expiry. Read maps to `ws:read`, run to `ws:prompt`,
edit to `ws:edit`, and manage/credentials/delete to `ws:manage`. A read-only owner
cannot obtain run funding through actor confirmation. Source/key revocation
still fences recorded work; ordinary socket release and interactive expiry
retain the existing independent rules for accepted work. Detached/context
confirmations keep their at-most-10-second bound.

Legacy consume and grant-relay routes accept only legacy rows. Every live socket
counts toward the existing 100-session workspace limit, including capability
rows whose diagnostic `last_renewed_at` is older than 30 seconds. Admission
shares a workspace capacity fence; renewals serialize only their session row.

## HTTP boundary

The new internal POST routes are
`/internal/v2/cloud-workspaces/engine/capability-session-admission` and
`/internal/v2/cloud-workspaces/engine/capability-session-renewal`.
The separate strict contracts are mirrored in `packages/protocol` and CP.
The old `capability-admission` route and its required `renewalToken` stay intact.

Both requests carry explicit version/mode, exact engine placement, heartbeat
bearer, the client's `zeros:engine` token and its device PoP for `direct` or
`relay`. CP independently verifies S1 and consumes the nonce. Renewal adds the
actor session UUID and expected revision. In one transaction CP authenticates
the engine and supported generation, checks the active boot/writer when present,
locks the source and the old/new signing keys, and rechecks committed authority.
The key-lock function exposes only a boolean for at most two keys; it grants no
key writes or sealed material to the application.

The response contains the committed claims, signing key ID, token SHA-256 and
revision, never a new bearer. A fresh-PoP retry of the same committed token
returns the same expiry/revision; the previous expected revision is accepted
only for that lost-ACK case. Reusing the PoP is refused. Different tokens need
the current revision and a strictly later expiry. Recovery after an expired
interactive token requires a fresh full proof with the original binding and
live source/key; expired tokens and positively revoked rows cannot renew.

Commit precedes the success response. A request has a five-second observation
bound, capped by signed expiry, checked against wall and monotonic time after
I/O. Abort or flag loss cannot deliver a successful late response. The future
engine delivery must additionally fence its local registration, boot, lifetime,
epochs and disconnect before installing the returned state or ACKing in band;
the CP response is not permission to resurrect an aborted principal/context.
That delivery also owns unused-handshake release and removal of legacy timers.

## Rollout

`capability_actor_sessions` defaults off and requires `capabilities`,
`runtime_connect` and `realtime_uplink` for the same organization. Its memory
snapshot reads off while the flag feed is unavailable. Disabling it refuses
admissions, renewals and current-session CP use; it does not manufacture a
legacy bearer or extend a context. A future engine may reconnect into a new
legacy session and must honor its existing signed deadline in the meantime.

This migration lands after build handoff 0163 and finite provider proof 0164.
Engine/SDK activation, R3 owner confirmation removal, accepted-work continuation
and warm-context timer removal are separate deliveries. No database load saving
or runtime qualification is claimed by this CP-only foundation.
