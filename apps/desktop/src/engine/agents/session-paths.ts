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
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { zerosDataDir } from "../db/paths";

export const SHADOW_GIT_RECOVERY_HOLD_FILE = ".shadow-git-recovery-hold.json";
export const ORBSTACK_MACHINE_RECOVERY_HOLD_FILE =
  ".zsr-orbstack-machine-recovery.json";
export const PROVIDER_HOME_RECOVERY_HOLD_FILE = ".provider-home-recovery.json";
export const CURSOR_STATE_RECOVERY_HOLD_FILE = ".cursor-state-recovery.json";

function baseDir(): string {
  return zerosDataDir();
}

async function assertPhysicalDirectory(directory: string, label: string) {
  const metadata = await fsp.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory`);
  }
}

async function ensurePhysicalDirectory(directory: string, label: string) {
  try {
    await fsp.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPhysicalDirectory(directory, label);
  await fsp.chmod(directory, 0o700);
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
  await fsp.mkdir(sessionsRoot(), { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(sessionsRoot(), "sessions root");
  await ensurePhysicalDirectory(root, "session root");
  await Promise.all(
    [env, log, telemetry].map((directory) =>
      ensurePhysicalDirectory(directory, "session subdirectory"),
    ),
  );
  return { root, env, log, telemetry };
}

/** Write session metadata (agent id, pid, created-at) for crash recovery. */
export async function writeSessionMeta(
  sessionId: string,
  meta: {
    agentId: string;
    actor?: string;
    cwd: string;
    pid?: number;
    createdAt: number;
  },
): Promise<void> {
  const root = sessionDir(sessionId);
  await assertPhysicalDirectory(root, "session root");
  const metadataPath = path.join(root, "meta.json");
  try {
    const existing = await fsp.lstat(metadataPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("session metadata is not a physical file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fsp.writeFile(metadataPath, JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });
  await fsp.chmod(metadataPath, 0o600);
}

/** Remove the entire session dir. Called on graceful session end. */
export async function removeSessionDir(sessionId: string): Promise<void> {
  const root = sessionDir(sessionId);
  try {
    await assertPhysicalDirectory(root, "session root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    (await hasPendingProcessDomainRecovery(root)) ||
    (await hasPendingShadowGitRecovery(root)) ||
    (await hasPendingOrbStackMachineRecovery(root)) ||
    (await hasPendingProviderHomeRecovery(root))
  )
    return;
  await fsp.rm(root, { recursive: true, force: true });
}

async function hasPendingShadowGitRecovery(sessionRoot: string) {
  try {
    await fsp.lstat(path.join(sessionRoot, SHADOW_GIT_RECOVERY_HOLD_FILE));
    // Any entry is a conservative hold. A malformed marker must not
    // turn a recoverable linked worktree into a broken pointer via GC.
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function hasPendingOrbStackMachineRecovery(sessionRoot: string) {
  try {
    await fsp.lstat(
      path.join(sessionRoot, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
    );
    // Any entry is a conservative hold. The trusted recovery
    // parser decides whether it is valid; generic session GC never deletes a
    // selective-mount source while an OrbStack machine may still reference it.
    return true;
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
      await fsp.lstat(
        path.join(
          boundaryRoot,
          generation.name,
          "commands",
          "process-domain.json",
        ),
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

async function hasPendingProviderHomeRecovery(sessionRoot: string) {
  const boundaryRoot = path.join(sessionRoot, "boundary");
  let generations: import("node:fs").Dirent[];
  try {
    generations = await fsp.readdir(boundaryRoot, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const generation of generations) {
    if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
    const generationRoot = path.join(boundaryRoot, generation.name);
    if (
      (await hasRecoveryMarker(
        generationRoot,
        PROVIDER_HOME_RECOVERY_HOLD_FILE,
      )) ||
      (await hasPendingCursorStateRecovery(generationRoot))
    )
      return true;
  }
  return false;
}

async function hasRecoveryMarker(generationRoot: string, name: string) {
  try {
    await fsp.lstat(path.join(generationRoot, name));
    // Generic GC has no authority to interpret or discard recovery state. A
    // malformed entry remains a conservative hold.
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function hasPendingCursorStateRecovery(
  generationRoot: string,
): Promise<boolean> {
  return hasRecoveryMarker(generationRoot, CURSOR_STATE_RECOVERY_HOLD_FILE);
}

const LEGACY_SESSION_DIRECTORIES = new Set([
  "boundary",
  "container-worker",
  "env",
  "log",
  "telemetry",
]);
const LEGACY_SESSION_FILES = new Set(["claude-sdk.json"]);

/** A pre-owner-metadata Zeros session is removable only when every top-level
 *  entry has a known engine-owned role. Unknown files, symlinks, malformed
 *  metadata are preserved rather than guessed at by generic GC. A physical
 *  empty child is also a known partial-session shape: this root is exclusively
 *  engine-owned, and a crash can land between creating it and its subdirs. */
async function isRecognizableLegacySession(sessionRoot: string) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) return true;
  let hasSessionDirectory = false;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false;
    if (LEGACY_SESSION_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory()) return false;
      hasSessionDirectory = true;
      continue;
    }
    if (
      LEGACY_SESSION_FILES.has(entry.name) ||
      /^orbstack-container-[A-Za-z0-9_-]+\.json$/.test(entry.name)
    ) {
      if (!entry.isFile()) return false;
      continue;
    }
    return false;
  }
  return hasSessionDirectory;
}

async function hasPendingRecovery(sessionRoot: string) {
  return (
    (await hasPendingProcessDomainRecovery(sessionRoot)) ||
    (await hasPendingShadowGitRecovery(sessionRoot)) ||
    (await hasPendingOrbStackMachineRecovery(sessionRoot)) ||
    (await hasPendingProviderHomeRecovery(sessionRoot))
  );
}

const MAX_SESSION_META_BYTES = 64 * 1024;

async function readSessionOwner(
  sessionRoot: string,
): Promise<
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "readable"; pid?: number }
> {
  const metadataPath = path.join(sessionRoot, "meta.json");
  let handle;
  try {
    handle = await fsp.open(
      metadataPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  try {
    let linkMetadata;
    try {
      linkMetadata = await fsp.lstat(metadataPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "missing" }
        : { state: "invalid" };
    }
    const openedMetadata = await handle.stat();
    if (
      !linkMetadata.isFile() ||
      linkMetadata.isSymbolicLink() ||
      !openedMetadata.isFile() ||
      openedMetadata.nlink !== 1 ||
      openedMetadata.dev !== linkMetadata.dev ||
      openedMetadata.ino !== linkMetadata.ino ||
      openedMetadata.size <= 0 ||
      openedMetadata.size > MAX_SESSION_META_BYTES
    ) {
      return { state: "invalid" };
    }
    const parsed = JSON.parse((await handle.readFile()).toString("utf8")) as {
      pid?: unknown;
    };
    return {
      state: "readable",
      ...(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid)
        ? { pid: parsed.pid }
        : {}),
    };
  } catch {
    return { state: "invalid" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Boot-time GC. Graceful teardown (`removeSessionDir`) cleans session dirs,
 *  but a hard crash / `kill -9` never does, so the next engine boot reclaims
 *  dead owners. Older ZSR builds created recognizable boundary/session roots
 *  without metadata; after all authoritative recovery passes have cleared
 *  their holds, those known shapes are legacy debris and are reclaimed too.
 *  Best-effort and conservative: malformed/pid-less metadata, live owners,
 *  symlinks, unknown shapes, and recovery-held state are preserved. */
export async function sweepDeadSessions(): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(sessionsRoot(), { withFileTypes: true });
  } catch {
    return 0; // root not created yet — nothing to sweep
  }
  let removed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      const dir = path.join(sessionsRoot(), entry.name);
      const owner = await readSessionOwner(dir);
      if (owner.state === "invalid") return;
      if (owner.state === "missing") {
        if (
          (await hasPendingRecovery(dir)) ||
          !(await isRecognizableLegacySession(dir))
        )
          return;
        try {
          await fsp.rm(dir, { recursive: true, force: true });
          removed++;
        } catch {
          /* best-effort */
        }
        return;
      }
      const pid = owner.pid;
      if (
        !pid ||
        pid <= 0 ||
        isProcessAlive(pid) ||
        (await hasPendingRecovery(dir))
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
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
  return id;
}
