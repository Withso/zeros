// ──────────────────────────────────────────────────────────
// useRunControl — the repo's run ACTIONS (multi-run)
// ──────────────────────────────────────────────────────────
//
// Shared by terminal panel's terminal panel (its per-action Run tabs) and the
// terminal panel header split-button. Resolves the repo's `[[scripts.run_actions]]`
// (with the legacy single `scripts.run` migrated to one default "run" action
// at read time — see @zeros/protocol/run-actions), filters them to this OS, and
// owns start/stop/focus per action.
//
// Starting goes through the ENGINE (workspace.startRun): the engine resolves
// the action's command from settings by id, spawns it as the PTY's foreground
// process (one-shot `zsh -l -c`, so the exit code is honest — RunManager),
// and this hook then ATTACHES a terminal-store session to the deterministic
// per-(folder, action) id (`runSessionId`) so TerminalSessionView reattaches
// to the live engine PTY. A repeat start of a live action just refocuses it.
// The header button additionally expands/reveals the terminal panel.

import { useCallback, useMemo } from "react";
import {
  filterRunActionsForPlatform,
  normalizeRunPlatform,
  parseRunActions,
  runSessionId,
  type RunAction,
} from "@zeros/protocol/run-actions";

import { useActiveWorkspace } from "../../state/use-active-workspace";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { useResolvedSettings } from "../../features/settings/use-settings";
import { workspaceStartRun, workspaceStopRun } from "../../platform/git";
import { toast } from "../../shared/ui/primitives/elements";
import { useTerminalStore } from "./terminal-store";

/** This renderer's platform in the run-actions vocabulary (mac/linux/win),
 *  or null when undetectable (then no action is filtered out). */
function currentRunPlatform() {
  if (typeof navigator === "undefined") return null;
  return normalizeRunPlatform(
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
  );
}

/** Read + normalize the repo's run actions out of resolved settings. Empty
 *  array when none configured → no Run controls anywhere. */
export function readRunActions(
  resolved: ReturnType<typeof useResolvedSettings>["resolved"],
): RunAction[] {
  return parseRunActions(resolved?.effective.scripts);
}

export interface RunControl {
  /** Platform-eligible actions, normalized (exactly one isDefault). Empty =
   *  the repo defines no run actions → the Run sub-tab shows its "Add run
   *  script" state (and the header control hides). */
  actions: RunAction[];
  /** True once `actions` reflects RESOLVED settings on a runnable surface —
   *  false while settings are still loading (or there's no chat/workspace),
   *  when an empty list means "unknown", not "none configured". Gates the
   *  add-script empty state AND the stale-session cleanup so neither fires
   *  off a not-yet-loaded snapshot. */
  actionsReady: boolean;
  /** The split-button face / ⌘R action (null when `actions` is empty). */
  defaultAction: RunAction | null;
  /** The deterministic session id for one action's run terminal. */
  runIdFor(actionId: string): string;
  /** Start (or focus, when already live) one action — engine-spawned, then
   *  attached as this folder's run terminal + focused as the active sub-tab. */
  startRun(actionId?: string): void;
  /** Stop one action's live run (records "stopped", not "failed"). */
  stopRun(actionId: string): void;
}

export function useRunControl(
  folderKey: string,
  chatCwd: string | undefined,
): RunControl {
  const { workspace: activeWs } = useActiveWorkspace();
  // Resolve run actions from the repo ROOT (so a Settings edit applies even
  // though the run terminal spawns inside a worktree).
  const { resolved } = useResolvedSettings(
    activeWs?.repoRoot || folderKey || undefined,
  );
  // Gated on a real chat folder — a chatless surface has no runnable workspace.
  const actions = useMemo(
    () =>
      chatCwd && activeWs
        ? filterRunActionsForPlatform(
            readRunActions(resolved),
            currentRunPlatform(),
          )
        : [],
    [chatCwd, activeWs, resolved],
  );
  const actionsReady = !!chatCwd && !!activeWs && resolved != null;
  const defaultAction = useMemo(
    () => actions.find((a) => a.isDefault) ?? actions[0] ?? null,
    [actions],
  );

  const workspaceId = activeWs?.id ?? "";
  // Only the trunk needs the explicit repoRoot fallback (no engine row); a
  // real worktree resolves from its row (same contract as the setup ops).
  const repoRoot =
    activeWs && isLocalMainWorkspace(activeWs) ? activeWs.repoRoot : undefined;

  const createSession = useTerminalStore((s) => s.createSession);
  const forceCloseSession = useTerminalStore((s) => s.forceCloseSession);

  const runIdFor = useCallback(
    (actionId: string) => (folderKey ? runSessionId(folderKey, actionId) : ""),
    [folderKey],
  );

  const startRun = useCallback(
    (actionId?: string) => {
      const action = actionId
        ? actions.find((a) => a.id === actionId)
        : defaultAction;
      if (!action || !folderKey || !workspaceId) return;
      const sessionId = runSessionId(folderKey, action.id);
      void (async () => {
        try {
          const res = await workspaceStartRun({
            workspaceId,
            repoRoot,
            actionId: action.id,
            sessionId,
          });
          if (!res.hasCommand) {
            toast.error(`No command configured for "${action.name}".`);
            return;
          }
          // Nothing spawned: a Stop (or the archive reaper) landed while the
          // engine was still resolving the run's env. Creating the tab anyway
          // would attach it to a PTY that does not exist, find no buffered log to
          // replay, and render an instantly-"(exited)" blank pane — immediately
          // after the user pressed Stop.
          if (res.cancelled) return;
          // An EXITED session is force-dropped first so the recreate re-mounts
          // and reattaches to the fresh engine PTY (closeSession would refuse
          // to drop a folder's last tab); an ALIVE one is reused (focused); a
          // never-started one is created. Either way createSession sets the
          // terminal panel's active tab = the run id.
          const existing = useTerminalStore
            .getState()
            .sessions.find((s) => s.id === sessionId);
          if (existing && !existing.alive) forceCloseSession(sessionId);
          createSession(
            folderKey,
            null,
            undefined,
            sessionId,
            true,
            action.name,
          );
        } catch (err) {
          toast.error(
            `Couldn't start ${action.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    [
      actions,
      defaultAction,
      folderKey,
      workspaceId,
      repoRoot,
      forceCloseSession,
      createSession,
    ],
  );

  const stopRun = useCallback(
    (actionId: string) => {
      if (!folderKey) return;
      const sessionId = runSessionId(folderKey, actionId);
      void workspaceStopRun({ sessionId }).catch((err) => {
        toast.error(
          `Couldn't stop the run: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    [folderKey],
  );

  return { actions, actionsReady, defaultAction, runIdFor, startRun, stopRun };
}
