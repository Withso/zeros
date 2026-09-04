// Detach mode — run one workspace's changes inside the root checkout.
//
// Goal: the user keeps `pnpm electron:dev` running in their primary clone
// (the "root" main checkout). Detach mode mirrors one workspace's
// tracked-file changes into the root so the dev server picks them up
// without restart — without moving the root's branch ref.
//
// Mechanism:
//   1. Snapshot the root's current HEAD.
//   2. Build a tracked-Code checkpoint commit on a private ref with a scratch
//      index. The workspace branch and real index never move.
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import { GitError } from "./errors";
import { getWorkspace } from "./worktree";
import { runGit } from "./git-exec";
import { withWorkspaceGitMutation } from "./mutation-lock";
import { getInProgressState } from "./repo";
import {
  clearDetachState,
  detachLockPath,
  getDetachState,
  setDetachState,
  zerosStateRoot,
} from "./state";
import {
  discoverDesignDirectories,
  resolveDesignDirectoryPointerState,
} from "../design/directory";
import { designDirectoryNameFor } from "../design/directory-registry";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";

interface ActiveDetach {
  workspaceId: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
  syncTail: Promise<void>;
  stopping: boolean;
}

let active: ActiveDetach | null = null;

/** Commit message stamped on private detach checkpoint objects. */
const CHECKPOINT_MESSAGE = "zeros: detach checkpoint";

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
  const owner = active;
  if (!owner || owner.stopping) return;
  if (owner.debounceTimer) clearTimeout(owner.debounceTimer);
  owner.debounceTimer = setTimeout(() => {
    owner.debounceTimer = null;
    if (active !== owner || owner.stopping) return;
    const next = owner.syncTail.then(async () => {
      if (active !== owner || owner.stopping) return;
      await syncWorkspaceToRoot(workspaceId, rootPath);
    });
    owner.syncTail = next.catch((err) => {
      // We can't surface this to the renderer without an event channel
      // (the engine module doesn't depend on Electron). Best-effort
      // log; the renderer can poll detach_status and notice if active
      // unexpectedly flipped to false.
      console.error("[detach] sync failed:", err);
    });
  }, DEBOUNCE_MS);
}

async function detachDesignRoots(
  workspacePath: string,
  repoRoot: string,
): Promise<string[]> {
  const [discovered, sticky, pointer] = await Promise.all([
    discoverDesignDirectories(workspacePath),
    stickyRecognizedDesignDirectories(workspacePath),
    resolveDesignDirectoryPointerState({ repoRoot, workspacePath }),
  ]);
  return [
    ...new Set([
      designDirectoryNameFor(workspacePath),
      ...(pointer.configured ? [pointer.directory] : []),
      ...discovered,
      ...sticky,
    ]),
  ];
}

function detachCheckpointRef(workspaceId: string): string {
  return `refs/zeros/detach/${workspaceId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Build a tracked-Code projection in a scratch index. The workspace's real
 * index and HEAD never move, and every recognized Design root is reset to the
 * committed HEAD tree before the checkpoint object is written. */
async function createDetachCheckpoint(workspaceId: string): Promise<string> {
  const ws = getWorkspace(workspaceId);
  const scratchDir = await mkdtemp(path.join(tmpdir(), "zeros-detach-index-"));
  const env = { GIT_INDEX_FILE: path.join(scratchDir, "index") };
  try {
    const { stdout: headOut } = await runGit(ws.path, ["rev-parse", "HEAD"]);
    const head = headOut.trim();
    await runGit(ws.path, ["read-tree", head], { env });
    await runGit(ws.path, ["add", "-u"], { env });
    const designRoots = await detachDesignRoots(ws.path, ws.repoRoot);
    for (const designRoot of designRoots) {
      const { stdout: tracked } = await runGit(
        ws.path,
        [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          head,
          "--",
          `:(literal)${designRoot}`,
        ],
        { readOnly: true },
      );
      if (!tracked) continue;
      await runGit(
        ws.path,
        ["reset", "-q", head, "--", `:(literal)${designRoot}`],
        { env },
      );
    }
    const { stdout: treeOut } = await runGit(ws.path, ["write-tree"], { env });
    const { stdout: checkpointOut } = await runGit(
      ws.path,
      ["commit-tree", treeOut.trim(), "-p", head, "-m", CHECKPOINT_MESSAGE],
      { env },
    );
    const checkpointSha = checkpointOut.trim();
    await runGit(ws.path, [
      "update-ref",
      detachCheckpointRef(workspaceId),
      checkpointSha,
    ]);
    return checkpointSha;
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function syncWorkspaceToRoot(
  workspaceId: string,
  rootPath: string,
): Promise<void> {
  const ws = getWorkspace(workspaceId);
  await withWorkspaceGitMutation(ws.path, async () => {
    const checkpointSha = await createDetachCheckpoint(workspaceId);
    await runGit(rootPath, ["read-tree", "--reset", "-u", checkpointSha]);
    const current = getDetachState();
    if (current?.workspaceId === workspaceId) {
      setDetachState({ ...current, checkpointSha });
    }
  });
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
      code:
        wsInProgress === "merge" ? "MERGE_IN_PROGRESS" : "REBASE_IN_PROGRESS",
      message: `Workspace has an in-progress ${wsInProgress}. Finish or abort it before starting detach.`,
    });
  }
  const rootInProgress = await getInProgressState(rootPath);
  if (rootInProgress) {
    throw new GitError({
      code:
        rootInProgress === "merge" ? "MERGE_IN_PROGRESS" : "REBASE_IN_PROGRESS",
      message: `Root checkout has an in-progress ${rootInProgress}. Finish or abort it before starting detach.`,
    });
  }

  // The `read-tree --reset -u` below overwrites the root working tree. If
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
  const { stdout: rootHeadOut } = await runGit(rootPath, ["rev-parse", "HEAD"]);
  const rootHead = rootHeadOut.trim();

  // 2. Build a scratch tracked-Code checkpoint + 3. read-tree into root. No
  // workspace branch/index mutation occurs, so staged Code and Design lanes
  // stay exactly as the user left them.
  let checkpointSha = "";
  await withWorkspaceGitMutation(ws.path, async () => {
    checkpointSha = await createDetachCheckpoint(opts.workspaceId);
    await runGit(rootPath, ["read-tree", "--reset", "-u", checkpointSha]);
  });

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
  fsWatcher.on("error", (err) => console.error("[detach] watcher error:", err));
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
    syncTail: Promise.resolve(),
    stopping: false,
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
  // trigger a checkpoint refresh on the way out.
  active.stopping = true;
  try {
    await active.watcher.close();
  } catch {
    /* best effort */
  }
  if (active.debounceTimer) clearTimeout(active.debounceTimer);
  await active.syncTail;
  active = null;

  const ws = getWorkspace(state.workspaceId);
  // Restore the root's working tree to what it was before detach.
  await withWorkspaceGitMutation(ws.path, async () => {
    await runGit(ws.repoRoot, [
      "read-tree",
      "--reset",
      "-u",
      state.preRootHead,
    ]);
    await runGit(ws.path, [
      "update-ref",
      "-d",
      detachCheckpointRef(state.workspaceId),
    ]).catch(() => {});
  });
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
