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

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

import type {
  BoundaryProcess,
  PreparedBoundary,
} from "../../containment/types";

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 2_000;
const DEFAULT_FORCE_SHUTDOWN_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 20;

export interface SpawnStdioAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete child environment. Callers that need ambient variables must
   * construct and scrub that environment before this process boundary. */
  env?: Record<string, string>;
  /** Prepared execution capability. When present the real child is the
   * selected lifecycle/sandbox supervisor and every provider descendant shares
   * its boundary. */
  executionBoundary?: PreparedBoundary;
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
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    /** Present when the executable could not be spawned at all. */
    error?: Error;
  }>;
  /** SIGTERM the whole group; on grace-timeout, SIGKILL the whole group and
   * prove the group is empty. A dead leader is not sufficient: a descendant
   * may survive and retain the old filesystem authority. */
  stop(opts?: { gracefulMs?: number; forceMs?: number }): Promise<void>;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, PROCESS_GROUP_POLL_MS),
    );
  }
  return true;
}

/** Spawn a stdio agent in its own process group. */
export function spawnStdioAgent(
  opts: SpawnStdioAgentOptions,
): StdioAgentProcess {
  if (opts.executionBoundary && !opts.env) {
    throw new Error(
      "a contained stdio process requires a complete environment",
    );
  }
  const launch = opts.executionBoundary?.wrapSpawn({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env ?? {},
    stdio: "pipe",
  });
  const spawnOpts: SpawnOptions = {
    cwd: launch?.cwd ?? opts.cwd,
    env: launch?.env ?? opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX: child becomes a process-group leader (setpgid(0,0))
    // → all its descendants share its pgid → kill(-pgid) reaches all.
    // Windows: spawn() spawns a detached process with a new console;
    // process.kill on Windows goes through the job object equivalent.
    detached: true,
  };
  const child = spawn(
    launch?.command ?? opts.command,
    launch?.args ?? opts.args,
    spawnOpts,
  );

  // On POSIX, child.pid IS the new process-group id (because the child
  // is the group leader). On Windows there is no group id, just a pid.
  const processGroupId =
    process.platform === "win32" ? null : (child.pid ?? null);

  let spawnFailure: Error | null = null;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    let settled = false;
    const settle = (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("exit", (code, signal) => settle({ code, signal }));
    // spawn() reports ENOENT/EACCES asynchronously and emits no `exit` event.
    // Keep an error listener for the entire child lifetime so a late ChildProcess
    // error is never process-fatal, but only a pid-less error means spawn itself
    // failed and can safely settle the process-domain proof.
    child.on("error", (error) => {
      if (child.pid != null) return;
      spawnFailure = error;
      settle({ code: null, signal: null, error });
    });
  });

  // Registration may reject a pid-less child synchronously. Keep the Node
  // error event owned before crossing that boundary so the asynchronous
  // ENOENT/EACCES that explains the missing pid can never become process-fatal.
  const boundaryProcess: BoundaryProcess | undefined =
    opts.executionBoundary?.trackProcess(child);

  let stopPromise: Promise<void> | null = null;
  const stop = (
    stopOpts: { gracefulMs?: number; forceMs?: number } = {},
  ): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (boundaryProcess) {
        await boundaryProcess.stopAndProve();
        return;
      }
      const gracefulMs = stopOpts.gracefulMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;
      const forceMs = stopOpts.forceMs ?? DEFAULT_FORCE_SHUTDOWN_MS;

      if (spawnFailure) return;

      // A wrapper may exit while leaving a command descendant in its process
      // group. Check the group itself before treating an exited leader as done.
      if (processGroupId == null) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        sendSignal(child, processGroupId, "SIGTERM");
        const graceful = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), gracefulMs),
          ),
        ]);
        if (!graceful) {
          sendSignal(child, processGroupId, "SIGKILL");
          await exited;
        }
        return;
      }

      if (!processGroupExists(processGroupId)) return;

      sendSignal(child, processGroupId, "SIGTERM");
      if (await waitForProcessGroupExit(processGroupId, gracefulMs)) return;

      sendSignal(child, processGroupId, "SIGKILL");
      if (!(await waitForProcessGroupExit(processGroupId, forceMs))) {
        throw new Error(
          `Agent process group ${processGroupId} survived SIGKILL`,
        );
      }
      // Reap the direct child once the complete group is known to be gone.
      await exited;
    })();
    return stopPromise;
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
