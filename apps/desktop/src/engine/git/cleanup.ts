// Background worktree cleanup.
//
// Why: archiving or deleting a worktree often has to remove gigabytes of
// files. Asking `git worktree remove` to recursively walk the live checkout can
// block Bun's event loop for seconds-to-minutes, freezing every workspace
// request. Instead:
//
//   1. `fs.rename(worktree, sibling-trash/worktree)` — one same-filesystem
//      metadata operation, independent of checkout size.
//   2. A deferred native-Bun subprocess (or async fs fallback) walks the
//      renamed tree after the lifecycle transaction has continued.
//
// Net effect: archive/delete returns immediately; the disk reclaims space
// over the next few seconds. Owner markers let startup reclaim both legacy
// `/tmp/zeros-trash-*` and same-filesystem `.zeros-trash-*` after a crash.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/** Heavy directories worth move-then-async-delete. Anything not in this
 *  list gets the regular sync rm path. */
const HEAVY_DIR_NAMES = [
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".nuxt",
  "target",
  "out",
  ".cache",
  ".parcel-cache",
];
const TRASH_DIR_RE = /^\.?zeros-trash-[0-9a-f]{8}$/;
const TRASH_OWNER_FILE = ".zeros-trash-owner.json";
const LEGACY_TRASH_MIN_AGE_MS = 60 * 60 * 1000;
// Archive/delete closes the exact per-worktree native watcher before moving the
// checkout. Keep physical cleanup deferred too: this lets the lifecycle
// response unwind and gives already-queued macOS FSEvents callbacks time to be
// discarded by the retired-root tombstone. Recursive deletion remains entirely
// off the authoritative request path.
const BACKGROUND_REMOVE_DELAY_MS = 2_000;

interface TrashOwner {
  pid: number;
  worktreePath: string;
  createdAt: number;
}

export interface PreparedDirectoryEviction {
  /** Temporary destinations holding the moved directories. */
  moved: string[];
  /** Removal succeeded: delete the staged directories asynchronously. */
  commit(): void;
  /** Removal failed: put every staged directory back before reporting failure. */
  rollback(): Promise<void>;
}

/** Backwards-compatible name for callers that stage selected cache folders. */
export type PreparedHeavyDirEviction = PreparedDirectoryEviction;

async function markTrashOwner(
  trashRoot: string,
  worktreePath: string,
): Promise<void> {
  // Best-effort: markerless trash is still covered by the conservative age
  // gate, while a marker lets startup distinguish a live transaction from an
  // abandoned one immediately.
  await writeFile(
    path.join(trashRoot, TRASH_OWNER_FILE),
    JSON.stringify({
      pid: process.pid,
      worktreePath: path.resolve(worktreePath),
      createdAt: Date.now(),
    } satisfies TrashOwner),
  ).catch(() => {});
}

/** Stage heavy directories outside the worktree without deleting them yet.
 * Lifecycle callers can then roll the move back if `git worktree remove`
 * fails, so a failed archive/delete leaves the live checkout intact. */
export async function prepareHeavyDirEviction(
  worktreePath: string,
): Promise<PreparedDirectoryEviction> {
  const trashRoot = path.join(
    tmpdir(),
    `zeros-trash-${randomBytes(4).toString("hex")}`,
  );
  // SECURITY: `mkdir(..., { recursive: true })` SUCCEEDS on a path that already
  // exists, which made this a squattable target in a world-writable dir — guess
  // the suffix, pre-create it (or symlink it), and an evicted worktree gets
  // renamed somewhere you control (CodeQL js/insecure-temporary-file). Plain
  // non-recursive mkdir fails EEXIST instead, so a lost race aborts the eviction
  // loudly rather than proceeding into a hostile directory. tmpdir() always
  // exists, so `recursive` was never doing anything here anyway.
  //
  // NOT mkdtemp, deliberately: TRASH_DIR_RE above is /^\.?zeros-trash-[0-9a-f]{8}$/
  // and startup crash-reclaim uses it to find abandoned trash. mkdtemp's 6-char
  // mixed-case suffix does not match that, so switching primitives here would
  // quietly strand every orphaned trash dir instead of reclaiming it. This keeps
  // the 8-hex naming contract that the reclaim path and its test both assert, and
  // matches how the sibling `.zeros-trash-` root below is already created.
  await mkdir(trashRoot);
  await markTrashOwner(trashRoot, worktreePath);
  const entries: Array<{ src: string; dst: string }> = [];
  for (const name of HEAVY_DIR_NAMES) {
    const src = path.join(worktreePath, name);
    try {
      const st = await stat(src);
      if (!st.isDirectory()) continue;
      const dst = path.join(trashRoot, name);
      await rename(src, dst);
      entries.push({ src, dst });
    } catch {
      // Doesn't exist or not accessible — skip.
    }
  }
  if (entries.length === 0) {
    await rm(trashRoot, { recursive: true, force: true }).catch(() => {});
  }
  let state: "pending" | "committed" | "rolled-back" = "pending";
  return {
    moved: entries.map((entry) => entry.dst),
    commit() {
      if (state !== "pending") return;
      state = "committed";
      if (entries.length > 0) scheduleBackgroundRemove(trashRoot);
    },
    async rollback() {
      if (state !== "pending") return;
      // Check every destination before moving anything back. If a watcher
      // recreated one of these folders, preserve both copies for manual
      // recovery instead of leaving a half-rolled-back workspace.
      for (const entry of entries) {
        let sourceExists = false;
        try {
          await stat(entry.src);
          sourceExists = true;
        } catch {
          // Missing is the expected state while the directory is staged.
        }
        if (sourceExists) {
          throw new Error(
            `Cannot restore ${entry.src}: another process recreated it`,
          );
        }
      }
      // Reverse order is deterministic and mirrors stack-like staging.
      for (const entry of [...entries].reverse()) {
        await rename(entry.dst, entry.src);
      }
      state = "rolled-back";
      await rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Atomically move an entire checkout out of its registered path.
 *
 * The trash root is a sibling of the checkout, which guarantees the rename is
 * on the same filesystem (unlike `/tmp` on some machines). Git then sees a
 * missing worktree and only has to remove its small administrative entry; it
 * never recursively traverses the checkout on the engine's request path.
 *
 * Callers deliberately roll lifecycle operations forward after this rename.
 * The durable journal owns crash recovery, and the owner marker lets startup
 * reclaim the staged directory only after recovery has settled. */
export async function prepareWorktreeDirectoryEviction(
  worktreePath: string,
): Promise<PreparedDirectoryEviction> {
  const source = path.resolve(worktreePath);
  const trashRoot = path.join(
    path.dirname(source),
    `.zeros-trash-${randomBytes(4).toString("hex")}`,
  );
  const destination = path.join(trashRoot, "worktree");
  await mkdir(trashRoot);
  await markTrashOwner(trashRoot, source);
  try {
    await rename(source, destination);
  } catch (error) {
    await rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let state: "pending" | "committed" | "rolled-back" = "pending";
  return {
    moved: [destination],
    commit() {
      if (state !== "pending") return;
      state = "committed";
      scheduleBackgroundRemove(trashRoot);
    },
    async rollback() {
      if (state !== "pending") return;
      let sourceExists = false;
      try {
        await stat(source);
        sourceExists = true;
      } catch {
        // Missing is the expected state while the checkout is staged.
      }
      if (sourceExists) {
        throw new Error(
          `Cannot restore ${source}: another process recreated it`,
        );
      }
      await rename(destination, source);
      state = "rolled-back";
      await rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTrashOwner(trashRoot: string): Promise<TrashOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(trashRoot, TRASH_OWNER_FILE), "utf8"),
    ) as Partial<TrashOwner>;
    return typeof parsed.pid === "number" &&
      typeof parsed.worktreePath === "string" &&
      typeof parsed.createdAt === "number"
      ? {
          pid: parsed.pid,
          worktreePath: path.resolve(parsed.worktreePath),
          createdAt: parsed.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

/** Schedule deletion of abandoned lifecycle trash after crash recovery.
 *
 * New trash carries its creating PID + worktree. A live PID is never touched,
 * and a worktree with a still-pending lifecycle journal is protected so a
 * failed archive can retain its staged checkout for recovery.
 * Pre-marker directories use a conservative age gate. */
export async function pruneStaleHeavyDirTrash(
  opts: {
    root?: string;
    /** Managed roots contain repository directories; whole-checkout trash is
     * staged one level below each root beside the workspace it replaced. */
    managedRoots?: Iterable<string>;
    protectedWorktreePaths?: Iterable<string>;
    legacyMinAgeMs?: number;
    now?: number;
  } = {},
): Promise<number> {
  const root = opts.root ?? tmpdir();
  const protectedPaths = new Set(
    [...(opts.protectedWorktreePaths ?? [])].map((entry) =>
      path.resolve(entry),
    ),
  );
  const now = opts.now ?? Date.now();
  const legacyMinAgeMs = opts.legacyMinAgeMs ?? LEGACY_TRASH_MIN_AGE_MS;
  const scanRoots = new Set([path.resolve(root)]);
  for (const managedRoot of opts.managedRoots ?? []) {
    const resolvedRoot = path.resolve(managedRoot);
    scanRoots.add(resolvedRoot);
    try {
      const repoEntries = await readdir(resolvedRoot, {
        withFileTypes: true,
      });
      for (const entry of repoEntries) {
        if (entry.isDirectory() && !TRASH_DIR_RE.test(entry.name)) {
          scanRoots.add(path.join(resolvedRoot, entry.name));
        }
      }
    } catch {
      // A missing legacy/managed root has nothing to reclaim.
    }
  }
  let scheduled = 0;
  for (const scanRoot of scanRoots) {
    let entries;
    try {
      entries = await readdir(scanRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TRASH_DIR_RE.test(entry.name)) continue;
      const trashRoot = path.join(scanRoot, entry.name);
      const owner = await readTrashOwner(trashRoot);
      if (owner) {
        if (
          processIsAlive(owner.pid) ||
          protectedPaths.has(owner.worktreePath)
        ) {
          continue;
        }
      } else {
        try {
          const details = await stat(trashRoot);
          if (now - details.mtimeMs < legacyMinAgeMs) continue;
        } catch {
          continue;
        }
      }
      scheduleBackgroundRemove(trashRoot);
      scheduled += 1;
    }
  }
  return scheduled;
}

/** Move any heavy directories under `worktreePath` to /tmp, then schedule
 *  their deletion. Returns the list of trash paths so callers can log /
 *  monitor. */
export async function fastEvictHeavyDirs(
  worktreePath: string,
): Promise<string[]> {
  const prepared = await prepareHeavyDirEviction(worktreePath);
  prepared.commit();
  return prepared.moved;
}

type BunBackgroundRuntime = {
  spawn(
    command: string[],
    options: {
      stdin: "ignore";
      stdout: "ignore";
      stderr: "ignore";
    },
  ): { unref(): void };
};

function bunBackgroundRuntime(): BunBackgroundRuntime | null {
  const candidate = (
    globalThis as typeof globalThis & { Bun?: Partial<BunBackgroundRuntime> }
  ).Bun;
  return typeof candidate?.spawn === "function"
    ? (candidate as BunBackgroundRuntime)
    : null;
}

/** Start directory deletion outside the lifecycle transaction's call stack
 * and after native workspace watchers have retired the renamed checkout.
 *
 * The engine runs under Bun in development and in packaged builds. Keep the
 * recursive walk off Node's child-process compatibility layer and, more
 * importantly, off the authoritative lifecycle request. Bun's native
 * asynchronous subprocess API is designed for this server-style use. A
 * source-mode Node engine uses `fs.promises.rm`, which is likewise
 * asynchronous. */
function scheduleBackgroundRemove(target: string): void {
  const timer = setTimeout(() => {
    const bun = bunBackgroundRuntime();
    if (bun) {
      try {
        const child = bun.spawn(["rm", "-rf", "--", target], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
        return;
      } catch (error) {
        console.warn(
          `[cleanup] native background removal couldn't start for ${target}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    void rm(target, { recursive: true, force: true }).catch((error) => {
      console.warn(
        `[cleanup] background removal failed for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, BACKGROUND_REMOVE_DELAY_MS);
  timer.unref?.();
}

/** Convenience: atomically remove a worktree path and delete its old contents
 * in the background. */
export async function fastRemoveWorktreeDir(
  worktreePath: string,
): Promise<void> {
  const prepared = await prepareWorktreeDirectoryEviction(worktreePath);
  prepared.commit();
}
