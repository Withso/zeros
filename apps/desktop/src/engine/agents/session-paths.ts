// ──────────────────────────────────────────────────────────
// Session directory layout — <engine-data-dir>/sessions/
// ──────────────────────────────────────────────────────────
//
// One directory per session. Persistent across app restarts so a
// crash mid-session leaves a diagnostic breadcrumb. Cleaned on graceful
// session end or app quit.
//
// Lives UNDER the engine data dir (db/paths.ts zerosDataDir()):
// `~/Library/Application Support/com.zeros` (prod) / `com.zeros.dev` (dev)
// on macOS, XDG / %APPDATA% elsewhere, and ZEROS_DATA_DIR in cloud
// sandboxes — co-located with zeros.db + the relay identity. This was
// previously a hardcoded "Zeros" app-name dir with NO dev/prod split, so a
// `pnpm electron:dev` build and a packaged /Applications/Zeros.app shared
// one sessions/ dir, and each engine's boot-time GC swept the OTHER build's
// crash breadcrumbs.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { zerosDataDir } from "../db/paths";

export const SHADOW_GIT_RECOVERY_HOLD_FILE = ".shadow-git-recovery-hold.json";
export const ORBSTACK_MACHINE_RECOVERY_HOLD_FILE =
  ".zsr-orbstack-machine-recovery.json";

function baseDir(): string {
  return zerosDataDir();
}

/** Root of all session state on this machine. */
export function sessionsRoot(): string {
  return path.join(baseDir(), "sessions");
}

/** Path for a single session. Does NOT create anything — caller calls `ensureSessionDir`. */
export function sessionDir(sessionId: string): string {
  return path.join(sessionsRoot(), sanitizeId(sessionId));
}

/** Create the session dir + standard subdirs. Idempotent. */
export async function ensureSessionDir(sessionId: string): Promise<{
  root: string;
  env: string;
  log: string;
  telemetry: string;
}> {
  const root = sessionDir(sessionId);
  const env = path.join(root, "env");
  const log = path.join(root, "log");
  const telemetry = path.join(root, "telemetry");
  await fsp.mkdir(env, { recursive: true });
  await fsp.mkdir(log, { recursive: true });
  await fsp.mkdir(telemetry, { recursive: true });
  return { root, env, log, telemetry };
}

/** Write session metadata (agent id, pid, created-at) for crash recovery. */
export async function writeSessionMeta(
  sessionId: string,
  meta: {
    agentId: string;
    cwd: string;
    pid?: number;
    createdAt: number;
  },
): Promise<void> {
  const root = sessionDir(sessionId);
  await fsp.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
}

/** Remove the entire session dir. Called on graceful session end. */
export async function removeSessionDir(sessionId: string): Promise<void> {
  const root = sessionDir(sessionId);
  if (
    (await hasPendingShadowGitRecovery(root)) ||
    (await hasPendingOrbStackMachineRecovery(root))
  )
    return;
  await fsp.rm(root, { recursive: true, force: true });
}

async function hasPendingShadowGitRecovery(sessionRoot: string) {
  try {
    const metadata = await fsp.lstat(
      path.join(sessionRoot, SHADOW_GIT_RECOVERY_HOLD_FILE),
    );
    // Any entry is a conservative hold. A malformed/symlinked marker must not
    // turn a recoverable linked worktree into a broken pointer via GC.
    return !metadata.isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function hasPendingOrbStackMachineRecovery(sessionRoot: string) {
  try {
    const metadata = await fsp.lstat(
      path.join(sessionRoot, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
    );
    // Any non-directory entry is a conservative hold. The trusted recovery
    // parser decides whether it is valid; generic session GC never deletes a
    // selective-mount source while an OrbStack machine may still reference it.
    return !metadata.isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function hasPendingProcessDomainRecovery(sessionRoot: string) {
  const boundaryRoot = path.join(sessionRoot, "boundary");
  let generations: import("node:fs").Dirent[];
  try {
    generations = await fsp.readdir(boundaryRoot, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const generation of generations) {
    if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
    try {
      const descriptor = await fsp.lstat(
        path.join(
          boundaryRoot,
          generation.name,
          "commands",
          "process-domain.json",
        ),
      );
      if (descriptor.isFile() && !descriptor.isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

/** Boot-time GC. Graceful teardown (`removeSessionDir`) cleans session dirs,
 *  but a hard crash / `kill -9` never does, so they accumulate forever. On
 *  engine start — BEFORE this run creates any sessions, so we only ever see
 *  prior-run dirs — read each dir's `meta.json` and drop any whose recorded
 *  `pid` is no longer a live process. Best-effort and conservative: dirs
 *  with no/unreadable meta or no pid, and any whose pid still resolves to a
 *  live process, are left untouched. Returns the number removed. */
export async function sweepDeadSessions(): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(sessionsRoot());
  } catch {
    return 0; // root not created yet — nothing to sweep
  }
  let removed = 0;
  await Promise.all(
    entries.map(async (name) => {
      const dir = path.join(sessionsRoot(), name);
      let pid: number | undefined;
      try {
        const meta = JSON.parse(
          await fsp.readFile(path.join(dir, "meta.json"), "utf-8"),
        ) as { pid?: number };
        pid = typeof meta.pid === "number" ? meta.pid : undefined;
      } catch {
        return; // no/unreadable meta (mid-write or legacy) — leave it
      }
      if (
        !pid ||
        pid <= 0 ||
        isProcessAlive(pid) ||
        (await hasPendingProcessDomainRecovery(dir)) ||
        (await hasPendingShadowGitRecovery(dir)) ||
        (await hasPendingOrbStackMachineRecovery(dir))
      )
        return;
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* best-effort */
      }
    }),
  );
  return removed;
}

/** Liveness probe via signal 0 (checks existence, doesn't actually signal).
 *  ESRCH ⇒ dead; EPERM ⇒ alive but owned by another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Allow-list: alnum, dash, underscore. Matches UUID + our custom ids.
 *  Anything else gets stripped so we can never escape sessionsRoot(). */
function sanitizeId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error(`invalid session id: ${id}`);
  return clean;
}
