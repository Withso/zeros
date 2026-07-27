// Detach mode — run one workspace's changes inside the root checkout.
//
// Goal: the user keeps `pnpm electron:dev` running in their primary clone
// (the "root" main checkout). Detach mode mirrors one workspace's
// tracked-file changes into the root so the dev server picks them up
// without restart — without moving the root's branch ref.
//
// Mechanism (matches roadmap 03a § "Detach mode mechanics"):
//   1. Snapshot the root's current HEAD.
//   2. Make a checkpoint commit in the workspace (`commit --allow-empty`).
//   3. `git read-tree --reset -u <checkpoint-sha>` in the root — swaps
//      working files to match the checkpoint without moving any ref.
//   4. chokidar monitors workspace path changes; on each change
//      we re-commit + re-read-tree.
//   5. On stop, `git read-tree --reset -u <pre_root_head>` restores.
//
// Single-instance enforcement: a lockfile at <stateRoot>/detach.lock
// with the active PID + workspaceId. Stale PIDs (process gone) are
// reclaimed on detach_start.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";

import { GitError } from "./errors";
import { getWorkspace } from "./worktree";
import { runGit } from "./git-exec";
import { getInProgressState } from "./repo";
import {
  clearDetachState,
  detachLockPath,
  getDetachState,
  setDetachState,
  zerosStateRoot,
} from "./state";

interface ActiveDetach {
  workspaceId: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

let active: ActiveDetach | null = null;

/** Commit message stamped on every detach checkpoint. Shared so the
 *  stop-time unwind can recognise (and only unwind) its own commits. */
const CHECKPOINT_MESSAGE = "zeros: detach checkpoint";

/** Count the leading (newest-first) consecutive detach-checkpoint commits in
 *  a commit-subject list — how many to `reset --soft` off the workspace
 *  branch on stop so detach doesn't litter history. Stops at the first real
 *  commit, so a commit the user made mid-detach is preserved. */
export function trailingCheckpointCount(subjects: string[]): number {
  let n = 0;
  for (const s of subjects) {
    if (s.trim() !== CHECKPOINT_MESSAGE) break;
    n++;
  }
  return n;
}

// ── Lockfile ─────────────────────────────────────────────

interface Lock {
  pid: number;
  workspaceId: string;
  startedAt: number;
}

function readLock(): Lock | null {
  const p = detachLockPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Lock;
  } catch {
    return null;
  }
}

function writeLock(lock: Lock): void {
  mkdirSync(zerosStateRoot(), { recursive: true });
  writeFileSync(detachLockPath(), JSON.stringify(lock, null, 2), "utf8");
}

function removeLock(): void {
  try {
    unlinkSync(detachLockPath());
  } catch {
    /* best effort */
  }
}

/** True if the lockfile's PID is alive in the OS process table. We
 *  use `process.kill(pid, 0)` which sends signal 0 — a no-op that
 *  still raises ESRCH if the process is gone. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}

// ── Watcher event handling ───────────────────────────────

const DEBOUNCE_MS = 150;

/** Debounce file events so a burst of saves (a single editor command can
 *  emit dozens) collapses into one re-sync. 150ms balances responsiveness
 *  against thrashing. */
function scheduleSync(workspaceId: string, rootPath: string): void {
  if (!active) return;
  if (active.debounceTimer) clearTimeout(active.debounceTimer);
  active.debounceTimer = setTimeout(() => {
    active!.debounceTimer = null;
    syncWorkspaceToRoot(workspaceId, rootPath).catch((err) => {
      // We can't surface this to the renderer without an event channel
      // (the engine module doesn't depend on Electron). Best-effort
      // log; the renderer can poll detach_status and notice if active
      // unexpectedly flipped to false.
      console.error("[detach] sync failed:", err);
    });
  }, DEBOUNCE_MS);
}

async function syncWorkspaceToRoot(
  workspaceId: string,
  rootPath: string,
): Promise<void> {
  const ws = getWorkspace(workspaceId);
  // Stage all tracked changes. Untracked files are intentionally excluded:
  // mirroring them would pollute the root checkout with build artefacts and
  // scratch files the user never asked to see there.
  await runGit(ws.path, ["add", "-u"]);
  // Empty checkpoint commits are allowed — they make a parent-less ref
  // chain if the user edited nothing tracked but the watcher still fired.
  await runGit(ws.path, ["commit", "--allow-empty", "-m", CHECKPOINT_MESSAGE]);
  const { stdout } = await runGit(ws.path, ["rev-parse", "HEAD"]);
  const checkpointSha = stdout.trim();
  await runGit(rootPath, ["read-tree", "--reset", "-u", checkpointSha]);
  const current = getDetachState();
  if (current) {
    setDetachState({ ...current, checkpointSha });
  }
}

// ── Public API ───────────────────────────────────────────

export interface DetachStartOptions {
  workspaceId: string;
}

export interface DetachStartResult {
  startedAt: number;
  checkpointSha: string;
  rootHead: string;
}

export async function detachStart(
  opts: DetachStartOptions,
): Promise<DetachStartResult> {
  // Single-instance guard.
  const existing = readLock();
  if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    throw new GitError({
      code: "DETACH_LOCKED",
      message: `Detach mode is already active (workspace ${existing.workspaceId}, pid ${existing.pid})`,
      remediation: "Stop the active detach before starting a new one.",
      context: { heldBy: existing },
    });
  }
  if (existing && existing.pid === process.pid && active) {
    throw new GitError({
      code: "DETACH_LOCKED",
      message: `Detach mode is already active in this process for ${active.workspaceId}`,
      remediation: "Call detach_stop first.",
    });
  }
  // Stale lock — process is gone. Reclaim.
  if (existing && !isPidAlive(existing.pid)) {
    removeLock();
    clearDetachState();
  }

  const ws = getWorkspace(opts.workspaceId);
  const rootPath = ws.repoRoot;

  // Refuse to start when either side is in the middle of a multi-step
  // git operation — read-tree mid-rebase would silently corrupt state.
  const wsInProgress = await getInProgressState(ws.path);
  if (wsInProgress) {
    throw new GitError({
      code: wsInProgress === "merge" ? "MERGE_IN_PROGRESS" : "REBASE_IN_PROGRESS",
      message: `Workspace has an in-progress ${wsInProgress}. Finish or abort it before starting detach.`,
    });
  }
  const rootInProgress = await getInProgressState(rootPath);
  if (rootInProgress) {
    throw new GitError({
      code: rootInProgress === "merge" ? "MERGE_IN_PROGRESS" : "REBASE_IN_PROGRESS",
      message: `Root checkout has an in-progress ${rootInProgress}. Finish or abort it before starting detach.`,
    });
  }

  // M12: the `read-tree --reset -u` below OVERWRITES the root working tree. If
  // the root has uncommitted TRACKED changes they'd be silently destroyed —
  // refuse and ask the user to commit/stash first. (`-uno` ignores untracked,
  // which read-tree leaves alone.)
  const { stdout: rootDirty } = await runGit(rootPath, [
    "status",
    "--porcelain=v1",
    "-uno",
  ]);
  if (rootDirty.trim().length > 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Root checkout has uncommitted changes — commit or stash them before starting detach.",
    });
  }

  // 1. Snapshot root HEAD.
  const { stdout: rootHeadOut } = await runGit(rootPath, [
    "rev-parse",
    "HEAD",
  ]);
  const rootHead = rootHeadOut.trim();

  // 2. Initial checkpoint commit + 3. read-tree into root.
  await runGit(ws.path, ["add", "-u"]);
  await runGit(ws.path, ["commit", "--allow-empty", "-m", CHECKPOINT_MESSAGE]);
  const { stdout: shaOut } = await runGit(ws.path, ["rev-parse", "HEAD"]);
  const checkpointSha = shaOut.trim();
  await runGit(rootPath, ["read-tree", "--reset", "-u", checkpointSha]);

  // 4. Start the watcher. chokidar (v4, pure-JS — no native bindings) so the
  // engine still boots as a Bun single-file executable. @parcel/watcher's
  // native `watcher.node` addon CANNOT be loaded from inside a `bun --compile`
  // binary and crashed the engine on startup (regression: the rest of the
  // engine deliberately avoids native watchers — see watcher.ts / git/watch.ts).
  // Ignore .git/node_modules/build dirs — the user's editor doesn't produce
  // events there, but the watcher would still wake on every git ref update.
  const startedAt = Date.now();
  const fsWatcher = chokidar.watch(ws.path, {
    ignored: [
      /(?:^|[\\/])\.git(?:[\\/]|$)/,
      /(?:^|[\\/])node_modules(?:[\\/]|$)/,
      /(?:^|[\\/])\.zeros(?:[\\/]|$)/,
      /(?:^|[\\/])dist(?:[\\/]|$)/,
      /(?:^|[\\/])build(?:[\\/]|$)/,
      /(?:^|[\\/])\.next(?:[\\/]|$)/,
      /(?:^|[\\/])\.turbo(?:[\\/]|$)/,
      /(?:^|[\\/])\.cache(?:[\\/]|$)/,
    ],
    ignoreInitial: true,
    persistent: true,
  });
  fsWatcher.on("all", () => scheduleSync(opts.workspaceId, rootPath));
  fsWatcher.on("error", (err) =>
    console.error("[detach] watcher error:", err),
  );
  // Resolve only once chokidar's initial scan completes, mirroring
  // @parcel/watcher.subscribe()'s "watcher is live when this resolves"
  // contract — so an edit made right after detachStart returns is observed.
  // 3s safety cap so a huge tree can't hang detach_start (the watch is already
  // attached by then regardless).
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3_000);
    fsWatcher.once("ready", () => {
      clearTimeout(t);
      resolve();
    });
  });

  active = {
    workspaceId: opts.workspaceId,
    watcher: fsWatcher,
    debounceTimer: null,
  };
  setDetachState({
    workspaceId: opts.workspaceId,
    preRootHead: rootHead,
    checkpointSha,
    startedAt,
    lockfilePid: process.pid,
  });
  writeLock({
    pid: process.pid,
    workspaceId: opts.workspaceId,
    startedAt,
  });

  return { startedAt, checkpointSha, rootHead };
}

export interface DetachStopResult {
  stoppedAt: number;
  restoredHead: string;
}

export async function detachStop(): Promise<DetachStopResult> {
  const state = getDetachState();
  if (!state || !active) {
    throw new GitError({
      code: "DETACH_NOT_ACTIVE",
      message: "Detach is not active",
    });
  }
  // Stop the watcher first so a stray event during read-tree doesn't
  // trigger a checkpoint commit on the way out.
  try {
    await active.watcher.close();
  } catch {
    /* best effort */
  }
  if (active.debounceTimer) clearTimeout(active.debounceTimer);
  active = null;

  const ws = getWorkspace(state.workspaceId);
  // Restore the root's working tree to what it was before detach.
  await runGit(ws.repoRoot, [
    "read-tree",
    "--reset",
    "-u",
    state.preRootHead,
  ]);
  // Unwind the trailing detach-checkpoint commits off the WORKSPACE branch so
  // detach doesn't leave "zeros: detach checkpoint" commits in history. The
  // cumulative edits survive as STAGED changes (reset --soft keeps the index +
  // working tree). Only consecutive trailing checkpoints are removed — a real
  // commit the user made mid-detach stops the unwind. Best-effort: a failure
  // here must not block stop (the root is already restored).
  try {
    const { stdout } = await runGit(ws.path, ["log", "--format=%s", "-n", "500"]);
    const n = trailingCheckpointCount(stdout.split("\n"));
    if (n > 0) {
      await runGit(ws.path, ["reset", "--soft", `HEAD~${n}`]);
    }
  } catch (err) {
    console.warn(
      `[detach] could not unwind checkpoint commits on stop: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  clearDetachState();
  removeLock();
  return { stoppedAt: Date.now(), restoredHead: state.preRootHead };
}

export interface DetachStatusResult {
  active: boolean;
  workspaceId?: string;
  startedAt?: number;
  checkpointSha?: string | null;
  /** When the lockfile points at another PID, this surfaces the holder
   *  so the renderer can show "Active in other Zeros window (pid 1234)". */
  heldByOtherPid?: number;
}

export function detachStatus(): DetachStatusResult {
  // The active-in-this-process branch is unambiguous.
  if (active) {
    const state = getDetachState();
    return {
      active: true,
      workspaceId: active.workspaceId,
      startedAt: state?.startedAt,
      checkpointSha: state?.checkpointSha ?? null,
    };
  }
  // Check the lockfile for cross-process detach.
  const lock = readLock();
  if (lock && isPidAlive(lock.pid)) {
    return {
      active: true,
      workspaceId: lock.workspaceId,
      startedAt: lock.startedAt,
      heldByOtherPid: lock.pid,
    };
  }
  // Lock is stale — clean up so subsequent detach_start doesn't have
  // to re-discover the stale state.
  if (lock) {
    removeLock();
    clearDetachState();
  }
  return { active: false };
}
