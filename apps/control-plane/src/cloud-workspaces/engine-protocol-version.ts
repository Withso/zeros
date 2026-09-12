/**
 * Cloud setup is deployed from its own package, so it cannot depend on the
 * source-workspace protocol package at runtime. Keep the deployment boundary's
 * one compatibility literal here and let `pnpm check:protocol` prove it stays
 * equal to packages/protocol/src/version.ts before an image is qualified.
 *
 * An explicitly configured older image is still supported while its protocol
 * falls inside this range; new qualifications and omitted environment values
 * always use the current shared protocol below.
 */
export const CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION = 14 as const;
export const MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION = 2 as const;
