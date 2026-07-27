// ──────────────────────────────────────────────────────────
// Process group lifecycle for stdio agent subprocesses.
// ──────────────────────────────────────────────────────────
//
// Why a process group, not just `child.kill()`:
//   stdio agents are often launched via a wrapper. `codex app-server`
//   (launched via the `@openai/codex` npm wrapper) spawns a Node helper
//   that spawns the real binary; it also forks sub-tools (a shell for
//   run_shell_command, MCP server children, etc.). Killing
//   the immediate child orphans the grandchildren — they keep draining
//   stdout, holding file locks, sometimes printing terminal escape
//   sequences into the user's shell. `kill(-pgid, …)` flattens the
//   whole tree atomically.
//
// Pattern (athas):
//   1. spawn with `detached: true` so Node's `setpgid(0, 0)`-equivalent
//      makes the child its own process group leader. (On macOS/Linux,
//      `detached: true` does this; on Windows it sets a process group
//      via job objects, close enough for our SIGINT/kill needs.)
//   2. Stop: kill(-pgid, "SIGTERM") → wait up to 2s → kill(-pgid,
//      "SIGKILL"). The negative pid form is the "send to group"
//      contract on POSIX; Node 16+ exposes it directly via
//      process.kill(-pgid, signal).
//
// We deliberately do NOT use `child.kill()` after the group kill — the
// child's pid is already dead by then, and on Linux a zombie reap race
// can throw EPERM. The group kill is sufficient.
//
// ──────────────────────────────────────────────────────────

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 2_000;

export interface SpawnStdioAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Tag used for diagnostics (no behavioural effect). */
  logTag?: string;
}

export interface StdioAgentProcess {
  /** The underlying ChildProcess (already spawned). */
  readonly child: ChildProcess;
  /** OS-level process group id, or null if we couldn't establish one
   *  (Windows or unusual platforms). */
  readonly processGroupId: number | null;
  /** Resolves with `{code, signal}` once the subprocess exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM the whole group; on grace-timeout, SIGKILL the whole group.
   *  Idempotent: calling stop() after the child has already exited
   *  resolves immediately. */
  stop(opts?: { gracefulMs?: number }): Promise<void>;
}

/** Spawn a stdio agent in its own process group. */
export function spawnStdioAgent(opts: SpawnStdioAgentOptions): StdioAgentProcess {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX: child becomes a process-group leader (setpgid(0,0))
    // → all its descendants share its pgid → kill(-pgid) reaches all.
    // Windows: spawn() spawns a detached process with a new console;
    // process.kill on Windows goes through the job object equivalent.
    detached: true,
  };
  const child = spawn(opts.command, opts.args, spawnOpts);

  // On POSIX, child.pid IS the new process-group id (because the child
  // is the group leader). On Windows there is no group id, just a pid.
  const processGroupId = process.platform === "win32" ? null : (child.pid ?? null);

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const stop = async (stopOpts: { gracefulMs?: number } = {}) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gracefulMs = stopOpts.gracefulMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;

    sendSignal(child, processGroupId, "SIGTERM");

    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), gracefulMs)),
    ]);
    if (graceful) return;

    sendSignal(child, processGroupId, "SIGKILL");
    // Wait for the actual exit so callers can rely on resource teardown.
    await exited;
  };

  return { child, processGroupId, exited, stop };
}

function sendSignal(
  child: ChildProcess,
  processGroupId: number | null,
  signal: NodeJS.Signals,
): void {
  // On POSIX, prefer `process.kill(-pgid, signal)` so every descendant
  // receives it. Falling back to child.kill() leaves grandchildren
  // running — see the doc-block at the top of this file.
  if (processGroupId != null && process.platform !== "win32") {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch (err) {
      // ESRCH = no such process (already exited) — fine.
      // EPERM = lost permission to signal (rare, e.g. setuid drop) —
      //         fall through to single-pid kill as a last resort.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    }
    return;
  }
  // Windows or no pgid: send to the immediate child only.
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}
