import {
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";

// Capability projection only, owned by the catalog. Keeping this module free
// of UI/state imports lets every read/write boundary use the same gate.
type CatalogContext = Readonly<{ signature: string; version: number }>;
let contexts: ReadonlyMap<string, CatalogContext> = new Map();
let version = 0;
const listeners = new Set<(key: string) => void>();
export function onCloudGithubPrContextChange(
  listener: (key: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishCloudGithubPrCapabilities(
  workspaces: Iterable<CloudWorkspaceDocument>,
): void {
  const next = new Map<string, CatalogContext>();
  for (const document of workspaces) {
    if (document.capabilities?.githubPullRequests !== 1) continue;
    const github = document.github;
    const key = cloudWorkspaceKey({
      organizationId: document.organizationId,
      workspaceId: document.id,
    });
    const signature = JSON.stringify([
      document.repository,
      github?.repositoryId,
      github?.branch,
      github?.baseBranch,
      github?.headSha,
    ]);
    const previous = contexts.get(key);
    next.set(
      key,
      previous?.signature === signature
        ? previous
        : { signature, version: ++version },
    );
  }
  const previous = contexts;
  contexts = next;
  // Publish first so mounted consumers and pending requests observe the same
  // new authority. An A → B → A round trip never restores an old lifetime.
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(key) !== next.get(key))
      for (const listener of listeners) listener(key);
  }
}
export function hasCloudGithubPrCapability(
  target: CloudWorkspaceTarget,
): boolean {
  return contexts.has(cloudWorkspaceKey(target));
}
export function cloudGithubPrCatalogContext(
  target: CloudWorkspaceTarget,
): CatalogContext | undefined {
  return contexts.get(cloudWorkspaceKey(target));
}

export function cloudGithubPrCatalogKeys(): IterableIterator<string> {
  return contexts.keys();
}
