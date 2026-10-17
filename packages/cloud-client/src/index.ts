// @zeros/cloud-client — cloud-only S3 client SDK surface. Local workspaces
// never import this package (PLAN-v3 §2.1; `pnpm electron:local` sets
// ZEROS_CLOUD_WORKSPACES_ENABLED=false and no SDK code may run there).

// The three generated modules share primitive names (Uuid, Frame, …), so the
// frame schemas are namespaced; the REST surface stays flat.
export * from "./generated/rest";
export * as deviceStreamTypes from "./generated/device-stream";
export * as runtimeAuthTypes from "./generated/runtime-auth";
export {
  parseDeviceStreamFrame,
  type DeviceStreamParseResult,
} from "./device-stream";
export {
  DeviceStreamClient,
  DEVICE_STREAM_ACK_INTERVAL_MS,
  DEVICE_STREAM_CLIENT_CONTRACT,
  DEVICE_STREAM_DEAD_AFTER_MS,
  DEVICE_STREAM_DEAD_CLOSE_CODE,
  DEVICE_STREAM_MAX_RESUME_WORKSPACES,
  DEVICE_STREAM_SEND_BURST,
  DEVICE_STREAM_SEND_PER_SECOND,
  DEVICE_STREAM_STABLE_MS,
} from "./device-stream-client";
export type {
  DeviceSessionGrant,
  DeviceStreamClientOptions,
  DeviceStreamEvent,
  DeviceStreamPayloadFrame,
  DeviceStreamPresenceState,
  DeviceStreamResumeBase,
  DeviceStreamSocket,
  DeviceStreamSocketFactory,
  DeviceStreamSocketHandlers,
  DeviceStreamState,
  DeviceStreamStopReason,
} from "./device-stream-client";
export {
  isRuntimeHandshakeFrame,
  parseRuntimeAuthFrame,
  type RuntimeAuthParseResult,
} from "./runtime-auth";
export {
  CAPABILITY_POP_DOMAIN,
  capabilityProofMessage,
  connectRuntime,
  decodeCapabilityClaims,
  defaultNonce,
  relayHedgeDelayMs,
  RUNTIME_AUTH_CONTRACT,
  RUNTIME_AUTH_TIMEOUT_MS,
  RUNTIME_CONNECT_TIMEOUT_MS,
  RUNTIME_LEGACY_SUBPROTOCOL,
  RUNTIME_RELAY_HEDGE_MAX_MS,
  RUNTIME_RELAY_HEDGE_MIN_MS,
  RUNTIME_RENEW_TIMEOUT_MS,
  RUNTIME_SUBPROTOCOL,
  RuntimeConnectError,
  RuntimeConnection,
} from "./runtime-session";
export type {
  CapabilityProofFields,
  RuntimeAttemptFailure,
  RuntimeConnectResult,
  RuntimeRouteKind,
  RuntimeSessionOptions,
  RuntimeSocket,
  RuntimeSocketFactory,
  RuntimeSocketHandlers,
} from "./runtime-session";
export {
  CloudRestClient,
  CloudRestError,
  classifyFailure,
  retryDelayMs,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
} from "./rest-client";
export type {
  CloudRestClientOptions,
  CloudRestResponse,
  DeviceProofHeaders,
  RetryDecision,
} from "./rest-client";
export {
  canonicalJson,
  DEVICE_PROOF_VERSION,
  deviceProofMessage,
  deviceProofPayloadDigest,
} from "./device-proof";
export type { DeviceProofAction, DeviceProofRequest } from "./device-proof";
export { CloudOrgFlagCache, probeFromConnectFailure } from "./feature-probe";
export type { CloudFlagState } from "./feature-probe";
