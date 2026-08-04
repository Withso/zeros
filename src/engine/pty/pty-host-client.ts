// ──────────────────────────────────────────────────────────
// PTY host client — engine-side driver for the Node PTY subprocess
// ──────────────────────────────────────────────────────────
//
// The engine runs under bun, where node-pty's PTY I/O is broken (spawns a pid
// but emits no data — see pty-host.cjs for the full story). So instead of
// loading node-pty in-process, the engine spawns a tiny **Node** subprocess
// (pty-host.cjs) that owns every node-pty shell, and talks to it over stdio
// with a newline-delimited JSON protocol (PTY bytes base64-encoded).
//
// This module is the bun-side half: it lazily spawns the host, multiplexes all
// sessions over the one child, and hands `PtyService` a `PtyHandle` per shell
// that looks exactly like a direct node-pty handle. PtyService, the scrollback
// mirror, the shared-terminal registry, and the remote approval gates are all
// unchanged — only the spawn boundary moved out of process.
//
// Runtime resolution (set by electron/sidecar.ts; falls back for a
// source/standalone engine with no Electron host):
//   - ZEROS_PTY_HOST_RUNTIME           binary that runs the host (the Electron
//                                      app binary, run as Node) — else `node`.
//   - ZEROS_PTY_HOST_RUNTIME_ELECTRON  "1" ⇒ add ELECTRON_RUN_AS_NODE=1.
//   - ZEROS_PTY_HOST_SCRIPT            absolute path to pty-host.cjs — else the
//                                      sibling .cjs (source mode).
//   - ZEROS_PTY_NODE_PTY               absolute, ABI-matching node-pty path,
//                                      forwarded to the host (see pty-host.cjs).
//
// One shared host owns all sessions. If it dies unexpectedly every live session
// gets a reasoned synthetic exit; the next spawn can lazily respawn a transiently
// lost host, while an unloadable/missing host is surfaced as non-restartable.
// A host that keeps dying at boot (broken node-pty) additionally trips a
// crash-loop hold-off (see the guard below) so a terminal open can't
// machine-gun doomed Node children.
// ──────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PtyHandle } from "./service";
import type { PtyExitReason } from "@zeros/core/messages";

export interface PtyHostSpawnSpec {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Fully-resolved child env (Zeros ZDOTDIR, scrub allowlist, per-worktree
   *  PWD) — computed engine-side by shell-setup and passed through verbatim. */
  env: Record<string, string>;
  name?: string;
}

interface SessionEntry {
  pid: number;
  dataCbs: Array<(data: string) => void>;
  exitCbs: Array<
    (
      exitCode: number | null,
      signal: number | null,
      reason?: PtyExitReason,
    ) => void
  >;
  /** Set when the host reports that node-pty threw before a shell existed. */
  spawnFailed: boolean;
  exited: boolean;
}

/** Resolve the absolute path to pty-host.cjs. */
function resolveHostScript(): string | null {
  const explicit = process.env.ZEROS_PTY_HOST_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;
  // Source mode (e.g. `bun src/cli.ts` with no Electron host): the .cjs sits
  // next to this module. import.meta.url is a real file URL there; in a
  // bun-compiled binary fileURLToPath throws, so this is best-effort.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.join(here, "pty-host.cjs");
    if (existsSync(sibling)) return sibling;
  } catch {
    /* compiled binary — no source path on disk */
  }
  return null;
}

/** Resolve the runtime binary that runs the host (must be a real Node, not
 *  bun). The Electron app binary works when run with ELECTRON_RUN_AS_NODE=1. */
function resolveRuntime(): { cmd: string; electron: boolean } {
  const explicit = process.env.ZEROS_PTY_HOST_RUNTIME;
  if (explicit && explicit.length > 0) {
    return {
      cmd: explicit,
      electron: process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1",
    };
  }
  // Standalone/source fallback: assume `node` is on PATH.
  return { cmd: "node", electron: false };
}

// ── Crash-loop guard ──────────────────────────────────────
// Mirrors the Cursor host's guard (agents/adapters/cursor-sdk/host/host-client.ts):
// a host that dies EARLY (before its `ready` line, or within this window of
// spawn) is probably doomed — a broken/missing node-pty build, a bad runtime
// path. Without a hold-off, onHostGone's reset meant EVERY terminal open
// respawned a fresh Node child just to watch it die again.
/** Deaths within this many ms of spawn count as "early" (boot crashes). */
const EARLY_DEATH_WINDOW_MS = 5_000;
/** Exponential respawn hold-off after repeated early deaths (2nd: 1s, 3rd: 2s,
 *  …, capped). While held off, spawn() fails fast with the synthetic
 *  "host-unavailable" exit (the renderer's restart hint) instead of booting a
 *  doomed child. A `fatal`-preceded death (node-pty unloadable — a respawn
 *  fails identically) is held off from its FIRST death; a plain early crash
 *  gets one free immediate respawn so a one-off boot blip still heals. */
const RESPAWN_BACKOFF_BASE_MS = 1_000;
const RESPAWN_BACKOFF_CAP_MS = 30_000;
/** Ceiling for a partial (un-newline-terminated) protocol line — see onStdout. */
const MAX_PARTIAL_LINE_CHARS = 32 * 1024 * 1024;

class PtyHost {
  private child: ChildProcess | null = null;
  private buf = "";
  private readonly entries = new Map<string, SessionEntry>();
  private nextId = 1;
  /** Latches once we've logged that the host couldn't be located/spawned, so
   *  we don't spam the log on every terminal the user opens. */
  private spawnFailed = false;
  /** The host started but reported that node-pty itself could not be loaded. */
  private fatalFailure = false;
  /** Ready-line gate for the crash-loop guard: a death before the host's
   *  `ready` line is always a boot crash regardless of timing. */
  private sawReady = false;
  private spawnedAt = 0;
  /** Consecutive deaths before the host proved healthy (`ready` seen AND
   *  ≥ EARLY_DEATH_WINDOW_MS uptime). A healthy death resets it. */
  private consecutiveEarlyDeaths = 0;
  /** Respawn hold-off deadline (ms epoch). While in the future, ensure()
   *  refuses to spawn, so sessions fail fast with "host-unavailable". */
  private respawnBlockedUntil = 0;

  /** Test-only: ms until the crash-loop hold-off allows the next respawn
   *  (0 = not held off). */
  respawnHoldOffMs(): number {
    return Math.max(0, this.respawnBlockedUntil - Date.now());
  }

  /** Lazily (re)spawn the host subprocess. No-op if one is already running. */
  private ensure(): void {
    if (this.child) return;
    // Crash-loop hold-off: leave `child` null so spawn() flushes the synthetic
    // "host-unavailable" exit without booting another doomed Node child.
    if (Date.now() < this.respawnBlockedUntil) return;
    const script = resolveHostScript();
    if (!script) {
      if (!this.spawnFailed) {
        this.spawnFailed = true;
        console.error(
          "[pty-host] cannot locate pty-host.cjs (set ZEROS_PTY_HOST_SCRIPT) — terminals unavailable",
        );
      }
      return;
    }
    const { cmd, electron } = resolveRuntime();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    if (electron) env.ELECTRON_RUN_AS_NODE = "1";

    let child: ChildProcess;
    try {
      child = spawn(cmd, [script], { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      if (!this.spawnFailed) {
        this.spawnFailed = true;
        console.error(
          `[pty-host] failed to spawn host runtime (${cmd}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }
    this.child = child;
    this.spawnFailed = false;
    this.fatalFailure = false;
    this.sawReady = false;
    this.spawnedAt = Date.now();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const s = String(chunk).replace(/\s+$/, "");
      if (s) console.error(`[pty-host] ${s}`);
    });
    // Guard every lifecycle handler against the CURRENT child: a previous
    // child's delayed `close`/`error` (e.g. after a dispose+respawn) must not
    // clobber the freshly-spawned one and orphan it.
    child.on("error", (err) => {
      if (this.child !== child) return;
      console.error(`[pty-host] runtime error: ${err.message}`);
      this.onHostGone(null, "host-unavailable");
    });
    // `close` is guaranteed to run after stdout/stderr close, unlike `exit`.
    // Fatal protocol output must be parsed before we classify why the host died.
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.onHostGone(
        typeof code === "number" ? code : signal ? 128 : null,
        this.fatalFailure ? "host-unavailable" : "host-lost",
      );
    });
  }

  /** Fire a session's exit callbacks exactly once. */
  private flushExit(
    entry: SessionEntry,
    code: number | null,
    signal: number | null,
    reason?: PtyExitReason,
  ): void {
    if (entry.exited) return;
    entry.exited = true;
    for (const cb of entry.exitCbs) {
      try {
        cb(code, signal, reason);
      } catch {
        /* listener threw — ignore */
      }
    }
  }

  /** The host process vanished unexpectedly: synthesize an exit for every
   *  still-live session and reset so the next spawn respawns the host — unless
   *  the crash-loop accounting below decides the host is doomed and holds the
   *  respawn off (bounded exponential; ensure() enforces the deadline). */
  private onHostGone(code: number | null, reason: PtyExitReason): void {
    this.child = null;
    this.buf = "";
    const fatal = this.fatalFailure;
    this.fatalFailure = false;
    // Crash-loop accounting (mirrors the Cursor host). A death before the
    // ready line, or within the early window of spawn, counts toward the
    // loop; a death after a healthy run resets it (a long-lived host crashing
    // once is a blip, not a loop). A fatal-preceded death engages the
    // hold-off IMMEDIATELY — node-pty is unloadable, so a free retry would
    // just boot another doomed child.
    const uptime = Date.now() - this.spawnedAt;
    const early = !this.sawReady || uptime < EARLY_DEATH_WINDOW_MS;
    if (early) {
      this.consecutiveEarlyDeaths += 1;
      const holdOff = fatal || this.consecutiveEarlyDeaths >= 2;
      const holdOffMs = holdOff
        ? Math.min(
            RESPAWN_BACKOFF_CAP_MS,
            RESPAWN_BACKOFF_BASE_MS *
              2 **
                Math.max(0, this.consecutiveEarlyDeaths - (fatal ? 1 : 2)),
          )
        : 0;
      this.respawnBlockedUntil = holdOff ? Date.now() + holdOffMs : 0;
      if (holdOff) {
        console.error(
          `[pty-host] host died at boot (${this.consecutiveEarlyDeaths}x in a row` +
            `${fatal ? ", node-pty unloadable" : ""}) — holding off respawn for ` +
            `${Math.ceil(holdOffMs / 1000)}s`,
        );
      }
    } else {
      this.consecutiveEarlyDeaths = 0;
      this.respawnBlockedUntil = 0;
    }
    const survivors = [...this.entries.values()];
    this.entries.clear();
    for (const e of survivors) this.flushExit(e, code, null, reason);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) this.dispatch(line);
      nl = this.buf.indexOf("\n");
    }
    // A newline never arriving (host wedged mid-write, binary garbage on
    // stdout) would otherwise grow this partial-line buffer without bound.
    // Legit frames are far below this cap — a 24-row PTY data frame is tens of
    // KB — so past it the line is already unparseable; drop it rather than let
    // the engine's memory follow a broken host.
    if (this.buf.length > MAX_PARTIAL_LINE_CHARS) {
      console.error(
        `[pty-host] dropped ${this.buf.length}-char partial protocol line (no newline)`,
      );
      this.buf = "";
    }
  }

  private dispatch(line: string): void {
    let m: Record<string, unknown> | null = null;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m.t !== "string") return;
    const t = m.t;
    if (t === "ready") {
      // Crash-loop gate: the host booted far enough to load node-pty. A death
      // before this line is always an "early" (boot) crash regardless of timing.
      this.sawReady = true;
      return;
    }
    if (t === "fatal") {
      this.fatalFailure = true;
      console.error(`[pty-host] fatal: ${String(m.message ?? "")}`);
      return;
    }
    const id = typeof m.id === "string" ? m.id : String(m.id ?? "");
    const entry = this.entries.get(id);
    if (!entry) return;
    switch (t) {
      case "spawned":
        entry.pid = typeof m.pid === "number" ? m.pid : 0;
        return;
      case "data": {
        if (typeof m.data !== "string") return;
        const s = Buffer.from(m.data, "base64").toString("utf8");
        for (const cb of entry.dataCbs) {
          try {
            cb(s);
          } catch {
            /* listener threw — ignore */
          }
        }
        return;
      }
      case "error":
        entry.spawnFailed = true;
        console.error(
          `[pty-host] session ${id} error: ${String(m.message ?? "")}`,
        );
        return;
      case "exit": {
        this.entries.delete(id);
        if (entry.exited) return;
        entry.exited = true;
        const exitCode = typeof m.exitCode === "number" ? m.exitCode : null;
        const signal = typeof m.signal === "number" ? m.signal : null;
        for (const cb of entry.exitCbs) {
          try {
            cb(
              exitCode,
              signal,
              entry.spawnFailed ? "spawn-failed" : undefined,
            );
          } catch {
            /* listener threw — ignore */
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Write one protocol message to the host. No-op if the host isn't up — the
   *  caller (write/resize/kill on a dead session) just drops the message. */
  private writeMsg(msg: unknown): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      /* pipe broke — onHostGone will reconcile */
    }
  }

  spawn(spec: PtyHostSpawnSpec): PtyHandle {
    this.ensure();
    const id = String(this.nextId++);
    const entry: SessionEntry = {
      pid: 0,
      dataCbs: [],
      exitCbs: [],
      spawnFailed: false,
      exited: false,
    };
    this.entries.set(id, entry);

    // Ordering: NDJSON over one pipe preserves order, and the host spawns
    // synchronously (node-pty.spawn is sync) before reading the next line — so
    // a `write` sent right after this `spawn` is guaranteed to find the session.
    this.writeMsg({
      t: "spawn",
      id,
      shell: spec.shell,
      args: spec.args,
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
      name: spec.name ?? "xterm-256color",
    });

    // If the host couldn't be spawned at all — including a crash-loop
    // hold-off, where ensure() deliberately refuses to boot another doomed
    // child — fail closed: report an immediate exit so the renderer shows the
    // restart hint rather than a silent blank. Deferred to a microtask so the
    // caller can register its onExit handler (PtyService binds it
    // synchronously right after this returns).
    if (!this.child) {
      this.entries.delete(id);
      queueMicrotask(() =>
        this.flushExit(entry, null, null, "host-unavailable"),
      );
    }

    return {
      get pid() {
        return entry.pid;
      },
      onData: (cb) => {
        entry.dataCbs.push(cb);
      },
      onExit: (cb) => {
        entry.exitCbs.push(cb);
      },
      write: (data) => {
        this.writeMsg({
          t: "write",
          id,
          data: Buffer.from(data, "utf8").toString("base64"),
        });
      },
      resize: (cols, rows) => {
        this.writeMsg({ t: "resize", id, cols, rows });
      },
      kill: () => {
        this.writeMsg({ t: "kill", id });
      },
    };
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.buf = "";
    this.fatalFailure = false;
    // Intentional teardown (engine stop / test cleanup), not a crash: the
    // close handler's child guard keeps this out of onHostGone, and any
    // earlier crash-loop hold-off is reset so a later fresh start (a restarted
    // engine embedding, the next test) isn't blocked by a previous life.
    this.sawReady = false;
    this.consecutiveEarlyDeaths = 0;
    this.respawnBlockedUntil = 0;
    // Flush a synthetic exit for any still-live session so listeners
    // (PtyService → PTY_EXIT broadcast + shared-terminal registry) are
    // notified and nothing is left dangling.
    const survivors = [...this.entries.values()];
    this.entries.clear();
    for (const e of survivors) this.flushExit(e, null, null, "host-lost");
    if (child && !child.killed) {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }
}

const host = new PtyHost();

/** Spawn a PTY shell via the Node host subprocess. Drop-in for a direct
 *  node-pty spawn — returns the same `PtyHandle` contract. */
export function spawnPtyViaHost(spec: PtyHostSpawnSpec): PtyHandle {
  return host.spawn(spec);
}

/** Tear down the host subprocess (and every shell it owns). Called from the
 *  engine's stop() and as a process-exit safety net. */
export function disposePtyHost(): void {
  host.dispose();
}

/** Test-only: milliseconds until the crash-loop hold-off allows the next host
 *  respawn (0 = not held off). Lets tests assert the guard engaged without
 *  racing real child boots or reaching into private state. */
export function ptyHostRespawnHoldOffMsForTests(): number {
  return host.respawnHoldOffMs();
}

// Safety net: if the engine process exits without calling stop() (a crash, an
// uncaught fatal), still take the host child down with us so it doesn't strand
// orphan shells. The host also self-exits on stdin EOF, so this is belt-and-
// suspenders.
process.once("exit", () => host.dispose());
