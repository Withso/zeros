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
