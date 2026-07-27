// ──────────────────────────────────────────────────────────
// SetupManager — background setup-script runner
// ──────────────────────────────────────────────────────────
//
// Runs a new worktree's setup command (`scripts.setup`, e.g. `pnpm install`) in
// a worktree-scoped PTY AFTER workspace.create returns — so a slow install no
// longer blocks (or times out) creation. A real PTY (not piped exec) so the
// output is ANSI-colored in the Setup tab; one-shot (`zsh -l -c …`) so the exit
// code tells us pass/fail.
//
// Output is mirrored into a bounded in-memory buffer per workspace; the Setup
// tab reads it via the `workspace.setupInfo` op (delta-appended into a read-only
// xterm) and `setup_state` on the workspace row persists pass/fail across
// reloads. A failed setup is NOT fatal — the worktree stays and the user can
// Rerun from the tab.
//
// The trunk / "main" (the renderer's synthetic `local:<repoSlug>` workspace,
// which has no workspace row) runs through the SAME manager: callers pass an
// explicit SetupTarget (cwd = repo root) and the run's state lives on the
// in-memory entry instead of a row — so main gets the identical status
// language (running / passed / failed / stopped), just without restart
// durability.
// ──────────────────────────────────────────────────────────

import type { PtyService } from "../pty/service";
import { getWorkspaceById, updateWorkspace, listWorkspaces } from "./state";
import type { SetupState } from "./types";
import { buildSetupCommandEnv } from "./setup-hooks";

const SETUP_PREFIX = "setup:";
/** Keep at most the last 512 KB of setup output in memory (the tail is what a
 *  user reads after a failed install). Older bytes are dropped with a marker. */
const MAX_LOG_BYTES = 512 * 1024;
const TRUNCATION_MARKER = "\r\n[2m…[earlier setup output truncated]…[0m\r\n";

/** PTY session id for one setup RUN. `gen` makes it unique per run so a
 *  superseded run's late async exit (the one a Rerun just killed) can't clobber
 *  the new run's state. Format: `setup:<gen>:<workspaceId>` — recovered below
 *  as everything after the 2nd colon, so a workspaceId that itself contains
 *  ":" (the trunk's synthetic `local:<repoSlug>`) round-trips intact. */
export function setupSessionId(workspaceId: string, gen: number): string {
  return `${SETUP_PREFIX}${gen}:${workspaceId}`;
}
export function isSetupSession(sessionId: string): boolean {
  return sessionId.startsWith(SETUP_PREFIX);
}
function workspaceIdFromSetupSession(sessionId: string): string {
  // "setup:<gen>:<workspaceId>" → everything after the 2nd colon.
  return sessionId.split(":").slice(2).join(":");
}

export interface SetupInfo {
  state: SetupState | null;
  /** The command of the most recent run, or null if none has run this session. */
  command: string | null;
  /** Accumulated (ANSI) output of the most recent run. Empty when none ran. */
  log: string;
  truncated: boolean;
}

/** Where a ROWLESS setup run executes. A real worktree resolves all of this
 *  from its workspace row; the trunk / "main" — the renderer's synthetic
 *  `local:<repoSlug>` workspace, which has no row — passes it explicitly
 *  (cwd = the repo root itself). */
export interface SetupTarget {
  cwd: string;
  repoRoot: string;
  baseBranch: string;
}

interface SetupEntry {
  /** The CURRENT run's session id. appendData/handleExit ignore any event whose
   *  session id doesn't match this — that's a superseded (killed) run. */
  sessionId: string;
  command: string;
  log: string;
  truncated: boolean;
  /** In-memory state mirror — the source of truth for ROWLESS targets (the
   *  trunk has no workspace row to persist to). For a real workspace the
   *  durable row wins in info(). */
  state: SetupState | null;
  /** Set by stop() just before killing the PTY so handleExit records the run
   *  as "stopped" instead of "failed" (a killed process exits non-zero). */
  stopRequested: boolean;
  /** Fired once if THIS run ends "passed" — the workspace-create path hangs
   *  the run-on-create actions off it (never set for manual reruns). */
  onPassed?: () => void;
}

export class SetupManager {
  /** workspaceId → the CURRENT run's buffer + session id. */
  private readonly entries = new Map<string, SetupEntry>();
  /** Monotonic run counter → a unique session id per run (rerun-race guard). */
  private gen = 0;

  constructor(
    private readonly pty: PtyService,
    /** Nudge clients (DB_CHANGED) that a workspace's setup_state changed. */
    private readonly onChange: (workspaceId: string | null) => void,
  ) {}

  /** On engine start the in-memory buffers are empty, so any workspace row still
   *  marked "running" is an orphan from a previous process (the engine was quit
   *  mid-install). Mark it "stopped" so the Setup tab explains the interrupted
   *  run instead of spinning forever — the user can Rerun. Best-effort. */
  reconcileStaleRuns(): void {
    try {
      for (const ws of listWorkspaces({})) {
        if (ws.setupState === "running") {
          updateWorkspace(ws.id, { setupState: "stopped" });
        }
      }
    } catch {
      /* state db unavailable — nothing to reconcile */
    }
  }

  /** Record a run's state: mirrored on the in-memory entry (the only home a
   *  ROWLESS trunk run has) and persisted on the workspace row when one exists.
   *  Nudges clients either way — the trunk's state changes matter to the Setup
   *  tab too, and DB_CHANGED is the tab's refresh signal. */
  private setState(id: string, state: SetupState): void {
    const entry = this.entries.get(id);
    if (entry) entry.state = state;
    const workspace = getWorkspaceById(id);
    if (workspace) updateWorkspace(id, { setupState: state });
    this.onChange(workspace ? id : null);
  }

  /** (Re)start setup. Kills any in-flight setup PTY, resets the buffer under a
   *  NEW unique session id, marks the run "running", and spawns the one-shot
   *  setup PTY. The engine's pty.onData/onExit feed appendData/handleExit
   *  (which ignore a superseded run's events). A real workspace resolves its
   *  cwd/repo from the row; a ROWLESS caller (the trunk / "main") must pass
   *  `target` — with neither, this is a no-op (workspace vanished between
   *  create and setup). */
  async start(args: {
    workspaceId: string;
    command: string;
    target?: SetupTarget;
    /** Called once if this run PASSES (see SetupEntry.onPassed). */
    onPassed?: () => void;
  }): Promise<void> {
    const ws = getWorkspaceById(args.workspaceId);
    if (!ws && !args.target) return;
    const cwd = ws?.path ?? args.target!.cwd;
    const repoRoot = ws?.repoRoot ?? args.target!.repoRoot;
    const baseBranch = ws?.baseBranch ?? args.target!.baseBranch;
    // Kill the previous run's PTY (if any). Its late async exit carries the OLD
    // session id, which appendData/handleExit ignore (entry.sessionId moved on),
    // so it can't mislabel this new run.
    const prev = this.entries.get(args.workspaceId);
    if (prev && this.pty.has(prev.sessionId)) this.pty.kill(prev.sessionId);
    const sessionId = setupSessionId(args.workspaceId, ++this.gen);
    this.entries.set(args.workspaceId, {
      sessionId,
      command: args.command,
      log: "",
      truncated: false,
      state: "running",
      stopRequested: false,
      onPassed: args.onPassed,
    });
    this.setState(args.workspaceId, "running");
    const env = await buildSetupCommandEnv({
      workspaceId: args.workspaceId,
      worktreePath: cwd,
      repoRoot,
      baseBranch,
    });
    this.pty.create({
      sessionId,
      resolvedCwd: cwd,
      command: args.command,
      env,
      cols: 120,
      rows: 30,
      scrubEnv: false, // env is supplied verbatim (already scrubbed)
    });
  }

  /** Stop a live run without treating it as a failure. Flags the entry so the
   *  PTY's kill-exit records "stopped" (not "failed"), flips the state now for
   *  a snappy UI, and kills the PTY. With no live PTY (the run already ended,
   *  or the engine restarted mid-run) it just clears a stale "running" marker. */
  stop(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (entry && this.pty.has(entry.sessionId)) {
      entry.stopRequested = true;
      this.setState(workspaceId, "stopped");
      this.pty.kill(entry.sessionId);
      return;
    }
    const rowState = getWorkspaceById(workspaceId)?.setupState ?? entry?.state;
    if (rowState === "running") this.setState(workspaceId, "stopped");
  }

  /** Append a chunk of the CURRENT setup PTY's output (ignores non-setup AND
   *  superseded-run sessions). */
  appendData(sessionId: string, data: string): void {
    if (!isSetupSession(sessionId)) return;
    const entry = this.entries.get(workspaceIdFromSetupSession(sessionId));
    if (!entry || entry.sessionId !== sessionId) return; // superseded — ignore
    entry.log += data;
    if (entry.log.length > MAX_LOG_BYTES) {
      entry.log =
        TRUNCATION_MARKER + entry.log.slice(entry.log.length - MAX_LOG_BYTES);
      entry.truncated = true;
    }
  }

  /** Flip the run's state on the CURRENT setup PTY's exit. A superseded run's
   *  exit (e.g. the one a Rerun just killed) no longer matches the workspace's
   *  entry session id, so it's ignored and can't mislabel the new run. A
   *  stop()-killed run records "stopped", not "failed". */
  handleExit(sessionId: string, exitCode: number | null): void {
    if (!isSetupSession(sessionId)) return;
    const workspaceId = workspaceIdFromSetupSession(sessionId);
    const entry = this.entries.get(workspaceId);
    if (!entry || entry.sessionId !== sessionId) return; // superseded — ignore
    const state: SetupState = entry.stopRequested
      ? "stopped"
      : exitCode === 0
        ? "passed"
        : "failed";
    this.setState(workspaceId, state);
    if (state === "passed" && entry.onPassed) {
      const cb = entry.onPassed;
      entry.onPassed = undefined; // fire once
      try {
        cb();
      } catch {
        /* a run-on-create failure must never mislabel the setup run */
      }
    }
  }

  /** Snapshot for the Setup tab. `state` prefers the durable row (a real
   *  workspace) and falls back to the in-memory entry (a rowless trunk run);
   *  `log`/`command` come from the in-memory buffer either way (empty after an
   *  engine restart — the user can Rerun to repopulate). */
  info(workspaceId: string): SetupInfo {
    const ws = getWorkspaceById(workspaceId);
    const entry = this.entries.get(workspaceId);
    return {
      state: ws ? (ws.setupState ?? null) : (entry?.state ?? null),
      command: entry?.command ?? null,
      log: entry?.log ?? "",
      truncated: entry?.truncated ?? false,
    };
  }
}
