// Bun can spawn node-pty without delivering PTY I/O. Use one Node host over NDJSON, with PTY bytes encoded as base64.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PtyHandle } from "./service";
import type { PtyExitReason } from "@zeros/protocol/messages";

export interface PtyHostSpawnSpec {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** The engine resolves the environment, including remote-client scrubbing; the host passes it through. */
  env: Record<string, string>;
  name?: string;
  /** The host supplies its own PID, the trusted launcher's immediate parent. */
  immediateParentPidArgIndex?: number;
}

export interface PtyHostBirth {
  readonly pid: number;
  readonly parent: number;
  readonly startToken: string;
}

/** Capture only the child just spawned by this client. A failed observation
 * leaves ordinary PTY operation available but grants no idle exemption. */
function capturePtyHostBirth(child: ChildProcess): PtyHostBirth | null {
  const pid = child.pid;
  if (process.platform !== "linux" || pid === undefined || !Number.isSafeInteger(pid) || pid < 2) return null;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) return null;
    const maximum = 4096, buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maximum) return null;
    const source = buffer.toString("utf8", 0, size), end = source.lastIndexOf(")");
    const fields = source.slice(end + 1).trim().split(/\s+/);
    const parent = Number(fields[1]), startToken = fields[19];
    if (end < 0 || !source.startsWith(`${pid} (`) || parent !== process.pid ||
      !startToken || !/^[1-9][0-9]{0,19}$/.test(startToken) || BigInt(startToken) > 18446744073709551615n ||
      !/^[A-Z]$/.test(fields[0] ?? "") || fields[0] === "Z" || fields[0] === "X") return null;
    return Object.freeze({ pid, parent, startToken });
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

interface SessionEntry {
  pid: number;
  spawnCbs: Array<(pid: number) => void>;
  dataCbs: Array<(data: string) => void>;
  exitCbs: Array<
    (
      exitCode: number | null,
      signal: number | null,
      reason?: PtyExitReason,
    ) => void
  >;
  spawnFailed: boolean;
  exited: boolean;
}

function resolveHostScript(): string | null {
  const explicit = process.env.ZEROS_PTY_HOST_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;
  // The sibling path is a source-mode fallback; fileURLToPath can throw in a Bun-compiled binary.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.join(here, "pty-host.cjs");
    if (existsSync(sibling)) return sibling;
  } catch {
    /* compiled binary — no source path on disk */
  }
  return null;
}

/** The Electron binary must run in Node mode to load its ABI-matched node-pty. */
function resolveRuntime(): { cmd: string; electron: boolean } {
  const explicit = process.env.ZEROS_PTY_HOST_RUNTIME;
  if (explicit && explicit.length > 0) {
    return {
      cmd: explicit,
      electron: process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1",
    };
  }
  return { cmd: "node", electron: false };
}

const EARLY_DEATH_WINDOW_MS = 5_000;
const RESPAWN_BACKOFF_BASE_MS = 1_000;
const RESPAWN_BACKOFF_CAP_MS = 30_000;
const MAX_PARTIAL_LINE_CHARS = 32 * 1024 * 1024;

class PtyHost {
  private child: ChildProcess | null = null;
  private childBirth: PtyHostBirth | null = null;
  private buf = "";
  private readonly entries = new Map<string, SessionEntry>();
  private nextId = 1;
  private spawnFailed = false;
  private fatalFailure = false;
  private sawReady = false;
  private spawnedAt = 0;
  private consecutiveEarlyDeaths = 0;
  private respawnBlockedUntil = 0;

  respawnHoldOffMs(): number {
    return Math.max(0, this.respawnBlockedUntil - Date.now());
  }

  currentBirth(): PtyHostBirth | null {
    const child = this.child, birth = this.childBirth;
    if (!child || !birth || child.pid !== birth.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return null;
    return birth;
  }

  private ensure(): void {
    if (this.child) return;
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
    this.childBirth = null;
    try { this.childBirth = capturePtyHostBirth(child); }
    catch { /* Even a descriptor-close failure grants no exemption. */ }
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
    // Ignore late lifecycle events from a previous child after dispose and respawn.
    child.on("error", (err) => {
      if (this.child !== child) return;
      console.error(`[pty-host] runtime error: ${err.message}`);
      this.onHostGone(null, "host-unavailable");
    });
    // Use close, not exit, so fatal protocol output is drained before classifying the death.
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.onHostGone(
        typeof code === "number" ? code : signal ? 128 : null,
        this.fatalFailure ? "host-unavailable" : "host-lost",
      );
    });
  }

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

  private onHostGone(code: number | null, reason: PtyExitReason): void {
    this.child = null;
    this.childBirth = null;
    this.buf = "";
    const fatal = this.fatalFailure;
    this.fatalFailure = false;
    // Allow one immediate retry for a transient boot crash, but back off on the first fatal node-pty load failure.
    const uptime = Date.now() - this.spawnedAt;
    const early = !this.sawReady || uptime < EARLY_DEATH_WINDOW_MS;
    if (early) {
      this.consecutiveEarlyDeaths += 1;
      const holdOff = fatal || this.consecutiveEarlyDeaths >= 2;
      const holdOffMs = holdOff
        ? Math.min(
            RESPAWN_BACKOFF_CAP_MS,
            RESPAWN_BACKOFF_BASE_MS *
              2 ** Math.max(0, this.consecutiveEarlyDeaths - (fatal ? 1 : 2)),
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
    // Bound an unterminated line so a broken host cannot grow the engine's buffer indefinitely.
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
        if (entry.pid > 0) {
          for (const cb of entry.spawnCbs.splice(0)) {
            try {
              cb(entry.pid);
            } catch {
              /* observer threw — PTY ownership stays with the host */
            }
          }
        }
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
      spawnCbs: [],
      dataCbs: [],
      exitCbs: [],
      spawnFailed: false,
      exited: false,
    };
    this.entries.set(id, entry);

    // The host handles spawn synchronously on the same ordered pipe, so an immediate write finds the session.
    this.writeMsg({
      t: "spawn",
      id,
      shell: spec.shell,
      args: spec.args,
      ...(spec.immediateParentPidArgIndex === undefined
        ? {}
        : { immediateParentPidArgIndex: spec.immediateParentPidArgIndex }),
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
      name: spec.name ?? "xterm-256color",
    });

    // Defer the unavailable-host exit until PtyService can attach its onExit listener.
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
      onSpawned: (cb) => {
        if (entry.pid > 0) cb(entry.pid);
        else entry.spawnCbs.push(cb);
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
    this.childBirth = null;
    this.buf = "";
    this.fatalFailure = false;
    // Intentional teardown must not count as a boot crash or carry hold-off into a fresh start.
    this.sawReady = false;
    this.consecutiveEarlyDeaths = 0;
    this.respawnBlockedUntil = 0;
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

export function spawnPtyViaHost(spec: PtyHostSpawnSpec): PtyHandle {
  return host.spawn(spec);
}

export function disposePtyHost(): void {
  host.dispose();
}

/** Read-only identity of this client's current original Linux transport.
 * Shell/session descendants and arbitrary caller PIDs are never included. */
export function currentPtyHostBirth(): PtyHostBirth | null {
  return host.currentBirth();
}

export function ptyHostRespawnHoldOffMsForTests(): number {
  return host.respawnHoldOffMs();
}

// On process exit, dispose as a backup to the host's stdin-EOF shutdown.
process.once("exit", () => host.dispose());
