import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BoundaryProcess,
  PreparedBoundary,
} from "../../containment/types";

const DEFAULT_GRACE_MS = 500;
const DEFAULT_SIGNAL_WAIT_MS = 1_000;
const POLL_MS = 20;

export interface ContainedClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly processGroupId: number;
  readonly exited: Promise<void>;
  readonly boundaryProcess?: BoundaryProcess;
  termination: Promise<void> | null;
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

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

/** Spawn a territory-bound Claude CLI as a dedicated POSIX process group.
 *
 * The SDK normally owns its child handle privately. That makes `query.close()`
 * unable to prove teardown to Zeros while a workspace's immutable filesystem
 * authority is changing. The custom SDK spawn seam preserves the same pipes
 * and environment while retaining one observable group handle. Territory
 * admission already rejects non-macOS/Linux hosts, so falling back to an
 * unobservable Windows process tree would be a policy bypass. */
export function spawnContainedClaudeProcess(
  options: SpawnOptions,
  callbacks: {
    onSpawn(process: ContainedClaudeProcess): void;
    onStderr(data: string): void;
  },
  executionBoundary?: PreparedBoundary,
): SpawnedProcess {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Claude process-group containment is unsupported on ${process.platform}`,
    );
  }

  const completeEnv = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (executionBoundary && Object.keys(completeEnv).length === 0) {
    throw new Error(
      "a contained Claude process requires a complete environment",
    );
  }
  const launch = executionBoundary
    ? executionBoundary.wrapSpawn({
        command: options.command,
        args: options.args,
        cwd: options.cwd ?? process.cwd(),
        env: completeEnv,
        stdio: "pipe",
      })
    : undefined;
  const child = spawn(
    launch?.command ?? options.command,
    launch?.args ?? options.args,
    {
      cwd: launch?.cwd ?? options.cwd,
      env: launch?.env ?? options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const processGroupId = child.pid;
  if (!processGroupId || processGroupId === process.pid) {
    child.kill("SIGKILL");
    throw new Error("Claude process did not receive a dedicated process group");
  }
  const boundaryProcess = executionBoundary?.trackProcess(child);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => callbacks.onStderr(data));

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const tracked: ContainedClaudeProcess = {
    child,
    processGroupId,
    exited,
    ...(boundaryProcess ? { boundaryProcess } : {}),
    termination: null,
  };
  callbacks.onSpawn(tracked);

  // This is the SDK's forwarded abort signal: it fires only after its own
  // stdin-EOF grace period. A direct Zeros teardown calls the exported stop
  // function itself, while this listener also covers SDK-internal shutdowns.
  options.signal.addEventListener(
    "abort",
    () => {
      void terminateContainedClaudeProcess(tracked, { graceMs: 0 }).catch(
        () => undefined,
      );
    },
    { once: true },
  );

  return child;
}

/** Stop and verify the complete process group before an old territory grant
 * can be retired. SIGTERM follows a short graceful window; SIGKILL is the
 * bounded fail-safe. A surviving group rejects teardown, which the gateway's
 * fail-closed lifecycle path propagates instead of publishing new authority. */
export function terminateContainedClaudeProcess(
  tracked: ContainedClaudeProcess,
  opts: { graceMs?: number; signalWaitMs?: number } = {},
): Promise<void> {
  if (tracked.termination) return tracked.termination;
  tracked.termination = (async () => {
    if (tracked.boundaryProcess) {
      await tracked.boundaryProcess.stopAndProve();
      return;
    }
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const signalWaitMs = opts.signalWaitMs ?? DEFAULT_SIGNAL_WAIT_MS;
    if (
      graceMs > 0 &&
      (await waitForProcessGroupExit(tracked.processGroupId, graceMs))
    ) {
      return;
    }
    if (!processGroupExists(tracked.processGroupId)) return;

    signalProcessGroup(tracked.processGroupId, "SIGTERM");
    if (await waitForProcessGroupExit(tracked.processGroupId, signalWaitMs)) {
      return;
    }

    signalProcessGroup(tracked.processGroupId, "SIGKILL");
    if (
      !(await waitForProcessGroupExit(tracked.processGroupId, signalWaitMs))
    ) {
      throw new Error(
        `Claude process group ${tracked.processGroupId} survived SIGKILL`,
      );
    }
    await tracked.exited;
  })();
  return tracked.termination;
}
