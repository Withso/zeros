# Cloud workspace contracts

Status: **FROZEN 1.0.0** (2026-10-16, after the freeze review). Implementation is in progress.
These contracts are written before the backend tracks build on them; code,
tests and migrations remain authoritative once they exist.

| ID | Contract | Version | Status | Machine-readable sketch | Consumers |
| --- | --- | --- | --- | --- | --- |
| S1 | [Capabilities and revocation](s1-capabilities.md) | `zeros-cap` 1.0.0 | FROZEN | [JSON Schema: header and claims](s1-capabilities.md#draft-schema-capability-header-and-claims) | Tracks A, B, C |
| S2 | [VM uplink protocol](s2-uplink.md) | `zeros-uplink` 1.2.0 | FROZEN | [JSON Schema: uplink text frames](s2-uplink.md#draft-schema-uplink-text-frames) | Tracks C, D, E |
| S3 | [Client contract v1](s3-client-contract.md) | `zeros-client` 1.2.1 | FROZEN | [OpenAPI 3.1: REST](s3-client-contract.md#draft-schema-rest-api-openapi-31), [JSON Schema: device stream frames](s3-client-contract.md#draft-schema-device-stream-frames), [JSON Schema: runtime auth frames](s3-client-contract.md#draft-schema-runtime-auth-frames) | Tracks C, F1, F2 |

Until the Zod schemas replace them, each machine-readable sketch lives in a fenced block inside the
contract that owns it, under a "Draft schema" heading and directly after a
marker comment of the form `<!-- contract-schema: <name> (json|yaml) -->`.
The schema test extracts blocks by that marker.

Scope: **cloud workspaces only.** Local Personal and organization-local
workspaces, and `pnpm electron:local`, are unchanged by all three contracts.
Each contract has a "Local impact" section stating why.

## How the contracts fit together

```
client (SDK) ──REST──────────────► api ── issues S1 capabilities
     │  └─ device stream (S3) ───► realtime ◄── uplink (S2) ── VM engine
     └─ runtime: direct ─────────────────────────────────────► (verifies S1)
                 relay ──────────► realtime ── relay channel ─►
```

- S1 defines what a capability is, how verifiers check it locally, and how
  revocation reaches them.
- S2 is the only CP↔VM channel for liveness, revocation, credential-control
  revisions, turn notifications and relayed client sessions.
- S3 is what every cloud client sees: REST, one device stream, and the
  runtime connection handshake that carries an S1 capability.

## Versioning rules

- **Semver per contract.** Major: wire-incompatible change. Minor: additive
  (new optional fields, frame or event types, scopes, error codes). Patch:
  editorial. Drafts use `1.0.0-draft.N`.
- **Receivers ignore what they do not know:** unknown fields, unknown event
  types, unknown scopes and unknown claims. Senders never rely on a receiver
  understanding an optional addition unless the peer advertised it (S2
  `features`, S3 `contract` range).
- **N−1 during rollout.** Servers (`api`, `realtime`) accept the current and
  the previous major for at least one desktop release and one runtime
  qualification cycle. Engines and clients advertise `min`/`max`.
- **`packages/protocol` changes are additive only.** Existing message shapes
  do not change (plan §2.1). The runtime auth frames (`auth`, `auth.ok`,
  `auth.renew`, `auth.renewed`) are handshake frames gated by the
  `zeros-cap.v1` subprotocol, not new engine message types: `auth` and
  `auth.ok` precede the engine protocol, and the in-band renewal frames are
  told apart from engine messages by a top-level `t` with no `type`
  (S3, Part 3).
- **One source of truth after freeze.** The hand-written schema blocks in
  these documents are review sketches. At freeze, track B/C implement them as Zod schemas in
  `packages/protocol` (Zod 4, exported to JSON Schema with
  `z.toJSONSchema`, as `scripts/build-settings-schemas.ts` already does);
  the CP mirrors them with its own Zod 3 schemas and a parity test that
  imports the protocol source by relative path, following
  `apps/control-plane/src/cloud-workspaces/actor-direct-contract.test.ts`.
  The CP does not import `@zeros/protocol` at runtime. A generated schema
  then replaces each embedded sketch, with a test that fails on drift.

## Freeze process

1. Draft (this state): the master and the read-only reviewer read all three
   documents. S1 additionally gets an independent security review
   (`security-review` and `zstack-review` skills).
2. Each open question is answered: accepted recommendation, or a recorded
   alternative. Answers are written into the owning document.
3. The master marks a contract **FROZEN 1.0.0** in this table, in one commit.
   Tracks may build on a contract only after that commit.
4. After freeze, changes are additive minors with a changelog line in the
   owning document. A breaking change requires a new major, an N−1 window and
   owner sign-off.

The schema parse test (`scripts/__tests__/cloud-contract-schemas.test.ts`)
keeps the sketches valid until the generated schemas replace them.

## Decisions to confirm at freeze

| # | Decision | Recommendation | Main rejected alternative | Freeze review |
| --- | --- | --- | --- | --- |
| D1 | Token format (S1-Q1) | JWS compact, `EdDSA`/Ed25519, `jose` (already a dependency), pinned header | PASETO v4.public: new dependency on CP, engine and every client | Confirmed; every verifier uses one shared `jose`/`node:crypto` module, an exact header allow-list and a string-only `aud` (S1 draft 3). |
| D2 | Signing-key storage (S1-Q2) | Generalised settings-secret AES-256-GCM envelope code (the seal hard-codes the settings binding AAD today), **separate** keyring env and table. Deliberately narrows plan §3 S1 ("stored with the existing settings-secret encryption") to the envelope code, because [security](../security.md) (`security.md:287-289`) forbids reusing the keyring | Reuse the settings keyring itself: forbidden | Confirmed. |
| D3 | Membership epoch granularity (S1-Q3) | Per `(organization, user)` | Per workspace: fan-out writes and larger verifier state | Confirmed, with the snapshot scope and maximum-merge rules (S1, Epoch snapshot). |
| D4 | Proof of possession (S1-Q4, S1-Q8) | Required for client tokens on both routes, 0-RTT signed proof with the existing device key; every cloud client registers a trusted device (the Mac app already does). Keyless API/MCP/CLI clients get a scoped service-token grant in a later minor if needed | Bearer-only tokens: a leaked token works from any machine for 5 min | Confirmed. PoP protects leaked capabilities, not a leaked CP session, which can enrol its own device (S1 threat model). |
| D5 | Revocation transport | Epoch bump + existing `security_events` outbox in one transaction, NOTIFY to `realtime`, push over S2/S3 | Verifier polling the CP: reintroduces per-request reads | Confirmed; the 0015 outbox trigger already NOTIFYs at commit. Event rows carry the affected IDs; the engine confirms with S2 `auth.applied`. |
| D6 | Outage detection | Verifier-observed: uplink down ≥ 30 s **and** JWKS probe failing ≥ 30 s | Client-declared outage: unverifiable by the engine | Confirmed; a VM-side egress partition also counts and is accepted (bounded at 30 min). |
| D7 | Uplink encoding (S2-Q1) | JSON text control frames; binary relay chunks with an 8-byte header | All-binary: harder to debug and schema-check at low frame rates | Confirmed. |
| D8 | Uplink resume (S2-Q3) | In-memory 120 s buffer; otherwise idempotent full resync | Shared resume store: more infrastructure for a rare path | Confirmed; `auth` and `relay` frames are never buffered for resume (S2 draft 3). |
| D9 | Heartbeat fallback (S2-Q4) | Keep HTTP heartbeat one release behind the per-org flag, then delete | Immediate deletion: no rollback during the first rollout | Confirmed. |
| D10 | Device stream transport (S3-Q1) | WebSocket on `realtime`, ticket-authenticated | SSE: no client→server frames for attach and presence | Confirmed, with re-ticketing of an existing device session for resume (S3 draft 3). |
| D11 | Connect semantics (S3-Q2) | Connect never wakes; wake is an explicit idempotent command | Implicit wake: hides cost and races with stop | Confirmed. |
| D12 | Hedge delay (S3-Q3) | 400 ms, server-tunable 300–500 ms | Today's 5 s sequential fallback | Confirmed. |
| D13 | `/v1/auth/events` (S3-Q4) | Kept unchanged in v1 for Local organization workspaces | Fold into the device stream: changes a Local seam | Confirmed (Local seam, plan §2.1). |

## What these contracts retire

Each consuming slice deletes its old path when it lands (plan decision F).
The full file:line inventory is in each contract's "Code paths this
replaces" section; summary:

- Per-request engine authority SQL and client-admission verification (S1).
- Actor-confirm, warm-context and 5 s client-authority renewals (S1, S2).
- Relay revalidation every 5 s and separate relay socket pairs (S1, S2).
- Engine heartbeat POSTs, their per-beat DB writes, the 500 ms
  credential-control poll and the checkpoint-hint long-poll (S2).
- Renderer catalog, presence and access polling, and the 5 s
  direct-then-relay fallback (S3).
