// "Show archived": the owner's archived workspaces under the live sections,
// read from the same keyed archive list as Home. Mounted only while the switch
// is on, so the archive request never runs for users who keep it off.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { formatCompactAge } from "../features/agent/format-age";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { restoreWorkspaceWithFeedback } from "../state/archive-actions";
import { useArchivedWorkspaces } from "../state/use-projects";
import { useOpenWorkspace } from "../state/use-open-workspace";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading";
import { Button } from "../shared/ui/primitives/button";
import { IconButton } from "../shared/ui/primitives/icon-button";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { workspaceLabel } from "./workspace-tabs";

const ARCHIVED_LIMIT = 20;

export function SidebarArchivedSection({
  organization,
  collapsed,
  compact,
  onToggle,
  labelClassName,
}: {
  organization: Parameters<typeof filterRowsForOrganization>[1];
  collapsed: boolean;
  compact: boolean;
  onToggle: (collapsed: boolean) => void;
  labelClassName: string;
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
  const now = Date.now();
  return (
    <>
      <div className="group/section flex h-8 shrink-0 items-center gap-1 pt-1" data-sidebar-section="archived">
        <Button type="button" variant="ghost"
          className="hover:bg-transparent h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-md border-0 px-2 font-normal [&_svg]:size-3 [&_svg]:text-fg3"
          aria-expanded={!collapsed} aria-controls="sidebar-section-archived"
          onClick={() => onToggle(!collapsed)}>
          <span className={cn(labelClassName, "min-w-0")}>Archived</span>
          {resolved && <span className="text-muted-fg text-3xxs tabular-nums">{rows.length}</span>}
          <span className="ml-auto inline-flex shrink-0" aria-hidden="true">
            {collapsed ? <ChevronRight strokeWidth={1.5} /> : <ChevronDown strokeWidth={1.5} />}
          </span>
        </Button>
      </div>
      <div id="sidebar-section-archived" role="group" aria-label="Archived workspaces" className="flex flex-col gap-0.5 empty:hidden">
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
              className={cn("group/archived text-fg3 flex min-w-0 items-center gap-2 rounded-md pr-1 pl-2 text-xs hover:bg-(--surface-hover)", compact ? "h-8" : "h-9")}>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {workspace.archivedAt != null && (
                <span className="text-muted-fg text-3xxs shrink-0 tabular-nums group-hover/archived:hidden group-focus-within/archived:hidden">
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
