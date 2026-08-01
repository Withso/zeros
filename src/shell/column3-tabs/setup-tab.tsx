// ──────────────────────────────────────────────────────────
// Setup tab — column 3 row 2's pinned Setup tab
// ──────────────────────────────────────────────────────────
//
// A small state machine over the workspace's setup command (`scripts.setup`,
// e.g. `pnpm install`), rendered from `workspace.setupInfo`:
//   • loading                 → centered spinner (never flash an empty state
//                               before the first fetch resolves).
//   • no script configured    → illustration + "Add setup script" (opens
//                               Settings → Scripts) + one-line description.
//   • script, never ran       → illustration + "Run setup" + description.
//   • starting (no output yet)→ centered "Starting setup…" spinner.
//   • running                 → live output + a "Stop setup" button.
//   • finished (live log)     → output + a filled outcome badge ("Setup
//                               complete" / "Setup failed" / "Setup stopped")
//                               + "Rerun setup". The complete/failed badge
//                               auto-dismisses 15s after the user has VIEWED
//                               the tab (the countdown waits for the visit).
//   • finished (no log — an   → the empty layout with "Run setup again", a
//     app restart dropped the   "Last run …" description, and the outcome
//     in-memory buffer)         badge bottom-right. The result is durable even
//                               though the streamed log is not.
//
// BOTH surfaces run through the engine's SetupManager now: a real WORKTREE
// resolves everything from its workspace row (state persisted across
// restarts), and the TRUNK / "main" — the synthetic `local:<repoSlug>`
// workspace with no engine row — passes its repoRoot so the run executes in
// the repo root with in-memory state. Same view, same status language
// (see src/engine/git/setup-runner.ts).
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { FileCode, RotateCw, Square, SquarePlay } from "lucide-react";

import {
  workspaceSetupInfo,
  workspaceRerunSetup,
  workspaceStopSetup,
  type Workspace,
  type WorkspaceSetupInfo,
} from "../../native/git";
import { cn } from "../../zeros/ui/cn";
import { Button } from "../../zeros/ui";
import { Badge } from "../../zeros/ui/primitives";
import { toast } from "../../zeros/ui/primitives/elements";
import { useWorkspaceDispatch } from "../../zeros/store/store";
import { useActiveWorkspace } from "../../zeros/store/use-active-workspace";
import { isLocalMainWorkspace } from "../../zeros/store/local-main-workspace";
import { useProjects } from "../../zeros/store/use-projects";
import { repoPageViewForSection } from "../../zeros/panels/repo-page";
import { useThemeVariant } from "../../zeros/appearance/use-theme-variant";
import { ZerosSpinner } from "@/loaders";
import { createTerminalResizeScheduler } from "../terminal/terminal-resize-scheduler";
import { isUsableTerminalDimensions } from "../terminal/terminal-dimensions";

/** How often to re-pull the setup buffer while a run is live. The buffer is the
 *  source of truth; we delta-append, so polling is exact (no dup/gap). */
const LIVE_POLL_MS = 900;

/** A run outcome — every terminal state the outcome badge can show. */
export type SetupOutcome = "passed" | "failed" | "stopped";

/** True for a FINISHED run's state (running/null excluded). The single home of
 *  this list — the badge, the restored-outcome layout, and the tab dot
 *  (terminal-tab.tsx) all narrow through it. */
export function isSetupOutcome(
  state: WorkspaceSetupInfo["state"],
): state is SetupOutcome {
  return state === "passed" || state === "failed" || state === "stopped";
}

/** Resolve a CSS token to a concrete color (xterm can't read CSS vars). Returns
 *  undefined when unavailable so xterm falls back to its built-in default — same
 *  pattern as terminal-session-view's resolveTerminalTheme (no hex literals). */
function resolveToken(token: string): string | undefined {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Row 2's Setup view. Both a real worktree AND the trunk /
 *  "main" render the same engine-backed runner — the trunk (which has no
 *  engine workspace row) passes its repoRoot so the engine runs setup in the
 *  repo root itself, with the identical status language.
 *  `visible` = the user is actually LOOKING at this view (Terminal pane
 *  active + Setup sub-tab selected); it gates the outcome badge's 15s
 *  auto-dismiss countdown. */
export function SetupView({
  workspace,
  visible,
}: {
  workspace: Workspace | null;
  visible: boolean;
}) {
  const openScripts = useOpenScriptsSettings();
  if (!workspace) return <SetupLoading />;
  return (
    <WorkspaceSetup
      // Remount on workspace switch so the xterm + buffer cursor reset cleanly.
      key={workspace.id}
      workspaceId={workspace.id}
      // Only the trunk needs the explicit repoRoot fallback; a real worktree
      // must keep resolving from its row (a deleted row should error, not
      // silently run setup at the repo root).
      repoRoot={
        isLocalMainWorkspace(workspace) ? workspace.repoRoot : undefined
      }
      visible={visible}
      onAddSetupScript={openScripts}
    />
  );
}

/** Open the active repo's settings (default: Scripts, where `scripts.setup`
 *  is configured; the run control passes "run-actions", which lands on the
 *  Scripts view too — run actions live inside it). Repo settings live on the
 *  repo page now (H1 consolidation) — this lands on the requested section's
 *  view in the page toggle. When the repo can't be resolved to a project,
 *  fall back to global Settings. */
export function useOpenScriptsSettings(section = "scripts"): () => void {
  const dispatch = useWorkspaceDispatch();
  const { workspace } = useActiveWorkspace();
  const { projects } = useProjects();
  const repoRoot = workspace?.repoRoot ?? null;
  return useCallback(() => {
    const projectId = repoRoot
      ? projects.find((p) => p.repoRoot === repoRoot)?.id
      : undefined;
    if (projectId) {
      dispatch({
        type: "OPEN_REPO_PAGE",
        projectId,
        view: repoPageViewForSection(section || "scripts"),
      });
    } else {
      dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
    }
  }, [dispatch, projects, repoRoot, section]);
}

function WorkspaceSetup({
  workspaceId,
  repoRoot,
  visible,
  onAddSetupScript,
}: {
  workspaceId: string;
  /** Set ONLY for the trunk / "main" (no engine row) — lets the setup ops
   *  resolve the repo's command and run in the repo root. */
  repoRoot?: string;
  /** The user is viewing this tab (drives the badge auto-dismiss countdown). */
  visible: boolean;
  /** Open Settings → Scripts (shown when the repo has no setup command). */
  onAddSetupScript: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const xtermRef = useRef<XTerm | null>(null);
  const resizeSchedulerRef = useRef<ReturnType<
    typeof createTerminalResizeScheduler
  > | null>(null);
  const refetchRequestRef = useRef<Promise<void> | null>(null);
  // How many chars of the engine buffer we've already written to the xterm.
  const writtenRef = useRef(0);
  const [info, setInfo] = useState<WorkspaceSetupInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // Pull the buffer + state and delta-append any new bytes into the xterm. A
  // shrinking buffer (a fresh run reset it) → reset the grid + cursor.
  const refetch = useCallback((): Promise<void> => {
    const existing = refetchRequestRef.current;
    if (existing) return existing;
    const request = (async () => {
      let next: WorkspaceSetupInfo;
      try {
        next = await workspaceSetupInfo({ workspaceId, repoRoot });
      } catch {
        return; // bridge not ready / transient — keep showing what we have
      }
      const term = xtermRef.current;
      if (term) {
        if (next.log.length < writtenRef.current) {
          term.reset();
          writtenRef.current = 0;
        }
        if (next.log.length > writtenRef.current) {
          term.write(next.log.slice(writtenRef.current));
          writtenRef.current = next.log.length;
        }
      }
      setInfo(next);
    })().finally(() => {
      if (refetchRequestRef.current === request) {
        refetchRequestRef.current = null;
      }
    });
    refetchRequestRef.current = request;
    return request;
  }, [workspaceId, repoRoot]);

  // Mount the xterm once, then do the initial fetch.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XTerm({
      fontFamily:
        'ui-monospace, "Geist Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      scrollback: 10_000,
      disableStdin: true, // read-only log
      cursorStyle: "underline",
      cursorBlink: false,
      // The setup PTY is a real TTY → output already has CRLF; don't re-convert
      // (matches terminal-session-view; convertEol:true would double the \r).
      convertEol: false,
      theme: {
        background: resolveToken("--bg1"),
        foreground: resolveToken("--fg1"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    xtermRef.current = term;
    const doFit = () => {
      if (!visibleRef.current) return;
      const proposed = fit.proposeDimensions();
      if (
        !isUsableTerminalDimensions(proposed) ||
        (proposed.cols === term.cols && proposed.rows === term.rows)
      ) {
        return;
      }
      try {
        fit.fit();
      } catch {
        /* not yet sized */
      }
    };
    doFit();
    // Setup used to run `fit()` synchronously for every ResizeObserver
    // notification. Unlike a normal box measurement, xterm fit reflows its
    // scrollback buffer; that hot loop was the visible terminal-panel jerk in
    // the reported screenshots. Share the same settled scheduler as shells.
    const scheduler = createTerminalResizeScheduler(doFit);
    resizeSchedulerRef.current = scheduler;
    const ro = new ResizeObserver(() => {
      if (visibleRef.current) scheduler.request();
    });
    ro.observe(host);
    void refetch();
    return () => {
      ro.disconnect();
      scheduler.dispose();
      if (resizeSchedulerRef.current === scheduler) {
        resizeSchedulerRef.current = null;
      }
      term.dispose();
      xtermRef.current = null;
      writtenRef.current = 0;
    };
  }, [refetch]);

  // While a run is live, poll the buffer for new output + the terminal state.
  useEffect(() => {
    if (!visible || info?.state !== "running") return;
    const id = window.setInterval(() => void refetch(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, info?.state, refetch]);

  // The initial fetch can fail while the engine bridge is still coming up
  // (refetch swallows the error). Without a retry the tab would sit on the
  // loading spinner forever — the live poll above only starts once a
  // "running" snapshot has landed. Retry until the first snapshot arrives.
  useEffect(() => {
    if (!visible || info) return;
    const id = window.setInterval(() => void refetch(), 2_000);
    return () => window.clearInterval(id);
  }, [visible, info, refetch]);

  // A hidden retained setup does no polling. On reveal, catch up the complete
  // log/state once and fit the already-mounted grid to its real bounds.
  useEffect(() => {
    if (!visible) return;
    void refetch();
    // This also marks the scheduler dirty when dragging the collapsed row
    // open, guaranteeing one exact release-time fit even if ResizeObserver
    // coalesces away the visibility geometry change.
    resizeSchedulerRef.current?.flush();
  }, [visible, refetch]);

  // Re-resolve the xterm colors when the app variant flips (mode change OR an
  // OS flip in system mode) — xterm holds concrete values, not CSS vars, so the
  // mount-time resolve goes stale without this. Runs once at mount too, which
  // is a harmless re-set of the same values.
  //
  // useLayoutEffect (not useEffect): applyTheme() sets data-theme on <html>
  // synchronously inside the store's refresh(), so the whole app re-themes in
  // the same commit. A post-paint useEffect would re-resolve this terminal a
  // frame LATER — a visible flash of the old background against the flipped app
  // (the "switches very lately" report). Running pre-paint (the token values are
  // already live) lands it in the same frame; refresh() repaints the grid now.
  const variant = useThemeVariant();
  useLayoutEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = {
      background: resolveToken("--bg1"),
      foreground: resolveToken("--fg1"),
    };
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      /* not laid out yet — the mount effect paints the initial theme */
    }
  }, [variant]);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await workspaceRerunSetup({ workspaceId, repoRoot });
      if (!res.hasCommand) {
        toast.error("No setup command configured for this repo.");
        return;
      }
      // Reset the grid for the fresh run, then start tracking it.
      xtermRef.current?.reset();
      writtenRef.current = 0;
      await refetch();
    } catch (err) {
      toast.error(
        `Couldn't run setup: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, refetch, workspaceId, repoRoot]);

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await workspaceStopSetup({ workspaceId, repoRoot });
      await refetch();
    } catch (err) {
      toast.error(
        `Couldn't stop setup: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, refetch, workspaceId, repoRoot]);

  const state = info?.state ?? null;
  const hasLog = !!info && info.log.length > 0;
  const outcome: SetupOutcome | null = isSetupOutcome(state) ? state : null;

  // A NEW run resets this workspace's badge dismissal — its outcome deserves
  // its own 15s, even if the fresh log happens to match a dismissed key.
  useEffect(() => {
    if (state === "running") dismissedBadgeByWorkspace.delete(workspaceId);
  }, [state, workspaceId]);

  // The complete/failed badge auto-dismisses 15s after the user has VIEWED it;
  // "stopped" stays — it's the only explanation of a log with no result.
  const dismissKey =
    hasLog && outcome && outcome !== "stopped"
      ? `${outcome}:${info.log.length}`
      : null;
  const badgeVisible = useAutoDismissBadge(
    workspaceId,
    dismissKey,
    visible && hasLog,
  );

  return (
    <div className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* The xterm is always mounted (so writes land); the empty overlay covers
          it until there's output. */}
      <div
        className={cn(
          // FitAddon measures xterm's immediate parent. Padding therefore lives
          // on this outer box, leaving the measured host equal to the exact
          // content area at every narrow width and short height.
          "size-full min-h-0 min-w-0 overflow-hidden px-2 py-1",
          hasLog ? "opacity-100" : "opacity-0",
        )}
      >
        <div
          ref={hostRef}
          className="size-full min-h-0 min-w-0 overflow-hidden"
        />
      </div>

      {!hasLog && (
        <div className="absolute inset-0">
          {!info ? (
            // First paint — never flash an empty state before the state is known.
            <SetupLoading />
          ) : !info.hasCommand ? (
            <SetupAddEmpty onAdd={onAddSetupScript} />
          ) : state === "running" || busy ? (
            // Run accepted but no output yet (auto-run on a fresh worktree, or
            // the user just pressed Run) — an honest "starting" beat.
            <SetupStarting />
          ) : outcome ? (
            // The last run's result survived a restart; the streamed log didn't.
            <SetupLastRunEmpty outcome={outcome} busy={busy} onRun={run} />
          ) : (
            <SetupRunEmpty busy={busy} onRun={run} />
          )}
        </div>
      )}

      {/* Status cluster, bottom-right: a running run gets ONE action ("Stop
          setup") — rendered even before the first output byte, so a silent or
          hung command is still cancelable from the "Starting setup…" state; a
          finished log gets the outcome badge + "Rerun setup". */}
      {(hasLog || state === "running") && (
        <div className="absolute right-3 bottom-3 flex items-center gap-2">
          {state === "running" ? (
            <SetupActionButton
              busy={busy}
              onClick={() => void stop()}
              label="Stop setup"
              icon="stop"
            />
          ) : (
            <>
              {outcome && (outcome === "stopped" || badgeVisible) && (
                <SetupStatusBadge outcome={outcome} />
              )}
              <SetupActionButton
                busy={busy}
                onClick={() => void run()}
                label="Rerun setup"
                icon="rerun"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Outcome badge + auto-dismiss ──────────────────────────

const BADGE_DISMISS_MS = 15_000;

/** The LAST dismissed outcome badge per workspace (`<outcome>:<log length>`
 *  identifies one finished run). Module-level — NOT component state — because
 *  this view unmounts on every sub-tab switch, and a dismissed badge must not
 *  reappear when the user comes back. One slot per workspace (only one badge
 *  exists at a time), so the map stays O(workspaces). */
const dismissedBadgeByWorkspace = new Map<string, string>();
const MAX_DISMISSED_SETUP_BADGES = 128;

function rememberDismissedSetupBadge(workspaceId: string, key: string): void {
  dismissedBadgeByWorkspace.delete(workspaceId);
  dismissedBadgeByWorkspace.set(workspaceId, key);
  while (dismissedBadgeByWorkspace.size > MAX_DISMISSED_SETUP_BADGES) {
    const oldest = dismissedBadgeByWorkspace.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    dismissedBadgeByWorkspace.delete(oldest);
  }
}

/** True while the badge for `key` should show. The 15s countdown runs only
 *  while `counting` (the user is actually viewing the tab) — if setup finishes
 *  while they're elsewhere, the badge waits for their visit. `key` null = no
 *  dismissable badge (returns false). */
function useAutoDismissBadge(
  workspaceId: string,
  key: string | null,
  counting: boolean,
): boolean {
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (!key || !counting) return;
    if (dismissedBadgeByWorkspace.get(workspaceId) === key) return;
    const id = window.setTimeout(() => {
      rememberDismissedSetupBadge(workspaceId, key);
      bump();
    }, BADGE_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [workspaceId, key, counting]);
  return key != null && dismissedBadgeByWorkspace.get(workspaceId) !== key;
}

const BADGE_LABEL: Record<SetupOutcome, string> = {
  passed: "Setup complete",
  failed: "Setup failed",
  stopped: "Setup stopped",
};

/** Filled outcome badge — 24px (button height), token bg/fg pair, no icon.
 *  Green for a pass; red for failed AND stopped (per the state-catalog
 *  reference — a neutral yellow for "stopped" is a one-variant change here). */
export function SetupStatusBadge({ outcome }: { outcome: SetupOutcome }) {
  return (
    <Badge
      variant={outcome === "passed" ? "success" : "failure"}
      className="h-6 font-medium select-none"
    >
      {BADGE_LABEL[outcome]}
    </Badge>
  );
}

// ── Status-cluster action button (Stop / Rerun) ───────────

function SetupActionButton({
  busy,
  onClick,
  label,
  icon,
}: {
  busy: boolean;
  onClick: () => void;
  label: string;
  icon: "rerun" | "stop";
}) {
  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={onClick}>
      {busy ? (
        <ZerosSpinner size={16} />
      ) : icon === "stop" ? (
        <Square />
      ) : (
        <RotateCw />
      )}
      {label}
    </Button>
  );
}

// ── Loading / starting states ─────────────────────────────

/** First-paint cover — the state isn't known yet, so say nothing (no
 *  "No setup output yet" flash for a workspace whose setup already passed). */
function SetupLoading() {
  return <div className="h-full min-h-0" aria-busy="true" />;
}

/** The run has been accepted but the first output byte hasn't landed yet —
 *  the only indicator is this centered beat (no bottom-right pill). */
function SetupStarting() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <ZerosSpinner size={16} />
      <div className="text-fg2 text-xs">Starting setup…</div>
    </div>
  );
}

// ── Empty states (illustration → action → description) ────

/** Shared empty-state layout: a 1px-stroke illustration centered on top, the
 *  action button, then a one-line description underneath. */
function SetupEmptyLayout({
  icon: Icon,
  action,
  description,
}: {
  icon: typeof FileCode;
  action: ReactNode;
  description: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon className="text-muted-fg size-10" strokeWidth={1} aria-hidden />
      {action}
      <div className="text-fg2 max-w-sm text-xs">{description}</div>
    </div>
  );
}

/** "Run setup" empty state — a setup script exists but nothing has run yet
 *  this session and no prior result is on record. */
function SetupRunEmpty({ busy, onRun }: { busy: boolean; onRun: () => void }) {
  return (
    <SetupEmptyLayout
      icon={SquarePlay}
      action={
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => onRun()}
        >
          Run setup
        </Button>
      }
      description="Run the setup script."
    />
  );
}

const LAST_RUN_COPY: Record<SetupOutcome, string> = {
  passed: "Last run finished successfully.",
  failed: "Last run failed.",
  stopped: "Last run was stopped before it finished.",
};

/** Post-restart summary — the durable outcome survived, the streamed log
 *  didn't. Same layout as SetupRunEmpty plus the outcome badge bottom-right
 *  (persistent here: it IS the summary). */
function SetupLastRunEmpty({
  outcome,
  busy,
  onRun,
}: {
  outcome: SetupOutcome;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <>
      <SetupEmptyLayout
        icon={SquarePlay}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onRun()}
          >
            <RotateCw />
            Run setup again
          </Button>
        }
        description={LAST_RUN_COPY[outcome]}
      />
      <div className="absolute right-3 bottom-3">
        <SetupStatusBadge outcome={outcome} />
      </div>
    </>
  );
}

/** "Add setup script" empty state — the repo has no `scripts.setup`. The button
 *  opens Settings → Scripts (see useOpenScriptsSettings). */
function SetupAddEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <SetupEmptyLayout
      icon={FileCode}
      action={
        <Button variant="secondary" size="sm" onClick={() => onAdd()}>
          Add setup script
        </Button>
      }
      description="This script runs on worktree creation to install dependencies or environment setup."
    />
  );
}
