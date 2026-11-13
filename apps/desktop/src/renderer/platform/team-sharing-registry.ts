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

/** Team sharing phase 3 (3A): this person lost access to a workspace while it
 * was open (the relay closed 4001, or a re-read no longer finds it). The
 * workspace view shows that instead of its chats and tools; it clears once a
 * connection to that workspace is ready again. */
// D3: keyed exactly by the signed-in account session (user and organization store generation), organization and
// workspace. Another account on this Mac never matches, and an account or organization switch starts a new session.
type AccessTarget = { organizationId: string; workspaceId: string };
let accountScope: () => string | null = () => null;
/** team-sharing-state registers the current `${userId}#${generation}` (this module has no imports by design). */
export function registerAccessAccountScope(read: () => string | null): void { accountScope = read; }
/** The current account session, to bind a confirmation started now. */
export function workspaceAccessScope(): string | null { return accountScope(); }
const accessEnded = new Set<string>();
const accessListeners = new Set<() => void>();
const accessKey = (scope: string, target: AccessTarget) => `${scope}|${target.organizationId}|${target.workspaceId}`;
export function subscribeWorkspaceAccessEnded(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => { accessListeners.delete(listener); };
}
export function workspaceAccessEnded(target: AccessTarget): boolean {
  const scope = accountScope();
  return !!scope && accessEnded.has(accessKey(scope, target));
}
/** scope: the session the confirmation started in; a report from an earlier session is dropped. */
export function reportWorkspaceAccessEnded(target: AccessTarget, scope: string | null = accountScope()): void {
  if (!scope || scope !== accountScope()) return;
  // Earlier sessions' entries never match again: drop them.
  for (const key of accessEnded) if (!key.startsWith(`${scope}|`)) accessEnded.delete(key);
  const key = accessKey(scope, target);
  if (accessEnded.has(key)) return;
  accessEnded.add(key);
  for (const listener of accessListeners) listener();
}
export function clearWorkspaceAccessEnded(target: AccessTarget): void {
  const scope = accountScope();
  if (!scope || !accessEnded.delete(accessKey(scope, target))) return;
  for (const listener of accessListeners) listener();
}
export function resetWorkspaceAccessForTests(): void { accessEnded.clear(); accountScope = () => null; }
