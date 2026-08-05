// ──────────────────────────────────────────────────────────
// Run control — terminal panel terminal header split-button over repo run actions
// ──────────────────────────────────────────────────────────
//
// Replaces the old single stateless "▷ Run" button. The FACE is the repo's
// default run action: its icon + name when idle (click = start + jump to its
// Run sub-tab), or a static square + "Stop" while it runs (click = stop).
// With more than one action a caret opens a menu of every action — a running
// one wears the horse loop (click focuses it), a finished/failed one tints its
// icon green/red (click reruns) — plus "Configure…" (Settings → Scripts).
// Renders NOTHING when the repo defines no run actions. Modeled on the Create
// PR split-button (create-pr-button.tsx) for primitive consistency: one
// bordered container with a transparent fill that blends with the terminal
// row's bg1, and a border-l divider between the run FACE and the caret. Also
// owns the real ⌘R binding: the main process forwards plain Cmd+R as a
// "run-shortcut" event (reload stays dead), and this control starts/stops the
// default action on it.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from "react";
import { ChevronDown, Settings2, Square } from "lucide-react";
import { type RunAction } from "@zeros/protocol/run-actions";

import { cn } from "../../shared/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Tooltip,
} from "../../shared/ui/primitives";
import { DynamicIcon } from "../../shared/ui/icon-registry";
import { RunHorseShimmer } from "@/renderer/shared/ui/loading";
import { nativeListen } from "../../platform/runtime";
import { type WorkspaceRunActionStatus } from "../../platform/git";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useTerminalStore } from "./terminal-store";
import { useRunControl } from "./use-run-control";
import { useRunStatuses } from "./use-run-status";
import { useOpenScriptsSettings } from "../workbench/tabs/setup-tab";

// Secondary split-button chrome — mirrors CreatePrButton so the two read as one
// family. A bordered container with a TRANSPARENT fill (blends with the bg1
// terminal row) + a `border-l` divider between the run FACE and the caret; hover
// lifts to bg2-hover / border3. h-7 (not Create PR's h-6) so it matches the
// sibling collapse button in the terminal sub-tab row (RULES: same-row controls
// share a height).
const CONTAINER_CLS =
  "inline-flex shrink-0 items-center overflow-hidden rounded-sm border border-border2 bg-transparent transition-colors duration-120 ease-out hover:border-border3";
const FACE_BTN_CLS =
  "inline-flex h-7 items-center gap-1.5 pl-2 pr-2.5 text-xs font-medium text-fg1 transition-colors duration-120 ease-out hover:bg-bg2-hover";
const CHEVRON_BTN_CLS =
  "inline-flex h-7 w-6 items-center justify-center border-l border-border2 text-fg2 transition-colors duration-120 ease-out hover:bg-bg2-hover hover:text-fg1";

export function RunControl({
  folderKey,
  chatCwd,
  onRevealTerminalPanel,
}: {
  folderKey: string;
  chatCwd: string | undefined;
  /** Expand/reveal terminal panel (the selected Run tab is handled here). */
  onRevealTerminalPanel: () => void;
}) {
  const { workspace } = useActiveWorkspace();
  const { actions, defaultAction, runIdFor, startRun, stopRun } = useRunControl(
    folderKey,
    chatCwd,
  );
  // Readiness is irrelevant here: this surface only reacts to a POSITIVE
  // (a running/finished/failed action tints its face), and an unread map
  // renders the same idle face as a genuinely idle one.
  const { statuses: runStatuses } = useRunStatuses(
    workspace,
    folderKey,
    actions,
  );
  const setActiveTerminalTab = useTerminalStore((s) => s.setActiveTerminalTab);
  const openScripts = useOpenScriptsSettings("run-actions");

  const launch = useCallback(
    (action: RunAction) => {
      startRun(action.id);
      onRevealTerminalPanel();
    },
    [startRun, onRevealTerminalPanel],
  );
  const focus = useCallback(
    (action: RunAction) => {
      setActiveTerminalTab(folderKey, runIdFor(action.id));
      onRevealTerminalPanel();
    },
    [setActiveTerminalTab, folderKey, runIdFor, onRevealTerminalPanel],
  );

  // The REAL ⌘R: main forwards plain Cmd+R as "run-shortcut" (reload is
  // swallowed there). Running default → focus it; idle → start it. Bound via
  // a ref so the subscription survives re-renders without re-subscribing.
  const shortcutRef = useRef<() => void>(() => {});
  shortcutRef.current = () => {
    if (!defaultAction) return;
    if (runStatuses[defaultAction.id]?.state === "running")
      focus(defaultAction);
    else launch(defaultAction);
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void nativeListen("run-shortcut", () => shortcutRef.current()).then(
      (un) => {
        if (cancelled) un();
        else off = un;
      },
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  if (actions.length === 0 || !defaultAction) return null;

  const defaultRunning = runStatuses[defaultAction.id]?.state === "running";

  const face = defaultRunning ? (
    <Tooltip label={`Stop · ${defaultAction.command}`}>
      <button
        type="button"
        onClick={() => stopRun(defaultAction.id)}
        aria-label={`Stop ${defaultAction.name}`}
        className={FACE_BTN_CLS}
      >
        <Square className="size-3 shrink-0" aria-hidden="true" />
        <span>Stop</span>
      </button>
    </Tooltip>
  ) : (
    <Tooltip
      label={`${defaultAction.name} · ${defaultAction.command}`}
      shortcut="⌘R"
    >
      <button
        type="button"
        onClick={() => launch(defaultAction)}
        aria-label={`Run ${defaultAction.name}: ${defaultAction.command}`}
        className={FACE_BTN_CLS}
      >
        <RunTintedIcon
          action={defaultAction}
          status={runStatuses[defaultAction.id] ?? null}
        />
        <span>{defaultAction.name}</span>
      </button>
    </Tooltip>
  );

  // Single action → a lone secondary button (bordered, same face as Create PR).
  if (actions.length === 1) return <div className={CONTAINER_CLS}>{face}</div>;

  // Multi action → a secondary SPLIT button: the run FACE + a caret separated by
  // a `border-l` divider, both inside one bordered container — the Create PR shape.
  return (
    <div className={CONTAINER_CLS}>
      {face}
      <DropdownMenu>
        <Tooltip label="Run actions">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={CHEVRON_BTN_CLS}
              aria-label="Run actions"
            >
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[200px]"
        >
          {actions.map((action) => {
            const status = runStatuses[action.id] ?? null;
            const running = status?.state === "running";
            return (
              <DropdownMenuItem
                key={action.id}
                onSelect={() => (running ? focus(action) : launch(action))}
              >
                {running ? (
                  <RunHorseShimmer />
                ) : (
                  <RunTintedIcon action={action} status={status} />
                )}
                <span>{action.name}</span>
                {action.isDefault && <Kbd className="ml-auto">⌘R</Kbd>}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openScripts()}>
            <Settings2 className="size-3.5" />
            <span>Configure…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** An action's icon, tinted by its last outcome (green finished / red failed
 *  / normal otherwise). The running horse is handled by callers — its
 *  presence, not a tint, is the "live" signal. */
function RunTintedIcon({
  action,
  status,
}: {
  action: RunAction;
  status: WorkspaceRunActionStatus | null;
}) {
  return (
    <DynamicIcon
      name={action.icon}
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        status?.state === "finished" && "text-green-primary",
        status?.state === "failed" && "text-red-primary",
      )}
    />
  );
}
