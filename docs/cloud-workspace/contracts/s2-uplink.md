# S2. VM uplink protocol

Status: **DRAFT** · Contract ID `zeros-uplink` · Version `1.0.0-draft.1` ·
Schema: [Draft schema: uplink text frames](#draft-schema-uplink-text-frames)

One outbound WebSocket from each cloud engine to the `realtime` service
carries liveness, readiness, activity, credential-control revisions, epochs
and keys, turn notifications and relayed client sessions. It replaces the
engine heartbeat POSTs and their per-beat database writes, the 500 ms
credential-control poll, the checkpoint-hint long-poll and the separate
relay socket pairs.

## Purpose and principles

- **Outbound only.** The VM dials out; no inbound port is needed for the CP
  path. Direct client ingress (S3) is unchanged and optional.
- **One socket per engine instance.** A second uplink for the same
  `engineInstanceId` supersedes the first (close `4409`).
- **State in memory, durable facts in the database.** Liveness and presence
  live in `realtime` memory; the database is written on transitions only.
- **Secrets never traverse `realtime`.** Frames carry revisions and
  identifiers. The engine fetches secret material (credential controls,
  repository credentials) from `api` with its engine capability (S1).
- **Ordered recovery.** After (re)connect, the CP sends `auth.sync` first and
  nothing else until the engine acknowledges it (S1 outage rule).

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

2. CP verifies the credential, workspace, generation and engine instance
   against durable facts (one read), then replies `sys.welcome`
   (unsequenced) with the chosen `protocol`, the intersected `features`, a
   new `resumeToken`, `resumed: true|false`, `pingIntervalMs` (default
   20 000), and the lease deadline.
3. CP sends `auth.sync` (sequenced). The engine applies it and acks it. Until
   that ack, the CP sends nothing else and the engine admits no new client
   sessions (direct or relay).
4. Normal traffic.

Version rule: `realtime` supports protocol N and N−1 during a rollout; the
engine sends its `min`/`max`; the CP picks the highest common version or
closes with `4426 protocol_unsupported`. Features are additive flags; neither
side sends a frame type behind a feature the other did not list.

## Channels and frames

Direction: E = engine → CP, C = CP → engine. R = reliable (sequenced, acked,
replayed on resume), U = unreliable.

| Channel | Type | Dir | Rel | Payload (summary) | Replaces |
| --- | --- | --- | --- | --- | --- |
| sys | `sys.hello` / `sys.welcome` | E / C | U | Handshake above | Registration-time lease setup |
| sys | `sys.ping` / `sys.pong` | E / C | U | `{ ts }` every ~20 s | Heartbeat POST every 10 s, `cloud-runtime-registration.ts:997-1106` |
| sys | `sys.ack` | both | U | `{ a }` standalone ack when no other frame is due (≤ 250 ms delay) | — |
| sys | `sys.drain` | C | U | `{ reconnectAfterMs, deadlineMs }` | — (new: graceful deploys) |
| sys | `sys.error` | both | U | `{ code, message, fatal }` | — |
| auth | `auth.sync` | C | R | Full epochs `{ wa, wr, members: {userId: me}, accounts: {userId: ac}, devices: {deviceId: dk} }`, revocation entries since `authCursor`, new `authCursor` | — |
| auth | `auth.epochs` | C | R | Delta of the same shape + `authCursor` | Relay 5 s revalidation, client lease renewals |
| auth | `auth.keys` | C | R | JWKS (`next`, `current`, `retiring`) | — |
| auth | `auth.capability` | C | R | Engine capability (S1) for `zeros:api`, pushed at 60% lifetime | Actor-confirm renewal, `cloud-local-command-queue-boot.ts:380-396` |
| status | `status.ready` | E | R | `{ ready, phase, reason? }` on change | Ready inference from heartbeat/registration |
| status | `status.report` | E | R | Coalesced, latest-wins: `observedPorts`, runtime health, engine version | Heartbeat `observedPorts` field |
| activity | `activity.report` | E | R | Every 60 s and on edge: `{ clients, runningTurns, liveTerminals, lastInputAt, window }` | Idle timers (track D input) |
| cred | `cred.revision` | C | R | `{ kind: "agent-controls" \| "repository", revision }` | 500 ms poll, `cloud-local-command-queue-boot.ts:323-358` |
| cred | `cred.ack` | E | R | `{ kind, revision, result: "applied" \| "failed", code? }` after fetching from `api` | — |
| checkpoint | `checkpoint.request` | C | R | `{ requestId, reason, deadlineMs }` | Checkpoint-hint long-poll, `cloud-runtime-registration.ts:1129` |
| turns | `turns.event` | E | R | `{ journalSeq, chatId, turnId, state: started \| completed \| failed \| needs_attention, at }` | Notification and presence inference from history mirror |
| turns | `turns.ack` | C | R | `{ journalSeq }` durable on the CP side | — |
| relay | `relay.open` | C | R | `{ channel, clientSessionId, capability, proof }` (the client's S1 `auth` frame, forwarded; PoP signed with `route: relay`) | Separate relay socket pair, `runtime-bridge.ts` |
| relay | `relay.accept` / `relay.reject` | E | R | `{ channel }` / `{ channel, code }` after S1 verification | — |
| relay | `relay.credit` | both | U | `{ channel, bytes }` | — |
| relay | `relay.close` | both | R | `{ channel, code, reason }` | — |

### Relay channels and flow control

- `realtime` assigns a `channel` (uint32, unique per uplink) per client
  session. `realtime` first verifies the client's `zeros:realtime`
  capability and proof (S1), then forwards the client's `zeros:engine`
  capability and its proof in `relay.open`. The engine verifies them
  locally (S1) and replies `relay.accept` or `relay.reject`.
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
  `sys.welcome.resumed = false` and both sides resync:
  - CP sends `auth.sync`, current `auth.keys`, a fresh `auth.capability`,
    current `cred.revision` values and any pending `checkpoint.request`.
  - Engine re-sends `status.ready`, `status.report`, `activity.report`, and
    `turns.event` from the last `turns.ack` (`lastJournalSeq` in hello).
- Every reliable frame type is idempotent by content (revisions, journal
  sequence, request IDs), so duplicates after resume are harmless.

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
  changed, uplink lost (`engine_instances.last_heartbeat_at` and lease),
  plus a coarse watermark at most every 5 min so drift and cleanup jobs can
  still reason about stale engines if `realtime` itself is down. This
  replaces the per-beat `FOR UPDATE` on the workspace row and `UPDATE
  engine_instances` at `apps/control-plane/src/cloud-workspaces/setup-materials.ts:1536-1599`.
- Lease: the deadline in `sys.welcome` is extended in memory while the
  uplink is healthy; the durable lease is extended on the watermark write.
  An engine that loses the uplink keeps working until the lease deadline
  (decision G: never stop on an unknown error).

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

## Error and close codes

| Close | Code string | Meaning | Engine action |
| --- | --- | --- | --- |
| 1000 | `normal` | Clean close | Reconnect only if still running |
| 1001 | `going_away` | Process exit | Reconnect with backoff |
| 4400 | `frame_invalid` | Schema or size violation | Report; reconnect with backoff |
| 4401 | `uplink_unauthenticated` | Credential invalid or expired | Stop reconnecting; existing authority-loss path |
| 4403 | `uplink_forbidden` | Generation or engine instance not current | Existing authority-loss path; never retry with the same identity |
| 4408 | `ping_timeout` | Missed pings | Reconnect |
| 4409 | `uplink_superseded` | Newer uplink for this engine instance | Do not reconnect this socket |
| 4426 | `protocol_unsupported` | No common version | Report; keep running until lease deadline |
| 4429 | `backpressure` | Buffer overflow | Reconnect with resume |
| 4503 | `draining` | Instance draining | Reconnect after `reconnectAfterMs` |

`sys.error` codes for non-fatal errors: `frame_unknown_channel`,
`relay_channel_unknown`, `cred_fetch_failed`, `turn_journal_gap`.

## Failure and outage behavior

| Failure | Behavior |
| --- | --- |
| Uplink down, `api` up | Engine keeps running; direct client sessions continue under S1 normal rules (5 min worst case); engine fetches credentials directly from `api` with its last engine token until it expires; then it waits |
| `realtime` and `api` down (full CP outage) | S1 outage rule: pre-outage sessions up to 30 min; no new sessions; agents keep running until the lease deadline; turn events buffer in the journal |
| `realtime` redeploy | Drain, reconnect, resume or resync; relay clients re-route |
| Engine restart (same generation) | New `bootId`; resume rejected (`resumed: false`); full resync |
| Database slow or down | `realtime` keeps uplinks and liveness in memory; transition writes retry with jitter through a bounded queue; no uplink is closed because a write failed |

## Code paths this replaces

| Current path | Replacement | Track |
| --- | --- | --- |
| Engine heartbeat timer, `apps/desktop/src/engine/cloud-runtime-registration.ts:997-1106`; default 10 s, `apps/control-plane/src/cloud-workspaces/engine-heartbeat.ts:6-8` | `sys.ping` + `status.report` | C |
| Heartbeat DB writes, `apps/control-plane/src/cloud-workspaces/setup-materials.ts:1536-1599` | Transition writes + 5 min watermark | C |
| Credential-control poll every 500 ms, `apps/desktop/src/engine/cloud-local-command-queue-boot.ts:323-358`; endpoint `agent-credential-routes.ts:203` | `cred.revision` push, fetch, `cred.ack` | C |
| Checkpoint-hint long-poll (25 s hold), `cloud-runtime-registration.ts:1129` | `checkpoint.request` | C |
| Relay socket pairs and revalidation, `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts:351,753-794` | Relay channels over the uplink | C |
| Actor-confirm and warm-context renewals, `cloud-local-command-queue-boot.ts:380-435` | `auth.capability` | B, C |

## Local impact

None. The uplink client is a cloud-only engine module started only when the
engine boots in cloud mode from `ZEROS_CLOUD_RUNTIME_B64`
(`apps/desktop/src/engine/cloud-runtime-registration.ts:24,370`). The Local
engine on the Mac never dials `realtime`, and `pnpm electron:local` cannot
obtain a registration document (`scripts/electron-local.mjs:54-82`).

## Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| S2-Q1 | JSON for everything, or a binary encoding for control frames? | JSON text for control (debuggable, schema-validated, low rate); binary only for relay data. |
| S2-Q2 | One sequence space per direction, or per channel? | One per direction; channels are few and ordering across `auth` and other frames matters for recovery. |
| S2-Q3 | Resume across `realtime` instances (shared buffer in Redis or the DB)? | No in v1: resync is cheap and fully idempotent. Revisit if resync load shows up in measurements. |
| S2-Q4 | Keep the HTTP heartbeat as a fallback during rollout? | Yes, behind the per-org flag, for one release; the engine uses it only when `sys.welcome` was never received. Delete it at the end of the slice. |
| S2-Q5 | Should repository credentials move from the heartbeat response to the uplink? | Revision over the uplink, secret fetched from `api` with the engine token; secrets never pass through `realtime`. |
| S2-Q6 | Watermark write interval | 5 min; drift jobs already tolerate minutes. |
| S2-Q7 | Permessage-deflate | Off in v1; measure relay CPU first. |

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
  "description": "DRAFT 1.0.0-draft.1. Review sketch of uplink JSON text frames. Binary relay chunks are specified in s2-uplink.md. Receivers ignore unknown payload fields; frame types outside this list are handled by the unknown-type rule in s2-uplink.md.",
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
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "auth.sync" },
        "d": {
          "type": "object",
          "required": ["epochs", "revocations", "authCursor", "complete"],
          "properties": {
            "epochs": { "allOf": [{ "$ref": "#/$defs/epochSet" }], "required": ["wa", "wr"] },
            "revocations": { "$ref": "#/$defs/revocations" },
            "authCursor": { "$ref": "#/$defs/cursor" },
            "complete": { "type": "boolean", "description": "True when this is a full snapshot rather than a delta since the engine's authCursor." }
          }
        }
      }
    },
    "auth.epochs": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
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
    "auth.keys": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
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
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "auth.capability" },
        "d": {
          "type": "object",
          "required": ["audience", "token", "expiresAtMs"],
          "properties": {
            "audience": { "enum": ["zeros:api", "zeros:realtime"] },
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
          "required": ["requestId", "reason", "deadlineMs"],
          "properties": {
            "requestId": { "$ref": "#/$defs/uuid" },
            "reason": { "$ref": "#/$defs/code" },
            "deadlineMs": { "$ref": "#/$defs/timestampMs" }
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
      "allOf": [{ "$ref": "#/$defs/reliable" }],
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
      "allOf": [{ "$ref": "#/$defs/reliable" }],
      "properties": {
        "t": { "const": "relay.accept" },
        "d": { "type": "object", "required": ["channel"], "properties": { "channel": { "$ref": "#/$defs/channel" } } }
      }
    },
    "relay.reject": {
      "allOf": [{ "$ref": "#/$defs/reliable" }],
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
      "allOf": [{ "$ref": "#/$defs/reliable" }],
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
    { "t": "auth.epochs", "s": 9, "a": 4, "d": { "epochs": { "members": { "11111111-1111-4111-8111-111111111111": 6 } }, "revocations": [], "authCursor": "c-1042" } },
    { "t": "cred.revision", "s": 10, "d": { "kind": "agent-controls", "revision": 31 } },
    { "t": "relay.credit", "d": { "channel": 3, "bytes": 524288 } }
  ]
}
```
