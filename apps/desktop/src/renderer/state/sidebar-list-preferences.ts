import { useSyncExternalStore } from "react";
import type { WorkspaceStatus } from "../platform/git";
import { getSetting, setSetting } from "../platform/settings";
import { LIFECYCLE_STATUSES } from "../shared/lib/workspace-status";

export type SidebarWorkspaceSort = "updated" | "created";

interface SidebarListPreferences {
  sort: SidebarWorkspaceSort;
  repositoryIdsByOwner: Readonly<Record<string, readonly string[]>>;
  collapsedStatuses: readonly WorkspaceStatus[];
}

const KEY = "sidebar-list-preferences-v1";
const MAX_OWNERS = 32;
const MAX_REPOSITORIES = 256;
const MAX_ID_LENGTH = 512;
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const DEFAULTS: SidebarListPreferences = {
  sort: "updated",
  repositoryIdsByOwner: {},
  collapsedStatuses: [],
};
const listeners = new Set<() => void>();
let snapshot: SidebarListPreferences | null = null;

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function repositoryIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(validId))].slice(-MAX_REPOSITORIES)
    : EMPTY_IDS;
}

/** Layout is app-wide; repository selections belong to the device Local owner
 * or to the exact signed-in account and organization. A cold organization
 * must use its remembered id, never another owner's default. */
export function sidebarRepositoryFilterOwner(
  userId: string | null | undefined,
  organizationId: string | null,
): string {
  return organizationId === null
    ? "local"
    : JSON.stringify([userId ?? "signed-out", organizationId]);
}

export function getSidebarListPreferences(): SidebarListPreferences {
  if (snapshot) return snapshot;
  const raw = getSetting<unknown>(KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return (snapshot = DEFAULTS);
  }
  const value = raw as Record<string, unknown>;
  const owners = value.repositoryIdsByOwner;
  snapshot = {
    sort: value.sort === "created" ? "created" : "updated",
    repositoryIdsByOwner: Object.fromEntries(
      owners && typeof owners === "object" && !Array.isArray(owners)
        ? Object.entries(owners)
            .filter(([owner]) => validId(owner))
            .slice(-MAX_OWNERS)
            .map(([owner, ids]) => [owner, repositoryIds(ids)])
        : [],
    ),
    collapsedStatuses: LIFECYCLE_STATUSES.filter(
      ({ value: status }) =>
        Array.isArray(value.collapsedStatuses) &&
        value.collapsedStatuses.includes(status),
    ).map(({ value: status }) => status),
  };
  return snapshot;
}

export function sidebarRepositoryIds(owner: string): readonly string[] {
  const owners = getSidebarListPreferences().repositoryIdsByOwner;
  return Object.hasOwn(owners, owner) ? owners[owner] : EMPTY_IDS;
}

function write(next: SidebarListPreferences): void {
  snapshot = next;
  setSetting(KEY, next);
  for (const listener of listeners) listener();
}

export function setSidebarWorkspaceSort(sort: SidebarWorkspaceSort): void {
  const current = getSidebarListPreferences();
  if (current.sort !== sort && (sort === "created" || sort === "updated")) {
    write({ ...current, sort });
  }
}

export function setSidebarRepositoryIds(
  owner: string,
  ids: readonly string[],
): void {
  if (!validId(owner)) return;
  const current = getSidebarListPreferences();
  const next = repositoryIds(ids);
  const previous = sidebarRepositoryIds(owner);
  if (
    previous.length === next.length &&
    previous.every((id, i) => id === next[i])
  )
    return;
  const entries = Object.entries(current.repositoryIdsByOwner).filter(
    ([key]) => key !== owner,
  );
  if (next.length) entries.push([owner, next]);
  write({
    ...current,
    repositoryIdsByOwner: Object.fromEntries(entries.slice(-MAX_OWNERS)),
  });
}

export function setSidebarStatusCollapsed(
  status: WorkspaceStatus,
  collapsed: boolean,
): void {
  if (!LIFECYCLE_STATUSES.some(({ value }) => value === status)) return;
  const current = getSidebarListPreferences();
  if (current.collapsedStatuses.includes(status) === collapsed) return;
  const next = current.collapsedStatuses.filter((value) => value !== status);
  if (collapsed) next.push(status);
  write({ ...current, collapsedStatuses: next });
}

/** Explicit repository deletion, not a cold or owner-filtered catalog. Cloud
 * repositories can share an id across accounts, so their caller supplies the
 * exact account/organization owner. A Local registration is device-wide. */
export function forgetSidebarRepositoryFilter(
  projectId: string,
  owner?: string,
): void {
  const current = getSidebarListPreferences();
  const entries = Object.entries(current.repositoryIdsByOwner);
  if (
    !entries.some(
      ([key, ids]) =>
        (owner === undefined || key === owner) && ids.includes(projectId),
    )
  )
    return;
  write({
    ...current,
    repositoryIdsByOwner: Object.fromEntries(
      entries
        .map(
          ([key, ids]) =>
            [
              key,
              owner === undefined || key === owner
                ? ids.filter((id) => id !== projectId)
                : ids,
            ] as const,
        )
        .filter(([, ids]) => ids.length > 0),
    ),
  });
}

/** Membership confirmation can prune this account's removed organizations;
 * other accounts and device Local preferences are independent. */
export function pruneSidebarOwnerPreferences(
  userId: string,
  organizationIds: readonly string[],
): void {
  const current = getSidebarListPreferences();
  const entries = Object.entries(current.repositoryIdsByOwner);
  const retained = entries.filter(([owner]) => {
    try {
      const value: unknown = JSON.parse(owner);
      return (
        !Array.isArray(value) ||
        value[0] !== userId ||
        organizationIds.includes(value[1])
      );
    } catch {
      return true;
    }
  });
  if (retained.length !== entries.length) {
    write({ ...current, repositoryIdsByOwner: Object.fromEntries(retained) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarListPreferences(): SidebarListPreferences {
  return useSyncExternalStore(
    subscribe,
    getSidebarListPreferences,
    () => DEFAULTS,
  );
}

export function resetSidebarListPreferencesForTests(): void {
  snapshot = null;
  listeners.clear();
}
