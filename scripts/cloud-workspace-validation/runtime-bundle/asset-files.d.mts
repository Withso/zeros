export class RuntimeAssetError extends Error { readonly check: string; constructor(check: string); }
export type RuntimeAssetPin = { size: number; sha256: string };
export type RuntimeAssetFile = RuntimeAssetPin & { path: string; url: string };
export type RuntimeAssetFetch = (url: string, options?: RequestInit) => Promise<Response>;
export type RuntimeAssetLockIdentity = { sha256: string; lock12: string; tag: string; mirror: string };
export function checkedRuntimeAssetUrl(url: string, purpose?: "download" | "archive" | "release-metadata"): URL;
export function runtimeAssetLockIdentity(lock: unknown): RuntimeAssetLockIdentity;
export function runtimeAssetFiles(lock: unknown): RuntimeAssetFile[];
export function downloadVerifiedAsset(url: string, pin: RuntimeAssetPin, options?: { fetch?: RuntimeAssetFetch }): Promise<Buffer>;
export function downloadRuntimeAsset(pin: RuntimeAssetPin & { url: string }, options: {
  mirror: string; fetch?: RuntimeAssetFetch; log?: (line: string) => unknown;
}): Promise<Buffer>;
