// ──────────────────────────────────────────────────────────
// RunManager — run-action status engine (the Setup blueprint, applied to Run)
// ──────────────────────────────────────────────────────────
//
// Owns the lifecycle + verdict of every run-action PTY (`pty-run-…` ids):
//
//   • start()      — spawns the action's command as the PTY's FOREGROUND
//                    process (one-shot `zsh -l -c`, like Setup) so the PTY's
//                    exit code IS the command's. The renderer then ATTACHES to
//                    the session with its normal TerminalSessionView (reattach
//                    + mirror replay), so the log lives in the terminal itself
//                    — no separate buffer here, unlike SetupManager.
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
import { isRunSessionId } from "@zeros/core/run-actions";
import {
  getWorkspaceById,
  getWorkspaceMeta,
  setWorkspaceMeta,
} from "../git/state";

export type RunState = "running" | "finished" | "failed" | "stopped";

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

  constructor(
    private readonly pty: PtyService,
    /** Nudge clients (DB_CHANGED{workspaces}) that a run's state changed. */
    private readonly onChange: (workspaceId: string | null) => void,
    /** Register a freshly-spawned run terminal in the SHARED terminal registry
     *  (so every device's tab strip discovers it, like a renderer-spawned
     *  terminal). Wired by the engine; optional for unit tests. */
    private readonly registerTerminal?: (sessionId: string, cwd: string) => void,
  ) {}

  /** Start (or focus) a run. Returns alreadyRunning=true — without spawning —
   *  when the action's PTY is still alive; the caller just focuses its tab. */
  async start(args: RunStartArgs): Promise<{ alreadyRunning: boolean }> {
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

  /** Stop every live run belonging to a workspace — the archive/delete
   *  reaper: a run PTY left alive would keep writing into (and can partially
   *  resurrect) the worktree folder the engine is about to remove. */
  stopAllForWorkspace(workspaceId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.workspaceId === workspaceId && entry.state === "running") {
        this.stop(sessionId);
      }
    }
  }

  /** Flip the state machine on the run PTY's exit (no-op for other sessions).
   *  A run stop()/start()ed in between has already settled its state — the
   *  late exit only releases the respawn guard. */
  handleExit(sessionId: string, exitCode: number | null): void {
    if (!isRunSessionId(sessionId)) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.state === "running") {
      this.setState(
        entry,
        entry.stopRequested
          ? "stopped"
          : entry.oneShot
            ? exitCode === 0
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
