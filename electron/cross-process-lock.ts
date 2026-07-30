// Small same-user advisory file lock for operations that must span an async
// network request. The encrypted secret store's own lock protects one atomic
// read/modify/write; this lock serializes GitHub/Auth0 refresh-token rotation
// across dev worktrees that share that store.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Distinguishable so callers can translate "a sibling still holds it" into
 *  their own user-facing copy instead of leaking a lock filename into the UI. */
export class CrossProcessLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for lock ${path.basename(lockPath)}`);
    this.name = "CrossProcessLockTimeoutError";
  }
}

export interface CrossProcessLockOptions {
  staleAfterMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

interface LockSnapshot {
  owner: string;
  mtimeMs: number;
  dev: number;
  ino: number;
}

function lockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const owner = fs.readFileSync(lockPath, "utf8");
    const stat = fs.statSync(lockPath);
    return {
      owner,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    return null;
  }
}

function removeObservedLock(lockPath: string, observed: LockSnapshot): boolean {
  const current = lockSnapshot(lockPath);
  if (
    !current ||
    current.owner !== observed.owner ||
    current.dev !== observed.dev ||
    current.ino !== observed.ino
  ) {
    return false;
  }
  try {
    fs.rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withCrossProcessFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: CrossProcessLockOptions = {},
): Promise<T> {
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? staleAfterMs + 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const now = options.now ?? Date.now;
  const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
  const startedAt = now();
  let held = false;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (!held) {
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, owner, "utf8");
      fs.closeSync(descriptor);
      descriptor = null;
      held = true;
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The original failure is more useful.
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // If creation succeeded but writing failed, no peer could have owned
        // this path. Remove the unusable lock before surfacing the failure.
        const snapshot = lockSnapshot(lockPath);
        if (snapshot?.owner === owner || snapshot?.owner === "") {
          removeObservedLock(lockPath, snapshot);
        }
        throw error;
      }

      // Retry immediately ONLY when this pass made progress by clearing a stale
      // lock. Every other outcome — the holder is live, the lock is unreadable
      // (lockSnapshot returns null for any stat/read failure, not just "it
      // vanished"), or the removal was refused — must fall through to the
      // timeout check and the sleep below. Looping without either would spin
      // synchronously and, in the main process, wedge the whole event loop
      // instead of surfacing waitTimeoutMs.
      const observed = lockSnapshot(lockPath);
      if (
        observed &&
        now() - observed.mtimeMs > staleAfterMs &&
        removeObservedLock(lockPath, observed)
      ) {
        continue;
      }
      if (now() - startedAt >= waitTimeoutMs) {
        throw new CrossProcessLockTimeoutError(lockPath);
      }
      await delay(pollIntervalMs);
    }
  }

  try {
    return await operation();
  } finally {
    if (held) {
      const observed = lockSnapshot(lockPath);
      if (observed?.owner === owner) {
        removeObservedLock(lockPath, observed);
      }
    }
  }
}
