import { getOrganizationStoreGeneration, getTeamStoreState } from "../features/team/team-store";
import { ControlPlaneError } from "../features/team/control-plane";
import { isInternalFeatureActive } from "../features/settings/internal-features";
import {
  listCloudWorkspaceCollaborators,
  type CloudWorkspaceCollaborators,
  type CloudWorkspaceCollaboratorCollection,
  type CloudWorkspaceCollaboratorPage,
} from "../platform/cloud-workspace-collaboration";
import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import {
  cloudCatalogGeneration, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument,
  refreshCloudWorkspace, subscribeCloudWorkspaces, subscribeCloudWorkspaceRefresh,
} from "./cloud-workspace-catalog";

export type CloudWorkspaceCollaborationOwner = CloudWorkspaceTarget & {
  accountId: string; accountGeneration: number; deviceScopeId: string; catalogGeneration: number;
};
export const CLOUD_COLLABORATION_MAX_AGE_MS = 10_000;
const PAGE_SIZE = 50;
const MAX_ROWS = 2_000;
const collections = ["guests", "invitations", "members"] as const;
const cursorKeys = { guests: "guestCursor", invitations: "invitationCursor", members: "memberCursor" } as const;

export function cloudWorkspaceCollaborationKey(owner: CloudWorkspaceCollaborationOwner): string {
  cloudWorkspaceKey(owner);
  return JSON.stringify([owner.accountId, owner.accountGeneration, owner.deviceScopeId,
    owner.organizationId, owner.workspaceId, owner.catalogGeneration]);
}
function ownerFromKey(key: string): CloudWorkspaceCollaborationOwner {
  const [accountId, accountGeneration, deviceScopeId, organizationId, workspaceId, catalogGeneration] = JSON.parse(key);
  return { accountId, accountGeneration, deviceScopeId, organizationId, workspaceId, catalogGeneration };
}
function append<T>(previous: T[], next: T[], id: (row: T) => string): T[] {
  const rows = new Map(previous.map(row => [id(row), row]));
  for (const row of next) {
    const old = rows.get(id(row));
    rows.set(id(row), old && JSON.stringify(old) === JSON.stringify(row) ? old : row);
  }
  const result = [...rows.values()];
  return result.length === previous.length && result.every((row, index) => row === previous[index]) ? previous : result;
}
function reconcileRows<T>(previous: T[], next: T[], id: (row: T) => string): T[] {
  const prior = new Map(previous.map(row => [id(row), row]));
  const rows = next.map(row => {
    const old = prior.get(id(row));
    return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
  });
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
function reconcile(previous: CloudWorkspaceCollaborators | undefined, next: CloudWorkspaceCollaborators): CloudWorkspaceCollaborators {
  if (!previous) return next;
  if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
  return { ...next,
    writers: JSON.stringify(previous.writers) === JSON.stringify(next.writers) ? previous.writers : next.writers,
    guests: reconcileRows(previous.guests, next.guests, row => row.id),
    members: reconcileRows(previous.members, next.members, row => row.userId),
    invitations: reconcileRows(previous.invitations, next.invitations, row => row.id),
  };
}
function mergePage(previous: CloudWorkspaceCollaborators, next: CloudWorkspaceCollaborators, collection: CloudWorkspaceCollaboratorCollection): CloudWorkspaceCollaborators {
  const result = { ...previous, writers: next.writers };
  switch (collection) {
    case "guests": result.guests = append(previous.guests, next.guests, row => row.id); result.guestCursor = next.guestCursor; break;
    case "members": result.members = append(previous.members, next.members, row => row.userId); result.memberCursor = next.memberCursor; break;
    case "invitations": result.invitations = append(previous.invitations, next.invitations, row => row.id); result.invitationCursor = next.invitationCursor; break;
  }
  if (collections.reduce((total, name) => total + result[name].length, 0) > MAX_ROWS)
    throw new Error("Cloud collaborator list exceeded its row limit");
  return result;
}
function accessDenied(error: unknown): boolean {
  return error instanceof ControlPlaneError && [403, 404].includes(error.status);
}

/** Each renderer lives on one device/window. No collaborator data is persisted
 * or transferred between devices. The private scope also isolates test/browser
 * instances without exposing a native device credential through new IPC. */
const deviceScopeId = crypto.randomUUID();
export function cloudWorkspaceCollaborationOwner(target: CloudWorkspaceTarget): CloudWorkspaceCollaborationOwner | null {
  const accountId = getTeamStoreState().me?.user.id;
  if (!accountId) return null;
  return { ...target, accountId, accountGeneration: getOrganizationStoreGeneration(), deviceScopeId,
    catalogGeneration: cloudCatalogGeneration() };
}

type Dependencies = {
  list: (target: CloudWorkspaceTarget, page: CloudWorkspaceCollaboratorPage) => Promise<CloudWorkspaceCollaborators>;
  isCurrent: (owner: CloudWorkspaceCollaborationOwner) => boolean;
  afterMutation?: (owner: CloudWorkspaceCollaborationOwner) => Promise<unknown>;
  maxEntries?: number;
};

export class CloudWorkspaceCollaborationCache {
  readonly snapshots: KeyedAsyncCache<CloudWorkspaceCollaborators>;
  private readonly pages = new Map<string, Promise<void>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly denied = new Map<string, unknown>();
  // Grant/role refreshes can leave sharing CAS unchanged. Window tokens fence
  // pages across replacement reads; weak keys follow retained snapshot lifetime.
  private readonly pageWindows = new WeakMap<CloudWorkspaceCollaborators, object>();

  constructor(private readonly dependencies: Dependencies) {
    this.snapshots = new KeyedAsyncCache({
      maxEntries: dependencies.maxEntries ?? 32, maxWeight: 2 * 1024 * 1024,
      weightOf: value => JSON.stringify(value).length * 2,
      reconcile: (previous, next) => {
        const value = reconcile(previous, next);
        this.pageWindows.set(value, this.pageWindows.get(next) ?? {});
        return value;
      },
    });
  }

  private assertCurrent(key: string): CloudWorkspaceCollaborationOwner {
    const owner = ownerFromKey(key);
    if (!this.dependencies.isCurrent(owner)) {
      this.snapshots.forget(key);
      throw new Error("Cloud collaboration account or device changed");
    }
    return owner;
  }

  private async page(key: string, input: CloudWorkspaceCollaboratorPage): Promise<CloudWorkspaceCollaborators> {
    const owner = this.assertCurrent(key);
    try {
      const page = await this.dependencies.list(owner, { pageSize: PAGE_SIZE, ...input });
      this.assertCurrent(key);
      if (page.organizationId !== owner.organizationId || page.workspaceId !== owner.workspaceId)
        throw new Error("Cloud collaborator response changed identity");
      return page;
    } catch (error) {
      if (accessDenied(error)) this.withdraw(key, error);
      throw error;
    }
  }

  /** Revalidate the already-opened page window, retaining its last confirmation
   * until the complete replacement succeeds. Cold reads fetch only one page. */
  async fetch(key: string): Promise<CloudWorkspaceCollaborators> {
    this.assertCurrent(key);
    if (this.denied.has(key)) throw this.denied.get(key);
    const before = this.snapshots.peekSnapshot(key);
    if (before.data) this.pageWindows.set(before.data, {});
    let result = await this.page(key, {});
    for (const collection of collections) {
      const seen = new Set<string>();
      const cursorKey = cursorKeys[collection];
      while (result[cursorKey] && result[collection].length < (before.data?.[collection].length ?? 0)) {
        const cursor = result[cursorKey]!;
        if (seen.has(cursor) || seen.size >= MAX_ROWS / PAGE_SIZE)
          throw new Error("Cloud collaborator pagination did not advance");
        seen.add(cursor);
        const next = await this.page(key, { [cursorKey]: cursor });
        if (next.accessRevision !== result.accessRevision)
          throw new Error("Workspace sharing changed while loading collaborators");
        result = mergePage(result, next, collection);
      }
    }
    if (this.snapshots.peekSnapshot(key).invalidationVersion !== before.invalidationVersion)
      throw new Error("Workspace sharing changed while loading collaborators");
    this.pageWindows.set(result, {});
    return result;
  }

  load(key: string, force = false): Promise<CloudWorkspaceCollaborators> {
    this.assertCurrent(key);
    if (force && this.denied.has(key)) this.invalidate(key);
    if (this.denied.has(key)) return Promise.reject(this.denied.get(key));
    return this.snapshots.load(key, () => this.fetch(key), { force, maxAgeMs: CLOUD_COLLABORATION_MAX_AGE_MS });
  }

  loadMore(key: string, collection: CloudWorkspaceCollaboratorCollection): Promise<void> {
    this.assertCurrent(key);
    const before = this.snapshots.peekSnapshot(key);
    const cursorKey = cursorKeys[collection];
    const cursor = before.data?.[cursorKey];
    if (!cursor) return Promise.resolve();
    if (before.refreshing) return Promise.reject(new Error("Workspace collaborators are refreshing"));
    const pageWindow = this.pageWindows.get(before.data!)!;
    const requestKey = JSON.stringify([key, collection, cursor]);
    const pending = this.pages.get(requestKey);
    if (pending) return pending;
    const task = this.page(key, { [cursorKey]: cursor }).then(next => {
      const current = this.snapshots.peekSnapshot(key);
      if (current.data && this.pageWindows.get(current.data) === pageWindow &&
        current.invalidationVersion === before.invalidationVersion && current.data.accessRevision !== next.accessRevision)
        this.snapshots.invalidate(key);
      if (!current.data || this.pageWindows.get(current.data) !== pageWindow ||
        current.invalidationVersion !== before.invalidationVersion || current.data.accessRevision !== next.accessRevision)
        throw new Error("Workspace sharing changed while loading collaborators");
      if (next[cursorKey] === cursor) throw new Error("Cloud collaborator pagination did not advance");
      const merged = mergePage(current.data, next, collection);
      this.pageWindows.set(merged, pageWindow);
      this.snapshots.setData(key, merged);
    }).finally(() => { if (this.pages.get(requestKey) === task) this.pages.delete(requestKey); });
    this.pages.set(requestKey, task);
    return task;
  }

  /** Never retry a write after a CAS conflict or an uncertain response. Reads
   * reconcile the exact owner; request idempotency remains with the caller. */
  mutate<T>(key: string, write: () => Promise<T>): Promise<T> {
    const owner = this.assertCurrent(key);
    if (this.mutations.has(key)) return Promise.reject(new Error("A sharing change is already running"));
    this.snapshots.invalidate(key);
    const task = (async () => {
      let value: T;
      try {
        value = await write();
        this.assertCurrent(key);
      } catch (error) {
        if (accessDenied(error)) this.withdraw(key, error);
        else if (this.dependencies.isCurrent(owner)) await this.revalidateAfterMutation(key, owner);
        throw error;
      }
      await this.revalidateAfterMutation(key, owner);
      return value;
    })().finally(() => { if (this.mutations.get(key) === task) this.mutations.delete(key); });
    this.mutations.set(key, task);
    return task;
  }

  private async revalidateAfterMutation(key: string, owner: CloudWorkspaceCollaborationOwner): Promise<void> {
    await this.dependencies.afterMutation?.(owner).catch(() => {});
    if (!this.dependencies.isCurrent(owner)) return;
    this.snapshots.invalidate(key);
    await this.load(key, true).catch(() => {});
  }

  private withdraw(key: string, error: unknown): void {
    this.denied.set(key, error);
    this.snapshots.forget(key);
    this.snapshots.setError(key, error);
    const retained = new Set(this.snapshots.keys());
    for (const deniedKey of this.denied.keys()) if (!retained.has(deniedKey)) this.denied.delete(deniedKey);
  }

  invalidate(key: string): void {
    if (this.denied.delete(key)) this.snapshots.forget(key);
    else this.snapshots.invalidate(key);
  }

  prune(): void {
    for (const key of this.snapshots.keys()) {
      if (!this.dependencies.isCurrent(ownerFromKey(key))) {
        this.denied.delete(key);
        this.snapshots.forget(key);
      }
    }
  }
}

export const cloudWorkspaceCollaboration = new CloudWorkspaceCollaborationCache({
  list: listCloudWorkspaceCollaborators,
  isCurrent: owner => owner.deviceScopeId === deviceScopeId && owner.accountGeneration === getOrganizationStoreGeneration() &&
    owner.catalogGeneration === cloudCatalogGeneration() && owner.accountId === getTeamStoreState().me?.user.id,
  afterMutation: owner => refreshCloudWorkspace(owner),
});

export function warmCloudWorkspaceCollaboration(target: CloudWorkspaceTarget): void {
  if (!isInternalFeatureActive("cloudComputerV2")) return;
  const document = cloudWorkspaceDocument(target);
  if (!document?.capabilities.canManage || !["owner", "manager"].includes(document.actorRole ?? "")) return;
  cloudWorkspaceCollaboration.prune();
  const owner = cloudWorkspaceCollaborationOwner(target);
  if (owner) void cloudWorkspaceCollaboration.load(cloudWorkspaceCollaborationKey(owner)).catch(() => {});
}

subscribeCloudWorkspaces(() => {
  cloudWorkspaceCollaboration.prune();
  for (const key of cloudWorkspaceCollaboration.snapshots.keys()) {
    const document = cloudWorkspaceDocument(ownerFromKey(key));
    const confirmed = cloudWorkspaceCollaboration.snapshots.peekSnapshot(key).data;
    if ((!document && cloudWorkspaceCatalogConfirmed()) || document &&
      (!document.capabilities.canManage || !["owner", "manager"].includes(document.actorRole ?? "")))
      cloudWorkspaceCollaboration.snapshots.forget(key);
    else if (document && confirmed && document.accessRevision !== confirmed.accessRevision)
      cloudWorkspaceCollaboration.invalidate(key);
  }
});
// The existing catalog cadence is the fallback for invitation/role changes
// that do not advance sharing CAS. Only active cache consumers initiate reads.
subscribeCloudWorkspaceRefresh(() => {
  for (const key of cloudWorkspaceCollaboration.snapshots.keys()) cloudWorkspaceCollaboration.invalidate(key);
});
