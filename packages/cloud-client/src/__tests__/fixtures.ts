// One minimal, schema-valid instance per S3 contract shape. The mapped
// `satisfies` records fail to compile when the generated types gain a shape
// this file does not cover, and the round-trip test validates every value
// against the frozen markdown schemas with ajv — so types, fixtures and the
// contract cannot drift apart in either direction.

import type {
  DeviceStreamFrameType,
  DeviceStreamFrame,
} from "../generated/device-stream";
import type {
  RuntimeAuthFrame,
  RuntimeAuthFrameType,
} from "../generated/runtime-auth";
import type {
  Capabilities,
  CloudAgentBootScope,
  CatalogPage,
  ConnectRequest,
  ConnectResponse,
  ContractError,
  DeviceSessionRequest,
  DeviceSessionResponse,
  Jwks,
  RestSchemaName,
  WorkspaceDocument,
} from "../generated/rest";

export const WORKSPACE = "33333333-3333-4333-8333-333333333333";
export const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
export const DEVICE = "11111111-1111-4111-8111-111111111111";
export const DEVICE_SESSION = "77777777-7777-4777-8777-777777777777";
export const CLIENT_SESSION = "55555555-5555-4555-8555-555555555555";
export const NOW_ISO = "2026-10-16T00:00:00.000Z";
// S1 capability token shape: three base64url segments, 32+ chars overall.
export const TOKEN = `aaaaaaaaaaaaaaaa.${"b".repeat(38)}.${"c".repeat(43)}`;
export const NONCE = "0123456789abcdef012345";
export const SIGNATURE = "A".repeat(86);
export const PROOF = { timestampMs: 1760000000000, nonce: NONCE, signature: SIGNATURE };

export const WORKSPACE_DOCUMENT = {
  id: WORKSPACE,
  organizationId: ORGANIZATION,
  version: 41,
  status: "running",
  placement: "cloud",
} satisfies WorkspaceDocument;

export const CAPABILITIES = {
  engine: { token: TOKEN, expiresAt: NOW_ISO },
  realtime: { token: TOKEN, expiresAt: NOW_ISO },
} satisfies Capabilities;

export const BOOT_SCOPE = {
  organizationId: ORGANIZATION, workspaceId: WORKSPACE, generation: 7,
  engineInstanceId: "44444444-4444-4444-8444-444444444444",
  bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", writerEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  fundingOwnerUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fundingOwnerEpoch: 1,
} satisfies CloudAgentBootScope;
export const RUNTIME_BINDING = { authorityEpoch: 3, bootScope: BOOT_SCOPE };

export const DEVICE_STREAM_FIXTURES = {
  hello: {
    t: "hello",
    d: {
      contract: { min: 1, max: 1 },
      ticket: "t".repeat(32),
    },
  },
  attach: { t: "attach", d: { workspaceId: WORKSPACE, clientSessionId: CLIENT_SESSION } },
  detach: { t: "detach", d: { workspaceId: WORKSPACE, clientSessionId: CLIENT_SESSION } },
  "presence.set": { t: "presence.set", d: { workspaceId: WORKSPACE, state: "active" } },
  ack: { t: "ack", d: { cursor: "c-7" } },
  ping: { t: "ping", d: { ts: 1760000000000 } },
  ready: {
    t: "ready",
    d: {
      deviceSessionId: DEVICE_SESSION,
      cursor: "c-1",
      resumed: false,
      heartbeatIntervalMs: 20000,
      contract: 1,
      organizationFeatures: [{ organizationId: ORGANIZATION, deviceStream: true, presence: true }],
    },
  },
  "catalog.changed": {
    t: "catalog.changed",
    c: "c-2",
    d: {
      workspaceId: WORKSPACE,
      version: 41,
      catalogVersion: 9,
      op: "upsert",
      workspace: WORKSPACE_DOCUMENT,
    },
  },
  "catalog.reset": { t: "catalog.reset", d: { reason: "resume_expired" } },
  "lifecycle.changed": {
    t: "lifecycle.changed",
    c: "c-3",
    d: {
      workspaceId: WORKSPACE,
      version: 41,
      status: "running",
      generation: 7,
      observedState: "running",
    },
  },
  "presence.changed": {
    t: "presence.changed",
    d: { workspaceId: WORKSPACE, members: [{ userId: DEVICE, state: "active", since: NOW_ISO }] },
  },
  notification: {
    t: "notification",
    c: "c-4",
    d: {
      id: "88888888-8888-4888-8888-888888888888",
      kind: "turn.completed",
      workspaceId: WORKSPACE,
      title: "Turn finished",
      createdAt: NOW_ISO,
    },
  },
  "capability.renewed": {
    t: "capability.renewed",
    d: { workspaceId: WORKSPACE, clientSessionId: CLIENT_SESSION, capabilities: CAPABILITIES },
  },
  "capability.revoked": {
    t: "capability.revoked",
    c: "c-5",
    d: { workspaceId: WORKSPACE, reason: "membership_changed", scope: "workspace" },
  },
  heartbeat: { t: "heartbeat", d: { ts: 1760000000000 } },
  pong: { t: "pong", d: { ts: 1760000000000 } },
  drain: { t: "drain", d: { reconnectAfterMs: 250 } },
  error: { t: "error", d: { code: "ticket_expired", message: "fetch a new ticket", fatal: true } },
} satisfies Record<DeviceStreamFrameType, DeviceStreamFrame>;

export const RUNTIME_AUTH_FIXTURES = {
  auth: {
    t: "auth",
    d: {
      capability: TOKEN,
      proof: PROOF,
      clientSessionId: CLIENT_SESSION,
      contract: 1,
    },
  },
  "auth.renew": { t: "auth.renew", d: { capability: TOKEN, proof: PROOF } },
  "auth.ok": {
    t: "auth.ok",
    d: { sessionId: "66666666-6666-4666-8666-666666666666", scopes: ["ws:read"], expiresAtMs: 1760000000300 },
  },
  "auth.renewed": { t: "auth.renewed", d: { expiresAtMs: 1760000000300 } },
} satisfies Record<RuntimeAuthFrameType, RuntimeAuthFrame>;

export const REST_FIXTURES = {
  Uuid: WORKSPACE,
  ContractRange: { min: 1, max: 1 },
  Error: {
    error: { code: "workspace_archived", message: "archived", retryable: false },
  } satisfies ContractError,
  DeviceSessionRequest: {
    deviceId: DEVICE,
    client: { platform: "macos", appVersion: "1.2.3", contract: { min: 1, max: 1 } },
  } satisfies DeviceSessionRequest,
  DeviceSessionResponse: {
    deviceSessionId: DEVICE_SESSION,
    stream: { url: "wss://rt.example.invalid/stream", ticket: "t".repeat(32), ticketExpiresAt: NOW_ISO },
    contract: 1,
    heartbeatIntervalMs: 20000,
  } satisfies DeviceSessionResponse,
  WorkspaceDocument: WORKSPACE_DOCUMENT,
  CatalogPage: {
    workspaces: [WORKSPACE_DOCUMENT],
    nextCursor: null,
    catalogVersion: 9,
  } satisfies CatalogPage,
  ConnectRequest: {
    deviceSessionId: DEVICE_SESSION,
    clientSessionId: CLIENT_SESSION,
    routes: ["direct", "relay"],
  } satisfies ConnectRequest,
  CapabilityGrant: { token: TOKEN, expiresAt: NOW_ISO },
  Capabilities: CAPABILITIES,
  CloudAgentBootScope: BOOT_SCOPE,
  RuntimeBinding: RUNTIME_BINDING,
  Route: { kind: "direct", url: "wss://vm.example.invalid/runtime", priority: 0 },
  ConnectResponse: {
    workspaceId: WORKSPACE,
    generation: 7,
    engineInstanceId: BOOT_SCOPE.engineInstanceId,
    runtimeBinding: RUNTIME_BINDING,
    capabilities: CAPABILITIES,
    routes: [
      { kind: "direct", url: "wss://vm.example.invalid/runtime", priority: 0 },
      { kind: "relay", url: "wss://rt.example.invalid/relay", priority: 1 },
    ],
    renewAt: NOW_ISO,
    relayHedgeMs: 400,
  } satisfies ConnectResponse,
  Jwks: {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: "A".repeat(43),
        kid: "key-2026-10",
        use: "sig",
        alg: "EdDSA",
        zeros_state: "current",
      },
    ],
  } satisfies Jwks,
} satisfies Record<RestSchemaName, unknown>;
