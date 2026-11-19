// Keep this registry import-free: the catalog and team store register into it while its importers may still be loading.
/** A server read-only refusal invalidates the workspace document, not just the failed request. */
const readOnlyListeners = new Set<(workspaceId: string) => void>();
export function subscribeWorkspaceReadOnly(listener: (workspaceId: string) => void): () => void {
  readOnlyListeners.add(listener);
  return () => { readOnlyListeners.delete(listener); };
}
export function reportWorkspaceReadOnly(workspaceId: string): void {
  for (const listener of readOnlyListeners) listener(workspaceId);
}

let roleLookup: (workspaceId: string) => string | undefined = () => undefined;
export function registerSharingRoleLookup(lookup: (workspaceId: string) => string | undefined): void { roleLookup = lookup; }
/** Opt members and admins into server team admission, which checks the viewer's source access; Creator requests stay on the ordinary path. */
export function sharingFor(workspaceId: string): { teamSharing?: true } {
  const role = roleLookup(workspaceId);
  return role === "admin" || role === "member" ? { teamSharing: true } : {};
}

/** Record confirmed access loss by account session, organization and workspace; callers clear it when that workspace is ready again. */
type AccessTarget = { organizationId: string; workspaceId: string };
let accountScope: () => string | null = () => null;
export function registerAccessAccountScope(read: () => string | null): void { accountScope = read; }
export function workspaceAccessScope(): string | null { return accountScope(); }
const accessEnded = new Set<string>();
const accessListeners = new Set<(target: AccessTarget) => void>();
const accessKey = (scope: string, target: AccessTarget) => `${scope}|${target.organizationId}|${target.workspaceId}`;
export function subscribeWorkspaceAccessEnded(listener: (target: AccessTarget) => void): () => void {
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
  for (const key of accessEnded) if (!key.startsWith(`${scope}|`)) accessEnded.delete(key);
  const key = accessKey(scope, target);
  if (accessEnded.has(key)) return;
  accessEnded.add(key);
  for (const listener of accessListeners) listener(target);
}
export function clearWorkspaceAccessEnded(target: AccessTarget): void {
  const scope = accountScope();
  if (!scope || !accessEnded.delete(accessKey(scope, target))) return;
  for (const listener of accessListeners) listener(target);
}
export function resetWorkspaceAccessForTests(): void { accessEnded.clear(); accountScope = () => null; }
