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
  isRuntimeHandshakeFrame,
  parseRuntimeAuthFrame,
  type RuntimeAuthParseResult,
} from "./runtime-auth";
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
export { CloudOrgFlagCache, probeFromConnectFailure } from "./feature-probe";
export type { CloudFlagState } from "./feature-probe";
