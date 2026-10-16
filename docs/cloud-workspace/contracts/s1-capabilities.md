# S1. Capabilities and revocation

Status: **DRAFT** · Contract ID `zeros-cap` · Version `1.0.0-draft.2` ·
Schema: [Draft schema: capability header and claims](#draft-schema-capability-header-and-claims)

This contract defines the signed, workspace-scoped capability that replaces
per-request authority SQL, actor-confirm renewals, client-authority renewals
and relay revalidation for **cloud workspaces only**. It does not change Local
Personal or organization-local workspaces (see [Local impact](#local-impact)).

## Purpose

Today every engine request, client admission renewal and relay revalidation
asks the control plane (CP) database whether an actor may still act. The CP
instead issues a short-lived signed capability; verifiers (the VM engine, the
`realtime` service and the `api` service) check it locally and learn about
revocations by push. The database stores durable facts (roles, epochs, keys)
and is not consulted per request.

Targets (decision G of the plan):

| Property | Target |
| --- | --- |
| Revocation by push | ≤ 2 s p99 from the committing transaction to the verifier closing or downgrading the session |
| Revocation if push is down | About 5.5 min: the 300 s lifetime plus the 30 s expiry leeway in [verification](#verification) step 9 |
| Full CP outage | Sessions authenticated before the outage stay open up to 30 min; new sessions need the CP |
| Recovery | Missed epochs and revocations apply before any other traffic, then every open session is re-checked |
| Renewal | Silent: no user-visible reconnect, no re-admission round trip on the runtime connection |

## Token format

**Decision (recommended): compact JWS, `alg: "EdDSA"` over Ed25519, signed and
verified with `jose`.** `jose` is already a CP dependency
(`apps/control-plane/src/cloud-workspaces/runtime-oidc.ts`,
`apps/control-plane/src/auth.ts`) and a root runtime dependency
(`package.json:209`). Electron main imports it
(`apps/desktop/electron/workos-desktop-client.ts`), but nothing under
`apps/desktop/src` imports it today, so the engine verifier would be its first
engine import and the runtime bundle must include it. The alternative for the
engine is the existing Ed25519 primitives (`@noble`) in
`packages/protocol/src/crypto/primitives.ts`. No new dependency is introduced
either way.

Rejected: PASETO v4.public. It removes algorithm agility by design, but adds a
new runtime dependency to the CP, engine and every future client, and the
safety benefit is obtained here by pinning the header (below). Rejected:
opaque random tokens with CP lookup, because they reintroduce the per-request
database read this contract removes.

### Protected header

```json
{ "alg": "EdDSA", "typ": "zeros-cap+jwt", "kid": "cap-2026-10-a" }
```

Verifiers MUST reject any other `alg` (including `none` and every `HS*`/`RS*`
value), any other `typ`, a missing or unknown `kid`, and any `crit`, `jku`,
`jwk`, `x5u` or `x5c` header. Keys come only from the verifier's key set
(see [Keys](#keys-and-rotation)), never from the token.

### Claims

| Claim | Type | Required | Meaning |
| --- | --- | --- | --- |
| `iss` | string (URL) | yes | CP issuer origin, configured per environment (`CLOUD_CAPABILITY_ISSUER`, proposed). |
| `aud` | `"zeros:engine"` \| `"zeros:realtime"` \| `"zeros:api"` | yes | Exactly one audience. Client tokens use `zeros:engine` or `zeros:realtime`; engine tokens use `zeros:api` only. A token for one audience is never accepted by another. |
| `sub` | string | yes | Actor: `user:<uuid>` for client tokens, `engine:<engine-instance-uuid>` for engine-held tokens. |
| `knd` | `"client"` \| `"engine"` | yes | Token kind; must agree with `sub`. Verifiers check it against the kind their endpoint expects and never select checks from it (step 6). |
| `org` | uuid | yes | Organization that owns the workspace. |
| `wsp` | uuid | yes | Cloud workspace ID. |
| `gen` | positive integer | yes | Workspace generation number the token is valid for. |
| `ein` | uuid | engine tokens | Engine instance ID. Optional on client tokens; when present the engine rejects a mismatch. |
| `role` | `viewer` \| `prompter` \| `developer` \| `manager` \| `owner` | client tokens | Informational for UI. Enforcement uses `scp`. |
| `scp` | string[] | yes | Scopes (below). Sorted, unique, non-empty. |
| `ep` | object | yes | Epoch snapshot at issuance (below). |
| `sid` | uuid | client tokens | CP auth session (`auth_sessions.id`). |
| `did` | uuid | client tokens | Registered device (`/v1/devices`). |
| `dkv` | positive integer | client tokens | Device key version at issuance. |
| `cnf` | `{ "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>" } }` | client tokens | Device public key; the bearer must prove possession (below). |
| `iat`, `nbf`, `exp` | NumericDate | yes | `exp − iat` ≤ 300 s. `exp` is further capped by any earlier deadline (guest grant `expires_at`, session expiry). |
| `jti` | string (22 base64url chars, 128 bits) | yes | Unique token ID for audit and replay accounting. |
| `cv` | integer `1` | yes | Contract major version. |

Size budget: under 1 KiB encoded. Tokens are never logged; only `jti`, `kid`,
`sub` and `wsp` may appear in logs.

### Scopes

Client scopes are derived from the same role predicates the CP projects into
the workspace document today
(`apps/control-plane/src/cloud-workspaces/routes.ts:620-622`), so the token
grants exactly what the UI shows:

| Scope | Granted to | Allows |
| --- | --- | --- |
| `ws:read` | viewer and above | Open the runtime, read files, Git state, transcripts and history. |
| `ws:prompt` | prompter and above, executable generation (`canWrite`) | Send, steer and interrupt agent turns. |
| `ws:edit` | developer and above, executable generation (`canEdit`) | Write files, Git mutations, terminals, Design edits. |
| `ws:manage` | manager and above (`canManage`) | Lifecycle and sharing operations through the runtime. |

Engine scopes (engine-held tokens, `aud` `zeros:api` only) map to existing
engine route families:

| Scope | Existing routes |
| --- | --- |
| `engine:credentials.read` | `/internal/v2/cloud-workspaces/engine/agent-credential-controls`, `…/agent-boot/*`, `…/agent-execution` |
| `engine:history.write` | `/internal/v2/cloud-workspaces/engine/commands/mirror`, `…/commands/seal`; `/internal/v1/cloud-workspaces/engine/record/*`, `…/content/*`, `…/events` |
| `engine:checkpoint` | `/internal/v1/cloud-workspaces/engine/checkpoint-hint`, `…/checkpoint-progress`, `…/checkpoints/commit`, `…/blobs` |

The uplink itself is authenticated with the heartbeat credential (S2), so
there is no `engine:uplink` scope. Other engine routes (register, heartbeat,
usage, idle-stop, GitHub, actions, access admission) keep the heartbeat
credential in v1.

`ws:*` scopes exist only on client tokens and `engine:*` scopes only on engine
tokens. The issuer never emits a cross-kind scope (the schema rejects it); a
verifier that sees one ignores it and never grants it. Unknown scopes of the
token's own kind are ignored too (additive evolution). A verifier never
infers a scope from `role`.

### Epoch snapshot (`ep`)

| Key | Subject | Source of truth | Bumped by |
| --- | --- | --- | --- |
| `wa` | Workspace authority | `cloud_workspaces.authority_epoch` (existing, migration 0026; read by the 0113 authority function) | Stop, wake, failure, delete, generation change (`generation-transitions.ts:180,308,573`, `compute-credit-stop.ts:167,238`, `engine-health.ts:98`) |
| `wr` | Workspace access | `cloud_workspaces.access_revision` (existing, migration 0077) | Sharing-mode change (`actors.ts:184-186`) |
| `me` | Membership of `(org, user)` | **New** `cloud_capability_member_epochs(org_id, user_id, epoch)` | Any role, guest, invitation or org-membership change for that user in that org |
| `ac` | Account | `users.auth_revision` (existing, migration 0013) | Account disable, revoke or authentication change |
| `dk` | Device key | `devices.key_version` (existing) | Key rotation (`PATCH /v1/devices/:device/key`) |

`me` is deliberately per organization, not per workspace: a role change in one
workspace revokes that user's tokens for every workspace in the organization
and they silently renew. Role changes are rare, and one counter avoids
fan-out writes and a per-workspace verifier table.

The epoch key set is fixed per kind, and every key must be present:

| Kind | Required `ep` keys |
| --- | --- |
| `client` | `wa`, `wr`, `me`, `ac`, `dk` |
| `engine` | `wa` |

A token missing any required key fails with `capability_malformed` (step 7);
the verifier never treats a missing key as "nothing to check". Extra keys
are allowed for additive evolution and are checked if the verifier knows
them.

Session and device revocation are terminal, so they are expressed as
revocation entries (`sid` or `did` revoked), not counters. A verifier keeps
each entry for `max token lifetime + outage grace + skew` (≈ 36 min) and then
drops it, because no older token can still be valid.

## Verification

A verifier accepts a token only if every step passes, in this order. The first
failing step determines the error code.

1. Parse compact JWS; size ≤ 4 KiB → else `capability_malformed`.
2. Header pinned as above → else `capability_malformed`.
3. `kid` in the verifier's active key set → else `capability_key_unknown`
   (the verifier may refresh keys once, rate-limited to 1/min, before failing).
4. Ed25519 signature valid → else `capability_signature_invalid`.
5. `iss` equals the configured issuer → else `capability_issuer_mismatch`.
   `cv` is a supported major → else `capability_contract_unsupported` (the
   only code that tells a client to update).
6. `aud` equals the verifier's own audience **and** `knd` equals the kind the
   endpoint expects: client-facing endpoints (runtime connect on the engine,
   relay admission on `realtime`) pin `knd: "client"`; the engine route
   families on `api` pin `knd: "engine"`. Else
   `capability_audience_mismatch`. The verifier pins the pair; it never
   selects checks from the token's own `knd`.
7. Every epoch key required for the token's kind is present in `ep` → else
   `capability_malformed` (fail closed; a missing key is not "nothing to
   check").
8. `wsp`, `org` match the verifier's workspace (engine) or the requested
   workspace (realtime, api); `gen` equals the current generation; `ein`
   matches when present → else `capability_workspace_mismatch` /
   `capability_generation_mismatch`.
9. `nbf − 30 s ≤ now < exp + 30 s` (30 s clock-skew leeway) → else
   `capability_not_yet_valid` / `capability_expired`. See
   [outage rule](#outage-rule) for the only extension.
10. For every epoch key `k` in `ep`: `ep[k] ≥ known[k]` → else
    `capability_revoked`. If `ep[k] > known[k]`, the verifier raises
    `known[k]` to `ep[k]` (tokens are CP-signed, so they are a valid epoch
    source; this also closes older sessions sooner).
11. `sid`, `did` not in the revocation set; `dkv ≥ known device key version`
    → else `capability_revoked`.
12. Client tokens (pinned in step 6): proof of possession valid → else
    `capability_proof_invalid`.
13. Per message: the operation's required scope is in `scp`, ignoring any
    cross-kind scope → else `capability_scope_denied` (the session stays
    open).

### Proof of possession (client tokens)

The device private key (Ed25519, held by Electron main today; see
`apps/control-plane/src/cloud-workspaces/replicas.ts:110-139` for the
existing `zeros-cloud-device-proof-v1` format) signs, once per connection
and once per in-band renewal:

```
zeros-cap-pop-v1
<aud>
<wsp>
<jti>
<timestampMs>
<nonce: 22 base64url chars>
<route: direct | relay>
```

The verifier rebuilds the message from its own `aud`, `wsp` and route (never
from client-supplied values), checks the signature against `cnf.jwk`,
`|now − timestampMs| ≤ 30 s` and that `(jti, nonce)` was not seen in the last
5 min. This needs no extra round trip and no CP call. A stolen token alone
cannot open a session from another machine.

The replay cache is per verifier instance. A proof captured on one instance
can be replayed on another within the 30 s timestamp window. Mitigation:
`realtime` shards relay admission and the device stream by workspace, so one
workspace's verifier state lives on one instance; the engine is a single
instance per workspace. A shared replay set (S2-Q3's open question) closes
the residual window if sharding is ever relaxed.

Engine tokens carry no `cnf`: the VM is one trust domain and the engine's
uplink credential is equivalent (see [security](../security.md)).

## Lifetimes

| Item | Lifetime |
| --- | --- |
| Client and engine capability | 300 s (`exp − iat`), capped by earlier grant/session deadlines |
| Renewal | Pushed at 60% of lifetime (S2 for engine, S3 device stream for clients); REST fallback at 80% |
| Signing key | Active 90 days; published as `next` ≥ 24 h before activation; kept as `retiring` ≥ 24 h after |
| Revocation entries at verifiers | ≈ 36 min (300 s + 30 min + skew) |
| PoP replay window | 5 min |

In-band renewal: a client sends the new token (and a fresh PoP) over its
existing runtime connection (`auth.renew`, S3). The verifier applies steps
1–12 and swaps the session's token without reconnecting. If no valid renewal
arrives before `exp + 30 s`, the session is closed with
`capability_expired`.

## Keys and rotation

- **Algorithm:** Ed25519 only. `kid` format `cap-<yyyy>-<mm>-<suffix>`.
- **Storage (recommended):** new table `cloud_capability_signing_keys(kid,
  public_jwk, sealed_private_key, state, created_at, activated_at,
  retire_after)` with `state ∈ next | current | retiring | retired | revoked`.
  Private keys are sealed with a generalised form of the
  AES-256-GCM-with-AAD envelope used for settings secrets. Today's seal
  hard-codes the settings binding AAD (`secretBindingAad(binding)`,
  `apps/control-plane/src/cloud-workspaces/settings.ts:537-538`, seal at
  `:510-556`, open at `:602`), so the envelope code is generalised to take
  the AAD as a parameter; it is not reused as is. The sealing keyring is a
  **separate keyring** (`CLOUD_CAPABILITY_KEYS_JSON`,
  `CLOUD_CAPABILITY_CURRENT_KEY_VERSION`, proposed), because
  [security](../security.md) (`security.md:287-289`) forbids reusing the
  settings keyring for other domains. This deliberately narrows plan §3's
  "stored with the existing settings-secret encryption" to mean the existing
  envelope code, not the existing keyring. AAD binds `kid` and the purpose
  string `zeros-cap-signing-v1`.
- **Publication:** `GET /.well-known/zeros-capabilities/jwks.json` (public,
  `Cache-Control: max-age=300`), and the S2 `auth.keys` frame to every
  connected engine. The set contains `next`, `current` and `retiring` keys
  only (≤ 3).
- **Signing:** only `current`. Each `api` process loads the current key at
  start and on a `capability_keys_changed` NOTIFY.
- **Emergency rotation:** mark a key `revoked`, push `auth.keys` without it;
  verifiers reject its tokens immediately and clients renew under the new
  key.

## Issuance

Issued only by the `api` service:

- Client tokens: `POST …/runtime/connect` and `POST …/runtime/capabilities`
  (S3), and pushed `capability.renewed` events on the device stream (S3).
  Issuance reads the actor's role and epochs once (one SQL statement, served
  by the track B authority cache where possible) and requires a valid CP
  session plus a device proof. Unlike today's runtime admission, where the
  proof is optional and checked only when the device headers are present
  (`apps/control-plane/src/cloud-workspaces/routes.ts:2065`), the proof is
  **required**: every cloud client registers an Ed25519 device key with
  `POST /v1/devices` (rows are `trusted` by default at registration,
  migration 0027; verification requires that state,
  `apps/control-plane/src/cloud-workspaces/replicas.ts:48`) and holds the
  private key in platform storage. The Mac app already does this: Electron
  main signs the admission proof
  (`apps/desktop/electron/cloud-workspace-access-client.ts:919,932`). Web,
  CLI, MCP and API clients must do the same; see S1-Q8 for clients without a
  persistent key.
- Engine tokens: `auth.capability` frame on the uplink (S2) after the uplink
  is authenticated with the engine's heartbeat credential.

Issuance fails closed: if the role or an epoch cannot be read, no token is
issued (`503 capability_issuer_unavailable`).

## Revocation

Every authority-reducing change writes, in the **same transaction**:

1. the epoch bump or revocation entry, and
2. a row in the existing `security_events` outbox
   (`apps/control-plane/src/cloud-workspaces/collaboration-events.ts`,
   `apps/control-plane/src/security-events.ts`), which already drives
   `NOTIFY` via the security-event broker.

`realtime` listens, maps the event to affected workspaces, and sends
`auth.epochs` (S2) to each affected engine and `capability.revoked` (S3) to
each affected device stream. Latency budget for the 2 s p99 target:

| Step | Budget |
| --- | --- |
| Commit → NOTIFY received by `realtime` | 300 ms |
| Fan-out to the engine uplink | 200 ms |
| Engine applies epochs, closes or downgrades sessions, acks | 200 ms |
| Headroom (GC, reconnecting uplinks, load) | 1.3 s |

Measured as `capability_revocation_push_ms` = engine ack time − event
`created_at`, recorded by `realtime`.

Downgrade versus close: a role reduction that leaves `ws:read` closes the
session and the client reconnects with a fresh token (simplest correct
behavior). A future minor version may add in-place downgrade.

## Outage rule

Definitions, as observed by a verifier:

- **Push down:** the S2 uplink (or the `realtime` NOTIFY listener) is down, but
  the CP `api` answers `GET /.well-known/zeros-capabilities/jwks.json`.
  Normal rules apply: sessions close at `exp + 30 s` unless renewed. Worst-case
  revocation latency is therefore 5 min.
- **Full CP outage:** the uplink has been down for ≥ 30 s **and** the JWKS
  probe (every 10 s, 3 s timeout) has failed for ≥ 30 s. The verifier records
  `outageStartedAt`.

During a full CP outage only, a session that was authenticated **before**
`outageStartedAt` stays open past `exp` until
`min(outageStartedAt + 30 min, exp + 30 min)`. New sessions and renewals are
impossible (no issuer), so no new connection is admitted. A verifier never
extends a session because of a client-side network problem it cannot observe.

On recovery the verifier, before processing any other frame or request:

1. receives `auth.sync` (S2), which carries all current epochs and every
   revocation entry since the verifier's last applied cursor;
2. applies it;
3. re-checks every open session against steps 5–11;
4. requires every grace-extended session to present a valid renewal within
   30 s, else closes it with `capability_expired`.

The CP never sends other frames to an engine before `auth.sync` is
acknowledged (S2 ordering guarantee).

## Error codes

Wire errors use the existing envelope `{ "error": { "code", "message" } }`
for HTTP and the S2/S3 `error` frame for sockets.

| Code | HTTP | Socket close | Client action |
| --- | --- | --- | --- |
| `capability_missing` | 401 | 4401 | Obtain a token |
| `capability_malformed` | 401 | 4401 | Bug; report, do not retry with the same token |
| `capability_key_unknown` | 401 | 4401 | Renew once |
| `capability_signature_invalid` | 401 | 4401 | Renew once |
| `capability_issuer_mismatch` | 401 | 4401 | Check the configured CP origin; report |
| `capability_contract_unsupported` | 401 | 4426 | Update client |
| `capability_audience_mismatch` | 401 | 4401 | Bug |
| `capability_workspace_mismatch` | 403 | 4403 | Re-resolve workspace |
| `capability_generation_mismatch` | 409 | 4409 | Reconnect via `runtime/connect` |
| `capability_not_yet_valid` | 401 | 4401 | Check clock; renew |
| `capability_expired` | 401 | 4401 | Renew silently, then reconnect |
| `capability_revoked` | 403 | 4403 | Renew; if issuance is denied, show access lost |
| `capability_proof_invalid` | 401 | 4401 | Re-sign; if repeated, re-register device |
| `capability_scope_denied` | 403 | (no close) | Show read-only or role-required state |
| `capability_issuer_unavailable` | 503 | — | Retry with jitter |

Issuance also returns existing workspace codes unchanged, for example
`workspace_role_required`, `cloud_workspace_v2_required` and
`workspace_replica_device_proof_rejected`.

## Versioning

`cv` carries the contract major. Minor versions may add optional claims and
scopes; verifiers ignore unknown claims and scopes. During a major rollout the
issuer signs the version the verifier advertised in S2 `sys.hello`
(`features: ["cap.v2"]`), and verifiers accept N and N−1 for one release
window.

## Code paths this replaces

| Current path | Replacement | Track |
| --- | --- | --- |
| Per-request engine authority SQL, `apps/control-plane/src/cloud-workspaces/engine-authority.ts:169-216` | Engine token verification + authority cache keyed by `wa` | B |
| Engine client-admission verification call, `apps/desktop/src/engine/cloud-runtime-registration.ts:828-875` → `/internal/v2/cloud-workspaces/engine/client-admission` | Local verification (steps 1–12) on the engine | B |
| Client authority renewal every lease/2 (lease ≤ 10 s), `apps/desktop/src/engine/transport/cloud.ts:154,554-607` | In-band `auth.renew` every ~3 min | B, F1 |
| Actor-confirm renewal at half lifetime, `apps/desktop/src/engine/cloud-local-command-queue-boot.ts:380-396`; CP side `apps/control-plane/src/cloud-workspaces/agent-boot-credentials.ts:576,606-646` | Engine token renewal pushed over the uplink | B |
| Warm-context request, `cloud-local-command-queue-boot.ts:410-435` | Engine token with `engine:credentials.read` | B |
| Client bridge revalidation every 5 s, `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts:351,753-771` | Epoch push to `realtime` + token `exp` | B, C |
| Provider resolver `FOR SHARE` authority read on runtime paths, `apps/control-plane/src/cloud-workspaces/provider-resolver.ts:122-173` | Authority cache; cleanup bypass at `:197-213` kept | A, B |

Preview and PTY relay lanes (`preview-websocket-relay.ts:39` and friends)
keep their current revalidation in v1. They are scoped separately from the
engine, control and event lanes (see the resident outbound VM transport row
in [warm-pool](../warm-pool.md)) and join the contract in a later minor.

Each slice deletes the old path when it lands (decision F).

## Local impact

None. Local Personal and organization-local workspaces never request, verify
or receive capabilities. `pnpm electron:local` strips CP and cloud environment
and sets `ZEROS_CLOUD_WORKSPACES_ENABLED=false`
(`scripts/electron-local.mjs:54-82`); the engine verifies capabilities only in
cloud mode, which starts only with `ZEROS_CLOUD_RUNTIME_B64`
(`apps/desktop/src/engine/cloud-runtime-registration.ts:24,370`). The
verifier lives in cloud-only modules. `packages/protocol` gains additive
schemas only.

## Threat model summary

| Threat | Mitigation |
| --- | --- |
| Token theft (logs, memory dump on another host) | 5 min lifetime, PoP bound to the device key, tokens never logged |
| Algorithm confusion, key injection | Pinned header, key set from CP only, unknown header fields rejected |
| Replay of a revoked token | Epochs and revocation entries; learned epochs from newer tokens |
| Signing key compromise | Sealed at rest under a dedicated keyring, emergency `revoked` state, 90-day rotation |
| Engine forging client tokens | Engine holds no signing key; it only verifies |
| Heartbeat credential used from off the VM | The uplink binds it to a registered `bootId` and rejects or alerts on mismatch (S2, [supersede rules](s2-uplink.md#supersede-and-the-heartbeat-credential)). Reading credential controls off the VM is possible with that credential today and is unchanged; receiving relayed client sessions and engine tokens through a hijacked uplink is new with S2 and is what the bootId rule bounds |
| Compromised VM | Out of scope as a boundary: one trust domain per workspace. Engine tokens are scoped to that workspace and generation only |
| Outage abuse (cutting the CP to keep access) | Grace only for pre-outage sessions, bounded at 30 min, requires the verifier itself to see the CP down |

## Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| S1-Q1 | JWS or PASETO v4.public? | JWS EdDSA via existing `jose`; pinned header. |
| S1-Q2 | Reuse the settings-secret keyring for signing keys? | No. Generalised envelope code, separate keyring env (`security.md:287-289` forbids reuse). Narrows plan §3 S1 accordingly. |
| S1-Q3 | Membership epoch per workspace or per organization? | Per `(org, user)`; rare changes, no fan-out. |
| S1-Q4 | Require PoP for relay tokens too? | Yes; same proof, `route: relay`. |
| S1-Q5 | Downgrade in place on role reduction? | Not in v1: close and reconnect. Revisit with real traffic. |
| S1-Q6 | Bind client tokens to `ein`? | Optional claim; set it once the engine instance is known, so a replaced engine cannot accept old tokens even within one generation. |
| S1-Q7 | Clock skew leeway | 30 s; Boat VMs and Macs run NTP. Alert if observed skew > 10 s. |
| S1-Q8 | PoP for clients without a persistent device key (API, MCP, short-lived CLI)? | v1 requires a registered trusted device for every cloud client (the Mac app already proves possession via Electron main, `apps/desktop/electron/cloud-workspace-access-client.ts:919,932`). If a headless client cannot hold a key, add a scoped service-token grant without PoP in a later minor; do not weaken v1. |
| S1-Q9 | Cross-instance PoP replay within the 30 s window | Shard verifier state by workspace so one workspace has one replay cache; revisit if S2-Q3 adds a shared store. |

## Draft schema: capability header and claims

JSON Schema 2020-12 for the protected header and claims of a decoded
capability. Unknown claims are allowed (verifiers ignore them). This sketch is
a review aid until freeze; the frozen source of truth will be Zod in
`packages/protocol`.

<!-- contract-schema: s1-capability-claims (json) -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://zeros.dev/schemas/cloud-contracts/s1-capability-claims.schema.json",
  "title": "Zeros capability (S1) protected header and claims",
  "description": "DRAFT 1.0.0-draft.1. Review sketch; the frozen source of truth will be Zod in packages/protocol.",
  "type": "object",
  "required": ["header", "claims"],
  "additionalProperties": false,
  "properties": {
    "header": { "$ref": "#/$defs/header" },
    "claims": { "$ref": "#/$defs/claims" }
  },
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "epoch": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
    "numericDate": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "header": {
      "type": "object",
      "required": ["alg", "typ", "kid"],
      "additionalProperties": false,
      "properties": {
        "alg": { "const": "EdDSA" },
        "typ": { "const": "zeros-cap+jwt" },
        "kid": { "type": "string", "pattern": "^cap-[0-9]{4}-[0-9]{2}-[a-z0-9]{1,16}$" }
      }
    },
    "role": { "enum": ["viewer", "prompter", "developer", "manager", "owner"] },
    "scope": {
      "type": "string",
      "pattern": "^(ws|engine):[a-z][a-z0-9.]{1,47}$",
      "description": "Known v1 scopes: ws:read, ws:prompt, ws:edit, ws:manage (client tokens only), engine:credentials.read, engine:history.write, engine:checkpoint (engine tokens only). Verifiers ignore unknown and cross-kind scopes."
    },
    "epochs": {
      "type": "object",
      "required": ["wa"],
      "additionalProperties": { "$ref": "#/$defs/epoch" },
      "properties": {
        "wa": { "$ref": "#/$defs/epoch", "description": "cloud_workspaces.authority_epoch" },
        "wr": { "$ref": "#/$defs/epoch", "description": "cloud_workspaces.access_revision" },
        "me": { "$ref": "#/$defs/epoch", "description": "Membership epoch for (org, user)" },
        "ac": { "$ref": "#/$defs/epoch", "description": "users.auth_revision" },
        "dk": { "$ref": "#/$defs/epoch", "description": "devices.key_version" }
      }
    },
    "ed25519Jwk": {
      "type": "object",
      "required": ["kty", "crv", "x"],
      "additionalProperties": false,
      "properties": {
        "kty": { "const": "OKP" },
        "crv": { "const": "Ed25519" },
        "x": { "type": "string", "pattern": "^[A-Za-z0-9_-]{43}$" }
      }
    },
    "claims": {
      "type": "object",
      "required": ["iss", "aud", "sub", "knd", "org", "wsp", "gen", "scp", "ep", "iat", "nbf", "exp", "jti", "cv"],
      "properties": {
        "iss": { "type": "string", "pattern": "^https://[^/\\s]+$" },
        "aud": { "enum": ["zeros:engine", "zeros:realtime", "zeros:api"] },
        "sub": { "type": "string", "pattern": "^(user|engine):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
        "knd": { "enum": ["client", "engine"] },
        "org": { "$ref": "#/$defs/uuid" },
        "wsp": { "$ref": "#/$defs/uuid" },
        "gen": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
        "ein": { "$ref": "#/$defs/uuid" },
        "role": { "$ref": "#/$defs/role" },
        "scp": {
          "type": "array",
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/scope" }
        },
        "ep": { "$ref": "#/$defs/epochs" },
        "sid": { "$ref": "#/$defs/uuid" },
        "did": { "$ref": "#/$defs/uuid" },
        "dkv": { "$ref": "#/$defs/epoch" },
        "cnf": {
          "type": "object",
          "required": ["jwk"],
          "additionalProperties": false,
          "properties": { "jwk": { "$ref": "#/$defs/ed25519Jwk" } }
        },
        "iat": { "$ref": "#/$defs/numericDate" },
        "nbf": { "$ref": "#/$defs/numericDate" },
        "exp": { "$ref": "#/$defs/numericDate" },
        "jti": { "type": "string", "pattern": "^[A-Za-z0-9_-]{22}$" },
        "cv": { "const": 1 }
      },
      "allOf": [
        {
          "if": { "properties": { "knd": { "const": "client" } } },
          "then": {
            "required": ["role", "sid", "did", "dkv", "cnf"],
            "properties": {
              "sub": { "pattern": "^user:" },
              "aud": { "enum": ["zeros:engine", "zeros:realtime"] },
              "scp": { "items": { "pattern": "^ws:" } },
              "ep": { "required": ["wa", "wr", "me", "ac", "dk"] }
            }
          }
        },
        {
          "if": { "properties": { "knd": { "const": "engine" } } },
          "then": {
            "required": ["ein"],
            "not": { "anyOf": [{ "required": ["cnf"] }, { "required": ["sid"] }, { "required": ["did"] }] },
            "properties": {
              "sub": { "pattern": "^engine:" },
              "aud": { "const": "zeros:api" },
              "scp": { "items": { "pattern": "^engine:" } },
              "ep": { "not": { "anyOf": [{ "required": ["wr"] }, { "required": ["me"] }, { "required": ["ac"] }, { "required": ["dk"] }] } }
            }
          }
        }
      ]
    }
  },
  "examples": [
    {
      "header": { "alg": "EdDSA", "typ": "zeros-cap+jwt", "kid": "cap-2026-10-a" },
      "claims": {
        "iss": "https://cp.example.invalid",
        "aud": "zeros:engine",
        "sub": "user:11111111-1111-4111-8111-111111111111",
        "knd": "client",
        "org": "22222222-2222-4222-8222-222222222222",
        "wsp": "33333333-3333-4333-8333-333333333333",
        "gen": 7,
        "ein": "44444444-4444-4444-8444-444444444444",
        "role": "developer",
        "scp": ["ws:edit", "ws:prompt", "ws:read"],
        "ep": { "wa": 12, "wr": 3, "me": 5, "ac": 1, "dk": 2 },
        "sid": "55555555-5555-4555-8555-555555555555",
        "did": "66666666-6666-4666-8666-666666666666",
        "dkv": 2,
        "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
        "iat": 1792000000,
        "nbf": 1792000000,
        "exp": 1792000300,
        "jti": "AAAAAAAAAAAAAAAAAAAAAA",
        "cv": 1
      }
    },
    {
      "header": { "alg": "EdDSA", "typ": "zeros-cap+jwt", "kid": "cap-2026-10-a" },
      "claims": {
        "iss": "https://cp.example.invalid",
        "aud": "zeros:api",
        "sub": "engine:44444444-4444-4444-8444-444444444444",
        "knd": "engine",
        "org": "22222222-2222-4222-8222-222222222222",
        "wsp": "33333333-3333-4333-8333-333333333333",
        "gen": 7,
        "ein": "44444444-4444-4444-8444-444444444444",
        "scp": ["engine:credentials.read", "engine:history.write"],
        "ep": { "wa": 12 },
        "iat": 1792000000,
        "nbf": 1792000000,
        "exp": 1792000300,
        "jti": "BBBBBBBBBBBBBBBBBBBBBB",
        "cv": 1
      }
    }
  ]
}
```
