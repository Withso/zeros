// ============================================
// COMPONENT: ResourceMonitor
// PURPOSE: App resource icon, memory tooltip and process-inspection popover.
// USED IN: AppSidebar's title band, immediately before the archived-workspaces
//          control.
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
  AppWindow,
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
  processDiagnosticsReport,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shared/ui/primitives/popover";
import { ScrollArea } from "../shared/ui/primitives/scroll-area";
import { Separator } from "../shared/ui/primitives/separator";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { toast } from "../shared/ui/primitives/elements";
import { copyToClipboardWithFallback } from "../shared/lib/clipboard";
import { documentIsForeground, observeForeground } from "../shared/lib/element-activity";
import {
  buildOtherAppNodes,
  buildResourceView,
  collectResourceNodeIds,
  copyResourceReport,
  flattenResourceView,
  formatCpuPercent,
  formatResourceMemory,
  resolveResourceScope,
  selectResourceSnapshot,
  systemSummaryParts,
  type ResourceSortDirection,
  type ResourceSortKey,
  type ResourceViewNode,
  type SystemSummaryTone,
} from "./resource-monitor-model";
import { Inline } from "@/renderer/shared/ui/layout/inline";

// --- CONSTANTS ---

const OPEN_SAMPLE_INTERVAL_MS = 1_000;
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

// Complete class strings per tone so the UI checks can see every utility.
const SYSTEM_TONE_CLASS: Record<SystemSummaryTone, string> = {
  default: "text-fg2",
  warning: "text-yellow-primary font-medium",
  critical: "text-red-primary font-medium",
};

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
            ) : node.kind === "other-app" ? (
              <AppWindow
                className="text-fg2 size-3.5 shrink-0"
                aria-hidden="true"
              />
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
  // Only an open foreground inspector owns process sampling.
  const [open, setOpen] = useState(false);
  // Last confirmed app-global process snapshot; retained through refresh errors.
  const [snapshot, setSnapshot] = useState<ProcessMetricsSnapshot | null>(null);
  // Latest polling error; it never clears the retained confirmed snapshot.
  const [sampleError, setSampleError] = useState<string | null>(null);
  // App-global display scope; include terminal processes by default.
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
  // A native read cannot be cancelled. Keep its lock through close/reopen and
  // let only the currently active effect schedule the next sample.
  const sampling = useRef(false);
  const afterSample = useRef<((stale: boolean) => void) | null>(null);
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
    if (!ready || !open) return;
    let settleTimer: number | null = null;
    let detach: (() => void) | undefined;
    const active = () => !!detach && documentIsForeground();
    const refreshAfterRegistryChange = (): void => {
      if (!active()) return;
      terminalOwnership.current = {
        ...terminalOwnership.current,
        known: false,
      };
      void refreshTerminalOwnership();
      if (settleTimer != null) window.clearTimeout(settleTimer);
      // node-pty publishes the terminal registry before its async host has
      // necessarily returned the real PID. Re-read once after that handshake.
      settleTimer = window.setTimeout(
        () => { settleTimer = null; if (active()) void refreshTerminalOwnership(); },
        500,
      );
    };
    const stop = () => {
      terminalGeneration.current += 1;
      if (settleTimer != null) window.clearTimeout(settleTimer);
      settleTimer = null;
      detach?.(); detach = undefined;
    };
    const update = () => {
      if (!documentIsForeground()) { stop(); return; }
      if (detach) return;
      // Registry events may have been missed while inactive. The sample loop
      // performs the initial census before it requests the next OS snapshot.
      terminalOwnership.current = { ...terminalOwnership.current, known: false };
      const offTerminals = onPtyTerminalsChanged(refreshAfterRegistryChange);
      const offBridgeChange = onActiveBridgeChange(() => {
        terminalGeneration.current += 1;
        terminalOwnership.current = { pids: [], known: false };
      });
      const offBridge = onActiveBridgeConnected((_bridge, info) => {
        if (info.initial || !active()) return;
        terminalOwnership.current = { pids: [], known: false };
        void refreshTerminalOwnership();
      });
      detach = () => { offTerminals(); offBridgeChange(); offBridge(); };
    };
    const unwatch = observeForeground(update);
    update();
    return () => { unwatch(); stop(); };
  }, [open, ready, refreshTerminalOwnership]);

  // Every scan runs `ps` in the native process. Closed, hidden and unfocused
  // inspectors retain their snapshot without owning a timer or starting reads.
  useEffect(() => {
    if (!ready || !open) return;
    let disposed = false;
    let active = false;
    let timer: number | null = null;
    const canSample = () => !disposed && active && documentIsForeground();

    const clearTimer = (): void => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (): void => {
      clearTimer();
      if (!canSample()) return;
      timer = window.setTimeout(
        () => { timer = null; void sample(); },
        OPEN_SAMPLE_INTERVAL_MS,
      );
    };
    const sample = async (): Promise<void> => {
      if (!canSample() || sampling.current) return;
      sampling.current = true;
      const generation = ++requestGeneration.current;
      try {
        // Private Setup/ephemeral PTYs do not publish registry events.
        await refreshTerminalOwnership();
        if (!canSample() || generation !== requestGeneration.current) return;
        const ownership = terminalOwnership.current;
        const next = await processMetricsSnapshot({
          terminalPids: ownership.pids,
          terminalRootsKnown: ownership.known,
          detail: true,
        });
        if (!canSample() || generation !== requestGeneration.current || !next)
          return;
        if (next.totals.excludingTerminals) {
          lastTerminalSnapshot.current = next;
        }
        setSnapshot(next);
        setSampleError(null);
      } catch (error) {
        if (!canSample() || generation !== requestGeneration.current) return;
        setSampleError(error instanceof Error ? error.message : String(error));
      } finally {
        sampling.current = false;
        afterSample.current?.(generation !== requestGeneration.current);
      }
    };
    const handleActivity = (): void => {
      const next = documentIsForeground();
      if (next === active) {
        if (next && timer == null) void sample();
        return;
      }
      active = next;
      requestGeneration.current += 1;
      clearTimer();
      if (active) void sample();
    };
    afterSample.current = (stale) => {
      if (!canSample()) return;
      if (stale) void sample(); else schedule();
    };
    const unwatch = observeForeground(handleActivity);
    handleActivity();
    return () => {
      disposed = true;
      requestGeneration.current += 1;
      afterSample.current = null;
      clearTimer();
      unwatch();
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
  const otherAppNodes = useMemo(
    () =>
      open && displaySnapshot
        ? buildOtherAppNodes(
            displaySnapshot.otherApps ?? [],
            sortKey,
            sortDirection,
          )
        : [],
    [displaySnapshot, open, sortDirection, sortKey],
  );
  const systemParts = useMemo(
    () =>
      displaySnapshot
        ? systemSummaryParts(
            displaySnapshot.system ?? null,
            displaySnapshot.logicalCpuCount,
          )
        : [],
    [displaySnapshot],
  );
  const memoryIsFootprint = displaySnapshot?.memorySource === "footprint";

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

  // Dedupes repeated clicks while main builds the report.
  const [copying, setCopying] = useState(false);

  /** Copy the full diagnostics report Electron main builds (process tree with
   * scrubbed command lines, Mac memory context, recent scrubbed app logs).
   * Command lines never cross into the renderer except inside that text. If
   * main cannot build it, fall back to the renderer's own snapshot. */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!displaySnapshot || !totals || copying) return;
    setCopying(true);
    try {
      const ownership = terminalOwnership.current;
      let text: string | null = null;
      let withLogs = false;
      try {
        const report = await processDiagnosticsReport({
          terminalPids: ownership.pids,
          terminalRootsKnown: ownership.known,
        });
        if (report?.text) {
          text = report.text;
          withLogs = report.logCharacters > 0;
        }
      } catch {
        // An older main process lacks the command; the snapshot still helps.
      }
      text ??= copyResourceReport({
        sampledAt: displaySnapshot.sampledAt,
        logicalCpuCount: displaySnapshot.logicalCpuCount,
        scanDurationMs: displaySnapshot.scanDurationMs,
        includeTerminal: includesTerminal,
        totals,
        view,
        system: displaySnapshot.system ?? null,
        otherApps: otherAppNodes,
        memorySource: displaySnapshot.memorySource,
      });
      if (!(await copyToClipboardWithFallback(text))) {
        toast.error("Couldn't write to the clipboard — focus the app and retry.");
        return;
      }
      const kb = Math.max(1, Math.round(text.length / 1024));
      toast.success(
        withLogs
          ? `Diagnostics copied — ${kb} KB with recent app logs`
          : `Resource snapshot copied — ${kb} KB`,
      );
    } finally {
      setCopying(false);
    }
  }, [copying, displaySnapshot, includesTerminal, otherAppNodes, totals, view]);

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
    ? `${formatResourceMemory(totals.memoryBytes)} ${
        memoryIsFootprint ? "memory" : "resident memory"
      }, ${scopeLabel}`
    : open ? "Collecting app resource usage" : "Inspect app resource usage";

  return (
    <div className="flex h-full shrink-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label={triggerLabel} side="bottom" delayDuration={1500} disabled={open}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1"
              data-active={open}
              aria-label="App resources"
              aria-expanded={open}
            >
              <Cpu className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </Tooltip>
        {/* The monitor sits at the sidebar's top edge, so the panel opens
            toward the content area rather than back over the sidebar. */}
        <PopoverContent
          aria-label="App resources"
          align="start"
          sideOffset={5}
          size="wide"
          padding="none"
        >
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
              {systemParts.length > 0 && (
                <p className="text-muted-fg mt-1 text-xs">
                  Mac:{" "}
                  {systemParts.map((part, index) => (
                    <React.Fragment key={part.id}>
                      {index > 0 && " · "}
                      <span className="whitespace-nowrap">
                        {part.label && `${part.label} `}
                        <span
                          className={`tabular-nums ${SYSTEM_TONE_CLASS[part.tone]}`}
                        >
                          {part.value}
                        </span>
                      </span>
                    </React.Fragment>
                  ))}
                </p>
              )}
            </div>
            <Inline gap={1} align="center" className="shrink-0">
              <Tooltip
                label={
                  currentTerminalFilterAvailable
                    ? includesTerminal
                      ? "Exclude terminals"
                      : "Include terminals"
                    : includeTerminal
                      ? "Loading terminals"
                      : "Include terminals"
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
                    ? "Ungroup processes"
                    : "Group processes"
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
                label={tree ? "Flat view" : "Tree view"}
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
              <Tooltip
                label="Copy diagnostics"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy diagnostics"
                  aria-busy={copying}
                  disabled={!displaySnapshot || !totals || copying}
                  onClick={() => void handleCopy()}
                >
                  <Copy aria-hidden="true" />
                </Button>
              </Tooltip>
            </Inline>
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
                  {otherAppNodes.length > 0 && (
                    <>
                      <div role="row">
                        <div
                          role="gridcell"
                          className="text-muted-fg px-4 pt-2 pb-1 text-xs"
                        >
                          Other Zeros apps on this Mac
                        </div>
                      </div>
                      {otherAppNodes.map((node) => (
                        <ResourceProcessRow
                          key={node.id}
                          node={node}
                          depth={0}
                          collapsed={false}
                          cpuReady={displaySnapshot.cpuReady}
                          onToggle={handleToggle}
                        />
                      ))}
                    </>
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
              100% CPU = one core ·{" "}
              {memoryIsFootprint
                ? "memory = physical footprint, as in Activity Monitor"
                : "memory = resident working set"}{" "}
              · sampled peaks are since monitoring started
            </span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});
