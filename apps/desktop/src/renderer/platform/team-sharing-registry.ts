// Team sharing state that request producers and the catalog share. It has no
// imports on purpose: the catalog registers into it while modules that import
// it (cloud-v2, cloud-workspaces, team-store's graph) may still be loading, so
// nothing here may sit behind a circular import.
/** The control plane refused execution as read-only: whoever holds the
 * workspace's document reads it again, so the view becomes read-only. */
const readOnlyListeners = new Set<(workspaceId: string) => void>();
export function subscribeWorkspaceReadOnly(listener: (workspaceId: string) => void): () => void {
  readOnlyListeners.add(listener);
  return () => { readOnlyListeners.delete(listener); };
}
export function reportWorkspaceReadOnly(workspaceId: string): void {
  for (const listener of readOnlyListeners) listener(workspaceId);
}

/** The viewer's role in the document this desktop holds for a workspace; the
 * catalog registers the lookup (platform code never imports state). */
let roleLookup: (workspaceId: string) => string | undefined = () => undefined;
export function registerSharingRoleLookup(lookup: (workspaceId: string) => string | undefined): void { roleLookup = lookup; }
/** The opt-in for a workspace's own requests (history, receipts, prompts, connect,
 * lifecycle, activity, GitHub, chat edits): only when the held document says this
 * account is an admin or member there, never the Creator or a document without
 * sharing fields. The header routes the server through team admission (extra
 * transactions and the viewer's GitHub source check), so the Creator's hot paths
 * stay exactly as today. A stale UI still gets 409 workspace_read_only. */
export function sharingFor(workspaceId: string): { teamSharing?: true } {
  const role = roleLookup(workspaceId);
  return role === "admin" || role === "member" ? { teamSharing: true } : {};
}
