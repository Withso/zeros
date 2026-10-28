import { gitRepoBranchCatalog } from "../../platform/git";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useNativeRuntime } from "../../platform/runtime";
import { createBranchCatalogCache, GIT_READ_MAX_AGE_MS } from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";

async function readCatalog(key: string) {
  const [repoRoot] = JSON.parse(key) as [string, string | null];
  const catalog = await gitRepoBranchCatalog({ repoRoot, fetch: false });
  if (!catalog || !Array.isArray(catalog.remotes)) {
    throw new Error("Repository remotes are unavailable.");
  }
  return catalog;
}

/** A blank origin can mean a local-only repo or a configured remote with a
 * different name. Reuse Create's exact-repository, local-ref catalog to tell
 * them apart; active consumers share one read and never fetch or wake a VM. */
export function useRepositoryRemote(
  repoRoot: string | null | undefined,
  originUrl: string | null,
  active = true,
): { remoteUrl: string | null; localOnly: boolean } {
  const nativeReady = useNativeRuntime().ready;
  const origin = originUrl?.trim() || null;
  const key = !origin && repoRoot && !isCloudWorkspace(repoRoot)
    ? JSON.stringify([repoRoot, originUrl])
    : null;
  const { data: catalog } = useCachedRead(createBranchCatalogCache, key, readCatalog, {
    enabled: active && nativeReady,
    maxAgeMs: GIT_READ_MAX_AGE_MS,
  });
  return {
    remoteUrl: origin ?? catalog?.remotes.find(remote => remote.name === catalog.effectiveRemote)?.url ?? null,
    localOnly: !origin && (!catalog || catalog.remotes.length === 0),
  };
}
