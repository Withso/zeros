// Pure helpers behind the sidebar's View menu: which workspaces a filter keeps,
// the order they sort in, the extra groupings and a row's pull request marks.
import type { Workspace } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import type {
  SidebarAgentStatusFilter,
  SidebarExtraGrouping,
  SidebarOwnerFilter,
  SidebarPrFilter,
  SidebarViewPreferences,
  SidebarWorkspaceSort,
} from "../state/sidebar-list-preferences";
import { SIDEBAR_VIEW_DEFAULTS } from "../state/sidebar-list-preferences";
import { workspacePrTone } from "./workspace-glyph";

/** What the sidebar knows about a workspace's chats, read once for the list. */
export interface SidebarWorkspaceSignal {
  awaiting: "plan" | "input" | null;
  working: boolean;
  unread: boolean;
  draft: boolean;
}

export const NO_SIGNAL: SidebarWorkspaceSignal = Object.freeze({ awaiting: null, working: false, unread: false, draft: false });

export function agentStatusOf(workspace: Workspace, signal: SidebarWorkspaceSignal = NO_SIGNAL): SidebarAgentStatusFilter {
  if (signal.awaiting) return "input";
  if (signal.working) return "working";
  if (workspace.setupState === "failed") return "failed";
  if (signal.unread) return "unread";
  return "idle";
}

export type PrMarkTone = Exclude<SidebarPrFilter, "none">;
export const PR_MARK_TONES: readonly PrMarkTone[] = ["open", "conflicts", "draft", "merged", "closed"];

export interface SidebarPullRequest {
  number: number;
  url: string | null;
  repository: string | null;
  tone: PrMarkTone;
}

/** Every pull request a workspace holds: one per repository, the primary one
 * taking the island's live state. */
export function workspacePullRequests(workspace: Workspace, islandKind: string | null = null): SidebarPullRequest[] {
  const repositories = workspace.repositories?.length ? workspace.repositories : null;
  const rows = repositories
    ? repositories.map((repository, index) => ({
        prNumber: repository.prNumber, prState: repository.prState, prUrl: repository.prUrl,
        repository: repository.repository, island: index === 0 ? islandKind : null,
      }))
    : [{ prNumber: workspace.prNumber, prState: workspace.prState, prUrl: workspace.prUrl, repository: null, island: islandKind }];
  return rows.flatMap((row) => {
    if (row.prNumber == null) return [];
    const tone = row.prState === "draft" ? "draft" : workspacePrTone(row, row.island);
    if (!tone) return [];
    return [{ number: row.prNumber, url: row.prUrl, repository: row.repository, tone: tone === "ready" ? "open" : tone }];
  });
}

export interface PrMarkGroup { tone: PrMarkTone; pulls: SidebarPullRequest[] }

export function prMarkGroups(pulls: readonly SidebarPullRequest[]): PrMarkGroup[] {
  return PR_MARK_TONES.flatMap((tone) => {
    const group = pulls.filter((pull) => pull.tone === tone);
    return group.length ? [{ tone, pulls: group }] : [];
  });
}

export type PrMarkLayout = "separate" | "combined" | "single";

const digits = (n: number) => String(n).length;
/** Estimated pixel widths of the three PR mark steps at 11px tabular figures. */
export function prMarkWidth(groups: readonly PrMarkGroup[], layout: PrMarkLayout): number {
  const total = groups.reduce((sum, group) => sum + group.pulls.length, 0);
  if (layout === "single") return 14 + 2 + digits(total) * 7;
  if (layout === "combined") return groups.length * 12 + (groups.length - 1) * 3 + 4 + digits(total) * 7;
  return groups.reduce((sum, group) => sum + 12 + 2 + digits(group.pulls.length) * 7, 0) + (groups.length - 1) * 6;
}

/** Separate marks while they fit, then one combined group, then one blue icon.
 * A single state is never combined. Compact rows combine past two states. */
export function prMarkLayout(groups: readonly PrMarkGroup[], available: number, compact = false): PrMarkLayout {
  if (groups.length <= 1) return "separate";
  if (compact) return groups.length > 2 ? "single" : "separate";
  if (prMarkWidth(groups, "separate") <= available) return "separate";
  if (prMarkWidth(groups, "combined") <= available) return "combined";
  return "single";
}

export function isCloudRow(workspace: Pick<Workspace, "placement" | "path">): boolean {
  return workspace.placement === "cloud" || isCloudWorkspace(workspace.path);
}

/** Whether the view narrows the list beyond the per-owner repository and
 * placement filters. */
export function sidebarViewFilters(view: SidebarViewPreferences): boolean {
  return view.statuses.length > 0 || view.prStates.length > 0 || view.owners.length > 0 || view.unreadOnly || view.draftOnly;
}

export function filterSidebarWorkspaces(
  workspaces: readonly Workspace[],
  view: SidebarViewPreferences,
  signalOf: (workspace: Workspace) => SidebarWorkspaceSignal,
  ownerOf?: (workspace: Workspace) => SidebarOwnerFilter | null,
): readonly Workspace[] {
  if (!sidebarViewFilters(view)) return workspaces;
  return workspaces.filter((workspace) => {
    const signal = signalOf(workspace);
    if (view.unreadOnly && !signal.unread) return false;
    if (view.draftOnly && !signal.draft) return false;
    if (view.statuses.length && !view.statuses.includes(agentStatusOf(workspace, signal))) return false;
    if (view.prStates.length) {
      const tones = workspacePullRequests(workspace).map((pull) => pull.tone);
      if (!(tones.length ? tones.some((tone) => view.prStates.includes(tone)) : view.prStates.includes("none"))) return false;
    }
    if (view.owners.length && ownerOf) {
      const owner = ownerOf(workspace);
      if (owner && !view.owners.includes(owner)) return false;
    }
    return true;
  });
}

const finite = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function workspaceUpdatedAt(workspace: Workspace, activeAt?: number): number {
  return Math.max(finite(workspace.createdAt), finite(workspace.lastActiveAt), finite(activeAt));
}

/** A stable comparator for the sort, direction and Needs you on top. */
export function sidebarWorkspaceComparator(args: {
  sort: SidebarWorkspaceSort;
  direction: "desc" | "asc";
  needsYouFirst: boolean;
  label: (workspace: Workspace) => string;
  activeAt: (workspace: Workspace) => number | undefined;
  needsYou: (workspace: Workspace) => boolean;
}): (a: Workspace, b: Workspace) => number {
  const { sort, direction, needsYouFirst, label, activeAt, needsYou } = args;
  const sign = direction === "asc" ? -1 : 1;
  return (a, b) => {
    if (needsYouFirst) {
      const delta = Number(needsYou(b)) - Number(needsYou(a));
      if (delta) return delta;
    }
    // Name reads A→Z by default; the direction flips it.
    if (sort === "name") return sign * label(a).localeCompare(label(b), undefined, { sensitivity: "base", numeric: true });
    const at = (workspace: Workspace) => sort === "created" ? finite(workspace.createdAt) : workspaceUpdatedAt(workspace, activeAt(workspace));
    return sign * (at(b) - at(a));
  };
}

export interface SidebarGroupKey { key: string; label: string }

const DAY = 86_400_000;
export function recencyGroup(at: number, now = Date.now()): SidebarGroupKey {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (at >= today) return { key: "today", label: "Today" };
  if (at >= today - DAY) return { key: "yesterday", label: "Yesterday" };
  if (at >= today - 6 * DAY) return { key: "week", label: "This week" };
  if (at >= today - 29 * DAY) return { key: "month", label: "This month" };
  return { key: "older", label: "Older" };
}

const RECENCY_ORDER = ["today", "yesterday", "week", "month", "older"];
const PR_LABELS: Record<SidebarPrFilter, string> = { open: "Open", conflicts: "Needs attention", draft: "Draft", merged: "Merged", closed: "Closed", none: "No pull request" };
const PR_ORDER: readonly SidebarPrFilter[] = ["open", "conflicts", "draft", "merged", "closed", "none"];
const STATUS_LABELS: Record<SidebarAgentStatusFilter, string> = { input: "Needs you", working: "Working", failed: "Failed", unread: "Done, unread", idle: "Idle" };
const STATUS_ORDER: readonly SidebarAgentStatusFilter[] = ["input", "working", "failed", "unread", "idle"];

export const AGENT_STATUS_LABELS = STATUS_LABELS;
export const PR_FILTER_LABELS = PR_LABELS;

/** The group a workspace falls in for a grouping beyond Repository / Status. */
export function extraGroupOf(
  grouping: SidebarExtraGrouping | "agent-status",
  workspace: Workspace,
  context: { signal: SidebarWorkspaceSignal; activeAt?: number; owner?: SidebarOwnerFilter | null; now?: number },
): SidebarGroupKey & { order: number } {
  switch (grouping) {
    case "placement":
      return isCloudRow(workspace) ? { key: "cloud", label: "Cloud", order: 1 } : { key: "local", label: "This Mac", order: 0 };
    case "owner":
      return context.owner === "following" ? { key: "following", label: "Following", order: 1 } : { key: "mine", label: "Mine", order: 0 };
    case "recency": {
      const group = recencyGroup(workspaceUpdatedAt(workspace, context.activeAt), context.now);
      return { ...group, order: RECENCY_ORDER.indexOf(group.key) };
    }
    case "pr": {
      const tones = workspacePullRequests(workspace).map((pull) => pull.tone);
      const tone = PR_ORDER.find((value) => value !== "none" && tones.includes(value)) ?? "none";
      return { key: tone, label: PR_LABELS[tone], order: PR_ORDER.indexOf(tone) };
    }
    case "agent-status": {
      const status = agentStatusOf(workspace, context.signal);
      return { key: status, label: STATUS_LABELS[status], order: STATUS_ORDER.indexOf(status) };
    }
  }
}

export type SidebarViewKey = keyof SidebarViewPreferences;
/** Which view options differ from the default, so the menu can mark them. */
export function changedSidebarView(view: SidebarViewPreferences, keys: readonly SidebarViewKey[]): SidebarViewKey[] {
  return keys.filter((key) => JSON.stringify(view[key]) !== JSON.stringify(SIDEBAR_VIEW_DEFAULTS[key]));
}
