
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
import { LoginShellPathUnavailableError } from "../agents/adapters/shared/login-shell-path";
import { createShellPathRecovery } from "./shell-path-recovery";

export interface PtyHandle {
  readonly pid: number;
  /** The subprocess reports the real PID after returning the handle. */
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
  /** Scrub the inherited environment for remote shells; Local shells keep the normal environment. */
  scrubEnv?: boolean;
  /** One-shot commands use a login shell and report the command's exit status. */
  command?: string;
  /** An explicit environment replaces the computed shell environment, including scrubbing. */
  env?: Record<string, string>;
  /** Run opts into interactive startup for Terminal parity; Setup does not, because startup files could widen its scrubbed environment. */
  interactive?: boolean;
  /** The prepared supervisor must establish ownership before repository shell startup. */
  wrapSpawn?: PtySpawnWrapper;
  /** Use the wrapper's actual PID to prove process-group retirement. */
  onSpawned?: (pid: number) => void;
  /** @deprecated Historical internal worker metadata. New cloud terminals
   * inherit the engine identity through their original prepared Host scope. */
  cloudWorkerIdentity?: CloudWorkerIdentity;
  /** @deprecated Historical helper path; new launches never execute it. */
  cloudWorkerSetprivPath?: string;
}

export interface PtyLaunchRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: "inherit";
  /** Trusted wrapper argv slot rebound by the Node PTY host at spawn time. */
  immediateParentPidArgIndex?: number;
}

export type PtySpawnWrapper = (request: PtyLaunchRequest) => PtyLaunchRequest;
export type PtySpawnFn = (req: PtySpawnRequest) => PtyHandle;

export interface PtyCreateOptions {
  sessionId: string;
  cwd?: string;
  /** Only trusted callers supply an already validated cwd; don't re-resolve the path chosen at approval. */
  resolvedCwd?: string;
  cols?: number;
  rows?: number;
  scrubEnv?: boolean;
  command?: string;
  env?: Record<string, string>;
  interactive?: boolean;
  /** Local Setup/Run only; retry a positively unstarted command once. */
  recoverShellPath?: boolean;
  wrapSpawn?: PtySpawnWrapper;
  /** Expose the PID and native-exit witness for this exact launch attempt. */
  onSpawned?: (pid: number, leaderExited: () => boolean) => void;
  /** Positive native no-child witness, distinct from a lost host. */
  onSpawnFailed?: (reason: PtyExitReason) => void;
  /** Captured original lifecycle owner, not a later session-id lookup. */
  onExit?: () => void;
}
export interface PtyInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  /** Only on reattach should the client request existing scrollback. */
  reattached?: boolean;
}

export interface PtyMirrorSnapshot {
  data: string;
  truncated: boolean;
  bytes: number;
}

export interface PtyMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(maxBytes?: number): Promise<PtyMirrorSnapshot>;
  dispose(): void;
}
export type PtyMirrorFactory = (cols: number, rows: number) => PtyMirror;

export interface PtyServiceOptions {
  now?: () => number;
  /** Enables repository-free auth cwd identity checks and cloud input accounting. */
  agentAuthIdentity?: CloudWorkerIdentity;
}

interface Session {
  cancelPathRecovery?: () => void;
  stopped?: boolean;
  lastInputAt?: number;
  proc: PtyHandle;
  cwd: string;
  cols: number;
  rows: number;
  mirror?: PtyMirror;
}

export function coerceDim(value: unknown, fallback: number): number {
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

  /** Keep legacy worktree roots accepted and compare real paths on both sides, including symlinked home directories. */
  private allowedRoots(): string[] {
    const roots = [this.root, worktreesRoot(), legacyWorktreesRoot()];
    // Tracked roots let Local terminals open managed paths outside the default tree; new remote terminals still fail closed unless their workspace ID or path resolves inside this allowlist.
    try {
      for (const ws of listWorkspaces()) {
        if (ws.path) roots.push(ws.path);
        if (ws.repoRoot) roots.push(ws.repoRoot);
      }
    } catch {
      /* state.db unavailable — static roots only */
    }
    // A registered checkout needs terminal access before it has any managed worktree.
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

  /** Remote approval must display the resolved cwd, not the raw request. */
  resolveCwd(input?: string): string {
    const fallback = this.root || os.homedir();
    const raw = typeof input === "string" ? input.trim() : "";
    if (raw === PTY_AGENT_AUTH_CWD) {
      // Keep CLI sign-in outside repositories so startup cannot enable repository settings or hooks.
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
            identity.uid < 0 ||
            !Number.isSafeInteger(identity.gid) ||
            identity.gid < 0 || identity.uid !== ownerUid || identity.gid !== ownerGid
          ) {
            throw new Error("agent sign-in identity is invalid");
          }
          // Same-user agents share this ordinary engine directory. Their
          // selected HOME separates state; it is not an agent sandbox.
          if (stat.uid !== ownerUid) throw new Error("agent sign-in owner is invalid");
          fs.chmodSync(authCwd, 0o700);
        } else {
          fs.chmodSync(authCwd, 0o700);
        }
        return fs.realpathSync(authCwd);
      } catch {
        // Never fall back to a project directory for CLI sign-in.
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

  /** The remote agent path reuses this cwd boundary as a fail-closed check. */
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

  create(opts: PtyCreateOptions): PtyInfo {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) {
      // Match the reattaching client's dimensions before serializing a snapshot.
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
    const recovery = opts.recoverShellPath && opts.command && opts.env
      ? createShellPathRecovery(opts.command, opts.env) : null;
    const request: PtySpawnRequest = {
      cwd,
      cols,
      rows,
      scrubEnv: opts.scrubEnv === true,
      command: recovery?.command ?? opts.command,
      env: opts.env,
      interactive: opts.interactive === true,
      wrapSpawn: opts.wrapSpawn,
    };
    const proc = this.spawnFn(request);
    const mirror = this.mirrorFactory?.(cols, rows);
    const session: Session = { proc, cwd, cols, rows, mirror };
    this.sessions.set(opts.sessionId, session);
    let finished = false;
    const publishData = (data: string) => {
      if (!data || this.sessions.get(opts.sessionId) !== session) return;
      session.mirror?.write(data);
      this.onDataCb?.(opts.sessionId, data);
    };
    const finish = (exitCode: number | null, signal: number | null, reason?: PtyExitReason) => {
      if (finished) return;
      finished = true;
      session.cancelPathRecovery = undefined;
      publishData(recovery?.flush() ?? "");
      session.mirror?.dispose();
      const current = this.sessions.get(opts.sessionId);
      if (current && current !== session) return;
      this.sessions.delete(opts.sessionId);
      const waiters = this.exitWaiters.get(opts.sessionId);
      if (waiters) {
        this.exitWaiters.delete(opts.sessionId);
        for (const settle of waiters) settle(true);
      }
      this.onExitCb?.(opts.sessionId, exitCode, signal, reason);
    };
    const bind = (attempt: PtyHandle) => {
      let leaderExited = false;
      if (opts.onSpawned) attempt.onSpawned((pid) => opts.onSpawned?.(pid, () => leaderExited));
      attempt.onData((data) => {
        if (session.proc === attempt && !finished)
          publishData(recovery ? recovery.filterData(data) : data);
      });
      attempt.onExit((exitCode, signal, reason) => {
        if (leaderExited) return;
        leaderExited = true;
        // Each attempt retains its own native exit witness for process cleanup.
        try { if (!attempt.pid && (reason === "spawn-failed" || reason === "host-unavailable")) opts.onSpawnFailed?.(reason); } catch { /* Owner retains the original pending launch. */ }
        try { opts.onExit?.(); } catch { /* Owner retains the original retirement. */ }
        if (session.stopped || this.sessions.get(opts.sessionId) !== session || !recovery?.canRetry(exitCode, signal)) {
          finish(exitCode, signal, reason);
          return;
        }
        session.cancelPathRecovery = () => finish(exitCode, signal, reason);
        void recovery.retry().then((retry) => {
          if (finished || session.stopped || this.sessions.get(opts.sessionId) !== session) return;
          session.cancelPathRecovery = undefined;
          session.proc = this.spawnFn({ ...request, ...retry, cols: session.cols, rows: session.rows });
          bind(session.proc);
        }).catch((error: unknown) => {
          if (finished || session.stopped || this.sessions.get(opts.sessionId) !== session) return;
          if (error instanceof LoginShellPathUnavailableError)
            publishData(`\r\n${error.message}\r\n`);
          finish(exitCode, signal, reason);
        });
      });
    };
    bind(proc);

    return {
      sessionId: opts.sessionId,
      pid: proc.pid,
      cwd,
      cols,
      rows,
      reattached: false,
    };
  }

  /** Replay the serialized screen into a fresh xterm of the same size. */
  async snapshot(sessionId: string): Promise<PtyMirrorSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session?.mirror) return null;
    return session.mirror.snapshot();
  }

  write(sessionId: string, data: string): void {
    // Malformed remote frames may carry non-strings that node-pty rejects.
    if (typeof data !== "string" || data.length === 0) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.proc.write(data);
      if (this.options.agentAuthIdentity) session.lastInputAt = (this.options.now ?? (() => performance.now()))();
    }
  }

  /** Only input to a live PTY renews recency, not output or reattach. */
  hasRecentInput(): boolean {
    if (!this.options.agentAuthIdentity) return false;
    const now = (this.options.now ?? (() => performance.now()))();
    return [...this.sessions.values()].some(session => session.lastInputAt !== undefined && now - session.lastInputAt < 10 * 60_000);
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
      s.mirror?.resize(c, r);
    } catch {
      /* pty already exited */
    }
  }

  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.stopped = true;
    s.cancelPathRecovery?.();
    try {
      s.proc.kill();
    } catch {
      /* already exiting */
    }
    // Dispose here as well as onExit: a killed PTY may never report exit.
    s.mirror?.dispose();
    this.sessions.delete(sessionId);
  }

  /** Register before kill removes the session. A timed-out wait does not prove the terminal process group retired. */
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
      s.stopped = true;
      s.cancelPathRecovery?.();
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
