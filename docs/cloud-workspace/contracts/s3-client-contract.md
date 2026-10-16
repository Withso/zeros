# S3. Client contract v1 (cloud workspaces)

Status: **DRAFT** · Contract ID `zeros-client` · Version `1.0.0-draft.2` ·
Schemas: [Draft schema: REST API (OpenAPI 3.1)](#draft-schema-rest-api-openapi-31),
[Draft schema: device stream frames](#draft-schema-device-stream-frames),
[Draft schema: runtime auth frames](#draft-schema-runtime-auth-frames)

The one contract every cloud client uses: the Mac app first (through a
cloud-only SDK), then web, Windows, Linux, mobile, API, MCP and CLI. It has
three parts: REST commands and reads, one device stream for pushed state, and
a runtime connection to the workspace engine. Part 3 authenticates the
runtime connection defined in
[client-runtime-contract.md](../client-runtime-contract.md); the engine
message protocol itself stays as specified there and in `packages/protocol`.
Local workspaces are not part of it.

## Purpose

Replace the client's polling (catalog, presence, access, client-authority
renewals) and the 5 s direct-then-relay fallback with: snapshot + versioned
push, idempotent commands with an outbox, and a parallel direct/relay connect
where the first ready route wins.

## Part 1: REST

Base: the CP `api` origin. Paths keep today's shapes where they exist, so the
Mac app can move endpoint by endpoint. New endpoints are marked **new**.
Authentication: `Authorization: Bearer <CP session access token>` as today.
Device-bound endpoints also require the existing device proof headers
(`x-zeros-device-id`, `x-zeros-device-key-version`, `x-zeros-device-timestamp`,
`x-zeros-device-nonce`, `x-zeros-device-signature`;
`apps/control-plane/src/cloud-workspaces/routes.ts:1011-1030`).

| Operation | Method and path | Status |
| --- | --- | --- |
| Device session | `POST /v1/device-sessions` | **new** |
| Catalog snapshot | `GET /v1/cloud-workspaces?limit&cursor` | existing (`routes.ts:1997`), adds `catalogVersion` |
| Workspace document | `GET /v1/cloud-workspaces/{workspace}` | existing (`routes.ts:1998`) |
| Create | `POST /v1/organizations/{org}/cloud-workspaces` | existing (`routes.ts:3255`) |
| Wake, stop, archive | `POST /v1/organizations/{org}/cloud-workspaces/{workspace}/{wake\|stop\|archive}` | existing (`routes.ts:3528-3530`) |
| Delete | `DELETE /v1/organizations/{org}/cloud-workspaces/{workspace}` | existing (`routes.ts:3531`) |
| Rename | `PATCH /v1/organizations/{org}/cloud-workspaces/{workspace}` | existing (`routes.ts:2036`) |
| Runtime connect | `POST /v1/organizations/{org}/cloud-workspaces/{workspace}/runtime/connect` | **new**, supersedes `runtime/admission` (`routes.ts:2049`) |
| Capability renew | `POST /v1/organizations/{org}/cloud-workspaces/{workspace}/runtime/capabilities` | **new** |
| History chats | `GET …/{workspace}/history/chats` | existing (`history-routes.ts:47`) |
| History messages | `GET …/{workspace}/history/messages/{chat}` | existing (`history-routes.ts:63`) |
| History search | `GET …/{workspace}/history/search` | existing (`history-routes.ts:57`) |
| Command receipts | `GET …/{workspace}/history/commands[/{command}]` | existing (`history-routes.ts:74,79`) |
| Key set | `GET /.well-known/zeros-capabilities/jwks.json` | **new** (S1) |

Other existing cloud endpoints (create-options, generations, runtime upgrade,
detected ports, access grants, forks, replicas) remain available unchanged
and join the contract in later minor versions.

### Idempotency

Lifecycle and metadata commands (`POST …/cloud-workspaces`, wake, stop,
archive, delete, rename) carry `Idempotency-Key`. The CP already requires it
on those routes and accepts 8–128 characters of `[A-Za-z0-9._:-]`
(`apps/control-plane/src/cloud-workspaces/routes.ts:106-111`); a missing or
invalid key gets `422 idempotency_key_required` (`routes.ts:586`). SDK
clients generate a UUIDv4 when the user acts and persist it in the outbox.
Replays return the original result with `Idempotency-Replayed: true`.
Reusing a key for a different body returns `409 idempotency_key_reused`
(`routes.ts:839`). The new runtime endpoints (`runtime/connect`,
`runtime/capabilities`) and `POST /v1/device-sessions` take no idempotency
key: they are guarded by the device session and device proof, and repeating
them is safe (connect re-issues equivalent capabilities, device sessions are
cheap to re-create).

### Errors

`{ "error": { "code": "…", "message": "…", "retryable": false,
"retryAfterMs": 1000 } }`. `code` and `message` exist today; `retryable` and
`retryAfterMs` are additive and optional. Clients treat an unknown code as
non-retryable unless the HTTP status is 429, 502, 503 or 504.

### Device session

`POST /v1/device-sessions` with device proof headers. Body:
`{ "deviceId", "client": { "platform", "appVersion", "contract": { "min": 1, "max": 1 } } }`.
Response `201`:

```json
{ "deviceSessionId": "…", "stream": { "url": "wss://…/v1/device-stream",
  "ticket": "…", "ticketExpiresAt": "…" }, "contract": 1,
  "heartbeatIntervalMs": 20000 }
```

The ticket is single-use, valid 60 s, and bound to the account, CP session
and device. It exists because browser WebSocket clients cannot set an
`Authorization` header; tokens never go into URLs.

### Runtime connect

Request body: `{ "deviceSessionId", "routes": ["direct", "relay"],
"clientSessionId" }` plus device proof headers. Response `201`:

```json
{
  "workspaceId": "…", "generation": 7, "engineInstanceId": "…",
  "capabilities": {
    "engine":   { "token": "<S1 aud zeros:engine>",   "expiresAt": "…" },
    "realtime": { "token": "<S1 aud zeros:realtime>", "expiresAt": "…" }
  },
  "routes": [
    { "kind": "direct", "url": "wss://…", "priority": 0 },
    { "kind": "relay",  "url": "wss://…/v1/relay", "priority": 1 }
  ],
  "renewAt": "…", "relayHedgeMs": 400
}
```

Errors: `409 cloud_workspace_not_running` (new code, with
`"wakeable": true|false`),
`403 workspace_role_required`, `409 cloud_workspace_v2_required`,
`503 capability_issuer_unavailable`, `503 cloud_workspace_runtime_not_configured`.
Connect never wakes a workspace; the SDK calls wake explicitly (user intent)
and waits for the lifecycle event on the device stream.

### Catalog and resource versions

Every workspace document already carries `version`
(`apps/desktop/src/renderer/platform/cloud-workspace-contract.ts`). The
catalog response adds `catalogVersion` (monotonic per account) so a client can
resume the device stream from a known snapshot. Clients apply a pushed
document only if its `version` is greater than the one they hold for the same
`cloud://` workspace key.

## Part 2: Device stream

One WebSocket per signed-in device session, cloud-only, served by `realtime`.
Text frames, JSON, envelope `{ "t", "d", "c"? }` where `c` is an opaque
stream cursor on resumable server events. Schema:
[Draft schema: device stream frames](#draft-schema-device-stream-frames).

### Client → server

| Type | Payload | Notes |
| --- | --- | --- |
| `hello` | `{ contract: {min,max}, ticket, resume?: { cursor, catalogVersion, workspaces: { id: version } } }` | First frame, within 10 s |
| `attach` | `{ workspaceId, clientSessionId }` | Declares an open runtime connection; enables pushed capability renewals for it |
| `detach` | `{ workspaceId, clientSessionId }` | |
| `presence.set` | `{ workspaceId, state: "active" \| "idle" \| "away" }` | Sent on transitions only |
| `ack` | `{ cursor }` | At most once per second |
| `ping` | `{ ts }` | If the client wants an RTT sample |

### Server → client

| Type | Payload | Resumable |
| --- | --- | --- |
| `ready` | `{ deviceSessionId, cursor, resumed, heartbeatIntervalMs, contract }` | — |
| `catalog.changed` | `{ workspaceId, version, catalogVersion, op: "upsert" \| "remove", workspace? }` (full document on upsert) | yes |
| `catalog.reset` | `{ reason }`: resume impossible; fetch the snapshot again | — |
| `lifecycle.changed` | `{ workspaceId, version, status, generation, observedState, reason? }` | yes |
| `presence.changed` | `{ workspaceId, members: [{ userId, state, since }] }` (latest-wins) | no |
| `notification` | `{ id, kind, workspaceId, chatId?, turnId?, title, createdAt }` | yes |
| `capability.renewed` | `{ workspaceId, clientSessionId, capabilities }` | no |
| `capability.revoked` | `{ workspaceId?, reason, scope: "workspace" \| "account" \| "session" \| "device" \| "organization" }` | yes |
| `heartbeat` | `{ ts }` every 20 s | — |
| `pong` | `{ ts }` | — |
| `drain` | `{ reconnectAfterMs }` | — |
| `error` | `{ code, message, fatal }` | — |

Resume: the server keeps resumable events for 10 min per device session.
`hello.resume.cursor` older than that, or a different `realtime` instance
without the history, yields `ready { resumed: false }` followed by
`catalog.reset`; the client re-reads the snapshot (REST) while keeping its
last confirmed view on screen. Resource `version` comparisons make
duplicates harmless.

Heartbeat: the server sends `heartbeat` every 20 s; the client treats 45 s of
silence as dead and reconnects with full-jitter backoff (250 ms base, 30 s
cap).

Security events: Electron main's existing account security monitor
(`apps/desktop/electron/auth-security-monitor.ts`, consuming
`/v1/auth/events`) stays as is because Local organization workspaces use it.
The device stream adds `capability.revoked` for cloud runtime sessions; it
does not replace `/v1/auth/events` in v1.

## Part 3: Runtime connection

A client opens the runtime connection to one of the routes from
`runtime/connect`. Authentication is a **pre-protocol handshake**, not a
`BaseMessage` of the engine protocol
(`packages/protocol/src/messages.ts:221`): the client offers subprotocol
`zeros-cap.v1` in `Sec-WebSocket-Protocol`, and a server that speaks this
contract selects it (the engine's `handleProtocols` hook,
`apps/desktop/src/engine/transport/cloud.ts:506-507`, picks from the offered
set). For N−1 rollout the client may also offer `zeros-v1`; a server that
selects `zeros-v1` does not speak this contract, and the client falls back to
today's token-in-subprotocol behavior (`cloud.ts:70-110`) for one release
cycle.

The first client frame must be `auth` and must arrive within 10 s of the
upgrade, or the server closes with `4401` (`capability_missing`). The frame
is one JSON text message of at most 16 KiB, on top of the existing pre-auth
connection limits (`cloud.ts:128-137`):

```json
{ "t": "auth", "d": { "capability": "<S1 token for this route's audience>",
  "proof": { "timestampMs": 0, "nonce": "…", "signature": "…" },
  "clientSessionId": "…", "contract": 1 } }
```

On the direct route the token is the `zeros:engine` capability and the engine
verifies it locally (S1). On the relay route the frame carries the
`zeros:realtime` capability with its proof, plus
`"engine": { "capability", "proof" }` with the `zeros:engine` capability
(proof signed with `route: relay`); `realtime` verifies its own token and
forwards the engine pair in S2 `relay.open`. The verifier replies
`auth.ok { sessionId, scopes, expiresAtMs }` or closes with the S1 close
code. Renewal is in-band: the client sends `auth.renew` with a fresh
capability and proof, and the verifier replies `auth.renewed` with the new
`expiresAtMs`, without reconnecting. After `auth.ok` the existing engine
message protocol flows unchanged; the handshake frames never appear inside
it. Frame sketches:
[Draft schema: runtime auth frames](#draft-schema-runtime-auth-frames).

## SDK behaviors (normative for every client)

1. **Snapshot cache.** On start, show the last confirmed catalog snapshot for
   the exact account and organization, then revalidate through the device
   stream resume or a snapshot read. Never show an empty list while
   revalidating.
2. **Exact-key state.** Key every workspace by its `cloud://` identity;
   retain the last confirmed snapshot per key during revalidation; drop
   responses whose request key no longer matches; apply pushed documents only
   if `version` increases.
3. **Outbox.** Every command is enqueued with its `Idempotency-Key` before
   sending, persisted per account, retried on network errors, 429, 502, 503,
   504 and `retryable: true`, with full jitter (250 ms base, 30 s cap) until
   success, a terminal error, or user cancellation. 4xx other than 429 is
   terminal and reported once. The same key is used for every retry.
4. **Connect race.** Start the direct route immediately (if offered). If it
   is not ready within `relayHedgeMs` (default 400 ms, allowed range
   300–500 ms) start relay in parallel. The first route to reach `auth.ok`
   wins; the other is closed with `1000 superseded`. With no direct route,
   start relay immediately. If the winner later fails, reconnect with the
   same race.
5. **Silent renewal.** Renew from `capability.renewed` pushes; fall back to
   `POST …/runtime/capabilities` at 80% of lifetime. On `capability.revoked`
   or a 4403 close, close that workspace's runtime connections, try one
   connect, and show access lost only if connect is denied.
6. **Presence on transitions only.** Send `presence.set` when focus,
   visibility or input state changes; no periodic presence writes.
7. **No polling.** No periodic catalog, presence, access or lifecycle reads.
   A snapshot read happens only on start, on `catalog.reset`, or on explicit
   user refresh.
8. **Hidden surfaces inert.** Closed or hidden workspaces detach from the
   device stream and close runtime connections after the retention budget.

A conformance suite (track F1) runs the same scenarios against a contract mock
and the real CP.

## Current calls and polls → contract

| Current call or poll | File | Replacement |
| --- | --- | --- |
| Catalog refresh every 30 s (2 s during transitions) | `apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx:125` | Snapshot on start + `catalog.changed` / `lifecycle.changed` |
| Presence re-evaluation every 15 s | `apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx:512` | Event-driven `presence.set` |
| Presence refresh every 60 s | `apps/desktop/src/renderer/state/cloud-workspace-interaction.ts:4,88-91` | `presence.set` on transition; `presence.changed` push |
| List `/v1/cloud-workspaces?limit=100&cursor` | `apps/desktop/src/renderer/platform/cloud-workspaces.ts:231-255` | Same endpoint (snapshot), plus stream |
| Get workspace document | `cloud-workspaces.ts:257-270` | Same endpoint; mostly replaced by `catalog.changed` |
| Rename | `cloud-workspaces.ts:127-139` | Same endpoint via outbox |
| Wake, stop, archive, delete | `cloud-workspaces.ts:272-300` | Same endpoints via outbox; progress from `lifecycle.changed` |
| Create | `cloud-workspaces.ts:331-364` | Same endpoint via outbox |
| Runtime admission | `apps/desktop/electron/cloud-workspace-access-client.ts:457` → `routes.ts:2049` | `runtime/connect` |
| Client authority renewal every 5 s (lease 10 s) | `apps/desktop/src/engine/transport/cloud.ts:154,554-607` | `auth.renew` every ~3 min, pushed |
| Token-in-subprotocol runtime auth (`zeros-v1` parsing, `handleProtocols`) | `apps/desktop/src/engine/transport/cloud.ts:70-110,506-507` | `zeros-cap.v1` subprotocol and pre-protocol `auth` frame |
| Direct-then-relay fallback after 5 s | `apps/desktop/src/renderer/platform/bridge/runtime-client.ts:29,591-603` | Hedged connect at 400 ms, first ready wins |
| Relay bridge `/v1/cloud-workspaces/bridge` | `apps/control-plane/src/cloud-workspaces/engine-client-admission.ts:11` | Relay route over the uplink (S2) |
| History pages | `apps/desktop/src/renderer/platform/cloud-history.ts:106` | Same endpoints |

Not changed in v1: create-options (`cloud-workspaces.ts:320`), generation
recovery (`:309`), detected ports (`:118`), agent availability and prepare
(`:204-225`).

## Versioning

`contract` in `hello`, device-session and `auth` frames carries the major
version. Minor versions add optional fields, event types and error codes;
clients ignore unknown event types and fields. The server supports N and N−1
majors for at least one desktop release cycle. The OpenAPI document's
`info.version` follows the contract version.

## Failure and outage behavior

| Failure | Client behavior |
| --- | --- |
| Device stream down, `api` up | Reconnect with backoff; renew capabilities by REST at 80%; one snapshot read after reconnect if `resumed: false` |
| `api` down, VM up (full CP outage) | Existing direct runtime sessions continue up to 30 min (S1); outbox holds commands; UI shows CP offline, not workspace failure |
| Direct route fails mid-session | Reconnect with the race; relay usually wins |
| Relay fails, direct healthy | No impact |
| Revocation | Push closes sessions in ≤ 2 s p99; client tries one connect; shows access lost on denial |

## Local impact

None. The SDK and device stream are cloud-only. The renderer router keeps
sending non-cloud messages to the Local engine and keeps Local list reads and
merge semantics (plan §2.1); only the cloud-peer half of
`WorkspaceRuntimeClient` is replaced. `pnpm electron:local` sets
`ZEROS_CLOUD_WORKSPACES_ENABLED=false` and removes account settings
(`scripts/electron-local.mjs:54-82`), so neither the SDK nor the device stream
starts. Account and organization APIs used by signed-in organization-local
workspaces (`/v1/me`, organizations, teams, settings, `/v1/auth/events`) are
not part of this contract and do not change.

## Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| S3-Q1 | Device stream over WebSocket or SSE? | WebSocket: it carries client frames (`attach`, `presence.set`, `ack`), and the same `realtime` service already terminates WebSockets. |
| S3-Q2 | Should connect wake a stopped workspace? | No. Wake is an explicit, idempotent user command; connect stays side-effect free. |
| S3-Q3 | Hedge delay | 400 ms default, server-tunable in 300–500 ms via `relayHedgeMs`. |
| S3-Q4 | Replace `/v1/auth/events` with the device stream? | Not in v1; Local org workspaces depend on it. Reconsider once every client uses the SDK. |
| S3-Q5 | Outbox persistence location on the Mac | Electron main, per account, bounded (500 entries, 7 days), cleared on sign-out. |
| S3-Q6 | Version path prefix (`/v2/…`) for new endpoints? | No; keep `/v1` and evolve additively; the contract major is negotiated in bodies and frames. |
| S3-Q7 | Push full documents or deltas in `catalog.changed`? | Full documents (bounded, already schema-validated by the client); deltas later if size matters. |

## Draft schema: REST API (OpenAPI 3.1)

OpenAPI 3.1 for the REST half. Existing endpoints keep their current shapes;
the schemas constrain only the fields this contract relies on. This sketch is
a review aid until freeze; the frozen source of truth will be Zod in
`packages/protocol`.

<!-- contract-schema: s3-client-api (yaml) -->
```yaml
openapi: 3.1.0
info:
  title: Zeros cloud workspace client contract (S3)
  version: 1.0.0-draft.2
  description: >-
    DRAFT review sketch of the REST half of client contract v1 for cloud
    workspaces. Existing endpoints keep their current request and response
    shapes; schemas below constrain only the fields the contract relies on.
    New endpoints are marked x-zeros-status new. Local workspaces are not part
    of this API.
servers:
  - url: https://cp.example.invalid
security:
  - session: []
tags:
  - name: session
  - name: catalog
  - name: lifecycle
  - name: runtime
  - name: history
  - name: keys
paths:
  /v1/device-sessions:
    post:
      tags: [session]
      operationId: createDeviceSession
      x-zeros-status: new
      summary: Bind the CP session to a registered device and obtain a device-stream ticket.
      parameters:
        - $ref: '#/components/parameters/DeviceId'
        - $ref: '#/components/parameters/DeviceKeyVersion'
        - $ref: '#/components/parameters/DeviceTimestamp'
        - $ref: '#/components/parameters/DeviceNonce'
        - $ref: '#/components/parameters/DeviceSignature'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/DeviceSessionRequest'
      responses:
        '201':
          description: Device session created.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DeviceSessionResponse'
        '401':
          $ref: '#/components/responses/Error'
        '403':
          $ref: '#/components/responses/Error'
  /v1/cloud-workspaces:
    get:
      tags: [catalog]
      operationId: listCloudWorkspaces
      x-zeros-status: existing
      summary: Catalog snapshot for the signed-in account.
      parameters:
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
        - name: cursor
          in: query
          schema: { type: string, maxLength: 1024 }
      responses:
        '200':
          description: One catalog page.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CatalogPage'
        '401':
          $ref: '#/components/responses/Error'
  /v1/cloud-workspaces/{workspace}:
    get:
      tags: [catalog]
      operationId: getCloudWorkspace
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Workspace'
      responses:
        '200':
          description: Workspace document.
          content:
            application/json:
              schema:
                type: object
                required: [workspace]
                properties:
                  workspace:
                    $ref: '#/components/schemas/WorkspaceDocument'
        '404':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces:
    post:
      tags: [lifecycle]
      operationId: createCloudWorkspace
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              description: Existing create body (apps/desktop/src/renderer/platform/cloud-workspaces.ts).
      responses:
        '201':
          $ref: '#/components/responses/LifecycleAccepted'
        '202':
          $ref: '#/components/responses/LifecycleAccepted'
        '200':
          $ref: '#/components/responses/LifecycleAccepted'
        '409':
          $ref: '#/components/responses/Error'
        '422':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}:
    patch:
      tags: [lifecycle]
      operationId: renameCloudWorkspace
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - $ref: '#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string, minLength: 1, maxLength: 120 }
      responses:
        '200':
          description: Renamed.
          content:
            application/json:
              schema:
                type: object
                required: [workspace]
                properties:
                  workspace:
                    $ref: '#/components/schemas/WorkspaceDocument'
        '409':
          $ref: '#/components/responses/Error'
    delete:
      tags: [lifecycle]
      operationId: deleteCloudWorkspace
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - $ref: '#/components/parameters/IdempotencyKey'
      responses:
        '200':
          $ref: '#/components/responses/LifecycleAccepted'
        '202':
          $ref: '#/components/responses/LifecycleAccepted'
        '409':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/{operation}:
    post:
      tags: [lifecycle]
      operationId: runCloudWorkspaceLifecycle
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: operation
          in: path
          required: true
          schema: { enum: [wake, stop, archive] }
        - $ref: '#/components/parameters/IdempotencyKey'
      responses:
        '200':
          $ref: '#/components/responses/LifecycleAccepted'
        '202':
          $ref: '#/components/responses/LifecycleAccepted'
        '409':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/runtime/connect:
    post:
      tags: [runtime]
      operationId: connectCloudWorkspaceRuntime
      x-zeros-status: new
      summary: Issue S1 capabilities and runtime routes. Never wakes the workspace.
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - $ref: '#/components/parameters/DeviceId'
        - $ref: '#/components/parameters/DeviceKeyVersion'
        - $ref: '#/components/parameters/DeviceTimestamp'
        - $ref: '#/components/parameters/DeviceNonce'
        - $ref: '#/components/parameters/DeviceSignature'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConnectRequest'
      responses:
        '201':
          description: Capabilities and routes.
          headers:
            Cache-Control:
              schema: { const: no-store }
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConnectResponse'
        '403':
          $ref: '#/components/responses/Error'
        '409':
          $ref: '#/components/responses/Error'
        '503':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/runtime/capabilities:
    post:
      tags: [runtime]
      operationId: renewCloudWorkspaceCapabilities
      x-zeros-status: new
      summary: REST fallback for capability renewal when no device-stream push arrived by 80% of lifetime.
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - $ref: '#/components/parameters/DeviceId'
        - $ref: '#/components/parameters/DeviceKeyVersion'
        - $ref: '#/components/parameters/DeviceTimestamp'
        - $ref: '#/components/parameters/DeviceNonce'
        - $ref: '#/components/parameters/DeviceSignature'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [deviceSessionId, clientSessionId]
              properties:
                deviceSessionId: { $ref: '#/components/schemas/Uuid' }
                clientSessionId: { $ref: '#/components/schemas/Uuid' }
      responses:
        '201':
          description: Fresh capabilities.
          content:
            application/json:
              schema:
                type: object
                required: [capabilities, renewAt]
                properties:
                  capabilities: { $ref: '#/components/schemas/Capabilities' }
                  renewAt: { type: string, format: date-time }
        '403':
          $ref: '#/components/responses/Error'
        '409':
          $ref: '#/components/responses/Error'
        '503':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/history/chats:
    get:
      tags: [history]
      operationId: listCloudHistoryChats
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 200, default: 100 }
        - name: afterId
          in: query
          schema: { type: string, minLength: 1, maxLength: 255 }
        - name: revision
          in: query
          schema: { type: integer, minimum: 0 }
      responses:
        '200':
          $ref: '#/components/responses/HistoryPage'
        '422':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/history/messages/{chat}:
    get:
      tags: [history]
      operationId: listCloudHistoryMessages
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: chat
          in: path
          required: true
          schema: { type: string, minLength: 1, maxLength: 255 }
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 1000, default: 200 }
        - name: beforeMsgId
          in: query
          schema: { type: string, minLength: 1, maxLength: 255 }
        - name: before
          in: query
          schema: { type: integer, minimum: 0 }
      responses:
        '200':
          $ref: '#/components/responses/HistoryPage'
        '422':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/history/search:
    get:
      tags: [history]
      operationId: searchCloudHistory
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: query
          in: query
          required: true
          schema: { type: string, maxLength: 1000 }
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
        - name: chatId
          in: query
          schema: { type: string, minLength: 1, maxLength: 255 }
        - name: folder
          in: query
          schema: { type: string, minLength: 1, maxLength: 4096 }
        - name: cursor
          in: query
          schema: { type: string, minLength: 1, maxLength: 1024 }
        - name: revision
          in: query
          schema: { type: integer, minimum: 0 }
      responses:
        '200':
          $ref: '#/components/responses/HistoryPage'
        '422':
          $ref: '#/components/responses/Error'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/history/commands:
    get:
      tags: [history]
      operationId: listCloudCommandReceipts
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: conversationId
          in: query
          required: true
          schema: { type: string, pattern: '^[A-Za-z0-9._:-]{1,128}$' }
      responses:
        '200':
          $ref: '#/components/responses/HistoryPage'
  /v1/organizations/{organization}/cloud-workspaces/{workspace}/history/commands/{command}:
    get:
      tags: [history]
      operationId: getCloudCommandReceipt
      x-zeros-status: existing
      parameters:
        - $ref: '#/components/parameters/Organization'
        - $ref: '#/components/parameters/Workspace'
        - name: command
          in: path
          required: true
          schema: { $ref: '#/components/schemas/Uuid' }
      responses:
        '200':
          $ref: '#/components/responses/HistoryPage'
        '404':
          $ref: '#/components/responses/Error'
  /.well-known/zeros-capabilities/jwks.json:
    get:
      tags: [keys]
      operationId: getCapabilityKeys
      x-zeros-status: new
      security: []
      responses:
        '200':
          description: Public Ed25519 verification keys (next, current, retiring).
          headers:
            Cache-Control:
              schema: { const: max-age=300 }
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Jwks'
components:
  securitySchemes:
    session:
      type: http
      scheme: bearer
      description: CP session access token, as used by the desktop today.
  parameters:
    Organization:
      name: organization
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Uuid' }
    Workspace:
      name: workspace
      in: path
      required: true
      schema: { $ref: '#/components/schemas/Uuid' }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: Existing CP rule; SDK clients send a UUIDv4.
      schema: { type: string, minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }
    DeviceId:
      name: x-zeros-device-id
      in: header
      required: true
      schema: { $ref: '#/components/schemas/Uuid' }
    DeviceKeyVersion:
      name: x-zeros-device-key-version
      in: header
      required: true
      schema: { type: string, pattern: '^[1-9][0-9]{0,15}$' }
    DeviceTimestamp:
      name: x-zeros-device-timestamp
      in: header
      required: true
      schema: { type: string, pattern: '^(?:0|[1-9][0-9]{0,15})$' }
    DeviceNonce:
      name: x-zeros-device-nonce
      in: header
      required: true
      schema: { type: string, pattern: '^[A-Za-z0-9_-]{32}$' }
    DeviceSignature:
      name: x-zeros-device-signature
      in: header
      required: true
      schema: { type: string, pattern: '^[A-Za-z0-9_-]{86}$' }
  responses:
    Error:
      description: Error envelope.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    LifecycleAccepted:
      description: Command accepted or replayed. Replays set Idempotency-Replayed true.
      headers:
        Idempotency-Replayed:
          schema: { const: 'true' }
      content:
        application/json:
          schema:
            type: object
            properties:
              workspace: { $ref: '#/components/schemas/WorkspaceDocument' }
              intent: { type: object }
    HistoryPage:
      description: Existing history response (apps/control-plane/src/cloud-workspaces/history.ts).
      content:
        application/json:
          schema:
            type: object
  schemas:
    Uuid:
      type: string
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ContractRange:
      type: object
      required: [min, max]
      properties:
        min: { type: integer, minimum: 1 }
        max: { type: integer, minimum: 1 }
    Error:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code]
          properties:
            code: { type: string, pattern: '^[a-z][a-z0-9_]{2,127}$' }
            message: { type: string, maxLength: 512 }
            retryable: { type: boolean }
            retryAfterMs: { type: integer, minimum: 0, maximum: 3600000 }
            wakeable: { type: boolean }
    DeviceSessionRequest:
      type: object
      required: [deviceId, client]
      properties:
        deviceId: { $ref: '#/components/schemas/Uuid' }
        client:
          type: object
          required: [platform, appVersion, contract]
          properties:
            platform: { enum: [macos, windows, linux, ios, ipados, android, web] }
            appVersion: { type: string, minLength: 1, maxLength: 64 }
            contract: { $ref: '#/components/schemas/ContractRange' }
    DeviceSessionResponse:
      type: object
      required: [deviceSessionId, stream, contract, heartbeatIntervalMs]
      properties:
        deviceSessionId: { $ref: '#/components/schemas/Uuid' }
        stream:
          type: object
          required: [url, ticket, ticketExpiresAt]
          properties:
            url: { type: string, pattern: '^wss://' }
            ticket: { type: string, minLength: 32, maxLength: 512 }
            ticketExpiresAt: { type: string, format: date-time }
        contract: { type: integer, minimum: 1 }
        heartbeatIntervalMs: { type: integer, minimum: 5000, maximum: 60000 }
    WorkspaceDocument:
      type: object
      description: >-
        Existing CloudWorkspaceDocumentSchema
        (apps/desktop/src/renderer/platform/cloud-workspace-contract.ts).
        Only the fields the contract relies on are constrained here.
      required: [id, organizationId, version, status, placement]
      properties:
        id: { $ref: '#/components/schemas/Uuid' }
        organizationId: { $ref: '#/components/schemas/Uuid' }
        version: { type: integer, minimum: 0 }
        status: { type: string, minLength: 1, maxLength: 64 }
        placement: { const: cloud }
        accessRevision: { type: integer, minimum: 1 }
    CatalogPage:
      type: object
      required: [workspaces]
      properties:
        workspaces:
          type: array
          maxItems: 100
          items: { $ref: '#/components/schemas/WorkspaceDocument' }
        nextCursor: { type: [string, 'null'], maxLength: 1024 }
        catalogVersion:
          type: integer
          minimum: 0
          description: Additive in v1; monotonic per account; used to resume the device stream.
    ConnectRequest:
      type: object
      required: [deviceSessionId, clientSessionId, routes]
      properties:
        deviceSessionId: { $ref: '#/components/schemas/Uuid' }
        clientSessionId: { $ref: '#/components/schemas/Uuid' }
        routes:
          type: array
          minItems: 1
          uniqueItems: true
          items: { enum: [direct, relay] }
    CapabilityGrant:
      type: object
      required: [token, expiresAt]
      properties:
        token:
          type: string
          minLength: 32
          maxLength: 4096
          pattern: '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
        expiresAt: { type: string, format: date-time }
    Capabilities:
      type: object
      required: [engine, realtime]
      properties:
        engine: { $ref: '#/components/schemas/CapabilityGrant' }
        realtime: { $ref: '#/components/schemas/CapabilityGrant' }
    Route:
      type: object
      required: [kind, url, priority]
      properties:
        kind: { enum: [direct, relay] }
        url: { type: string, pattern: '^wss://' }
        priority: { type: integer, minimum: 0, maximum: 9 }
    ConnectResponse:
      type: object
      required: [workspaceId, generation, capabilities, routes, renewAt, relayHedgeMs]
      properties:
        workspaceId: { $ref: '#/components/schemas/Uuid' }
        generation: { type: integer, minimum: 1 }
        engineInstanceId: { $ref: '#/components/schemas/Uuid' }
        capabilities: { $ref: '#/components/schemas/Capabilities' }
        routes:
          type: array
          minItems: 1
          maxItems: 4
          items: { $ref: '#/components/schemas/Route' }
        renewAt: { type: string, format: date-time }
        relayHedgeMs: { type: integer, minimum: 300, maximum: 500, default: 400 }
    Jwks:
      type: object
      required: [keys]
      properties:
        keys:
          type: array
          minItems: 1
          maxItems: 3
          items:
            type: object
            required: [kty, crv, x, kid, use, alg]
            properties:
              kty: { const: OKP }
              crv: { const: Ed25519 }
              x: { type: string, pattern: '^[A-Za-z0-9_-]{43}$' }
              kid: { type: string, maxLength: 64 }
              use: { const: sig }
              alg: { const: EdDSA }
              zeros_state: { enum: [next, current, retiring] }
```

## Draft schema: device stream frames

JSON Schema 2020-12 for client and server device-stream frames. This sketch is
a review aid until freeze; the frozen source of truth will be Zod in
`packages/protocol`.

<!-- contract-schema: s3-device-stream-events (json) -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://zeros.dev/schemas/cloud-contracts/s3-device-stream-events.schema.json",
  "title": "Zeros device stream (S3) frames",
  "description": "DRAFT 1.0.0-draft.2. Review sketch. Envelope { t, d, c? }; c is an opaque cursor present on resumable server events. Clients ignore unknown event types and unknown fields.",
  "oneOf": [
    { "$ref": "#/$defs/client.hello" },
    { "$ref": "#/$defs/client.attach" },
    { "$ref": "#/$defs/client.detach" },
    { "$ref": "#/$defs/client.presence.set" },
    { "$ref": "#/$defs/client.ack" },
    { "$ref": "#/$defs/client.ping" },
    { "$ref": "#/$defs/server.ready" },
    { "$ref": "#/$defs/server.catalog.changed" },
    { "$ref": "#/$defs/server.catalog.reset" },
    { "$ref": "#/$defs/server.lifecycle.changed" },
    { "$ref": "#/$defs/server.presence.changed" },
    { "$ref": "#/$defs/server.notification" },
    { "$ref": "#/$defs/server.capability.renewed" },
    { "$ref": "#/$defs/server.capability.revoked" },
    { "$ref": "#/$defs/server.heartbeat" },
    { "$ref": "#/$defs/server.pong" },
    { "$ref": "#/$defs/server.drain" },
    { "$ref": "#/$defs/server.error" }
  ],
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "version": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "timestampMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "isoTime": { "type": "string", "format": "date-time" },
    "cursor": { "type": "string", "minLength": 1, "maxLength": 256 },
    "code": { "type": "string", "pattern": "^[a-z][a-z0-9_]{2,63}$" },
    "contractRange": {
      "type": "object",
      "required": ["min", "max"],
      "properties": { "min": { "type": "integer", "minimum": 1 }, "max": { "type": "integer", "minimum": 1 } }
    },
    "frame": {
      "type": "object",
      "required": ["t", "d"],
      "properties": { "d": { "type": "object" } }
    },
    "resumable": {
      "type": "object",
      "required": ["t", "d", "c"],
      "properties": { "c": { "$ref": "#/$defs/cursor" }, "d": { "type": "object" } }
    },
    "capabilityGrant": {
      "type": "object",
      "required": ["token", "expiresAt"],
      "properties": {
        "token": { "type": "string", "minLength": 32, "maxLength": 4096, "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" },
        "expiresAt": { "$ref": "#/$defs/isoTime" }
      }
    },
    "capabilities": {
      "type": "object",
      "required": ["engine", "realtime"],
      "properties": {
        "engine": { "$ref": "#/$defs/capabilityGrant" },
        "realtime": { "$ref": "#/$defs/capabilityGrant" }
      }
    },
    "workspaceDocument": {
      "type": "object",
      "description": "The existing workspace document (apps/desktop/src/renderer/platform/cloud-workspace-contract.ts, CloudWorkspaceDocumentSchema). Only the fields the stream relies on are constrained here.",
      "required": ["id", "organizationId", "version", "status", "placement"],
      "properties": {
        "id": { "$ref": "#/$defs/uuid" },
        "organizationId": { "$ref": "#/$defs/uuid" },
        "version": { "$ref": "#/$defs/version" },
        "status": { "type": "string", "minLength": 1, "maxLength": 64 },
        "placement": { "const": "cloud" }
      }
    },
    "client.hello": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "hello" },
        "d": {
          "type": "object",
          "required": ["contract", "ticket"],
          "properties": {
            "contract": { "$ref": "#/$defs/contractRange" },
            "ticket": { "type": "string", "minLength": 32, "maxLength": 512 },
            "resume": {
              "type": "object",
              "required": ["cursor", "catalogVersion"],
              "properties": {
                "cursor": { "$ref": "#/$defs/cursor" },
                "catalogVersion": { "$ref": "#/$defs/version" },
                "workspaces": { "type": "object", "maxProperties": 1000, "additionalProperties": { "$ref": "#/$defs/version" } }
              }
            }
          }
        }
      }
    },
    "client.attach": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "attach" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "clientSessionId"],
          "properties": { "workspaceId": { "$ref": "#/$defs/uuid" }, "clientSessionId": { "$ref": "#/$defs/uuid" } }
        }
      }
    },
    "client.detach": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "detach" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "clientSessionId"],
          "properties": { "workspaceId": { "$ref": "#/$defs/uuid" }, "clientSessionId": { "$ref": "#/$defs/uuid" } }
        }
      }
    },
    "client.presence.set": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "presence.set" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "state"],
          "properties": { "workspaceId": { "$ref": "#/$defs/uuid" }, "state": { "enum": ["active", "idle", "away"] } }
        }
      }
    },
    "client.ack": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "ack" },
        "d": { "type": "object", "required": ["cursor"], "properties": { "cursor": { "$ref": "#/$defs/cursor" } } }
      }
    },
    "client.ping": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "ping" },
        "d": { "type": "object", "required": ["ts"], "properties": { "ts": { "$ref": "#/$defs/timestampMs" } } }
      }
    },
    "server.ready": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "ready" },
        "d": {
          "type": "object",
          "required": ["deviceSessionId", "cursor", "resumed", "heartbeatIntervalMs", "contract"],
          "properties": {
            "deviceSessionId": { "$ref": "#/$defs/uuid" },
            "cursor": { "$ref": "#/$defs/cursor" },
            "resumed": { "type": "boolean" },
            "heartbeatIntervalMs": { "type": "integer", "minimum": 5000, "maximum": 60000 },
            "contract": { "type": "integer", "minimum": 1 }
          }
        }
      }
    },
    "server.catalog.changed": {
      "allOf": [{ "$ref": "#/$defs/resumable" }],
      "properties": {
        "t": { "const": "catalog.changed" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "version", "op", "catalogVersion"],
          "properties": {
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "version": { "$ref": "#/$defs/version" },
            "catalogVersion": { "$ref": "#/$defs/version" },
            "op": { "enum": ["upsert", "remove"] },
            "workspace": { "$ref": "#/$defs/workspaceDocument" }
          },
          "if": { "properties": { "op": { "const": "upsert" } } },
          "then": { "required": ["workspace"] }
        }
      }
    },
    "server.catalog.reset": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "catalog.reset" },
        "d": { "type": "object", "required": ["reason"], "properties": { "reason": { "enum": ["resume_expired", "instance_changed", "contract_changed", "server_reset"] } } }
      }
    },
    "server.lifecycle.changed": {
      "allOf": [{ "$ref": "#/$defs/resumable" }],
      "properties": {
        "t": { "const": "lifecycle.changed" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "version", "status", "generation", "observedState"],
          "properties": {
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "version": { "$ref": "#/$defs/version" },
            "status": { "type": "string", "minLength": 1, "maxLength": 64 },
            "generation": { "type": "integer", "minimum": 1 },
            "observedState": { "type": "string", "minLength": 1, "maxLength": 64 },
            "reason": { "$ref": "#/$defs/code" }
          }
        }
      }
    },
    "server.presence.changed": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "presence.changed" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "members"],
          "properties": {
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "members": {
              "type": "array",
              "maxItems": 256,
              "items": {
                "type": "object",
                "required": ["userId", "state", "since"],
                "properties": {
                  "userId": { "$ref": "#/$defs/uuid" },
                  "state": { "enum": ["active", "idle", "away"] },
                  "since": { "$ref": "#/$defs/isoTime" }
                }
              }
            }
          }
        }
      }
    },
    "server.notification": {
      "allOf": [{ "$ref": "#/$defs/resumable" }],
      "properties": {
        "t": { "const": "notification" },
        "d": {
          "type": "object",
          "required": ["id", "kind", "workspaceId", "title", "createdAt"],
          "properties": {
            "id": { "$ref": "#/$defs/uuid" },
            "kind": { "enum": ["turn.completed", "turn.failed", "turn.needs_attention", "workspace.stopped", "workspace.funds_low"] },
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "chatId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
            "turnId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
            "title": { "type": "string", "minLength": 1, "maxLength": 200 },
            "createdAt": { "$ref": "#/$defs/isoTime" }
          }
        }
      }
    },
    "server.capability.renewed": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "capability.renewed" },
        "d": {
          "type": "object",
          "required": ["workspaceId", "clientSessionId", "capabilities"],
          "properties": {
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "clientSessionId": { "$ref": "#/$defs/uuid" },
            "capabilities": { "$ref": "#/$defs/capabilities" }
          }
        }
      }
    },
    "server.capability.revoked": {
      "allOf": [{ "$ref": "#/$defs/resumable" }],
      "properties": {
        "t": { "const": "capability.revoked" },
        "d": {
          "type": "object",
          "required": ["reason", "scope"],
          "properties": {
            "workspaceId": { "$ref": "#/$defs/uuid" },
            "reason": { "$ref": "#/$defs/code" },
            "scope": { "enum": ["workspace", "account", "session", "device", "organization"] }
          },
          "if": { "properties": { "scope": { "const": "workspace" } } },
          "then": { "required": ["workspaceId"] }
        }
      }
    },
    "server.heartbeat": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "heartbeat" },
        "d": { "type": "object", "required": ["ts"], "properties": { "ts": { "$ref": "#/$defs/timestampMs" } } }
      }
    },
    "server.pong": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "pong" },
        "d": { "type": "object", "required": ["ts"], "properties": { "ts": { "$ref": "#/$defs/timestampMs" } } }
      }
    },
    "server.drain": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "drain" },
        "d": { "type": "object", "required": ["reconnectAfterMs"], "properties": { "reconnectAfterMs": { "type": "integer", "minimum": 0, "maximum": 60000 } } }
      }
    },
    "server.error": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "error" },
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
    }
  },
  "examples": [
    { "t": "ready", "d": { "deviceSessionId": "77777777-7777-4777-8777-777777777777", "cursor": "c-1", "resumed": false, "heartbeatIntervalMs": 20000, "contract": 1 } },
    { "t": "lifecycle.changed", "c": "c-2", "d": { "workspaceId": "33333333-3333-4333-8333-333333333333", "version": 41, "status": "running", "generation": 7, "observedState": "running" } },
    { "t": "capability.revoked", "c": "c-3", "d": { "workspaceId": "33333333-3333-4333-8333-333333333333", "reason": "membership_changed", "scope": "workspace" } },
    { "t": "presence.set", "d": { "workspaceId": "33333333-3333-4333-8333-333333333333", "state": "active" } }
  ]
}
```

## Draft schema: runtime auth frames

JSON Schema 2020-12 for the pre-protocol handshake frames of Part 3. They
are not `BaseMessage` messages and never appear after `auth.ok`. This sketch
is a review aid until freeze; the frozen source of truth will be Zod in
`packages/protocol`.

<!-- contract-schema: s3-runtime-auth-frames (json) -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://zeros.dev/schemas/cloud-contracts/s3-runtime-auth-frames.schema.json",
  "title": "Zeros runtime connection auth handshake (S3, pre-protocol)",
  "description": "DRAFT 1.0.0-draft.2. Review sketch. Frames exchanged before the engine message protocol starts; envelope { t, d }, one JSON text message of at most 16 KiB. auth must arrive within 10 s of the WebSocket upgrade; renewal is in-band.",
  "oneOf": [
    { "$ref": "#/$defs/client.auth" },
    { "$ref": "#/$defs/client.auth.renew" },
    { "$ref": "#/$defs/server.auth.ok" },
    { "$ref": "#/$defs/server.auth.renewed" }
  ],
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "timestampMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "token": {
      "type": "string",
      "minLength": 32,
      "maxLength": 4096,
      "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
      "description": "S1 capability (JWS compact) for the route's audience."
    },
    "proof": {
      "type": "object",
      "required": ["timestampMs", "nonce", "signature"],
      "properties": {
        "timestampMs": { "$ref": "#/$defs/timestampMs" },
        "nonce": { "type": "string", "pattern": "^[A-Za-z0-9_-]{22}$" },
        "signature": { "type": "string", "pattern": "^[A-Za-z0-9_-]{86}$" }
      },
      "additionalProperties": false
    },
    "frame": {
      "type": "object",
      "required": ["t", "d"],
      "properties": { "d": { "type": "object" } }
    },
    "client.auth": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "auth" },
        "d": {
          "type": "object",
          "required": ["capability", "proof", "clientSessionId", "contract"],
          "properties": {
            "capability": { "$ref": "#/$defs/token" },
            "proof": { "$ref": "#/$defs/proof" },
            "clientSessionId": { "$ref": "#/$defs/uuid" },
            "contract": { "type": "integer", "minimum": 1 },
            "engine": {
              "type": "object",
              "required": ["capability", "proof"],
              "properties": {
                "capability": { "$ref": "#/$defs/token" },
                "proof": { "$ref": "#/$defs/proof" }
              },
              "additionalProperties": false,
              "description": "Relay route only: the zeros:engine capability and proof (signed with route: relay) that realtime forwards in S2 relay.open."
            }
          },
          "additionalProperties": false
        }
      }
    },
    "client.auth.renew": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "auth.renew" },
        "d": {
          "type": "object",
          "required": ["capability", "proof"],
          "properties": {
            "capability": { "$ref": "#/$defs/token" },
            "proof": { "$ref": "#/$defs/proof" }
          },
          "additionalProperties": false
        }
      }
    },
    "server.auth.ok": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "auth.ok" },
        "d": {
          "type": "object",
          "required": ["sessionId", "scopes", "expiresAtMs"],
          "properties": {
            "sessionId": { "$ref": "#/$defs/uuid" },
            "scopes": {
              "type": "array",
              "minItems": 1,
              "maxItems": 32,
              "items": { "type": "string", "minLength": 1, "maxLength": 128 }
            },
            "expiresAtMs": { "$ref": "#/$defs/timestampMs" }
          },
          "additionalProperties": false
        }
      }
    },
    "server.auth.renewed": {
      "allOf": [{ "$ref": "#/$defs/frame" }],
      "properties": {
        "t": { "const": "auth.renewed" },
        "d": {
          "type": "object",
          "required": ["expiresAtMs"],
          "properties": { "expiresAtMs": { "$ref": "#/$defs/timestampMs" } },
          "additionalProperties": false
        }
      }
    }
  },
  "examples": [
    {
      "t": "auth",
      "d": {
        "capability": "aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccccccccccccccccccccccc",
        "proof": { "timestampMs": 1760000000000, "nonce": "0123456789abcdef012345", "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        "clientSessionId": "55555555-5555-4555-8555-555555555555",
        "contract": 1
      }
    },
    {
      "t": "auth.ok",
      "d": {
        "sessionId": "66666666-6666-4666-8666-666666666666",
        "scopes": ["ws:read", "ws:edit"],
        "expiresAtMs": 1760000000300
      }
    }
  ]
}
```
