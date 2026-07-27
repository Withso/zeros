import type { WorkspaceStatus } from "@/native/git";

/** Display metadata for one lifecycle status. */
export interface LifecycleStatusMeta {
  value: WorkspaceStatus;
  label: string;
  /** Tailwind text-color class — a color-family token (yellow / green /
   *  violet primary) or neutral --fg3. Colors both the status glyph and label. */
  colorClass: string;
}

/** The five kanban lifecycle states in board (left→right) order. THE single
 *  source of truth for status labels, ordering, and color — shared by the
 *  Dashboard columns, the right-click "Set status" menu, and the status glyph.
 *
 *  Automatic transitions land on in-progress / in-review / done; backlog and
 *  cancelled are reachable only by an explicit manual set. */
export const LIFECYCLE_STATUSES: readonly LifecycleStatusMeta[] = [
  { value: "backlog", label: "Backlog", colorClass: "text-fg3" },
  {
    value: "in-progress",
    label: "In progress",
    colorClass: "text-yellow-primary",
  },
  {
    value: "in-review",
    label: "In review",
    colorClass: "text-green-primary",
  },
  { value: "done", label: "Done", colorClass: "text-violet-primary" },
  {
    value: "cancelled",
    label: "Cancelled",
    colorClass: "text-fg3",
  },
];

const BY_VALUE = new Map<WorkspaceStatus, LifecycleStatusMeta>(
  LIFECYCLE_STATUSES.map((s) => [s.value, s]),
);

/** Metadata for a status; falls back to "in-progress" for an unknown value so a
 *  stale/legacy row still renders something sensible instead of crashing. */
export function statusMeta(status: WorkspaceStatus): LifecycleStatusMeta {
  return BY_VALUE.get(status) ?? LIFECYCLE_STATUSES[1];
}

export function statusLabel(status: WorkspaceStatus): string {
  return statusMeta(status).label;
}
