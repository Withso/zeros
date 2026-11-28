// The Agents tab's rows and groups, kept pure so the grouping, the status a
// row shows and where it says it runs are tested without rendering.
//
// Groups follow the sidebar's Group › Status (sidebar-view-model.ts
// agentStatusOf): Needs you holds a question, a plan, a setup failure, a cloud
// error and an unread finish; then Working, Idle and Archived, in that order.

import { sidebarRowStatus, type SidebarRowStatus } from "../../sidebar-workspace-row-meta";
import type { ChatThread } from "../../../state/store";

export type AgentsSessionStatus = "input" | "plan" | "running" | "idle";
export type AgentsGroupId = "needs-you" | "working" | "idle" | "archived";

export const AGENTS_GROUPS: ReadonlyArray<{ id: AgentsGroupId; label: string }> = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "archived", label: "Archived" },
];

export interface AgentsRowSignal {
  status: AgentsSessionStatus;
  unread: boolean;
  /** Only for a child in its own workspace: that workspace's state. */
  setupFailed?: boolean;
  cloudStatus?: string | null;
  cloudError?: boolean;
  archived?: boolean;
}

/** The status word a row shows, in the sidebar's priority and colours; null
 *  leaves line 2 to the time. */
export function agentsRowStatus(signal: AgentsRowSignal): SidebarRowStatus | null {
  if (signal.archived) return null;
  return sidebarRowStatus({
    archiving: false,
    setupFailed: !!signal.setupFailed,
    cloudStatus: signal.cloudStatus ?? null,
    awaiting: signal.status === "input" || signal.status === "plan" ? signal.status : null,
    working: signal.status === "running",
    unread: signal.unread,
  });
}

export function agentsGroupOf(signal: AgentsRowSignal): AgentsGroupId {
  if (signal.archived) return "archived";
  if (signal.setupFailed || signal.cloudError) return "needs-you";
  if (signal.status === "input" || signal.status === "plan") return "needs-you";
  if (signal.status === "running") return "working";
  if (signal.unread) return "needs-you";
  return "idle";
}

/** Where a child runs, shown only when it is not this workspace: a laptop or
 *  a cloud for its own workspace, and its project when that differs too. */
export interface AgentsRowPlace {
  separate: boolean;
  cloud: boolean;
  project: string | null;
}

export function agentsRowPlace(
  chat: Pick<ChatThread, "folder">,
  args: {
    folder: string;
    /** The workspace that owns the tab's folder, and the child's. */
    current: { id: string; project?: { id: string; name: string } | null } | null;
    child: { id: string; project?: { id: string; name: string } | null } | null;
    cloud: boolean;
  },
): AgentsRowPlace {
  const separate = args.current && args.child ? args.child.id !== args.current.id : chat.folder !== args.folder;
  if (!separate) return { separate: false, cloud: false, project: null };
  const project = args.child?.project && args.child.project.id !== args.current?.project?.id ? args.child.project.name : null;
  return { separate: true, cloud: args.cloud, project };
}

/** Rows per group in display order; an empty group is left out. */
export function groupAgentsRows<T extends { group: AgentsGroupId }>(rows: readonly T[]) {
  return AGENTS_GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => row.group === group.id) }))
    .filter((group) => group.rows.length > 0);
}
