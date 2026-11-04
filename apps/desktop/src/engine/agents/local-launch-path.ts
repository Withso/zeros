import { stat } from "node:fs/promises";
import path from "node:path";

import {
  getLoginShellPath,
  loginShellPathGeneration,
  LoginShellPathUnavailableError,
} from "./adapters/shared/login-shell-path";
import { sanitizeProbedPath } from "../env/launcher-env";
import { AgentFailureError, type AgentFailureStage } from "./types";
import type { BoundaryLaunchSpec, PreparedBoundary } from "./containment/types";

export function missingExecutableError(command: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      `Could not start ${path.basename(command)}: executable not found.`,
    ),
    {
      code: "ENOENT",
      syscall: `spawn ${command}`,
      path: command,
    },
  );
}

function isMissingExecutable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as NodeJS.ErrnoException;
  return (
    failure.code === "ENOENT" &&
    typeof failure.path === "string" &&
    failure.syscall === `spawn ${failure.path}`
  );
}

export class LocalLaunchPathRecovery {
  private retried = false;
  private started = false;
  private readonly pendingLaunches = new Set<BoundaryLaunchSpec>();
  private readonly generation = loginShellPathGeneration();
  private readonly inheritedPath: string;

  constructor(
    private readonly env: Record<string, string>,
    private readonly cwd: string,
    private readonly stage: AgentFailureStage,
    private readonly assertCurrent: () => void,
    originalPath = env.PATH ?? "",
  ) {
    this.inheritedPath = originalPath;
  }

  observeBoundary(boundary: PreparedBoundary): PreparedBoundary {
    return {
      ...boundary,
      wrapSpawn: (request) => {
        const launch = boundary.wrapSpawn(request);
        if (!this.started) this.pendingLaunches.add(launch);
        return launch;
      },
      cancelUnstartedLaunch: (launch) => {
        boundary.cancelUnstartedLaunch?.(launch);
        this.pendingLaunches.delete(launch);
      },
      trackProcess: (child) => {
        if (child.pid) {
          this.started = true;
          this.pendingLaunches.clear();
        }
        return boundary.trackProcess(child);
      },
      trackProcessGroup: (pid, options) => {
        this.started = true;
        this.pendingLaunches.clear();
        return boundary.trackProcessGroup(pid, options);
      },
      spawn: (request) => {
        // An opaque boundary spawn has no synchronous no-child witness.
        this.started = true;
        this.pendingLaunches.clear();
        return boundary.spawn(request);
      },
    };
  }

  async run<T>(start: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    try {
      return await start();
    } catch (error) {
      // ENOENT can also mean a missing cwd or a provider's file read. Neither
      // proves that the executable failed before its own effects began.
      if (
        this.retried ||
        this.started ||
        this.pendingLaunches.size > 0 ||
        !isMissingExecutable(error) ||
        !(await stat(this.cwd).catch(() => null))?.isDirectory()
      )
        throw error;
      this.retried = true;
      this.assertCurrent();
      let refreshed: string;
      try {
        refreshed = sanitizeProbedPath(
          await getLoginShellPath({
            refresh: true,
            ifGeneration: this.generation,
          }),
        );
      } catch (probeError) {
        this.assertCurrent();
        if (probeError instanceof LoginShellPathUnavailableError) {
          throw new AgentFailureError({
            kind: "protocol-error",
            stage: this.stage,
            message: probeError.message,
            advice: probeError.message,
          });
        }
        throw error;
      }
      this.assertCurrent();
      // Explicit toolchain additions and product shims must survive replacing
      // the inherited shell entries.
      const inherited = new Set(this.inheritedPath.split(path.delimiter));
      const prefix = (this.env.PATH ?? "")
        .split(path.delimiter)
        .filter((directory) => directory && !inherited.has(directory));
      this.env.PATH = [...prefix, refreshed]
        .filter(Boolean)
        .join(path.delimiter);
      return start();
    }
  }
}
