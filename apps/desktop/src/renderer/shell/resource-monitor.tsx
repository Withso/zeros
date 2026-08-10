// ============================================
// COMPONENT: ResourceMonitor
// PURPOSE: Live whole-app CPU/memory pill and process-inspection popover.
// USED IN: TopBar, immediately before the archived-workspaces control.
// ============================================

// --- IMPORTS ---

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  GitFork,
  Layers3,
  SquareTerminal,
} from "lucide-react";

import {
  processMetricsSnapshot,
  type ProcessMetricsSnapshot,
  type ProcessResourceTotals,
} from "../platform/process-metrics";
import { ptyProcessPids, onPtyTerminalsChanged } from "../platform/pty";
import { useNativeRuntime } from "../platform/runtime";
import {
  getActiveBridge,
  onActiveBridgeChange,
  onActiveBridgeConnected,
} from "../platform/bridge/active-bridge";
import { Button } from "../shared/ui/primitives/button";
import { Pill } from "../shared/ui/primitives/pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shared/ui/primitives/popover";
import { ScrollArea } from "../shared/ui/primitives/scroll-area";
import { Separator } from "../shared/ui/primitives/separator";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { toast } from "../shared/ui/primitives/elements";
import {
  buildResourceView,
  collectResourceNodeIds,
  copyResourceReport,
  flattenResourceView,
  formatCpuPercent,
  formatResourceMemory,
  resolveResourceScope,
  selectResourceSnapshot,
  type ResourceSortDirection,
  type ResourceSortKey,
  type ResourceViewNode,
} from "./resource-monitor-model";

// --- CONSTANTS ---

const OPEN_SAMPLE_INTERVAL_MS = 1_000;
// The closed pill shows two rounded totals — it doesn't need a near-live
// cadence, and every sample forks a `ps` process-table scan in Electron main
// plus (while open) a PTY census round-trip. 15s keeps the pill honest while
// making the idle app quiet; opening the popover snaps to the 1s cadence.
const CLOSED_SAMPLE_INTERVAL_MS = 15_000;
const MAX_VISIBLE_TREE_DEPTH = 8;
const MAX_RENDERED_PROCESS_ROWS = 500;

// --- TYPES ---

interface TerminalOwnership {
  /** Last confirmed live PTY shell roots. */
  pids: number[];
  /** False while the exact engine census is unavailable or unsettled. */
  known: boolean;
}

interface ResourceSortButtonProps {
  /** Column controlled by this button. */
  sortKey: ResourceSortKey;
  /** Visible column label. */
  label: string;
  /** Currently selected sort column. */
  activeKey: ResourceSortKey;
  /** Current direction for the selected column. */
  direction: ResourceSortDirection;
  /** Column alignment within the process grid. */
  align: "start" | "end";
  /** Publishes a sort selection. */
  onSelect: (key: ResourceSortKey) => void;
}

interface ResourceProcessRowProps {
  /** Flattened view node rendered on this row. */
  node: ResourceViewNode;
  /** Bounded visual indentation in tree mode. */
  depth: number;
  /** Whether the row's descendants are currently hidden. */
  collapsed: boolean;
  /** CPU deltas are unavailable on the first/stale-baseline sample. */
  cpuReady: boolean;
  /** Toggles this node's ephemeral disclosure state. */
  onToggle: (id: string) => void;
}

// --- HELPERS ---

function formatPeakTime(timestamp: number | null): string {
  if (timestamp == null) return "Not sampled yet";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatSampleAge(timestamp: number): string {
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (ageSeconds <= 1) return "just now";
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}h ago`;
}

// --- COMPONENTS ---

const ResourceSortButton = memo(function ResourceSortButton({
  sortKey,
  label,
  activeKey,
  direction,
  align,
  onSelect,
}: ResourceSortButtonProps) {
  const active = activeKey === sortKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={
        align === "start" ? "w-full justify-start" : "w-full justify-end"
      }
      aria-label={`Sort by ${label}${active ? `, ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
      aria-pressed={active}
      onClick={() => onSelect(sortKey)}
    >
      {label}
      {active &&
        (direction === "asc" ? (
          <ArrowUp aria-hidden="true" />
        ) : (
          <ArrowDown aria-hidden="true" />
        ))}
    </Button>
  );
});

const ResourceProcessRow = memo(function ResourceProcessRow({
  node,
  depth,
  collapsed,
  cpuReady,
  onToggle,
}: ResourceProcessRowProps) {
  const expandable = node.children.length > 0;
  const pidLabel =
    node.pids.length === 0
      ? "Aggregate app row"
      : `PID${node.pids.length === 1 ? "" : "s"} ${node.pids.join(", ")}`;
  const details = `${pidLabel} · peak CPU ${formatCpuPercent(
    node.peakCpuPercent,
  )} · peak memory ${formatResourceMemory(node.peakMemoryBytes)}`;
  const rowDetails =
    node.count > 1
      ? `${pidLabel} · current values are the aggregate of ${node.count} live processes`
      : details;
  const indent = Math.min(depth, MAX_VISIBLE_TREE_DEPTH) * 16;

  return (
    <div
      role="row"
      aria-label={`${node.name}. ${rowDetails}`}
      aria-level={depth + 1}
      aria-expanded={expandable ? !collapsed : undefined}
      className="grid min-h-7 grid-cols-[minmax(0,1fr)_5.5rem_6.5rem] items-center gap-1 px-2"
    >
      <div
        role="gridcell"
        className="flex min-w-0 items-center gap-1"
        style={{ paddingInlineStart: indent }}
      >
        {expandable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.name}`}
            aria-expanded={!collapsed}
            onClick={() => onToggle(node.id)}
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
          </Button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
        <Tooltip label={rowDetails} side="left" align="start">
          <span className="text-fg1 flex min-w-0 items-center gap-2 text-xs">
            {node.kind === "app" ? (
              <Cpu className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
            ) : node.terminal ? (
              <SquareTerminal
                className="text-fg2 size-3.5 shrink-0"
                aria-hidden="true"
              />
            ) : null}
            <span className="truncate">{node.name}</span>
            {node.count > 1 && (
              <span className="text-muted-fg shrink-0">×{node.count}</span>
            )}
          </span>
        </Tooltip>
      </div>
      <span
        role="gridcell"
        className="text-fg1 text-right text-xs tabular-nums"
      >
        {cpuReady ? formatCpuPercent(node.cpuPercent) : "—"}
      </span>
      <span
        role="gridcell"
        className="text-fg2 text-right text-xs tabular-nums"
      >
        {formatResourceMemory(node.memoryBytes)}
      </span>
    </div>
  );
});

// --- ROOT COMPONENT ---

export const ResourceMonitor = memo(function ResourceMonitor() {
  const { ready } = useNativeRuntime();
  // Whether the resource popover is mounted and receiving the faster cadence.
  const [open, setOpen] = useState(false);
  // Last confirmed app-global process snapshot; retained through refresh errors.
  const [snapshot, setSnapshot] = useState<ProcessMetricsSnapshot | null>(null);
  // Latest polling error; it never clears the retained confirmed snapshot.
  const [sampleError, setSampleError] = useState<string | null>(null);
  // App-global display scope; true keeps the pill honest by default.
  const [includeTerminal, setIncludeTerminal] = useState(true);
  // Whether identical sibling processes are aggregated into one row.
  const [stack, setStack] = useState(false);
  // Whether rows retain their logical ownership hierarchy or render flat.
  const [tree, setTree] = useState(true);
  // Current table sort column.
  const [sortKey, setSortKey] = useState<ResourceSortKey>("memory");
  // Current table sort direction.
  const [sortDirection, setSortDirection] =
    useState<ResourceSortDirection>("desc");
  // Ephemeral per-popover disclosure state, pruned against every new view.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Invalidates an older async sample after visibility/cadence changes.
  const requestGeneration = useRef(0);
  // Rejects an older PTY inventory after an engine bridge replacement.
  const terminalGeneration = useRef(0);
  // Last confirmed terminal roots survive a transient bridge disconnect.
  const terminalOwnership = useRef<TerminalOwnership>({
    pids: [],
    known: false,
  });
  // Exact excluded process/key pair retained while the terminal census
  // revalidates. All-process snapshots continue updating independently.
  const lastTerminalSnapshot = useRef<ProcessMetricsSnapshot | null>(null);

  /** Refresh terminal ownership only from a currently connected exact engine.
   * A missing bridge is cold/unavailable, never an authoritative empty list. */
  const refreshTerminalOwnership = useCallback(
    async (timeoutMs = 1_000): Promise<void> => {
      if (!getActiveBridge()) {
        terminalOwnership.current = {
          ...terminalOwnership.current,
          known: false,
        };
        return;
      }
      const generation = ++terminalGeneration.current;
      try {
        const processPids = await ptyProcessPids(timeoutMs);
        if (generation !== terminalGeneration.current || !getActiveBridge())
          return;
        if (!processPids) {
          terminalOwnership.current = {
            ...terminalOwnership.current,
            known: false,
          };
          return;
        }
        terminalOwnership.current = {
          // A newly-created node-pty session can briefly report PID 0 while its
          // host acknowledges the spawn. Treat that as an unsettled snapshot so
          // exclusion peaks cannot accidentally include the new terminal tree.
          known: processPids.every(
            (pid) => Number.isSafeInteger(pid) && pid > 0,
          ),
          pids: [...new Set(processPids)].filter(
            (pid) => Number.isSafeInteger(pid) && pid > 0,
          ),
        };
      } catch {
        // Keep the PIDs for diagnostics but do not combine an unconfirmed key
        // with a new OS scan. The renderer retains the last exact excluded
        // snapshot while retrying.
        if (generation === terminalGeneration.current) {
          terminalOwnership.current = {
            ...terminalOwnership.current,
            known: false,
          };
        }
      }
    },
    [],
  );

  // Registry events make ownership changes visible immediately; the sampling
  // loop also refreshes the PID-only census because private Setup/ephemeral
  // sessions intentionally do not publish shared-terminal events.
  useEffect(() => {
    // The monitor is desktop chrome and renders null without the native
    // bridge, but hooks still run there. Without this guard a web/relay
    // session would issue a PTY_LIST per mount, terminal change, and
    // reconnect for a surface it never shows — and the engine withholds
    // processPids from non-local clients, so every one of them fails.
    if (!ready) return;
    let settleTimer: number | null = null;
    const refreshAfterRegistryChange = (): void => {
      terminalOwnership.current = {
        ...terminalOwnership.current,
        known: false,
      };
      void refreshTerminalOwnership();
      if (settleTimer != null) window.clearTimeout(settleTimer);
      // node-pty publishes the terminal registry before its async host has
      // necessarily returned the real PID. Re-read once after that handshake.
      settleTimer = window.setTimeout(
        () => void refreshTerminalOwnership(),
        500,
      );
    };
    void refreshTerminalOwnership();
    const offTerminals = onPtyTerminalsChanged(refreshAfterRegistryChange);
    const offBridgeChange = onActiveBridgeChange(() => {
      terminalGeneration.current += 1;
      terminalOwnership.current = { pids: [], known: false };
    });
    const offBridge = onActiveBridgeConnected((_bridge, info) => {
      if (info.initial) return;
      // A reconnect is a new authoritative ownership boundary. Old PIDs remain
      // visible through an outage, but must not classify the first snapshot
      // after an engine respawn or missed terminal-registry broadcasts.
      terminalOwnership.current = { pids: [], known: false };
      void refreshTerminalOwnership();
    });
    return () => {
      terminalGeneration.current += 1;
      if (settleTimer != null) window.clearTimeout(settleTimer);
      offTerminals();
      offBridgeChange();
      offBridge();
    };
  }, [ready, refreshTerminalOwnership]);

  // Poll sequentially so reads never overlap. Open inspection gets a one-second
  // cadence; the closed pill backs off to four seconds and hidden windows stop
  // entirely. A generation check rejects any response from the prior cadence.
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: number | null = null;

    const clearTimer = (): void => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (): void => {
      clearTimer();
      if (disposed || document.visibilityState === "hidden") return;
      timer = window.setTimeout(
        () => void sample(),
        open ? OPEN_SAMPLE_INTERVAL_MS : CLOSED_SAMPLE_INTERVAL_MS,
      );
    };
    const sample = async (): Promise<void> => {
      const generation = ++requestGeneration.current;
      // Setup and ephemeral PTYs intentionally do not publish the shared-tab
      // registry event. Refresh the cheap PID-only census at every bounded
      // sample so the filter still covers them within this sample's exact key.
      // Only while the popover is OPEN: the closed pill shows rounded totals,
      // the registry listener above still tracks ordinary terminal changes,
      // and skipping the census keeps the idle app off the engine round-trip.
      if (open) {
        await refreshTerminalOwnership();
        if (disposed || generation !== requestGeneration.current) return;
      }
      const ownership = terminalOwnership.current;
      try {
        const next = await processMetricsSnapshot({
          terminalPids: ownership.pids,
          terminalRootsKnown: ownership.known,
        });
        if (disposed || generation !== requestGeneration.current || !next)
          return;
        if (next.totals.excludingTerminals) {
          lastTerminalSnapshot.current = next;
        }
        setSnapshot(next);
        setSampleError(null);
      } catch (error) {
        if (disposed || generation !== requestGeneration.current) return;
        setSampleError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed && generation === requestGeneration.current) schedule();
      }
    };
    const handleVisibility = (): void => {
      requestGeneration.current += 1;
      clearTimer();
      if (document.visibilityState !== "hidden") void sample();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (document.visibilityState !== "hidden") void sample();
    return () => {
      disposed = true;
      requestGeneration.current += 1;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [open, ready, refreshTerminalOwnership]);

  const selectedSnapshot = selectResourceSnapshot(
    includeTerminal,
    snapshot,
    lastTerminalSnapshot.current,
  );
  const displaySnapshot = selectedSnapshot.snapshot;
  const resolvedScope = displaySnapshot
    ? resolveResourceScope(includeTerminal, displaySnapshot.totals)
    : null;
  const totals: ProcessResourceTotals | null = resolvedScope?.totals ?? null;
  const includesTerminal = resolvedScope?.includesTerminal ?? true;
  const currentTerminalFilterAvailable =
    snapshot?.totals.excludingTerminals != null;

  const view = useMemo(
    () =>
      open && displaySnapshot && totals
        ? buildResourceView({
            processes: displaySnapshot.processes,
            totals,
            tree,
            stack,
            includeTerminal: includesTerminal,
            sortKey,
            sortDirection,
          })
        : [],
    [
      displaySnapshot,
      includesTerminal,
      open,
      sortDirection,
      sortKey,
      stack,
      totals,
      tree,
    ],
  );
  const rows = useMemo(
    () =>
      flattenResourceView(view, collapsedIds, MAX_RENDERED_PROCESS_ROWS + 1),
    [collapsedIds, view],
  );
  const renderedRows = rows.slice(0, MAX_RENDERED_PROCESS_ROWS);
  const rowsOmitted = rows.length > MAX_RENDERED_PROCESS_ROWS;

  // Bound disclosure state to the current live identities. Stable IDs retain
  // collapse choices; exited/reused processes cannot accumulate forever. The
  // live set walks the whole view rather than the rendered rows, which omit
  // anything inside a collapsed branch or past the row cap — pruning against
  // those would forget a nested branch the moment its parent was folded.
  useEffect(() => {
    const liveIds = collectResourceNodeIds(view);
    setCollapsedIds((current) => {
      if ([...current].every((id) => liveIds.has(id))) return current;
      return new Set([...current].filter((id) => liveIds.has(id)));
    });
  }, [view]);

  /** Clicking the active sort column reverses it; selecting a new numeric
   * column starts descending while names start ascending. */
  const handleSort = useCallback(
    (next: ResourceSortKey): void => {
      if (next === sortKey) {
        setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
        return;
      }
      setSortKey(next);
      setSortDirection(next === "name" ? "asc" : "desc");
    },
    [sortKey],
  );

  /** Toggle one tree disclosure without rebuilding unrelated row state. */
  const handleToggle = useCallback((id: string): void => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Copy only the already-sanitized renderer model; native command lines were
   * never sent across the IPC boundary. */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!displaySnapshot || !totals) return;
    try {
      await navigator.clipboard.writeText(
        copyResourceReport({
          sampledAt: displaySnapshot.sampledAt,
          logicalCpuCount: displaySnapshot.logicalCpuCount,
          scanDurationMs: displaySnapshot.scanDurationMs,
          includeTerminal: includesTerminal,
          totals,
          view,
        }),
      );
      toast.success("Resource snapshot copied");
    } catch {
      toast.error("Couldn't copy the resource snapshot");
    }
  }, [displaySnapshot, includesTerminal, totals, view]);

  if (!ready) return null;

  const scopeLabel = selectedSnapshot.usingRetainedTerminalSnapshot
    ? "excluding terminal processes using the last confirmed sample"
    : !currentTerminalFilterAvailable
      ? "including all processes while terminal classification is unavailable"
      : includesTerminal
        ? "including terminal processes"
        : "excluding terminal processes";
  const terminalControlLabel = !currentTerminalFilterAvailable
    ? includeTerminal
      ? "Terminal process filter unavailable"
      : "Include terminal processes"
    : includesTerminal
      ? "Exclude terminal processes"
      : "Include terminal processes";
  const triggerLabel = totals
    ? `${formatResourceMemory(totals.memoryBytes)} resident memory, ${scopeLabel}`
    : "Collecting app resource usage";

  return (
    <div className="flex h-full shrink-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label={triggerLabel} side="bottom">
          <PopoverTrigger asChild>
            <Pill aria-label={triggerLabel} aria-expanded={open}>
              <Cpu aria-hidden="true" />
              <span className="tabular-nums">
                {totals ? formatResourceMemory(totals.memoryBytes) : "—"}
              </span>
            </Pill>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="end" sideOffset={5} size="wide" padding="none">
          <div className="flex items-start justify-between gap-4 p-4 pb-3">
            <div className="min-w-0">
              <div className="text-fg2 text-xs font-medium">Resources</div>
              {totals ? (
                <div className="text-fg2 mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span>
                    CPU{" "}
                    <strong className="text-fg1 font-medium tabular-nums">
                      {displaySnapshot?.cpuReady
                        ? formatCpuPercent(totals.cpuPercent)
                        : "Sampling…"}
                    </strong>
                  </span>
                  <span>
                    Memory{" "}
                    <strong className="text-fg1 font-medium tabular-nums">
                      {formatResourceMemory(totals.memoryBytes)}
                    </strong>
                  </span>
                  <span className="text-muted-fg text-xs">
                    {totals.processCount} processes
                  </span>
                </div>
              ) : (
                <div className="text-fg2 mt-1 text-sm" role="status">
                  {sampleError
                    ? "Resource sampling is unavailable. Retrying automatically."
                    : "Collecting the first resource sample…"}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip
                label={
                  currentTerminalFilterAvailable
                    ? includesTerminal
                      ? "Exclude terminal processes"
                      : "Include terminal processes"
                    : includeTerminal
                      ? "Waiting for the engine's terminal inventory"
                      : "Include terminal processes; excluded data is retained while refreshing"
                }
                side="bottom"
              >
                <Button
                  type="button"
                  variant={includesTerminal ? "secondary-on" : "ghost"}
                  size="icon-sm"
                  aria-label={terminalControlLabel}
                  aria-pressed={includesTerminal}
                  disabled={!currentTerminalFilterAvailable && includeTerminal}
                  onClick={() => setIncludeTerminal((included) => !included)}
                >
                  <SquareTerminal aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip
                label={
                  stack
                    ? "Unstack matching processes"
                    : "Stack matching processes"
                }
                side="bottom"
              >
                <Button
                  type="button"
                  variant={stack ? "secondary-on" : "ghost"}
                  size="icon-sm"
                  aria-label={
                    stack
                      ? "Unstack matching processes"
                      : "Stack matching processes"
                  }
                  aria-pressed={stack}
                  onClick={() => setStack((stacked) => !stacked)}
                >
                  <Layers3 aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip
                label={tree ? "Use flat view" : "Use tree view"}
                side="bottom"
              >
                <Button
                  type="button"
                  variant={tree ? "secondary-on" : "ghost"}
                  size="icon-sm"
                  aria-label={tree ? "Use flat view" : "Use tree view"}
                  aria-pressed={tree}
                  onClick={() => setTree((treeView) => !treeView)}
                >
                  <GitFork aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip label="Copy resource snapshot" side="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy resource snapshot"
                  disabled={!displaySnapshot || !totals}
                  onClick={() => void handleCopy()}
                >
                  <Copy aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          </div>

          {totals && displaySnapshot && (
            <div className="text-fg2 grid grid-cols-2 gap-4 px-4 pb-3 text-xs">
              <div className="min-w-0">
                <span>CPU peak </span>
                <strong className="text-fg1 font-medium tabular-nums">
                  {formatCpuPercent(totals.peakCpuPercent)}
                </strong>
                <span className="text-muted-fg">
                  {" "}
                  · {formatPeakTime(totals.peakCpuAt)}
                </span>
              </div>
              <div className="min-w-0 text-right">
                <span>Memory peak </span>
                <strong className="text-fg1 font-medium tabular-nums">
                  {formatResourceMemory(totals.peakMemoryBytes)}
                </strong>
                <span className="text-muted-fg">
                  {" "}
                  · {formatPeakTime(totals.peakMemoryAt)}
                </span>
              </div>
            </div>
          )}

          <Separator />

          {totals && displaySnapshot ? (
            <div role="treegrid" aria-label="App resource processes">
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_5.5rem_6.5rem] items-center gap-1 px-2 py-1"
              >
                <div role="columnheader">
                  <ResourceSortButton
                    sortKey="name"
                    label="Name"
                    activeKey={sortKey}
                    direction={sortDirection}
                    align="start"
                    onSelect={handleSort}
                  />
                </div>
                <div role="columnheader">
                  <ResourceSortButton
                    sortKey="cpu"
                    label="CPU"
                    activeKey={sortKey}
                    direction={sortDirection}
                    align="end"
                    onSelect={handleSort}
                  />
                </div>
                <div role="columnheader">
                  <ResourceSortButton
                    sortKey="memory"
                    label="Memory"
                    activeKey={sortKey}
                    direction={sortDirection}
                    align="end"
                    onSelect={handleSort}
                  />
                </div>
              </div>
              <ScrollArea className="max-h-[min(28rem,calc(100vh-13rem))] min-h-28">
                <div className="pb-2">
                  {renderedRows.map(({ node, depth }) => (
                    <ResourceProcessRow
                      key={node.id}
                      node={node}
                      depth={depth}
                      collapsed={collapsedIds.has(node.id)}
                      cpuReady={displaySnapshot.cpuReady}
                      onToggle={handleToggle}
                    />
                  ))}
                  {rowsOmitted && (
                    <div role="row">
                      <div
                        role="gridcell"
                        className="text-muted-fg px-4 py-2 text-xs"
                      >
                        More than {MAX_RENDERED_PROCESS_ROWS} rows — sort,
                        stack, or collapse branches to narrow the view.
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          ) : (
            <div className="text-fg2 p-4 text-sm" role="status">
              Resource rows will appear after the first confirmed sample.
            </div>
          )}

          <Separator />
          <div className="text-muted-fg flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs">
            {displaySnapshot ? (
              <span>
                Sampled {formatSampleAge(displaySnapshot.sampledAt)} · scan{" "}
                {Math.round(displaySnapshot.scanDurationMs)} ms
                {sampleError ? " · refresh delayed" : ""}
                {!currentTerminalFilterAvailable && snapshot
                  ? " · terminal refresh pending"
                  : ""}
              </span>
            ) : (
              <span>Waiting for a confirmed sample</span>
            )}
            <span>
              100% CPU = one core · memory = resident working set · sampled
              peaks are since monitoring started
            </span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});
