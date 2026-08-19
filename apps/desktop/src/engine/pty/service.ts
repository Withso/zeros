// ──────────────────────────────────────────────────────────
// PtyService — engine-owned terminal sessions (for remote clients)
// ──────────────────────────────────────────────────────────
//
// Moves PTY ownership into the engine so an optional remote relay client can
// get a real shell on the host over the bridge. The spawn function is
// injectable (PtySpawnFn) so this whole service is unit-testable WITHOUT
// loading the native node-pty binding — production wires in the real
// node-pty spawn (node-pty-spawn.ts).
//
// Security: the cwd is validated against an allowlist (engine root +
// managed worktrees) before a login shell is forked — a remote client can
// never point a shell at an arbitrary host path. (Remote PTY creation is
// additionally gated by the remote-restriction list at the engine layer — a
// paired device is a trusted operator; there is no per-spawn host prompt.)
//
// Deferred vs the desktop PTY: no reattach-snapshot mirror yet (the
// resilient-resume work is Phase-8/10 territory).
// ──────────────────────────────────────────────────────────

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  worktreesRoot,
  legacyWorktreesRoot,
  listWorkspaces,
  zerosStateRoot,
} from "../git/state";
import { listKnownRepoRoots } from "../db/projects";
import {
  PTY_AGENT_AUTH_CWD,
  type PtyExitReason,
} from "@zeros/protocol/messages";
import type { CloudWorkerIdentity } from "../agents/containment/types";

export interface PtyHandle {
  readonly pid: number;
  /** Fires once when the host reports the real PTY process id. The handle is
   * returned before that asynchronous protocol frame can arrive. */
  onSpawned(cb: (pid: number) => void): void;
  onData(cb: (data: string) => void): void;
  onExit(
    cb: (
      exitCode: number | null,
      signal: number | null,
      reason?: PtyExitReason,
    ) => void,
  ): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnRequest {
  cwd: string;
  cols: number;
  rows: number;
  /** When true, the spawned shell's env is scrubbed of host secrets
   *  (API keys, tokens, connection URLs). Set for shells created on behalf of a
   *  remote client; local shells inherit the full env for parity. */
  scrubEnv?: boolean;
  /** One-shot mode: run this command in a login shell and EXIT when it finishes
   *  (`zsh -l -c "<command>"`), instead of an interactive login shell. The PTY's
   *  exit code is the command's. Used for the background setup script — a real
   *  PTY so output is ANSI-colored, exiting so the caller learns pass/fail. */
  command?: string;
  /** A fully-resolved child env to use VERBATIM (overrides the computed shell
   *  env). Used by one-shot setup so the command runs with the scrubbed setup
   *  allowlist + TERM/COLORTERM, not the interactive-terminal env. */
  env?: Record<string, string>;
  /** One-shot only: run `command` in an INTERACTIVE login shell, so it reads
   *  ~/.zshrc (nvm/fnm/mise/pnpm PATH setup, aliases) exactly like the Terminal
   *  tab. Opt-in because that also imports whatever the user's rc exports —
   *  fine for a user-authored run action, NOT for the repo-resident setup
   *  script, whose whole point is a narrow allowlist. See buildOneShotArgs. */
  interactive?: boolean;
  /** Synchronous, already-prepared process-root wrapper. The PTY host spawns
   * the returned supervisor command directly, so no repository-controlled
   * shell or rc file runs at engine authority before containment. */
  wrapSpawn?: PtySpawnWrapper;
  /** Observe the actual wrapper pid so an execution boundary can own and
   * prove retirement of the PTY process group. */
  onSpawned?: (pid: number) => void;
  /** Dedicated non-root identity for an explicitly human-controlled cloud
   * terminal. Wrapped repo/agent tasks retain the coordinator identity only
   * for the trusted ZSR supervisor, which performs its own mandatory drop. */
  cloudWorkerIdentity?: CloudWorkerIdentity;
  /** Root-controlled util-linux helper paired with cloudWorkerIdentity. */
  cloudWorkerSetprivPath?: string;
}

export interface PtyLaunchRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: "inherit";
}

export type PtySpawnWrapper = (request: PtyLaunchRequest) => PtyLaunchRequest;
export type PtySpawnFn = (req: PtySpawnRequest) => PtyHandle;

export interface PtyCreateOptions {
  sessionId: string;
  cwd?: string;
  /** An already-resolved+validated absolute cwd. When set, create() uses it
   *  verbatim and does NOT re-run resolveCwd — the caller resolved once (e.g.
   *  for an approval prompt) and spawns the exact path it approved (no TOCTOU). */
  resolvedCwd?: string;
  cols?: number;
  rows?: number;
  /** Scrub host secrets from the shell env (set for remote clients). */
  scrubEnv?: boolean;
  /** One-shot mode: run this command then exit (see PtySpawnRequest.command). */
  command?: string;
  /** Verbatim child env (see PtySpawnRequest.env). */
  env?: Record<string, string>;
  /** Interactive one-shot shell (see PtySpawnRequest.interactive). */
  interactive?: boolean;
  /** Prepared ZSR wrapper for repository-controlled commands. */
  wrapSpawn?: PtySpawnWrapper;
  /** Observe the actual wrapper pid reported by the asynchronous PTY host so
   * an execution boundary can adopt and retire the complete process group. */
  onSpawned?: (pid: number) => void;
}
export interface PtyInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  /** True when create() handed back an EXISTING session (reattach) rather than
   *  spawning. The caller fetches a scrollback snapshot() only in this case. */
  reattached?: boolean;
}

/** A serialized reattach snapshot — the resolved screen + bounded scrollback. */
export interface PtyMirrorSnapshot {
  data: string;
  truncated: boolean;
  bytes: number;
}

/** The headless-terminal mirror the engine feeds each PTY's byte stream so a
 *  reattach (refresh / second device) can repaint the exact pre-existing screen.
 *  Injected as a factory so PtyService stays testable WITHOUT loading
 *  @xterm/headless (prod wires the real TerminalMirror from ./mirror). */
export interface PtyMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(maxBytes?: number): Promise<PtyMirrorSnapshot>;
  dispose(): void;
}
export type PtyMirrorFactory = (cols: number, rows: number) => PtyMirror;

export interface PtyServiceOptions {
  /** Attested non-root identity allowed to traverse the repository-free CLI
   * authentication cwd. Omitted on a desktop/relay engine. */
  agentAuthIdentity?: CloudWorkerIdentity;
}

interface Session {
  proc: PtyHandle;
  cwd: string;
  cols: number;
  rows: number;
  /** Per-session scrollback mirror (absent when no factory was injected, e.g.
   *  in unit tests). */
  mirror?: PtyMirror;
}

function coerceDim(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(2, Math.min(500, Math.floor(n)));
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class PtyService {
  private readonly sessions = new Map<string, Session>();
  private readonly exitWaiters = new Map<
    string,
    Set<(observed: boolean) => void>
  >();
  private onDataCb: ((sessionId: string, data: string) => void) | null = null;
  private onExitCb:
    | ((
        sessionId: string,
        exitCode: number | null,
        signal: number | null,
        reason?: PtyExitReason,
      ) => void)
    | null = null;

  constructor(
    private readonly root: string,
    private readonly spawnFn: PtySpawnFn,
    /** Optional scrollback-mirror factory. Prod wires the real TerminalMirror;
     *  tests omit it (sessions then have no mirror and snapshot() is empty). */
    private readonly mirrorFactory?: PtyMirrorFactory,
    private readonly options: PtyServiceOptions = {},
  ) {}

  onData(cb: (sessionId: string, data: string) => void): void {
    this.onDataCb = cb;
  }
  onExit(
    cb: (
      sessionId: string,
      exitCode: number | null,
      signal: number | null,
      reason?: PtyExitReason,
    ) => void,
  ): void {
    this.onExitCb = cb;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Allowed roots for a PTY cwd: the engine root + managed worktrees.
   *
   *  The worktrees root is sourced from the SAME engine state module the rest of
   *  git uses (worktreesRoot() = the VISIBLE ~/zeros[-dev]/workspaces tree the
   *  engine relocates at boot; legacyWorktreesRoot() is the former hidden
   *  ~/.zeros[-dev]/worktrees tree) — NOT a hardcoded path. Hardcoding only the
   *  legacy hidden root made every relocated worktree fail isWithin(), so a
   *  remote terminal silently fell back to the engine root and a remote agent
   *  cwd-clamp hard-rejected. Both roots are included, and they are dev-aware
   *  (zerosStateRoot keys off ZEROS_DEV) + honour the test root override.
   *
   *  Each root is realpath-resolved so a symlinked root (e.g. a symlinked
   *  $HOME on macOS, where /var → /private/var) still matches a
   *  realpath-resolved cwd in resolveCwd — otherwise a legitimate cwd would
   *  silently fall back to the engine root. */
  private allowedRoots(): string[] {
    const roots = [this.root, worktreesRoot(), legacyWorktreesRoot()];
    // Also trust every engine-tracked workspace path AND its repoRoot. A LOCAL
    // desktop terminal can be opened in ANY managed project — a worktree OUTSIDE
    // the standard root, a tree adopted from another tool, or a primary checkout
    // whose repoRoot isn't under worktreesRoot — and must land in that dir, not
    // fall back to the engine root. (The desktop terminal is engine-owned, so
    // this PtyService allowlist is the sole cwd gate. Remote clients still
    // resolve their cwd from a managed workspaceId server-side, so this widens
    // LOCAL parity without granting a remote client any new path.) Best-effort:
    // a missing state DB falls back to the static roots above.
    try {
      for (const ws of listWorkspaces()) {
        if (ws.path) roots.push(ws.path);
        if (ws.repoRoot) roots.push(ws.repoRoot);
      }
    } catch {
      /* state.db unavailable — static roots only */
    }
    // Also trust every REGISTERED project root, even one with no worktree yet.
    // Adding a repo no longer respawns the engine to re-root at it (the engine
    // stays put and serves the new repo over the bridge), so a terminal opened
    // in a just-added repo's root ("Local main") would otherwise not match any
    // workspace path above and silently fall back to the engine root. The repos
    // table is the source of truth for "folders the user opened". Read-only.
    try {
      for (const root of listKnownRepoRoots()) roots.push(root);
    } catch {
      /* zeros.db unavailable — workspace + static roots only */
    }
    return roots.map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return r; // not yet created / broken symlink — compare literally
      }
    });
  }

  /** Resolve + validate a requested cwd against the allowlist. Public so the
   *  engine can surface the ACTUAL resolved cwd in a remote approval prompt
   *  (the operator approves the path that will really be used, not the raw
   *  client-supplied string). */
  resolveCwd(input?: string): string {
    const fallback = this.root || os.homedir();
    const raw = typeof input === "string" ? input.trim() : "";
    if (raw === PTY_AGENT_AUTH_CWD) {
      // Hidden CLI authentication must never inherit a repository cwd: Claude
      // asks whether to trust project files before showing /login. This
      // app-owned directory has no project ancestors, so accepting that prompt
      // cannot enable repository-controlled settings or hooks.
      const authCwd = path.join(zerosStateRoot(), "agent-auth");
      try {
        fs.mkdirSync(authCwd, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(authCwd);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("agent sign-in path is not a physical directory");
        }
        const identity = this.options.agentAuthIdentity;
        if (identity) {
          const ownerUid = process.geteuid?.();
          const ownerGid = process.getegid?.();
          if (
            process.platform !== "linux" ||
            ownerUid === undefined ||
            ownerGid === undefined ||
            !Number.isSafeInteger(identity.uid) ||
            identity.uid <= 0 ||
            !Number.isSafeInteger(identity.gid) ||
            identity.gid <= 0 ||
            (ownerUid !== 0 &&
              (identity.uid !== ownerUid ||
                (identity.gid !== ownerGid &&
                  !(process.getgroups?.() ?? []).includes(identity.gid))))
          ) {
            throw new Error("agent sign-in identity is invalid");
          }
          // Root keeps ownership; the image's dedicated worker group receives
          // read/traverse only. The CLI persists credentials under its worker
          // HOME, not in this repository-free cwd.
          fs.chownSync(authCwd, ownerUid, identity.gid);
          fs.chmodSync(authCwd, 0o750);
        } else {
          fs.chmodSync(authCwd, 0o700);
        }
        return fs.realpathSync(authCwd);
      } catch {
        // Failing closed is safer than silently returning the engine/project
        // root for a trust-sensitive authentication shell.
        throw new Error(
          "Could not create the isolated agent sign-in directory",
        );
      }
    }
    if (!raw || !fs.existsSync(raw)) return fallback;
    try {
      if (!fs.statSync(raw).isDirectory()) return fallback;
    } catch {
      return fallback;
    }
    let real = raw;
    try {
      real = fs.realpathSync(raw);
    } catch {
      /* broken symlink — use raw */
    }
    for (const root of this.allowedRoots()) {
      if (isWithin(root, real)) return real;
    }
    return fallback;
  }

  /** True when an existing absolute dir sits within the allowlist (engine
   *  root + managed worktrees). Lets the agent-session path clamp a remote
   *  client's workspace cwd to the SAME boundary the PTY enforces — defence in
   *  depth on top of resolving the cwd server-side from a managed workspaceId.
   *  Fails closed: a nonexistent / unreadable path is rejected. */
  isWithinAllowed(cwd: string): boolean {
    if (typeof cwd !== "string" || cwd.length === 0) return false;
    let real: string;
    try {
      real = fs.realpathSync(cwd);
    } catch {
      return false;
    }
    for (const root of this.allowedRoots()) {
      if (isWithin(root, real)) return true;
    }
    return false;
  }

  /** Spawn (or reattach to) a PTY. Reattach returns the live session's info. */
  create(opts: PtyCreateOptions): PtyInfo {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) {
      // Reattach: reconcile the live PTY (and its mirror) to the attaching
      // client's dims so the scrollback snapshot is produced at the width the
      // client's xterm will render it at, then hand back the live session. The
      // caller fetches the snapshot via snapshot() (async) when reattached.
      const cols = coerceDim(opts.cols, existing.cols);
      const rows = coerceDim(opts.rows, existing.rows);
      if (cols !== existing.cols || rows !== existing.rows) {
        try {
          existing.proc.resize(cols, rows);
          existing.cols = cols;
          existing.rows = rows;
        } catch {
          /* pty already exited — leave dims as-is */
        }
      }
      existing.mirror?.resize(existing.cols, existing.rows);
      return {
        sessionId: opts.sessionId,
        pid: existing.proc.pid,
        cwd: existing.cwd,
        cols: existing.cols,
        rows: existing.rows,
        reattached: true,
      };
    }
    const cwd = opts.resolvedCwd ?? this.resolveCwd(opts.cwd);
    const cols = coerceDim(opts.cols, 80);
    const rows = coerceDim(opts.rows, 24);
    const proc = this.spawnFn({
      cwd,
      cols,
      rows,
      scrubEnv: opts.scrubEnv === true,
      command: opts.command,
      env: opts.env,
      interactive: opts.interactive === true,
      wrapSpawn: opts.wrapSpawn,
    });
    const mirror = this.mirrorFactory?.(cols, rows);
    const session: Session = { proc, cwd, cols, rows, mirror };
    this.sessions.set(opts.sessionId, session);

    if (opts.onSpawned) proc.onSpawned(opts.onSpawned);

    proc.onData((data) => {
      // Feed the mirror the EXACT bytes clients get so its resolved grid stays
      // in lockstep — that grid is what we serialize on reattach.
      session.mirror?.write(data);
      this.onDataCb?.(opts.sessionId, data);
    });
    proc.onExit((exitCode, signal, reason) => {
      session.mirror?.dispose();
      this.sessions.delete(opts.sessionId);
      const waiters = this.exitWaiters.get(opts.sessionId);
      if (waiters) {
        this.exitWaiters.delete(opts.sessionId);
        for (const settle of waiters) settle(true);
      }
      this.onExitCb?.(opts.sessionId, exitCode, signal, reason);
    });

    return {
      sessionId: opts.sessionId,
      pid: proc.pid,
      cwd,
      cols,
      rows,
      reattached: false,
    };
  }

  /** A clean reattach snapshot of a live session's resolved screen + bounded
   *  scrollback (serialized escape sequences to write verbatim into a fresh
   *  same-size xterm). Null when the session is unknown or has no mirror (e.g.
   *  no factory was injected). Never throws — the mirror caps + degrades the
   *  payload internally. */
  async snapshot(sessionId: string): Promise<PtyMirrorSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session?.mirror) return null;
    return session.mirror.snapshot();
  }

  write(sessionId: string, data: string): void {
    // A malformed/hostile remote frame can carry a non-string payload; node-pty
    // throws on anything but a string. Guard the type, not just truthiness.
    if (typeof data !== "string" || data.length === 0) return;
    this.sessions.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const c = coerceDim(cols, s.cols);
    const r = coerceDim(rows, s.rows);
    if (c === s.cols && r === s.rows) return;
    try {
      s.proc.resize(c, r);
      s.cols = c;
      s.rows = r;
      // Keep the mirror grid the same size as the live PTY so its resolved
      // state (and any reattach snapshot) matches.
      s.mirror?.resize(c, r);
    } catch {
      /* pty already exited */
    }
  }

  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      /* already exiting */
    }
    // onExit also disposes, but kill may not always fire it — drop the mirror
    // grid now so it can't leak. dispose() is idempotent.
    s.mirror?.dispose();
    this.sessions.delete(sessionId);
  }

  /** Register BEFORE asking a manager to stop a PTY, then await the host's real
   * exit notification. `kill()` intentionally drops the renderer mirror
   * immediately, but archive/delete must not remove a cwd while its process
   * group can still write into it. False means the bounded wait elapsed; the
   * host kill path has already escalated to the process group. */
  waitForExit(sessionId: string, timeoutMs = 2_500): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (observed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.exitWaiters.get(sessionId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.exitWaiters.delete(sessionId);
        resolve(observed);
      };
      const waiters = this.exitWaiters.get(sessionId) ?? new Set();
      waiters.add(finish);
      this.exitWaiters.set(sessionId, waiters);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    });
  }

  list(): PtyInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      pid: s.proc.pid,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
    }));
  }

  killAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      s.mirror?.dispose();
    }
    this.sessions.clear();
    for (const waiters of this.exitWaiters.values()) {
      for (const settle of waiters) settle(false);
    }
    this.exitWaiters.clear();
  }
}
