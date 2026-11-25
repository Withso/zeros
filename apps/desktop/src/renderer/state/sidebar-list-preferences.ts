import { useSyncExternalStore } from "react";
import type { WorkspaceStatus } from "../platform/git";
import { getSetting, setSetting } from "../platform/settings";
import { LIFECYCLE_STATUSES } from "../shared/lib/workspace-status";

export type SidebarWorkspaceSort = "updated" | "created" | "name";
export type SidebarPlacement = "local" | "cloud";
/** Groupings beyond the persisted Repository / Status / None presentation. */
export type SidebarExtraGrouping = "placement" | "owner" | "recency" | "pr";
export type SidebarThenBy = "repository" | "status" | SidebarExtraGrouping;
export type SidebarAgentStatusFilter = "input" | "working" | "unread" | "failed" | "idle";
export type SidebarPrFilter = "none" | "draft" | "open" | "conflicts" | "merged" | "closed";
export type SidebarOwnerFilter = "mine" | "following";
export type SidebarSection = "pinned" | "mine" | "following" | "archived";

/** App-wide view options from the sidebar's menu. Every default reads as "not
 * applied", so the menu can mark exactly what the user changed. */
export interface SidebarViewPreferences {
  direction: "desc" | "asc";
  needsYouFirst: boolean;
  grouping: SidebarExtraGrouping | null;
  thenBy: SidebarThenBy | null;
  hideEmptyGroups: boolean;
  statuses: readonly SidebarAgentStatusFilter[];
  prStates: readonly SidebarPrFilter[];
  owners: readonly SidebarOwnerFilter[];
  unreadOnly: boolean;
  draftOnly: boolean;
  showProjectName: boolean;
  compact: boolean;
  expandChildren: boolean;
  showArchived: boolean;
  collapsedSections: readonly SidebarSection[];
  collapsedGroups: readonly string[];
}

export const SIDEBAR_AGENT_STATUS_FILTERS: readonly SidebarAgentStatusFilter[] = ["input", "working", "unread", "failed", "idle"];
export const SIDEBAR_PR_FILTERS: readonly SidebarPrFilter[] = ["none", "draft", "open", "conflicts", "merged", "closed"];
export const SIDEBAR_OWNER_FILTERS: readonly SidebarOwnerFilter[] = ["mine", "following"];
const EXTRA_GROUPINGS: readonly SidebarExtraGrouping[] = ["placement", "owner", "recency", "pr"];
const THEN_BY: readonly SidebarThenBy[] = ["repository", "status", ...EXTRA_GROUPINGS];
const SECTIONS: readonly SidebarSection[] = ["pinned", "mine", "following", "archived"];
const MAX_COLLAPSED_GROUPS = 128;

export const SIDEBAR_VIEW_DEFAULTS: SidebarViewPreferences = Object.freeze({
  direction: "desc",
  needsYouFirst: false,
  grouping: null,
  thenBy: null,
  hideEmptyGroups: false,
  statuses: Object.freeze([]),
  prStates: Object.freeze([]),
  owners: Object.freeze([]),
  unreadOnly: false,
  draftOnly: false,
  showProjectName: false,
  compact: false,
  expandChildren: false,
  showArchived: false,
  collapsedSections: Object.freeze([]),
  collapsedGroups: Object.freeze([]),
});

function pick<T extends string>(value: unknown, allowed: readonly T[]): readonly T[] {
  return Array.isArray(value) ? allowed.filter((option) => value.includes(option)) : [];
}

function sidebarView(raw: unknown): SidebarViewPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return SIDEBAR_VIEW_DEFAULTS;
  const value = raw as Record<string, unknown>;
  const flag = (key: keyof SidebarViewPreferences) => value[key] === true;
  return {
    direction: value.direction === "asc" ? "asc" : "desc",
    needsYouFirst: flag("needsYouFirst"),
    grouping: EXTRA_GROUPINGS.find((option) => option === value.grouping) ?? null,
    thenBy: THEN_BY.find((option) => option === value.thenBy) ?? null,
    hideEmptyGroups: flag("hideEmptyGroups"),
    statuses: pick(value.statuses, SIDEBAR_AGENT_STATUS_FILTERS),
    prStates: pick(value.prStates, SIDEBAR_PR_FILTERS),
    owners: pick(value.owners, SIDEBAR_OWNER_FILTERS),
    unreadOnly: flag("unreadOnly"),
    draftOnly: flag("draftOnly"),
    showProjectName: flag("showProjectName"),
    compact: flag("compact"),
    expandChildren: flag("expandChildren"),
    showArchived: flag("showArchived"),
    collapsedSections: pick(value.collapsedSections, SECTIONS),
    collapsedGroups: Array.isArray(value.collapsedGroups)
      ? [...new Set(value.collapsedGroups.filter(validId))].slice(-MAX_COLLAPSED_GROUPS)
      : [],
  };
}

interface SidebarListPreferences {
  sort: SidebarWorkspaceSort;
  repositoryIdsByOwner: Readonly<Record<string, readonly string[]>>;
  collapsedStatuses: readonly WorkspaceStatus[];
  /** unified-workspaces: a view preference per owner; at most one placement is hidden. */
  hiddenPlacementsByOwner: Readonly<Record<string, readonly SidebarPlacement[]>>;
  view: SidebarViewPreferences;
}

const KEY = "sidebar-list-preferences-v1";
const MAX_OWNERS = 32;
const MAX_REPOSITORIES = 256;
const MAX_ID_LENGTH = 512;
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const NO_PLACEMENTS: readonly SidebarPlacement[] = Object.freeze([]);
const DEFAULTS: SidebarListPreferences = {
  sort: "updated",
  repositoryIdsByOwner: {},
  collapsedStatuses: [],
  hiddenPlacementsByOwner: {},
  view: SIDEBAR_VIEW_DEFAULTS,
};

function hiddenPlacements(value: unknown): readonly SidebarPlacement[] {
  const only = Array.isArray(value) && value.length === 1 ? value[0] : null;
  return only === "local" || only === "cloud" ? [only] : NO_PLACEMENTS;
}
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
    sort: value.sort === "created" || value.sort === "name" ? value.sort : "updated",
    view: sidebarView(value.view),
    repositoryIdsByOwner: Object.fromEntries(
      owners && typeof owners === "object" && !Array.isArray(owners)
        ? Object.entries(owners)
            .filter(([owner]) => validId(owner))
            .slice(-MAX_OWNERS)
            .map(([owner, ids]) => [owner, repositoryIds(ids)])
        : [],
    ),
    hiddenPlacementsByOwner: Object.fromEntries(
      value.hiddenPlacementsByOwner &&
        typeof value.hiddenPlacementsByOwner === "object" &&
        !Array.isArray(value.hiddenPlacementsByOwner)
        ? Object.entries(value.hiddenPlacementsByOwner)
            .filter(([owner, hidden]) => validId(owner) && hiddenPlacements(hidden).length > 0)
            .slice(-MAX_OWNERS)
            .map(([owner, hidden]) => [owner, hiddenPlacements(hidden)])
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
  if (current.sort !== sort && (sort === "created" || sort === "updated" || sort === "name")) {
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

export function sidebarHiddenPlacements(owner: string): readonly SidebarPlacement[] {
  const owners = getSidebarListPreferences().hiddenPlacementsByOwner;
  return Object.hasOwn(owners, owner) ? owners[owner] : NO_PLACEMENTS;
}

/** Hiding both placements would empty the list, so that request shows both. */
export function setSidebarHiddenPlacements(
  owner: string,
  hidden: readonly SidebarPlacement[],
): void {
  if (!validId(owner)) return;
  const next = hidden.length === 1 ? hiddenPlacements(hidden) : NO_PLACEMENTS;
  const previous = sidebarHiddenPlacements(owner);
  if (previous.length === next.length && previous[0] === next[0]) return;
  const current = getSidebarListPreferences();
  const entries = Object.entries(current.hiddenPlacementsByOwner).filter(([key]) => key !== owner);
  if (next.length) entries.push([owner, next]);
  write({ ...current, hiddenPlacementsByOwner: Object.fromEntries(entries.slice(-MAX_OWNERS)) });
}

/** Merge menu changes into the view; unchanged values write nothing. */
export function setSidebarView(patch: Partial<SidebarViewPreferences>): void {
  const current = getSidebarListPreferences();
  const next = sidebarView({ ...current.view, ...patch });
  if (JSON.stringify(next) === JSON.stringify(current.view)) return;
  write({ ...current, view: next });
}

/** Reset keeps what the menu does not own: collapsed sections and groups. */
export function resetSidebarView(keys?: readonly (keyof SidebarViewPreferences)[]): void {
  const reset = keys ?? (Object.keys(SIDEBAR_VIEW_DEFAULTS) as (keyof SidebarViewPreferences)[])
    .filter((key) => key !== "collapsedSections" && key !== "collapsedGroups");
  setSidebarView(Object.fromEntries(reset.map((key) => [key, SIDEBAR_VIEW_DEFAULTS[key]])) as Partial<SidebarViewPreferences>);
}

export function setSidebarSectionCollapsed(section: SidebarSection, collapsed: boolean): void {
  const { view } = getSidebarListPreferences();
  const rest = view.collapsedSections.filter((value) => value !== section);
  setSidebarView({ collapsedSections: collapsed ? [...rest, section] : rest });
}

export function setSidebarGroupCollapsed(key: string, collapsed: boolean): void {
  if (!validId(key)) return;
  const { view } = getSidebarListPreferences();
  const rest = view.collapsedGroups.filter((value) => value !== key);
  setSidebarView({ collapsedGroups: collapsed ? [...rest, key] : rest });
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
  const keep = ([owner]: [string, unknown]) => {
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
  };
  const entries = Object.entries(current.repositoryIdsByOwner);
  const retained = entries.filter(keep);
  const placements = Object.entries(current.hiddenPlacementsByOwner);
  const retainedPlacements = placements.filter(keep);
  if (retained.length !== entries.length || retainedPlacements.length !== placements.length) {
    write({
      ...current,
      repositoryIdsByOwner: Object.fromEntries(retained),
      hiddenPlacementsByOwner: Object.fromEntries(retainedPlacements),
    });
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
