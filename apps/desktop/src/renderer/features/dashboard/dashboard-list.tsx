import {
  forwardRef,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, Folder, FolderX } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { StatusIcon } from "../../shared/ui/primitives/status-icon";
import { ZerosSpinner } from "../../shared/ui/loading";
import { statusMeta } from "../../shared/lib/workspace-status";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import type { PendingWorkspaceCreate } from "../../state/pending-workspaces";
import { formatCompactAge } from "../agent/format-age";
import {
  DashboardRepositoryIcon,
  DashboardLineChanges,
  DashboardCost,
  DashboardPlacement,
} from "./dashboard-metadata";
import type { DashboardDisplay } from "./preferences";
import type { DashboardRow } from "./dashboard-model";

export function DashboardList({
  rows,
  pending,
  display,
  active,
  renderRow,
  renderPending,
}: {
  rows: DashboardRow[];
  pending: PendingWorkspaceCreate[];
  display: DashboardDisplay;
  active: boolean;
  renderRow: (row: DashboardRow, rowIndex: number) => ReactNode;
  renderPending: (
    pending: PendingWorkspaceCreate,
    rowIndex: number,
  ) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => [
      ...pending.map((value) => ({
        kind: "pending" as const,
        key: value.token,
        value,
      })),
      ...rows.map((value) => ({
        kind: "workspace" as const,
        key: value.workspace.id,
        value,
      })),
    ],
    [pending, rows],
  );
  const virtualized = items.length > 100;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 48,
    overscan: 8,
    getItemKey: (index) => items[index].key,
    enabled: active && virtualized,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visibleIndices = virtualized
    ? virtualRows.map((item) => item.index)
    : items.map((_, index) => index);
  const columns =
    2 +
    Number(display.repository || display.repositoryIcon) +
    Number(display.lineChanges) +
    Number(display.cost) +
    Number(display.owner) +
    Number(display.lastActive);
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length
    ? Math.max(
        0,
        virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end,
      )
    : 0;
  // Keep the name usable when optional columns are enabled in a narrow pane.
  const minWidth =
    256 +
    144 +
    (display.repository ? 144 : display.repositoryIcon ? 40 : 0) +
    (display.lineChanges ? 96 : 0) +
    (display.cost ? 80 : 0) +
    (display.owner ? 96 : 0) +
    (display.lastActive ? 80 : 0);
  return (
    <div
      ref={scroll}
      className="min-h-0 flex-1 overflow-auto px-6 pb-4"
      data-dashboard-view="list"
      role="region"
      aria-label="Workspace list"
    >
      <table
        className="w-full table-fixed border-collapse text-left text-xs"
        style={{ minWidth }}
        aria-label="Workspaces"
        aria-rowcount={items.length + 1}
      >
        <colgroup>
          <col />
          {(display.repository || display.repositoryIcon) && (
            <col className={display.repository ? "w-36" : "w-10"} />
          )}
          {display.lineChanges && <col className="w-24" />}
          {display.cost && <col className="w-20" />}
          {display.owner && <col className="w-24" />}
          {display.lastActive && <col className="w-20" />}
          <col className="w-36" />
        </colgroup>
        <thead className="bg-bg1 text-fg3 sticky top-0 z-1">
          <tr className="border-border1 border-b" aria-rowindex={1}>
            <th scope="col" className="h-8 pr-3 pl-2 font-medium">
              Workspace
            </th>
            {(display.repository || display.repositoryIcon) && (
              <th scope="col" className="px-2 font-medium">
                {display.repository ? (
                  "Repository"
                ) : (
                  <span className="sr-only">Repository icon</span>
                )}
              </th>
            )}
            {display.lineChanges && (
              <th scope="col" className="px-2 text-right font-medium">
                Changes
              </th>
            )}
            {display.cost && (
              <th scope="col" className="px-2 text-right font-medium">
                Cost
              </th>
            )}
            {display.owner && (
              <th scope="col" className="px-2 font-medium">
                Owner
              </th>
            )}
            {display.lastActive && (
              <th scope="col" className="px-2 text-right font-medium">
                Active
              </th>
            )}
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns} style={{ height: paddingTop }} />
            </tr>
          )}
          {visibleIndices.map((index) => {
            const item = items[index];
            // Row 1 is the header. Preserve each logical position when rows
            // outside the viewport are omitted from the accessibility tree.
            return item.kind === "pending"
              ? renderPending(item.value, index + 2)
              : renderRow(item.value, index + 2);
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns} style={{ height: paddingBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface DashboardListRowProps extends Omit<
  ComponentPropsWithoutRef<"tr">,
  "children"
> {
  row: DashboardRow;
  display: DashboardDisplay;
  ownerName: string;
  active: boolean;
  onOpen: () => void;
  onWarm?: () => void;
  actions: ReactNode;
  busy?: boolean;
}

// Forward the native row props/ref so the shared context menu can own its
// pointer/keyboard trigger and phantom-click guard with asChild.
export const DashboardListRow = forwardRef<
  HTMLTableRowElement,
  DashboardListRowProps
>(function DashboardListRow(
  {
    row,
    display,
    ownerName,
    active,
    onOpen,
    onWarm,
    actions,
    busy = false,
    ...rowProps
  },
  ref,
) {
  const w = row.workspace;
  const archived = w.archivedAt != null;
  const missing = w.present === false && !archived;
  const status = archived
    ? "Archived"
    : missing
      ? "Folder missing"
      : isLocalMainWorkspace(w)
        ? "Folder"
        : statusMeta(w.status).label;
  return (
    <tr
      {...rowProps}
      ref={ref}
      className="border-border1 hover:bg-bg1-hover focus-within:bg-bg1-hover group h-12 cursor-pointer border-b"
      data-dashboard-workspace={w.id}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy && active) onOpen();
      }}
      onPointerEnter={() => {
        if (active) onWarm?.();
      }}
      onFocus={() => {
        if (active) onWarm?.();
      }}
    >
      <td className="pr-3 pl-1">
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={`Open ${row.title}${archived || missing ? " history" : ""}`}
          className="h-10 w-full min-w-0 justify-start gap-3 px-1 hover:bg-transparent"
          onClick={(event) => {
            event.stopPropagation();
            if (active) onOpen();
          }}
        >
          <Tooltip label={status}>
            <span className="shrink-0" role="img" aria-label={status}>
              {archived ? (
                <Archive className="text-muted-fg size-4" />
              ) : missing ? (
                <FolderX className="text-red-primary size-4" />
              ) : isLocalMainWorkspace(w) ? (
                <Folder className="text-fg2 size-4" />
              ) : (
                <StatusIcon status={w.status} className="size-4" />
              )}
            </span>
          </Tooltip>
          <span className="min-w-0 flex-1 text-left">
            <span className="text-fg1 block truncate font-medium">
              {row.title}
            </span>
            <span className="text-fg3 text-3xxs block truncate font-normal">
              {archived ? "Archived" : missing ? "Folder missing" : row.branch}
            </span>
          </span>
          <DashboardPlacement workspace={w} active={active} />
        </Button>
      </td>
      {(display.repository || display.repositoryIcon) && (
        <td
          className="px-2"
          aria-label={display.repository ? undefined : row.repoName}
        >
          <Tooltip label={row.repoName}>
            <span className="text-fg2 flex min-w-0 items-center gap-2">
              {display.repositoryIcon && (
                <DashboardRepositoryIcon
                  project={row.project}
                  name={row.repoName}
                />
              )}
              {display.repository && (
                <span className="truncate">{row.repoName}</span>
              )}
            </span>
          </Tooltip>
        </td>
      )}
      {display.lineChanges && (
        <td className="px-2 text-right">
          <DashboardLineChanges workspace={w} active={active} />
        </td>
      )}
      {display.cost && (
        <td className="px-2 text-right">
          <DashboardCost />
        </td>
      )}
      {display.owner && (
        <td className="text-fg3 truncate px-2" title={ownerName}>
          {ownerName}
        </td>
      )}
      {display.lastActive && (
        <td className="text-muted-fg group-hover:text-fg3 px-2 text-right tabular-nums">
          <time
            dateTime={new Date(row.lastActiveAt).toISOString()}
            title={new Date(row.lastActiveAt).toLocaleString()}
          >
            {formatCompactAge(row.lastActiveAt)}
          </time>
        </td>
      )}
      <td className="px-2" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">{actions}</div>
      </td>
    </tr>
  );
});

export function PendingDashboardListRow({
  label,
  display,
  rowIndex,
}: {
  label: string;
  display: DashboardDisplay;
  rowIndex: number;
}) {
  const columns =
    2 +
    Number(display.repository || display.repositoryIcon) +
    Number(display.lineChanges) +
    Number(display.cost) +
    Number(display.owner) +
    Number(display.lastActive);
  return (
    <tr className="border-border1 h-12 border-b" aria-rowindex={rowIndex}>
      <td colSpan={columns} className="px-2">
        <div role="status" className="text-fg2 flex items-center gap-3">
          <ZerosSpinner size={16} />
          <span className="truncate">{label}</span>
          <span className="text-fg3 shrink-0">Setting up…</span>
        </div>
      </td>
    </tr>
  );
}
