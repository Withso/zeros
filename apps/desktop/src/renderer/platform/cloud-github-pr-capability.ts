import {
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";

// Keep the catalog capability independent of UI and state so reads and writes share one authority.
type CatalogContext = Readonly<{ signature: string; presentation: string; version: number }>;
let contexts: ReadonlyMap<string, CatalogContext> = new Map();
let version = 0;
const listeners = new Set<(key: string, retainPresentation: boolean) => void>();
export function onCloudGithubPrContextChange(
  listener: (key: string, retainPresentation: boolean) => void,
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
  const publish = (key: string, repository: unknown, github: CloudWorkspaceDocument["github"]) => {
    const presentation = JSON.stringify([repository, github?.repositoryId, github?.branch, github?.baseBranch]);
    const signature = JSON.stringify([presentation, github?.headSha]);
    const previous = contexts.get(key);
    next.set(key, previous?.signature === signature ? previous : { signature, presentation, version: ++version });
  };
  for (const document of workspaces) {
    if (document.capabilities?.githubPullRequests !== 1) continue;
    const key = cloudWorkspaceKey({
      organizationId: document.organizationId,
      workspaceId: document.id,
    });
    publish(key, document.repository, document.github);
    // A workspace of several repositories: each repository's own context, under
    // its key, so a branch or head change in one retires only its authority.
    const root = document.root, list = document.repositories;
    if (root && list && list.length > 1) list.forEach((entry, index) => {
      if (!entry.checkoutPath.startsWith(`${root}/`)) return;
      publish(`${key}/${entry.checkoutPath.slice(root.length + 1)}`, entry.repository, entry.github ?? (index === 0 ? document.github : undefined));
    });
  }
  const previous = contexts;
  contexts = next;
  // Notify only after publishing new authority; switching A → B → A must not revive the original lifetime.
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(key) !== next.get(key))
      for (const listener of listeners) listener(key, !!next.get(key) && previous.get(key)?.presentation === next.get(key)?.presentation);
  }
}
export function hasCloudGithubPrCapability(
  target: CloudWorkspaceTarget,
): boolean {
  return contexts.has(cloudWorkspaceKey(target));
}
/** `repositoryKey`: one repository of a workspace of several, by its key. */
export function cloudGithubPrCatalogContext(
  target: CloudWorkspaceTarget,
  repositoryKey?: string,
): CatalogContext | undefined {
  // A repository missing from the catalog falls back to its workspace's context.
  return (repositoryKey && contexts.get(repositoryKey)) || contexts.get(cloudWorkspaceKey(target));
}

export function cloudGithubPrCatalogKeys(): IterableIterator<string> {
  return contexts.keys();
}
