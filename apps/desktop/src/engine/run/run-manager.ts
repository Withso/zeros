// ──────────────────────────────────────────────────────────
// RunManager — run-action status engine (the Setup blueprint, applied to Run)
// ──────────────────────────────────────────────────────────
//
// Owns the lifecycle + verdict of every run-action PTY (`pty-run-…` ids):
//
//   • start()      — spawns the action's command as the PTY's FOREGROUND
//                    process (a one-shot command shell, like Setup — see
//                    buildOneShotArgs) so the PTY's exit code IS the command's,
//                    under the terminal-parity env buildRunCommandEnv resolves.
//                    The renderer then ATTACHES to the session with its normal
//                    TerminalSessionView (reattach + mirror replay), so the log
//                    lives in the terminal itself — no separate buffer here,
//                    unlike SetupManager.
//   • stop()       — kills the PTY, recording "stopped" (not "failed").
//   • handleExit() — flips the state machine on the real exit code:
//                    one-shot  → finished (0) | failed (≠0)
//                    long-lived (dev server) → stopped (an exit is never a
//                    verdict for a server; red for a Ctrl-C would lie).
//
// Durability: per-(workspace, action) outcomes persist in the workspace_meta
// KV (key "run_status") so a verdict survives an app restart. The trunk /
// "main" (synthetic `local:` id, no row) is in-memory only — the same
// accepted tradeoff as Setup. Orphan reconciliation is LAZY: after an engine
// restart the in-memory map is empty, so any durable "running" is necessarily
// an orphan and reads back as "stopped" (and is repaired on read).
//
// Same-id respawn guard: PtyService keys sessions by id and a kill's exit
// callback lands ASYNC — spawning the same id before the old exit settles
// would let the stale exit clobber the new run (and orphan the new session's
// bookkeeping). start() therefore awaits the previous run's exit (bounded)
// before respawning. Ids stay deterministic (unlike Setup's per-run gen ids)
// because the renderer's tabs attach by id.
// ──────────────────────────────────────────────────────────

import type { PtyService } from "../pty/service";
import { buildRunCommandEnv } from "../pty/shell-setup";
import { isRunSessionId } from "@zeros/protocol/run-actions";
import {
  getWorkspaceById,
  getWorkspaceMeta,
  setWorkspaceMeta,
} from "../git/state";

export type RunState = "running" | "finished" | "failed" | "stopped";

/** The outcome of a start attempt.
 *
 *  `cancelled` exists because the other two shapes both mean "there is a tab to
 *  show": the renderer creates (or focuses) the run terminal unconditionally on a
 *  non-error reply. A cancelled start has no PTY and no entry, so that tab
 *  attached to nothing, found no buffered log to replay, and rendered as an
 *  instantly-"(exited)" blank pane with no explanation — right after the user
 *  pressed Stop. */
export interface RunStartResult {
  alreadyRunning: boolean;
  cancelled?: boolean;
}

/** What a run's env builder is told about the run it's building for. */
export interface RunEnvContext {
  cwd: string;
  workspaceId: string | null;
  repoRoot?: string | null;
}

/** One action's status, as the Run tab consumes it. */
export interface RunActionStatus {
  state: RunState;
  /** True when backed by a LIVE in-memory run this engine process owns. */
  live: boolean;
  oneShot: boolean;
  startedAt: number | null;
  endedAt: number | null;
}

export interface RunStartArgs {
  /** Deterministic per-(folder, action) id — `pty-run-…` (see runSessionId). */
  sessionId: string;
  /** Row-backed workspace id for durable status; null = rowless (the trunk). */
  workspaceId: string | null;
  actionId: string;
  command: string;
  oneShot: boolean;
  /** Already-resolved working directory (worktree path / repo root). */
  cwd: string;
  /** The workspace's repo root, surfaced to the command as ZEROS_REPO_ROOT
   *  (parity with the setup script's context env). Optional — a rowless trunk
   *  run's cwd already IS the repo root. */
  repoRoot?: string | null;
}

/** The durable per-workspace map persisted in workspace_meta. */
const RUN_STATUS_META_KEY = "run_status";

interface DurableActionStatus {
  state: RunState;
  oneShot: boolean;
  endedAt: number | null;
}

interface RunEntry {
  sessionId: string;
  workspaceId: string | null;
  actionId: string;
  oneShot: boolean;
  state: RunState;
  /** Set by stop() before the kill so handleExit records "stopped". */
  stopRequested: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Resolves when this run's PTY exit has been processed — the respawn guard. */
  exitSettled: Promise<void>;
  settleExit: () => void;
  /** True once the exit landed (or the run was settled without a PTY). A
   *  same-id respawn must wait for this — a killed PTY's exit callback lands
   *  ASYNC, and processing it against the NEW run's entry would clobber it. */
  settled: boolean;
  /** Bounded copy of the run's output (see MAX_RUN_LOG_BYTES) — the terminal's
   *  fast-exit replay source. Retained after exit until the next same-id run. */
  log: string;
  truncated: boolean;
}

/** How long start() waits for a previous same-id run's exit to settle before
 *  respawning anyway (a wedged exit callback must not brick the action). */
const EXIT_SETTLE_TIMEOUT_MS = 3_000;

/** Keep at most the last 256 KB of a run's output in memory. Unlike a normal
 *  terminal, a run's log has no other home — the live PTY mirror is disposed
 *  the instant the process exits (pty/service.ts). A run that exits BEFORE the
 *  renderer can attach (an instant build/lint failure, a dev server that dies
 *  on boot) would otherwise leave a blank pane; this buffer lets the terminal
 *  replay why it ended (see workspace.runLog + TerminalSessionView.replayOnMiss).
 *  In-memory only — gone after an engine restart, like SetupManager's buffer;
 *  the durable OUTCOME survives regardless. Older bytes drop with a marker. */
const MAX_RUN_LOG_BYTES = 256 * 1024;
const RUN_TRUNCATION_MARKER = "\r\n[2m…[earlier run output truncated]…[0m\r\n";

export class RunManager {
  /** sessionId → the CURRENT run's entry. */
  private readonly entries = new Map<string, RunEntry>();
  /** Starts that are past the "no live PTY" check but have not spawned yet —
   *  the window the awaits in spawnRun open. Held here (not in `entries`, which
   *  must not publish "running" for a shell that doesn't exist yet) so stop()
   *  and the archive reaper can still CANCEL a run in that window instead of
   *  silently missing it and letting the PTY appear afterwards. */
  private readonly starting = new Map<
    string,
    { workspaceId: string | null; cancelled: boolean }
  >();

  constructor(
    private readonly pty: PtyService,
    /** Nudge clients (DB_CHANGED{workspaces}) that a run's state changed. */
    private readonly onChange: (workspaceId: string | null) => void,
    /** Register a freshly-spawned run terminal in the SHARED terminal registry
     *  (so every device's tab strip discovers it, like a renderer-spawned
     *  terminal). Wired by the engine; optional for unit tests. */
    private readonly registerTerminal?: (sessionId: string, cwd: string) => void,
    /** The child env for a run's shell. Injectable so unit tests don't pay (or
     *  depend on) the real `$SHELL -ilc` PATH probe buildRunCommandEnv runs. */
    private readonly envBuilder: (
      ctx: RunEnvContext,
    ) => Promise<Record<string, string> | undefined> = buildRunCommandEnv,
  ) {}

  /** The run's child env, never fatal: an env-builder failure must not block
   *  the run — the spawn layer then falls back to the standard terminal env,
   *  which is still strictly better than not running at all. */
  private async buildEnv(
    args: RunStartArgs,
  ): Promise<Record<string, string> | undefined> {
    try {
      return await this.envBuilder({
        cwd: args.cwd,
        workspaceId: args.workspaceId,
        repoRoot: args.repoRoot ?? null,
      });
    } catch {
      return undefined;
    }
  }

  /** Start (or focus) a run. Returns alreadyRunning=true — without spawning —
   *  when the action's PTY is still alive (or one is mid-spawn); the caller
   *  just focuses its tab. Returns cancelled=true when a Stop (or the archive
   *  reaper) landed while the env was still resolving, so nothing was spawned
   *  and the caller must NOT open a tab for it. */
  async start(args: RunStartArgs): Promise<RunStartResult> {
    if (!isRunSessionId(args.sessionId)) {
      throw new Error(`not a run session id: ${args.sessionId}`);
    }
    const prev = this.entries.get(args.sessionId);
    if (this.pty.has(args.sessionId)) {
      if (!prev) {
        // An untracked live PTY under this run id — a pre-migration run
        // terminal (spawned by the old renderer path) still alive. ADOPT it
        // so it wears the running star and Stop works; its exit settles
        // through the normal state machine.
        this.adopt(args);
      }
      return { alreadyRunning: true };
    }
    // In-flight guard. There are awaits (the exit-settle wait, the env build)
    // between "no live PTY" and the spawn, so a second Rerun click can arrive
    // while the first is still in that window — where `pty.has` is still false
    // and there is no entry to find. Without this, the loser would register a
    // SECOND entry over the winner's and call create() again.
    //
    // A CANCELLED flight is not "already running" — it is a corpse. Stop and
    // Rerun share the same bottom-right cluster, and ⌘R re-launches whenever the
    // state isn't "running", so Stop-then-Rerun inside the env window is an
    // ordinary thing to do: the first flight aborts (correctly) and the second
    // used to be told "already running" and drop on the floor. Nothing ran, no
    // error, no toast — the user had to click Rerun twice. `stop()` now retires
    // the slot so a later start takes a fresh one.
    if (this.starting.has(args.sessionId)) return { alreadyRunning: true };
    const flight = { workspaceId: args.workspaceId, cancelled: false };
    this.starting.set(args.sessionId, flight);
    try {
      return await this.spawnRun(args, prev, flight);
    } finally {
      // Only if it is still OURS — stop() may have retired it and a newer start
      // may already own the slot.
      if (this.starting.get(args.sessionId) === flight) {
        this.starting.delete(args.sessionId);
      }
    }
  }

  /** start()'s body, once it owns the in-flight slot for this session id. */
  private async spawnRun(
    args: RunStartArgs,
    prev: RunEntry | undefined,
    flight: { cancelled: boolean },
  ): Promise<RunStartResult> {
    if (prev && !prev.settled) {
      // PTY gone but its exit not yet processed (a stop's kill in flight, or
      // a crash landing) — wait for it so the stale exit can't clobber the
      // new run or orphan its PtyService bookkeeping. Bounded: a wedged
      // callback must not brick the action forever.
      await Promise.race([
        prev.exitSettled,
        new Promise<void>((r) => setTimeout(r, EXIT_SETTLE_TIMEOUT_MS)),
      ]);
    }
    // Resolve the child env BEFORE the entry is registered: it awaits the
    // login-shell PATH probe, and an await between "running" is published and
    // the PTY exists would leave a window where stop() settles an entry whose
    // shell is still about to spawn (an unkillable orphan run).
    const env = await this.buildEnv(args);
    // Stop / archive during either await above cancels the start. Without this
    // the spawn would land AFTER the user asked for it to go away — a dev
    // server appearing post-Stop, or worse, holding open a worktree the
    // archive reaper is about to `git worktree remove`.
    if (flight.cancelled) return { alreadyRunning: false, cancelled: true };
    let resolveExit = () => {};
    const exitSettled = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const entry: RunEntry = {
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      actionId: args.actionId,
      oneShot: args.oneShot,
      state: "running",
      stopRequested: false,
      startedAt: Date.now(),
      endedAt: null,
      exitSettled,
      settleExit: () => {},
      settled: false,
      log: "",
      truncated: false,
    };
    entry.settleExit = () => {
      entry.settled = true;
      resolveExit();
    };
    this.entries.set(args.sessionId, entry);
    this.persist(entry);
    this.onChange(entry.workspaceId);
    // One-shot PTY: the command is the foreground process, so stdin still
    // flows (vite hotkeys, watch-mode prompts) but the exit code is honest.
    // 120×30 seed dims — the renderer attaches right after and pushes real
    // ones (same as Setup).
    try {
      this.pty.create({
        sessionId: args.sessionId,
        resolvedCwd: args.cwd,
        command: args.command,
        env,
        // Behave exactly as if the command had been typed into the Terminal tab,
        // which means the user's ~/.zshrc toolchain — nvm/fnm/mise/volta all put
        // their PATH setup there and a login-but-not-interactive shell skips it.
        // Safe here because a run PTY already carries the full desktop env, so
        // the rc grants it nothing new; the SETUP script, whose whole point is a
        // narrow allowlist, deliberately does not opt in. Both are equally
        // repo-resident — see buildOneShotArgs for why that is not the reason.
        interactive: true,
        cols: 120,
        rows: 30,
      });
    } catch (err) {
      // Spawn failed (worktree gone, node-pty fault) — settle the entry so
      // it can't sit "running" forever (a permanent star + a 3s respawn
      // stall), then surface the error to the op caller.
      this.setState(entry, "failed");
      entry.settleExit();
      throw err;
    }
    this.registerTerminal?.(args.sessionId, args.cwd);
    return { alreadyRunning: false };
  }

  /** Track (without spawning) a live PTY this manager didn't create — a
   *  pre-migration run terminal. Long-lived semantics regardless of the
   *  action's flag: its command was typed into an interactive shell, so the
   *  eventual PTY exit is a shell exit, never a verdict. */
  private adopt(args: RunStartArgs): void {
    let resolveExit = () => {};
    const exitSettled = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const entry: RunEntry = {
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      actionId: args.actionId,
      oneShot: false,
      state: "running",
      stopRequested: false,
      startedAt: Date.now(),
      endedAt: null,
      exitSettled,
      settleExit: () => {},
      settled: false,
      log: "",
      truncated: false,
    };
    entry.settleExit = () => {
      entry.settled = true;
      resolveExit();
    };
    this.entries.set(args.sessionId, entry);
    this.persist(entry);
    this.onChange(entry.workspaceId);
  }

  /** Stop a live run without treating it as a failure. With no live PTY it
   *  just settles a stale "running" marker (engine restarted mid-run). */
  stop(sessionId: string): void {
    if (!isRunSessionId(sessionId)) return;
    // A start still resolving its env has no entry and no PTY yet — mark it so
    // it aborts instead of spawning behind the user's Stop, and RETIRE the slot
    // so an immediate Rerun isn't told "already running" by a flight that is
    // only going to abort. The aborting start's `finally` checks identity, so
    // handing the slot over here is safe.
    const flight = this.starting.get(sessionId);
    if (flight) {
      flight.cancelled = true;
      this.starting.delete(sessionId);
    }
    const entry = this.entries.get(sessionId);
    if (this.pty.has(sessionId)) {
      if (entry) {
        entry.stopRequested = true;
        this.setState(entry, "stopped");
      }
      // Untracked live PTY (pre-migration run terminal) → still honor Stop.
      this.pty.kill(sessionId);
      return;
    }
    if (entry && entry.state === "running") {
      this.setState(entry, "stopped");
      entry.settleExit();
    }
  }

  /** Cancel every not-yet-spawned start for a workspace WITHOUT touching a
   *  live PTY. The archive/delete reaper calls this before it enumerates
   *  processes: these flights own no PTY to enumerate, and their awaits would
   *  otherwise spend the lifecycle drain deadline on children that must never
   *  exist. Killing live PTYs that early would be actively wrong — kill() drops
   *  the session synchronously and waitForExit() resolves true for an unknown
   *  one, so a run PTY killed before enumeration is invisible to the reaper's
   *  exit wait. stopAllForWorkspace still runs afterwards for the live ones. */
  cancelPendingStartsForWorkspace(workspaceId: string): void {
    for (const [sessionId, flight] of [...this.starting]) {
      if (flight.workspaceId !== workspaceId) continue;
      flight.cancelled = true;
      this.starting.delete(sessionId);
    }
  }

  /** Stop every live run belonging to a workspace — the archive/delete
   *  reaper: a run PTY left alive would keep writing into (and can partially
   *  resurrect) the worktree folder the engine is about to remove. */
  stopAllForWorkspace(workspaceId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.workspaceId === workspaceId && entry.state === "running") {
        this.stop(sessionId);
      }
    }
    // Runs still mid-spawn have no entry yet, but their PTY is seconds from
    // existing — inside the folder this reaper is about to delete. Snapshot
    // first: stop() retires the slot it cancels.
    for (const [sessionId, flight] of [...this.starting]) {
      if (flight.workspaceId === workspaceId) this.stop(sessionId);
    }
  }

  /** Flip the state machine on the run PTY's exit (no-op for other sessions).
   *  A run stop()/start()ed in between has already settled its state — the
   *  late exit only releases the respawn guard.
   *
   *  `signal` is checked alongside `exitCode` because node-pty reports a killed
   *  PTY as `exitCode 0, signal N` — so a one-shot action killed by the OOM
   *  reaper (or anything else external) would otherwise show a green "finished". */
  handleExit(
    sessionId: string,
    exitCode: number | null,
    signal?: number | null,
  ): void {
    if (!isRunSessionId(sessionId)) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const killed = typeof signal === "number" && signal > 0;
    if (entry.state === "running") {
      this.setState(
        entry,
        entry.stopRequested
          ? "stopped"
          : entry.oneShot
            ? exitCode === 0 && !killed
              ? "finished"
              : "failed"
            : "stopped",
      );
    }
    entry.settleExit();
  }

  /** Buffer a chunk of a run PTY's output into its entry (no-op for non-run or
   *  untracked sessions). Bounded to the tail — see MAX_RUN_LOG_BYTES. Fed by
   *  the engine's pty.onData, in lockstep with the bytes broadcast to clients. */
  appendData(sessionId: string, data: string): void {
    if (!isRunSessionId(sessionId)) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.log += data;
    if (entry.log.length > MAX_RUN_LOG_BYTES) {
      entry.log =
        RUN_TRUNCATION_MARKER +
        entry.log.slice(entry.log.length - MAX_RUN_LOG_BYTES);
      entry.truncated = true;
    }
  }

  /** The buffered output of the run under `sessionId` — the terminal replays
   *  this when it mounts too late to attach to a fast-exiting run PTY. Empty
   *  when no run is tracked (unknown id, or the buffer dropped by a restart). */
  log(sessionId: string): { log: string; truncated: boolean } {
    const entry = this.entries.get(sessionId);
    return { log: entry?.log ?? "", truncated: entry?.truncated ?? false };
  }

  /** Statuses for the given session ids, merged over the workspace's durable
   *  last-run map: live in-memory entries win; durable rows fill the rest
   *  (with any orphaned "running" read back — and repaired — as "stopped"). */
  info(
    sessionIds: string[],
    workspaceId: string | null,
  ): Record<string, RunActionStatus> {
    const actions: Record<string, RunActionStatus> = {};
    if (workspaceId && getWorkspaceById(workspaceId)) {
      // Actions THIS engine process has an in-memory entry for — their
      // durable rows are shadows of the live state, never orphans.
      const liveActionIds = new Set(
        [...this.entries.values()]
          .filter((e) => e.workspaceId === workspaceId)
          .map((e) => e.actionId),
      );
      const durable = this.readDurable(workspaceId);
      let repaired = false;
      for (const [actionId, status] of Object.entries(durable)) {
        let state = status.state;
        if (state === "running" && !liveActionIds.has(actionId)) {
          // The in-memory map is authoritative for "running"; a durable
          // "running" with no live entry is an orphan from a previous process.
          state = "stopped";
          durable[actionId] = { ...status, state };
          repaired = true;
        }
        actions[actionId] = {
          state,
          live: false,
          oneShot: status.oneShot,
          startedAt: null,
          endedAt: status.endedAt,
        };
      }
      if (repaired) this.writeDurable(workspaceId, durable);
      // Live entries for this workspace override their durable shadows —
      // matched by WORKSPACE, not only by the caller-supplied session ids,
      // so a caller whose ids don't cover a live run still reads "running".
      for (const entry of this.entries.values()) {
        if (entry.workspaceId !== workspaceId) continue;
        actions[entry.actionId] = {
          state: entry.state,
          live: true,
          oneShot: entry.oneShot,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
        };
      }
    }
    // Rowless (trunk) runs have workspaceId null — matched by session id.
    for (const sessionId of sessionIds) {
      const entry = this.entries.get(sessionId);
      if (!entry || (workspaceId && entry.workspaceId === workspaceId)) continue;
      actions[entry.actionId] = {
        state: entry.state,
        live: true,
        oneShot: entry.oneShot,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      };
    }
    return actions;
  }

  private setState(entry: RunEntry, state: RunState): void {
    entry.state = state;
    if (state !== "running") entry.endedAt = Date.now();
    this.persist(entry);
    this.onChange(entry.workspaceId);
  }

  // ── Durable per-(workspace, action) map (workspace_meta) ──

  private readDurable(workspaceId: string): Record<string, DurableActionStatus> {
    try {
      const raw = getWorkspaceMeta(workspaceId, RUN_STATUS_META_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, DurableActionStatus> = {};
      for (const [actionId, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const s = v as Partial<DurableActionStatus>;
        if (
          s.state === "running" ||
          s.state === "finished" ||
          s.state === "failed" ||
          s.state === "stopped"
        ) {
          out[actionId] = {
            state: s.state,
            oneShot: s.oneShot === true,
            endedAt: typeof s.endedAt === "number" ? s.endedAt : null,
          };
        }
      }
      return out;
    } catch {
      return {}; // state db unavailable / corrupt JSON — in-memory still works
    }
  }

  private writeDurable(
    workspaceId: string,
    map: Record<string, DurableActionStatus>,
  ): void {
    try {
      setWorkspaceMeta(workspaceId, RUN_STATUS_META_KEY, JSON.stringify(map));
    } catch {
      /* best-effort — durability must never break a run */
    }
  }

  private persist(entry: RunEntry): void {
    if (!entry.workspaceId || !getWorkspaceById(entry.workspaceId)) return;
    const durable = this.readDurable(entry.workspaceId);
    durable[entry.actionId] = {
      state: entry.state,
      oneShot: entry.oneShot,
      endedAt: entry.endedAt,
    };
    this.writeDurable(entry.workspaceId, durable);
  }
}
