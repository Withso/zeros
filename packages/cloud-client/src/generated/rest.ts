// GENERATED from docs/cloud-workspace/contracts/s3-client-contract.md (s3-client-api).
// Do not edit by hand; run `pnpm --dir packages/cloud-client generate`.

export type Uuid = string;

export type ContractRange = {
  min: number;
  max: number;
};

export type ContractError = {
  error: {
    code: string;
    message?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    wakeable?: boolean;
  };
};

export type DeviceSessionRequest = {
  deviceId: Uuid;
  deviceSessionId?: Uuid;
  client: {
    platform: "macos" | "windows" | "linux" | "ios" | "ipados" | "android" | "web";
    appVersion: string;
    contract: ContractRange;
  };
};

export type DeviceSessionResponse = {
  deviceSessionId: Uuid;
  stream: {
    url: string;
    ticket: string;
    ticketExpiresAt: string;
  };
  contract: number;
  heartbeatIntervalMs: number;
};

/** Existing CloudWorkspaceDocumentSchema (apps/desktop/src/renderer/platform/cloud-workspace-contract.ts). Only the fields the contract relies on are constrained here. */
export type WorkspaceDocument = {
  id: Uuid;
  organizationId: Uuid;
  version: number;
  status: string;
  placement: "cloud";
  accessRevision?: number;
};

export type CatalogPage = {
  workspaces: WorkspaceDocument[];
  nextCursor?: string | null;
  catalogVersion?: number;
};

export type ConnectRequest = {
  deviceSessionId: Uuid;
  clientSessionId: Uuid;
  routes: ("direct" | "relay")[];
};

export type CapabilityGrant = {
  token: string;
  expiresAt: string;
};

export type Capabilities = {
  engine: CapabilityGrant;
  realtime: CapabilityGrant;
};

export type Route = {
  kind: "direct" | "relay";
  url: string;
  priority: number;
};

export type ConnectResponse = {
  workspaceId: Uuid;
  generation: number;
  engineInstanceId?: Uuid;
  capabilities: Capabilities;
  routes: Route[];
  renewAt: string;
  relayHedgeMs: number;
};

export type Jwks = {
  keys: ({
    kty: "OKP";
    crv: "Ed25519";
    x: string;
    kid: string;
    use: "sig";
    alg: "EdDSA";
    zeros_state?: "next" | "current" | "retiring";
  })[];
};

export const REST_OPERATIONS = [
  { id: "createDeviceSession", method: "POST", path: "/v1/device-sessions" },
  { id: "listCloudWorkspaces", method: "GET", path: "/v1/cloud-workspaces" },
  { id: "getCloudWorkspace", method: "GET", path: "/v1/cloud-workspaces/{workspace}" },
  { id: "createCloudWorkspace", method: "POST", path: "/v1/organizations/{organization}/cloud-workspaces" },
  { id: "renameCloudWorkspace", method: "PATCH", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}" },
  { id: "deleteCloudWorkspace", method: "DELETE", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}" },
  { id: "runCloudWorkspaceLifecycle", method: "POST", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/{operation}" },
  { id: "connectCloudWorkspaceRuntime", method: "POST", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/runtime/connect" },
  { id: "renewCloudWorkspaceCapabilities", method: "POST", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/runtime/capabilities" },
  { id: "listCloudHistoryChats", method: "GET", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/history/chats" },
  { id: "listCloudHistoryMessages", method: "GET", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/history/messages/{chat}" },
  { id: "searchCloudHistory", method: "GET", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/history/search" },
  { id: "listCloudCommandReceipts", method: "GET", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/history/commands" },
  { id: "getCloudCommandReceipt", method: "GET", path: "/v1/organizations/{organization}/cloud-workspaces/{workspace}/history/commands/{command}" },
  { id: "getCapabilityKeys", method: "GET", path: "/.well-known/zeros-capabilities/jwks.json" },
] as const;

export type RestOperation = (typeof REST_OPERATIONS)[number];
export type RestOperationId = RestOperation["id"];
export type RestSchemaName =
  | "Uuid"
  | "ContractRange"
  | "Error"
  | "DeviceSessionRequest"
  | "DeviceSessionResponse"
  | "WorkspaceDocument"
  | "CatalogPage"
  | "ConnectRequest"
  | "CapabilityGrant"
  | "Capabilities"
  | "Route"
  | "ConnectResponse"
  | "Jwks";
