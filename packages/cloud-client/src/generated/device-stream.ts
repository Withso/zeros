// GENERATED from docs/cloud-workspace/contracts/s3-client-contract.md (s3-device-stream-events).
// Do not edit by hand; run `pnpm --dir packages/cloud-client generate`.

export type Uuid = string;

export type Version = number;

export type TimestampMs = number;

export type IsoTime = string;

export type Cursor = string;

export type Code = string;

export type ContractRange = {
  min: number;
  max: number;
};

export type Frame = {
  d: Record<string, unknown>;
  t: unknown;
};

export type Resumable = {
  c: Cursor;
  d: Record<string, unknown>;
  t: unknown;
};

export type CapabilityGrant = {
  token: string;
  expiresAt: IsoTime;
};

export type Capabilities = {
  engine: CapabilityGrant;
  realtime: CapabilityGrant;
};

/** The existing workspace document (apps/desktop/src/renderer/platform/cloud-workspace-contract.ts, CloudWorkspaceDocumentSchema). Only the fields the stream relies on are constrained here. */
export type WorkspaceDocument = {
  id: Uuid;
  organizationId: Uuid;
  version: Version;
  status: string;
  placement: "cloud";
};

export type OrganizationFeatures = {
  organizationId: Uuid;
  deviceStream: boolean;
  presence: boolean;
}[];

export type ClientHello = Frame & {
  t: "hello";
  d: {
    contract: ContractRange;
    ticket: string;
    resume?: {
      cursor: Cursor;
      catalogVersion: Version;
      workspaces?: Record<string, Version>;
    };
  };
};

export type ClientAttach = Frame & {
  t: "attach";
  d: {
    workspaceId: Uuid;
    clientSessionId: Uuid;
  };
};

export type ClientDetach = Frame & {
  t: "detach";
  d: {
    workspaceId: Uuid;
    clientSessionId: Uuid;
  };
};

export type ClientPresenceSet = Frame & {
  t: "presence.set";
  d: {
    workspaceId: Uuid;
    state: "active" | "idle" | "away";
  };
};

export type ClientAck = Frame & {
  t: "ack";
  d: {
    cursor: Cursor;
  };
};

export type ClientPing = Frame & {
  t: "ping";
  d: {
    ts: TimestampMs;
  };
};

export type ServerReady = Frame & {
  t: "ready";
  d: {
    deviceSessionId: Uuid;
    cursor: Cursor;
    resumed: boolean;
    heartbeatIntervalMs: number;
    contract: number;
    organizationFeatures?: OrganizationFeatures;
  };
};

export type ServerCatalogChanged = Resumable & {
  t: "catalog.changed";
  d: {
    workspaceId: Uuid;
    version: Version;
    catalogVersion: Version;
    op: "upsert" | "remove";
    workspace?: WorkspaceDocument;
  };
};

export type ServerCatalogReset = Frame & {
  t: "catalog.reset";
  d: {
    reason: "resume_expired" | "instance_changed" | "contract_changed" | "server_reset";
  };
};

export type ServerLifecycleChanged = Resumable & {
  t: "lifecycle.changed";
  d: {
    workspaceId: Uuid;
    version: Version;
    status: string;
    generation: number;
    observedState: string;
    reason?: Code;
  };
};

export type ServerPresenceChanged = Frame & {
  t: "presence.changed";
  d: {
    workspaceId: Uuid;
    members: ({
      userId: Uuid;
      state: "active" | "idle" | "away";
      since: IsoTime;
    })[];
  };
};

export type ServerNotification = Resumable & {
  t: "notification";
  d: {
    id: Uuid;
    kind: "turn.completed" | "turn.failed" | "turn.needs_attention" | "workspace.stopped" | "workspace.funds_low";
    workspaceId: Uuid;
    chatId?: string;
    turnId?: string;
    title: string;
    createdAt: IsoTime;
  };
};

export type ServerCapabilityRenewed = Frame & {
  t: "capability.renewed";
  d: {
    workspaceId: Uuid;
    clientSessionId: Uuid;
    capabilities: Capabilities;
  };
};

export type ServerCapabilityRevoked = Resumable & {
  t: "capability.revoked";
  d: {
    workspaceId?: Uuid;
    reason: Code;
    scope: "workspace" | "account" | "session" | "device" | "organization";
  };
};

export type ServerHeartbeat = Frame & {
  t: "heartbeat";
  d: {
    ts: TimestampMs;
  };
};

export type ServerPong = Frame & {
  t: "pong";
  d: {
    ts: TimestampMs;
  };
};

export type ServerDrain = Frame & {
  t: "drain";
  d: {
    reconnectAfterMs: number;
  };
};

export type ServerError = Frame & {
  t: "error";
  d: {
    code: Code;
    message: string;
    fatal: boolean;
  };
};

export type DeviceStreamClientFrame =
  | ClientHello
  | ClientAttach
  | ClientDetach
  | ClientPresenceSet
  | ClientAck
  | ClientPing;

export type DeviceStreamServerEvent =
  | ServerReady
  | ServerCatalogChanged
  | ServerCatalogReset
  | ServerLifecycleChanged
  | ServerPresenceChanged
  | ServerNotification
  | ServerCapabilityRenewed
  | ServerCapabilityRevoked
  | ServerHeartbeat
  | ServerPong
  | ServerDrain
  | ServerError;

export type DeviceStreamFrame = DeviceStreamClientFrame | DeviceStreamServerEvent;
export type DeviceStreamFrameType = DeviceStreamFrame["t"];
export type DeviceStreamClientFrameType = DeviceStreamClientFrame["t"];
export type DeviceStreamServerEventType = DeviceStreamServerEvent["t"];
