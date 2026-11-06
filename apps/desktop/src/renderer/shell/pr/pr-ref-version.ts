import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

const versions = new Map<string, number>();
let version = 0, coarseVersion = 0;

/** Ref hints share the Git refresh bus, but ordinary file writes must not
 * bypass the GitHub observation cadence. No reads or timers start here. */
export function invalidateWorkspacePrRefs(workspaceIds?: readonly string[]): void {
  if (!workspaceIds?.length) {
    coarseVersion = ++version;
    versions.clear();
    return;
  }
  for (const id of new Set(workspaceIds)) {
    versions.delete(id);
    versions.set(id, ++version);
  }
  while (versions.size > 128) versions.delete(versions.keys().next().value!);
}

export function workspacePrRefVersion(workspaceId: string): number {
  return Math.max(coarseVersion, versions.get(workspaceId) ?? 0);
}

registerPrWorkspaceCacheForget(id => { versions.delete(id); });
