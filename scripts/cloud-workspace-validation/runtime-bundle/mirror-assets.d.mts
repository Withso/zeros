import type { RuntimeAssetFile, RuntimeAssetFetch, RuntimeAssetLockIdentity } from "./asset-files.mjs";
export type RuntimeAssetMirrorPlan = RuntimeAssetLockIdentity & { files: RuntimeAssetFile[]; mirrorMatches: boolean; notes: string };
export function planRuntimeAssetMirror(lock: unknown): RuntimeAssetMirrorPlan;
export function mirrorRuntimeAssets(lock: unknown, options?: {
  apply?: boolean; fetch?: RuntimeAssetFetch; gh?: (args: string[]) => Promise<void>; log?: (line: string) => unknown;
}): Promise<RuntimeAssetMirrorPlan>;
