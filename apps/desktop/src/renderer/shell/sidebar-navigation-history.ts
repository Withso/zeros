// ──────────────────────────────────────────────────────────
// App sidebar back/forward — one session history of sidebar destinations
// ──────────────────────────────────────────────────────────
//
// The sidebar's destinations are Home (the Dashboard), Customize, Create,
// repository pages and workspaces. The history observes the workspace store
// instead of the sidebar's click handlers, so a destination reached from a
// Dashboard card, a deep link or the menu bar is recorded like a sidebar click.
// Chat, workbench and repository hub tabs are state inside one destination,
// restored by their own owners. Settings replaces the sidebar and is never an
// entry.
//
// The stack is in-memory and bounded. A reload starts a new one, and so does
// another organization becoming active, from whichever switcher. Entries are
// never pruned: an entry whose repository or workspace has left the sidebar is
// skipped while stepping, so it can come back if its row does.

import { useSyncExternalStore } from "react";

import {
  getActiveTeamId,
  subscribeActiveTeam,
} from "../features/team/active-team";
import type { PendingWorkspaceCreate } from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import {
  selectActiveFolder,
  useWorkspaceStore,
  type Action,
  type WorkspaceState,
} from "../state/store";
import { findWorkspaceForFolder } from "../state/workspace-resolution";
import type { WorkspaceNavigationTarget } from "./prefetch-workspace-surface";

// --- MODEL ---

export type SidebarDestination =
  | { readonly kind: "dashboard" }
  | { readonly kind: "customize" }
  | { readonly kind: "create"; readonly projectId: string | null }
  | { readonly kind: "repo"; readonly projectId: string }
  | { readonly kind: "workspace"; readonly folder: string };

export interface SidebarHistory {
  readonly entries: readonly SidebarDestination[];
  /** The entry on screen; -1 only before anything was recorded. */
  readonly index: number;
}

/** What the sidebar currently lists, which is what back/forward may reopen. */
export interface SidebarHistoryScope {
  /** The active organization's registered repositories. */
  readonly projects: readonly Pick<Project, "id" | "repoRoot">[];
  /** Listed Local, cloud and plain-folder workspace rows. */
  readonly workspaces: readonly WorkspaceNavigationTarget[];
  /** In-flight creates, whose announced path is open before its row lands. */
  readonly pendingCreates: readonly Pick<
    PendingWorkspaceCreate,
    "path" | "repoRoot" | "kind"
  >[];
}

/** One history entry resolved against the current sidebar. */
export type SidebarHistoryRoute =
  | { readonly kind: "page"; readonly page: "dashboard" | "customize" }
  | { readonly kind: "create"; readonly projectId: string | null }
  | {
      readonly kind: "repo";
      readonly projectId: string;
      readonly repoRoot: string;
    }
  | {
      readonly kind: "workspace";
      readonly workspace: WorkspaceNavigationTarget;
    };

/** The two ways the sidebar opens a destination. */
export interface SidebarHistoryNavigator {
  dispatch: (action: Action) => void;
  openWorkspace: (workspace: WorkspaceNavigationTarget) => void;
}

/** Older entries fall off the front once the stack is this long. */
export const SIDEBAR_HISTORY_LIMIT = 50;

const DASHBOARD: SidebarDestination = { kind: "dashboard" };
const CUSTOMIZE: SidebarDestination = { kind: "customize" };
const EMPTY_HISTORY: SidebarHistory = { entries: [], index: -1 };

/** The destination a store snapshot shows, or null for Settings and for a
 * workspace page with nothing selected. */
export function sidebarDestinationFor(
  state: WorkspaceState,
): SidebarDestination | null {
  switch (state.activePage) {
    case "dashboard":
      return DASHBOARD;
    case "customize":
      return CUSTOMIZE;
    case "create":
      return { kind: "create", projectId: state.createWorkspaceProjectId };
    case "repo":
      return state.activeRepoId
        ? { kind: "repo", projectId: state.activeRepoId }
        : null;
    case "workspace": {
      const folder = selectActiveFolder(state);
      return folder ? { kind: "workspace", folder } : null;
    }
    default:
      return null;
  }
}

function sameDestination(
  a: SidebarDestination,
  b: SidebarDestination,
): boolean {
  switch (a.kind) {
    case "workspace":
      return b.kind === "workspace" && a.folder === b.folder;
    case "create":
      return b.kind === "create" && a.projectId === b.projectId;
    case "repo":
      return b.kind === "repo" && a.projectId === b.projectId;
    default:
      return a.kind === b.kind;
  }
}

/** Push a newly shown destination, dropping any forward entries. Showing the
 * current entry again returns the same history. */
export function recordSidebarDestination(
  history: SidebarHistory,
  destination: SidebarDestination,
  limit = SIDEBAR_HISTORY_LIMIT,
): SidebarHistory {
  const current = history.entries[history.index];
  if (current && sameDestination(current, destination)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), destination];
  const kept = entries.length > limit ? entries.slice(-limit) : entries;
  return { entries: kept, index: kept.length - 1 };
}

/** Land on `index`, adopting what the store actually showed there (a chat in
 * a subdirectory, or Create without a removed repository). */
function moveTo(
  history: SidebarHistory,
  index: number,
  shown?: SidebarDestination,
): SidebarHistory {
  const entry = history.entries[index];
  if (!entry) return history;
  const replace = shown !== undefined && !sameDestination(entry, shown);
  if (!replace && index === history.index) return history;
  return {
    entries: replace
      ? history.entries.map((candidate, at) =>
          at === index ? shown : candidate,
        )
      : history.entries,
    index,
  };
}

function resolveDestination(
  destination: SidebarDestination,
  scope: SidebarHistoryScope,
): SidebarHistoryRoute | null {
  switch (destination.kind) {
    case "dashboard":
    case "customize":
      return { kind: "page", page: destination.kind };
    case "create":
      return {
        kind: "create",
        projectId: scope.projects.some(
          (project) => project.id === destination.projectId,
        )
          ? destination.projectId
          : null,
      };
    case "repo": {
      const project = scope.projects.find(
        (candidate) => candidate.id === destination.projectId,
      );
      return project
        ? { kind: "repo", projectId: project.id, repoRoot: project.repoRoot }
        : null;
    }
    case "workspace": {
      const listed = findWorkspaceForFolder(
        destination.folder,
        scope.workspaces,
      );
      if (listed) return { kind: "workspace", workspace: listed };
      const pending = scope.pendingCreates.find(
        (create) => create.path === destination.folder,
      );
      // Its row has not landed yet: let the sidebar's remembered-target
      // validation confirm it before any default chat is created there.
      return pending?.path
        ? {
            kind: "workspace",
            workspace: {
              path: pending.path,
              repoRoot: pending.repoRoot,
              kind: pending.kind,
              validationPending: true,
            },
          }
        : null;
    }
  }
}

function sameRoute(a: SidebarHistoryRoute, b: SidebarHistoryRoute): boolean {
  switch (a.kind) {
    case "page":
      return b.kind === "page" && a.page === b.page;
    case "create":
      return b.kind === "create" && a.projectId === b.projectId;
    case "repo":
      return b.kind === "repo" && a.projectId === b.projectId;
    case "workspace":
      return b.kind === "workspace" && a.workspace.path === b.workspace.path;
  }
}

/** The nearest entry behind (-1) or ahead (+1) that the sidebar can still
 * open and that would not reopen what is already on screen: the same
 * workspace by another chat's subdirectory counts as already there. */
export function sidebarHistoryTarget(
  history: SidebarHistory,
  direction: -1 | 1,
  scope: SidebarHistoryScope,
): { index: number; route: SidebarHistoryRoute } | null {
  const current = history.entries[history.index];
  const onScreen = current ? resolveDestination(current, scope) : null;
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const entry = history.entries[index];
    if (current && sameDestination(entry, current)) continue;
    const route = resolveDestination(entry, scope);
    if (route && !(onScreen && sameRoute(route, onScreen))) {
      return { index, route };
    }
  }
  return null;
}

/** Open a resolved entry with the same actions the sidebar's rows use. */
export function openSidebarHistoryRoute(
  route: SidebarHistoryRoute,
  navigator: SidebarHistoryNavigator,
): void {
  switch (route.kind) {
    case "page":
      navigator.dispatch({ type: "SET_ACTIVE_PAGE", page: route.page });
      return;
    case "create":
      navigator.dispatch({
        type: "OPEN_CREATE_PAGE",
        projectId: route.projectId,
      });
      return;
    case "repo":
      navigator.dispatch({
        type: "OPEN_REPO_PAGE",
        projectId: route.projectId,
      });
      return;
    case "workspace":
      navigator.openWorkspace(route.workspace);
  }
}

// --- SESSION STORE ---

let history = EMPTY_HISTORY;
const listeners = new Set<() => void>();
// The entry back/forward is opening. Its own store updates land on that entry
// instead of pushing a new one.
let steppingTo: number | null = null;

function publish(next: SidebarHistory): void {
  if (next === history) return;
  history = next;
  for (const listener of [...listeners]) listener();
}

function observe(state: WorkspaceState): void {
  const shown = sidebarDestinationFor(state);
  if (!shown) return;
  publish(
    steppingTo === null
      ? recordSidebarDestination(history, shown)
      : moveTo(history, steppingTo, shown),
  );
}

observe(useWorkspaceStore.getState());
// Runs after every dispatch, including streaming and draft updates, so it
// compares only the fields a destination is derived from. The active chat's
// folder is mirrored into lastWorkspaceFolder by the store itself.
const stopObserving = useWorkspaceStore.subscribe((state, prev) => {
  if (
    state.activePage === prev.activePage &&
    state.activeRepoId === prev.activeRepoId &&
    state.createWorkspaceProjectId === prev.createWorkspaceProjectId &&
    state.activeChatId === prev.activeChatId &&
    state.newAgentFolder === prev.newAgentFolder &&
    state.lastWorkspaceFolder === prev.lastWorkspaceFolder
  ) {
    return;
  }
  observe(state);
});
// The selection also publishes when only its Personal hint changes, which
// keeps the same organization and so the same history.
let organizationId = getActiveTeamId();
const stopFollowingOrganization = subscribeActiveTeam(() => {
  const next = getActiveTeamId();
  if (next === organizationId) return;
  organizationId = next;
  resetSidebarNavigationHistory();
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopObserving();
    stopFollowingOrganization();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSidebarNavigationHistory(): SidebarHistory {
  return history;
}

export function useSidebarNavigationHistory(): SidebarHistory {
  return useSyncExternalStore(
    subscribe,
    getSidebarNavigationHistory,
    getSidebarNavigationHistory,
  );
}

/** Go back (-1) or forward (+1). Returns false when no entry can be opened. */
export function stepSidebarHistory(
  direction: -1 | 1,
  scope: SidebarHistoryScope,
  navigator: SidebarHistoryNavigator,
): boolean {
  const target = sidebarHistoryTarget(history, direction, scope);
  if (!target) return false;
  steppingTo = target.index;
  try {
    openSidebarHistoryRoute(target.route, navigator);
  } finally {
    steppingTo = null;
  }
  // The open may publish nothing when the store already shows the target.
  publish(moveTo(history, target.index));
  return true;
}

/** Start over from the destination on screen. */
export function resetSidebarNavigationHistory(): void {
  const shown = sidebarDestinationFor(useWorkspaceStore.getState());
  publish(
    shown ? recordSidebarDestination(EMPTY_HISTORY, shown) : EMPTY_HISTORY,
  );
}
