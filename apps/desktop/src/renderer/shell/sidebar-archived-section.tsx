// The owner's archived workspaces, read from the same keyed archive list as
// Home: a section under the live ones with View › Show archived, or Group ›
// Status's last group. Mounted only while one of those shows it, so the archive
// request never runs for users who keep both off.
import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { formatCompactAge } from "../features/agent/format-age";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { restoreWorkspaceWithFeedback } from "../state/archive-actions";
import { useArchivedWorkspaces } from "../state/use-projects";
import { useOpenWorkspace } from "../state/use-open-workspace";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading";
import { IconButton } from "../shared/ui/primitives/icon-button";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { workspaceLabel } from "./workspace-tabs";
import { SidebarGroupHeader } from "./sidebar-group-header";

const ARCHIVED_LIMIT = 20;

export function SidebarArchivedSection({
  variant,
  organization,
  collapsed,
  compact,
  onToggle,
}: {
  /** A section after the live ones, or the last group inside My workspaces. */
  variant: "section" | "group";
  organization: Parameters<typeof filterRowsForOrganization>[1];
  collapsed: boolean;
  compact: boolean;
  onToggle: (collapsed: boolean) => void;
}) {
  const { workspaces, resolved } = useArchivedWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => filterRowsForOrganization(workspaces, organization)
      .slice()
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
      .slice(0, ARCHIVED_LIMIT),
    [organization, workspaces],
  );
  // Group › Status drops empty groups; Archived is one of them. The section
  // stays, since the user turned View › Show archived on to see it.
  if (variant === "group" && resolved && rows.length === 0) return null;
  const now = Date.now();
  const listId = variant === "section" ? "sidebar-section-archived" : "sidebar-group-archived";
  return (
    <>
      <SidebarGroupHeader
        level={variant}
        label="Archived"
        count={resolved ? rows.length : undefined}
        expanded={!collapsed}
        controls={listId}
        onToggle={() => onToggle(!collapsed)}
        className={variant === "section" ? "mt-1" : undefined}
        {...(variant === "section" ? { "data-sidebar-section": "archived" } : { "data-sidebar-group": "group:archived" })}
      />
      <div id={listId} role="group" aria-label="Archived workspaces" className="flex flex-col gap-0.5 empty:hidden">
        {!collapsed && rows.map((workspace) => {
          const label = workspaceLabel(workspace);
          const busy = restoring.has(workspace.id);
          const restore = () => {
            if (busy) return;
            setRestoring((prev) => new Set(prev).add(workspace.id));
            void restoreWorkspaceWithFeedback(workspace, {
              label,
              onSettled: () => setRestoring((prev) => {
                const next = new Set(prev);
                next.delete(workspace.id);
                return next;
              }),
              onRestored: (result) => openWorkspace(result.workspace),
            });
          };
          return (
            <div key={workspace.id} data-sidebar-archived={workspace.id}
              className={cn("group/archived text-fg3 flex min-w-0 items-center gap-2 rounded-md pr-1 text-xs hover:bg-(--surface-hover)", variant === "group" ? "pl-8" : "pl-2", compact ? "h-8" : "h-9")}>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {workspace.archivedAt != null && (
                <span className="text-fg3 text-3xxs shrink-0 tabular-nums group-hover/archived:hidden group-focus-within/archived:hidden">
                  {formatCompactAge(workspace.archivedAt, now)}
                </span>
              )}
              <Tooltip label="Unarchive">
                <IconButton size="compact" label={`Unarchive ${label}`} onClick={restore} disabled={busy}
                  className={cn(!busy && "opacity-0 group-hover/archived:opacity-100 group-focus-within/archived:opacity-100 focus-visible:opacity-100")}>
                  {busy ? <ZerosSpinner size={12} /> : <RotateCcw strokeWidth={1.5} />}
                </IconButton>
              </Tooltip>
            </div>
          );
        })}
        {!collapsed && resolved && rows.length === 0 && (
          <div className="text-fg3 px-2 py-1.5 text-xs" role="status">No archived workspaces</div>
        )}
      </div>
    </>
  );
}
