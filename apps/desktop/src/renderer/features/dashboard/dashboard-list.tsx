import {
  forwardRef,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, Folder, FolderX } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { Avatar, AvatarFallback } from "../../shared/ui/primitives/avatar";
import { initialsOf } from "../../shared/lib/initials";
import { Button } from "../../shared/ui/primitives/button";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { StatusIcon } from "../../shared/ui/primitives/status-icon";
import { ZerosSpinner } from "../../shared/ui/loading";
import { statusMeta } from "../../shared/lib/workspace-status";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { PrPill } from "../../shell/pr/pr-pill";
import { usePrIslandKind } from "../../shell/pr/pr-island-state-store";
import { workspacePrTone } from "../../shell/workspace-glyph";
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

// --- CONSTANTS ---

// Rows are plain: no card, fill or divider. 40px rows 2px apart; hover and
// focus paint bg1-hover across the row's cells with 8px end corners.
const ROW_CLS =
  "h-10 cursor-pointer [&>td]:py-1 [&>td]:transition-colors [&>td]:duration-120 [&>td:first-child]:rounded-l-lg [&>td:first-child]:pl-2.5 [&>td:last-child]:rounded-r-lg [&>td:last-child]:pr-2 hover:[&>td]:bg-bg1-hover focus-within:[&>td]:bg-bg1-hover";
// The title cell takes every free pixel and truncates; each option cell
// shrinks to its content, right-aligned on the shared column.
const TITLE_CELL_CLS = "w-full max-w-0";
const OPTION_CELL_CLS = "w-px p-0 text-right whitespace-nowrap";
// Each present option starts with the even 16px gutter; an empty cell (no PR)
// takes no space.
const OPTION_CLS = "inline-flex items-center justify-end pl-4 align-middle";
// Column names stay in the accessibility tree; the list shows no header row.
const HEAD_CLS = "h-0 p-0";
// Narrow windows drop options, not text: under 720px the status and
// repository tags keep only their icons, Changes and Cost hide under 560px,
// Owner under 440px.
const TAG_CLS =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full border border-border2 text-3xxs leading-4 text-fg2 @max-[720px]/list:border-transparent @max-[720px]/list:px-0.5";
const TAG_LABEL_CLS = "min-w-0 truncate @max-[720px]/list:sr-only";
const HIDE_UNDER_560_CLS = "@max-[560px]/list:hidden";
const HIDE_UNDER_440_CLS = "@max-[440px]/list:hidden";


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
    estimateSize: () => 42,
    overscan: 8,
    getItemKey: (index) => items[index].key,
    enabled: active && virtualized,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visibleIndices = virtualized
    ? virtualRows.map((item) => item.index)
    : items.map((_, index) => index);
  const columns =
    4 +
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
  return (
    <div
      ref={scroll}
      className="@container/list min-h-0 flex-1 overflow-auto px-6 pb-4"
      data-dashboard-view="list"
      role="region"
      aria-label="Workspace list"
    >
      <table
        className="w-full border-separate border-spacing-y-0.5 text-left text-xs"
        aria-label="Workspaces"
        aria-rowcount={items.length + 1}
      >
        <thead>
          <tr aria-rowindex={1}>
            <th scope="col" className={HEAD_CLS}>
              <span className="sr-only">Workspace</span>
            </th>
            <th scope="col" className={HEAD_CLS}>
              <span className="sr-only">Pull request</span>
            </th>
            <th scope="col" className={HEAD_CLS}>
              <span className="sr-only">Status</span>
            </th>
            {(display.repository || display.repositoryIcon) && (
              <th scope="col" className={HEAD_CLS}>
                <span className="sr-only">
                  {display.repository ? "Repository" : "Repository icon"}
                </span>
              </th>
            )}
            {display.lineChanges && (
              <th scope="col" className={cn(HEAD_CLS, HIDE_UNDER_560_CLS)}>
                <span className="sr-only">Changes</span>
              </th>
            )}
            {display.cost && (
              <th scope="col" className={cn(HEAD_CLS, HIDE_UNDER_560_CLS)}>
                <span className="sr-only">Cost</span>
              </th>
            )}
            {display.owner && (
              <th scope="col" className={cn(HEAD_CLS, HIDE_UNDER_440_CLS)}>
                <span className="sr-only">Owner</span>
              </th>
            )}
            {display.lastActive && (
              <th scope="col" className={HEAD_CLS}>
                <span className="sr-only">Active</span>
              </th>
            )}
            <th scope="col" className={HEAD_CLS}>
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
  const folder = isLocalMainWorkspace(w);
  const prTone = workspacePrTone(w, usePrIslandKind(w.id, w.prNumber));
  const status = archived
    ? "Archived"
    : missing
      ? "Folder missing"
      : folder
        ? "Folder"
        : statusMeta(w.status).label;
  return (
    <tr
      {...rowProps}
      ref={ref}
      className={cn("group", ROW_CLS)}
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
      <td className={TITLE_CELL_CLS}>
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={`Open ${row.title}${archived || missing ? " history" : ""}`}
          className="h-8 w-full min-w-0 justify-start gap-2 border-0 px-0 hover:bg-transparent"
          onClick={(event) => {
            event.stopPropagation();
            if (active) onOpen();
          }}
        >
          {/* Title and branch share one line; the branch gives way first. */}
          <span className="flex min-w-0 items-baseline gap-2 text-left">
            <span
              className={cn(
                "min-w-0 shrink truncate font-medium",
                archived ? "text-fg2" : "text-fg1",
              )}
            >
              {row.title}
            </span>
            <span className="text-fg3 text-3xxs min-w-0 shrink-[100] truncate leading-4 font-normal">
              {row.branch}
            </span>
          </span>
          <DashboardPlacement workspace={w} active={active} />
        </Button>
      </td>
      <td className={OPTION_CELL_CLS} onClick={(event) => event.stopPropagation()}>
        {w.prNumber != null && w.prUrl && (
          <span className={OPTION_CLS}>
            <PrPill number={w.prNumber} url={w.prUrl} tone={prTone ?? "open"} />
          </span>
        )}
      </td>
      <td className={OPTION_CELL_CLS}>
        <span className={OPTION_CLS}>
          <Tooltip label={status}>
            {/* The tag names its state once for assistive tech. */}
            <span
              className={cn(TAG_CLS, "pr-2 pl-1.5", missing && "text-red-fg")}
              role="img"
              aria-label={status}
            >
              {archived ? (
                <Archive className="text-muted-fg size-3.5 shrink-0" />
              ) : missing ? (
                <FolderX className="text-red-primary size-3.5 shrink-0" />
              ) : folder ? (
                <Folder className="text-fg2 size-3.5 shrink-0" />
              ) : (
                <StatusIcon status={w.status} className="size-3.5 shrink-0" />
              )}
              <span className={TAG_LABEL_CLS}>{status}</span>
            </span>
          </Tooltip>
        </span>
      </td>
      {(display.repository || display.repositoryIcon) && (
        <td
          className={OPTION_CELL_CLS}
          aria-label={display.repository ? undefined : row.repoName}
        >
          <span className={OPTION_CLS}>
            <Tooltip label={row.repoName}>
              <span
                className={cn(
                  TAG_CLS,
                  "max-w-40",
                  display.repositoryIcon ? "pl-0.5" : "pl-2.5",
                  display.repository ? "pr-2.5" : "pr-0.5",
                )}
              >
                {display.repositoryIcon && (
                  <DashboardRepositoryIcon
                    project={row.project}
                    name={row.repoName}
                    round
                  />
                )}
                {display.repository && (
                  <span className={TAG_LABEL_CLS}>{row.repoName}</span>
                )}
              </span>
            </Tooltip>
          </span>
        </td>
      )}
      {display.lineChanges && (
        <td className={cn(OPTION_CELL_CLS, HIDE_UNDER_560_CLS)}>
          <span className={OPTION_CLS}>
            <DashboardLineChanges workspace={w} active={active} />
          </span>
        </td>
      )}
      {display.cost && (
        <td className={cn(OPTION_CELL_CLS, HIDE_UNDER_560_CLS)}>
          <span className={cn(OPTION_CLS, "text-fg3 text-3xxs tabular-nums")}>
            <DashboardCost />
          </span>
        </td>
      )}
      {display.owner && (
        <td className={cn(OPTION_CELL_CLS, HIDE_UNDER_440_CLS)}>
          <span className={OPTION_CLS}>
            <Tooltip label={`Owner: ${ownerName}`}>
              <Avatar size="xs" aria-label={`Owner: ${ownerName}`} role="img">
                <AvatarFallback aria-hidden="true">{initialsOf(ownerName)}</AvatarFallback>
              </Avatar>
            </Tooltip>
          </span>
        </td>
      )}
      {display.lastActive && (
        <td className={OPTION_CELL_CLS}>
          <span className={cn(OPTION_CLS, "text-fg3 text-3xxs tabular-nums")}>
            <time
              dateTime={new Date(row.lastActiveAt).toISOString()}
              title={new Date(row.lastActiveAt).toLocaleString()}
            >
              {formatCompactAge(row.lastActiveAt)}
            </time>
          </span>
        </td>
      )}
      <td className={OPTION_CELL_CLS} onClick={(event) => event.stopPropagation()}>
        <span className={cn(OPTION_CLS, "gap-1")}>{actions}</span>
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
    4 +
    Number(display.repository || display.repositoryIcon) +
    Number(display.lineChanges) +
    Number(display.cost) +
    Number(display.owner) +
    Number(display.lastActive);
  return (
    <tr className="h-10 [&>td]:rounded-lg [&>td]:py-1 [&>td]:pr-2 [&>td]:pl-2.5" aria-rowindex={rowIndex}>
      <td colSpan={columns}>
        {/* Creating: a spinner and Setting up… across the row. */}
        <div role="status" className="text-fg2 flex min-w-0 items-center gap-2">
          <ZerosSpinner size={14} />
          <span className="min-w-0 truncate">{label}</span>
          <span className="text-fg3 shrink-0">Setting up…</span>
        </div>
      </td>
    </tr>
  );
}
