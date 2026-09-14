import { useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileDiff,
  GitCommitVertical,
  GitCompare,
  GitPullRequest,
  SquarePlus,
  SquareSlash,
  type LucideProps,
} from "lucide-react";
import type {
  ChangesHistory,
  TurnIdentity,
} from "@zeros/protocol/changes-history";
import type { ChangeCounts, Commit } from "@/renderer/platform/git";
import type { TurnInfo } from "@/renderer/platform/turns";
import { cn } from "@/renderer/shared/ui/cn";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/renderer/shared/ui/primitives";
import { type Scope } from "./changes-scope";

const PAGE_SIZE = 50;
const LATEST_TURN_LABEL = "Latest agent turn";

function BranchIcon({ className, ...props }: LucideProps) {
  return (
    <GitPullRequest
      {...props}
      className={cn("-scale-x-100 rotate-180", className)}
    />
  );
}

function scopeIcon(scope: Scope) {
  switch (scope.kind) {
    case "all":
      return BranchIcon;
    case "uncommitted":
      return FileDiff;
    case "staged":
      return SquarePlus;
    case "unstaged":
      return SquareSlash;
    case "commit":
    case "commit-range":
    case "commits":
      return GitCommitVertical;
    default:
      return GitCompare;
  }
}

const turnKey = (turn: TurnIdentity) =>
  JSON.stringify([turn.chatId, turn.turnId]);
const turnLabel = (turn: TurnInfo) =>
  turn.summary?.trim().split("\n", 1)[0] || `Turn ${turn.ord}`;

export function historyRangeBounds(
  ids: string[],
  from: string,
  to: string,
): [number, number] | null {
  const start = ids.indexOf(from);
  const end = ids.indexOf(to);
  return start < 0 || end < 0
    ? null
    : [Math.min(start, end), Math.max(start, end)];
}

function scopeLabel(scope: Scope, turns: TurnInfo[]): string {
  switch (scope.kind) {
    case "all":
      return "Branch";
    case "uncommitted":
      return "Uncommitted";
    case "staged":
      return "Staged";
    case "unstaged":
      return "Unstaged";
    case "commits":
      return "All Commits";
    case "turns":
      return "All Turns";
    case "last-turn":
      return LATEST_TURN_LABEL;
    case "commit":
      return scope.sha.slice(0, 7);
    case "commit-range":
      return scope.from === scope.to
        ? scope.from.slice(0, 7)
        : `${scope.from.slice(0, 7)} → ${scope.to.slice(0, 7)}`;
    case "turn-range": {
      const from = turns.find((turn) => turnKey(turn) === turnKey(scope.from));
      const to = turns.find((turn) => turnKey(turn) === turnKey(scope.to));
      if (
        turnKey(scope.from) === turnKey(scope.to) &&
        turns[0] &&
        turnKey(scope.from) === turnKey(turns[0])
      ) {
        return LATEST_TURN_LABEL;
      }
      return turnKey(scope.from) === turnKey(scope.to)
        ? from
          ? turnLabel(from)
          : "Selected turn"
        : from && to
          ? `Turn ${from.ord} → Turn ${to.ord}`
          : "Selected turns";
    }
  }
}

type HistoryRow = {
  id: string;
  label: string;
  detail?: string;
  additions?: number;
  deletions?: number;
};

function HistoryItems({
  rows,
  allLabel,
  allSelected,
  bounds,
  onAll,
  onRange,
  showRangeHint = true,
  loading = false,
  error,
  onRetry,
}: {
  rows: HistoryRow[];
  allLabel: string;
  allSelected: boolean;
  bounds: [number, number] | null;
  onAll: () => void;
  onRange: (oldest: number, newest: number) => void;
  showRangeHint?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  const select = (index: number) => {
    const start =
      anchor.current === null
        ? -1
        : rows.findIndex((row) => row.id === anchor.current);
    if (start < 0) {
      anchor.current = rows[index].id;
      onRange(index, index);
    } else {
      onRange(Math.max(start, index), Math.min(start, index));
      if (!shift.current) anchor.current = null;
    }
    shift.current = false;
  };
  return (
    <>
      <DropdownMenuCheckboxItem
        indicatorSide="end"
        checked={allSelected}
        disabled={!rows.length}
        onSelect={(event) => {
          event.preventDefault();
          anchor.current = null;
          onAll();
        }}
      >
        {allLabel}
      </DropdownMenuCheckboxItem>
      {rows.slice(0, visible).map((row, index) => {
        const checked =
          allSelected || (!!bounds && index >= bounds[0] && index <= bounds[1]);
        return (
          <DropdownMenuCheckboxItem
            key={row.id}
            indicatorSide="end"
            checked={checked}
            title={row.detail ?? row.label}
            onPointerDown={(event) => {
              shift.current = event.shiftKey;
            }}
            onKeyDown={(event) => {
              shift.current = event.shiftKey;
            }}
            onSelect={(event) => {
              event.preventDefault();
              select(index);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.additions !== undefined && (
              <span className="text-green-primary shrink-0 tabular-nums">
                +{row.additions}
              </span>
            )}
            {row.deletions !== undefined && row.deletions > 0 && (
              <span className="text-red-primary shrink-0 tabular-nums">
                −{row.deletions}
              </span>
            )}
          </DropdownMenuCheckboxItem>
        );
      })}
      {visible < rows.length && (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setVisible((count) => count + PAGE_SIZE);
          }}
        >
          <span className="text-fg3">… {rows.length - visible} more</span>
        </DropdownMenuItem>
      )}
      {error ? (
        <div role="alert" className="text-red-fg px-2 py-1.5 text-xs">
          <p className="m-0">{error}</p>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={onRetry}
            aria-label={
              allLabel === "All Commits"
                ? "Retry commit history"
                : "Retry turn history"
            }
          >
            Retry
          </Button>
        </div>
      ) : (
        (!rows.length || showRangeHint) && (
          <p className="text-fg3 px-2 py-1.5 text-xs">
            {!rows.length && loading
              ? "Loading history…"
              : rows.length
                ? "Select two endpoints to choose a range."
                : "No history yet"}
          </p>
        )
      )}
    </>
  );
}

export function ChangesScopeMenu({
  scope,
  commits,
  turns,
  legacyTurn,
  changeCounts,
  onChange,
  commitsLoading,
  turnsLoading,
  commitsError,
  turnsError,
  onRetry,
}: {
  scope: Scope;
  commits: Commit[];
  turns: TurnInfo[];
  legacyTurn?: TurnInfo | null;
  changeCounts: ChangeCounts;
  onChange: (scope: Scope) => void;
  commitsLoading?: boolean;
  turnsLoading?: boolean;
  commitsError?: string | null;
  turnsError?: string | null;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const commitRows = useMemo(
    () =>
      commits.map((c) => ({
        id: c.sha,
        label: c.message.split("\n", 1)[0] || c.abbreviatedSha,
        detail: `${c.abbreviatedSha} · ${c.message.trim()}`,
      })),
    [commits],
  );
  const turnRows = useMemo(
    () =>
      turns.map((turn, index) => ({
        id: turnKey(turn),
        label: index === 0 ? LATEST_TURN_LABEL : turnLabel(turn),
        detail: `Turn ${turn.ord} · ${turnLabel(turn)}`,
        additions: turn.files.reduce((n, file) => n + file.additions, 0),
        deletions: turn.files.reduce((n, file) => n + file.deletions, 0),
      })),
    [turns],
  );
  const selected: Scope = legacyTurn
    ? { kind: "turn-range", from: legacyTurn, to: legacyTurn }
    : scope;
  const commitScope =
    selected.kind === "commit" ||
    selected.kind === "commit-range" ||
    selected.kind === "commits";
  const turnScope =
    selected.kind === "turn-range" ||
    selected.kind === "turns" ||
    selected.kind === "last-turn";
  const commitBounds =
    selected.kind === "commit-range"
      ? historyRangeBounds(
          commits.map((c) => c.sha),
          selected.from,
          selected.to,
        )
      : selected.kind === "commit"
        ? historyRangeBounds(
            commits.map((c) => c.sha),
            selected.sha,
            selected.sha,
          )
        : null;
  const turnBounds: [number, number] | null =
    selected.kind === "turn-range"
      ? historyRangeBounds(
          turns.map(turnKey),
          turnKey(selected.from),
          turnKey(selected.to),
        )
      : selected.kind === "last-turn" && turns.length
        ? [0, 0]
        : null;
  const commitRange = (oldest: number, newest: number): ChangesHistory => ({
    kind: "commit-range",
    from: commits[oldest].sha,
    to: commits[newest].sha,
  });
  const turnRange = (oldest: number, newest: number): ChangesHistory =>
    oldest === 0 && newest === 0
      ? { kind: "last-turn" }
      : {
          kind: "turn-range",
          from: { chatId: turns[oldest].chatId, turnId: turns[oldest].turnId },
          to: { chatId: turns[newest].chatId, turnId: turns[newest].turnId },
        };
  const selectLatestTurn = () => {
    onChange({ kind: "last-turn" });
    setOpen(false);
  };
  const ScopeIcon = scopeIcon(selected);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-fg2 hover:text-fg1 data-[state=open]:text-fg1 min-w-0 gap-1.5 bg-transparent px-1.5 text-xs font-normal hover:bg-transparent [&_svg]:size-3.5"
          aria-label={`Changes scope: ${scopeLabel(selected, turns)}`}
        >
          <ScopeIcon className="size-3.5" />
          <span className="max-w-48 truncate">
            {scopeLabel(selected, turns)}
          </span>
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-selected={turnScope || undefined}
            onClick={(event) => {
              event.preventDefault();
              selectLatestTurn();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectLatestTurn();
              }
            }}
          >
            <GitCompare className="text-fg2" />
            <span className="flex-1">{LATEST_TURN_LABEL}</span>
            {turnScope && <Check />}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="max-h-[min(480px,var(--radix-dropdown-menu-content-available-height))] w-[320px] overflow-y-auto">
              <HistoryItems
                rows={turnRows}
                loading={turnsLoading}
                error={turnsError}
                onRetry={onRetry}
                allLabel="All Turns"
                showRangeHint={false}
                allSelected={selected.kind === "turns"}
                bounds={turnBounds}
                onAll={() => onChange({ kind: "turns" })}
                onRange={(oldest, newest) =>
                  onChange(turnRange(oldest, newest))
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        {(
          [
            { kind: "all", label: "Branch", icon: BranchIcon },
            { kind: "uncommitted", label: "Uncommitted", icon: FileDiff },
            { kind: "staged", label: "Staged", icon: SquarePlus },
            { kind: "unstaged", label: "Unstaged", icon: SquareSlash },
          ] as const
        ).map(({ kind, label, icon: Icon }) => (
          <DropdownMenuItem
            key={kind}
            data-selected={selected.kind === kind || undefined}
            onSelect={() => onChange({ kind })}
          >
            <Icon className="text-fg2" />
            <span className="flex-1">{label}</span>
            {selected.kind === kind ? (
              <Check />
            ) : (
              <span className="text-fg3 tabular-nums">
                {changeCounts[kind]}
              </span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <GitCommitVertical className="text-fg2" />
            <span className="flex-1">Commits</span>
            {commitScope && <Check />}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="max-h-[min(480px,var(--radix-dropdown-menu-content-available-height))] w-[320px] overflow-y-auto">
              <HistoryItems
                rows={commitRows}
                loading={commitsLoading}
                error={commitsError}
                onRetry={onRetry}
                allLabel="All Commits"
                allSelected={selected.kind === "commits"}
                bounds={commitBounds}
                onAll={() => onChange({ kind: "commits" })}
                onRange={(oldest, newest) =>
                  onChange(commitRange(oldest, newest))
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
