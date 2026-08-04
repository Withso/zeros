// ──────────────────────────────────────────────────────────
// Workspace + Git watcher — terminal / agent / external-edit detection
// ──────────────────────────────────────────────────────────
//
// Agents and the embedded terminal run `git` through their OWN shell, which
// bypasses the engine's bridge ops entirely — so the engine never emits a
// DB_CHANGED for those writes and the renderer's Source tab would silently go
// stale. This watcher closes both halves of that gap:
//   • chokidar watches working-tree CONTENT (create/change/delete) so a plain
//     `echo > file`, editor save, agent patch, or `git clean` is visible; and
//   • a tiny stat poll watches per-worktree and shared git-dir STATE so stage,
//     commit, checkout, fetch, and ref updates that don't necessarily touch
//     working-tree content are visible too.
// Either signal lets the engine broadcast DB_CHANGED kinds:["workspaces"] so
// row-1 files, All Files, the Changes list, and its badge re-pull together. A
// managed worktree carries only its opaque workspace id; rowless/ambiguous
// roots deliberately fall back to a coarse event without exposing host paths.
//
// chokidar v4 is pure JS (no native addon inside the compiled Bun engine) and is
// already the engine's supported watcher. No event writes or respawns the
// engine; bursts are debounced into one renderer invalidation. Internal .git /
// .zeros state and dependency trees are excluded; tracked build/dist files are
// intentionally still observed because they appear in All Files/Changes. The
// git-dir poll remains a bounded mtime+ctime+size guard — and its filesystem
// work is fully ASYNC (fs.promises) with a single-flight guard: the engine is
// single-threaded under Bun, and the old sync walk (readdirSync + a statSync
// per collected path, up to thousands per second on a big repo's ref tree)
// stalled ALL HTTP/WS handling on every 1s tick.
//
// We watch three per-worktree git-dir files:
//   • HEAD       — branch switch / checkout / detach
//   • index      — stage / unstage / reset (the staging area)
//   • logs/HEAD  — commit / merge / pull / reset (the HEAD reflog; appended on
//                  every commit, and per-worktree even for linked worktrees)
// We also watch FETCH_HEAD, packed-refs, and bounded local/remote ref trees in
// the COMMON git dir. Those catch an external fetch or another linked worktree
// advancing a branch/base without touching this worktree's own files.
// The per-worktree files live in the REAL git dir, which for a linked worktree
// (`.git` is a `gitdir:` pointer file, the shape `git worktree add` creates) is
// `<main>/.git/worktrees/<name>` — resolveGitDir() handles both shapes.
// ──────────────────────────────────────────────────────────

import { type Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar";

const POLL_INTERVAL_MS = 1_000;
const WORKTREE_DEBOUNCE_MS = 75;

/** Per-worktree git-dir files that change on a terminal/agent git op. */
const GIT_STATE_FILES = ["HEAD", "index", "logs/HEAD"] as const;
const COMMON_GIT_STATE_FILES = ["FETCH_HEAD", "packed-refs"] as const;
/** The common-dir ref trees whose walk feeds the poll. The reflog mirrors
 *  (logs/refs/heads, logs/refs/remotes) are deliberately NOT walked: every git
 *  op that appends a branch reflog also rewrites the loose ref (or packed-refs)
 *  we already watch — plus the ref DIRECTORY signature catches create/delete —
 *  and commit/merge/reset detection rides the per-worktree logs/HEAD above.
 *  Reflog-only mutations (reflog expire/delete, gc) change no ref and no
 *  working-tree state, so skipping them loses no invalidation while halving
 *  the per-tick directory walk. */
const COMMON_GIT_STATE_DIRS = ["refs/heads", "refs/remotes"] as const;
const MAX_COMMON_GIT_STATE_PATHS = 4_096;

interface FileSig {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

export interface GitWatcher {
  /** Initial working-tree subscriptions are live AND the git-state poll has
   * primed its baseline signatures (the poll's fs work is async). Engine
   * startup need not wait for this, but tests and orderly shutdown can. */
  ready: Promise<void>;
  /** Stop observing one exact working-tree root and wait until Chokidar has
   * released its native recursive subscription. The returned suspension is
   * settled as either resumed (the workspace stayed live after a failure) or
   * retired (the checkout moved and its old callbacks must remain inert).
   *
   * Archive/delete must await this before atomically moving a checkout. On
   * macOS, deleting a large renamed directory while FSEvents still owns the
   * inode can flood or wedge Bun's event loop after the request has returned. */
  suspendRoot(root: string): Promise<GitRootSuspension>;
  stop(): Promise<void>;
}

export interface GitRootSuspension {
  /** The checkout stayed live, so allow the dynamic target provider to
   * subscribe again immediately. Idempotent. */
  resume(): void;
  /** The checkout was moved. Keep swallowing already-queued native callbacks
   * for its old path through background deletion; a later restore of the same
   * semantic root automatically starts a fresh subscription. Idempotent. */
  retire(): void;
}

export interface GitWatcherOptions {
  pollIntervalMs?: number;
  worktreeDebounceMs?: number;
  awaitWriteFinishMs?: number;
  /** Test/host fallback for environments whose native watcher pool is full. */
  usePolling?: boolean;
  worktreePollIntervalMs?: number;
}

/** One filesystem root and the opaque engine workspace it belongs to. Repo
 * roots without a row intentionally carry null: their host path must never be
 * copied into the cross-device DB_CHANGED payload. */
export interface GitWatchTarget {
  root: string;
  workspaceId: string | null;
}

/** A burst can touch several managed worktrees. `coarse` means at least one
 * changed path could not be assigned a safe opaque workspace id. */
export interface GitWatchChange {
  workspaceIds: string[];
  coarse: boolean;
  /** Working-tree content changed (create/edit/delete), as opposed to only
   * Git metadata. Consumers with source-derived caches use this narrower bit
   * so stage/fetch/ref activity does not discard still-valid data. */
  worktreeChanged?: true;
  /** A shared/common Git ref changed (fetch, branch create/delete/advance).
   * Consumers use this to invalidate branch catalogs without doing that work
   * for ordinary source-file saves. */
  gitRefsChanged?: true;
}

/** Resolve a working-tree root to its real git dir. `<root>/.git` is a
 *  directory for a normal checkout, or a `gitdir: <path>` pointer file for a
 *  linked worktree (the shape `git worktree add` creates). Returns null when
 *  the root isn't a git working tree (yet). */
async function resolveGitDir(root: string): Promise<string | null> {
  const dotGit = join(root, ".git");
  let st;
  try {
    st = await stat(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  // `.git` is a file: "gitdir: <absolute-or-relative path>".
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (!m) return null;
    const target = m[1].trim();
    return isAbsolute(target) ? target : resolve(root, target);
  } catch {
    return null;
  }
}

async function resolveCommonGitDir(gitDir: string): Promise<string> {
  try {
    const target = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (target) return isAbsolute(target) ? target : resolve(gitDir, target);
  } catch {
    /* A primary checkout has no commondir file; its git dir is common. */
  }
  return gitDir;
}

/** Include directories as well as files: directory signatures detect a newly
 * created/deleted ref, while file signatures detect an existing ref advancing.
 * The cap keeps pathological repositories from turning a one-second poll into
 * an unbounded filesystem walk; FETCH_HEAD remains covered independently. */
async function collectCommonGitStatePaths(
  commonDir: string,
): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (paths.length >= MAX_COMMON_GIT_STATE_PATHS) return;
    paths.push(dir);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_COMMON_GIT_STATE_PATHS) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) paths.push(child);
    }
  };
  for (const relativePath of COMMON_GIT_STATE_DIRS) {
    await visit(join(commonDir, relativePath));
  }
  return paths;
}

async function signature(filePath: string): Promise<FileSig | null> {
  try {
    const s = await stat(filePath);
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size };
  } catch {
    return null; // missing (e.g. no reflog yet) — a valid state; appears later = a change
  }
}

function sigEqual(a: FileSig | null, b: FileSig | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
  );
}

function readTargets(targets: () => GitWatchTarget[]): GitWatchTarget[] | null {
  try {
    const byRoot = new Map<string, GitWatchTarget>();
    for (const target of targets()) {
      if (!target.root) continue;
      const root = resolve(target.root);
      const existing = byRoot.get(root);
      // Prefer an exact identity if a root appears both as a registered repo
      // root and a live worktree.
      if (!existing?.workspaceId || target.workspaceId) {
        byRoot.set(root, {
          root,
          workspaceId: target.workspaceId || null,
        });
      }
    }
    return Array.from(byRoot.values());
  } catch {
    return null; // DB briefly unavailable — keep prior roots and retry
  }
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function changedTargetForPath(
  filePath: string,
  targetsByRoot: ReadonlyMap<string, GitWatchTarget>,
): GitWatchTarget | null {
  const absolutePath = resolve(filePath);
  let match: GitWatchTarget | null = null;
  for (const target of targetsByRoot.values()) {
    if (!isPathInsideRoot(absolutePath, target.root)) continue;
    // Nested watched roots are legal; the most specific owner wins.
    if (!match || target.root.length > match.root.length) match = target;
  }
  return match;
}

function makeChange(
  targets: Iterable<GitWatchTarget | null>,
  gitRefsChanged = false,
  worktreeChanged = false,
): GitWatchChange {
  const workspaceIds = new Set<string>();
  let coarse = false;
  for (const target of targets) {
    if (target?.workspaceId) workspaceIds.add(target.workspaceId);
    else coarse = true;
  }
  return {
    workspaceIds: Array.from(workspaceIds),
    coarse,
    ...(worktreeChanged ? { worktreeChanged: true as const } : {}),
    ...(gitRefsChanged ? { gitRefsChanged: true as const } : {}),
  };
}

/** Watch every known working tree plus its git-dir state. `targets` is
 * re-evaluated each poll so newly created/removed worktrees are subscribed
 * without an engine restart. */
export function startGitWatcher(
  targets: () => GitWatchTarget[],
  onChange: (change: GitWatchChange) => void,
  options: GitWatcherOptions = {},
): GitWatcher {
  const known = new Map<string, FileSig | null>();
  let primed = false;
  let stopped = false;
  let worktreeTimer: ReturnType<typeof setTimeout> | null = null;
  const initialTargets = readTargets(targets) ?? [];
  let targetsByRoot = new Map(
    initialTargets.map((target) => [target.root, target] as const),
  );
  const suspendedRoots = new Map<
    string,
    {
      state: "suspended" | "retired";
      expiry: ReturnType<typeof setTimeout> | null;
    }
  >();
  const retiredWatchers = new Set<Promise<void>>();
  const pendingWorktreeTargets = new Map<string, GitWatchTarget>();
  let pendingWorktreeCoarse = false;

  const watcherOptions = (usePolling: boolean): ChokidarOptions => ({
    // Generated/dependency dirs are excluded for the same reason as
    // node_modules: they hold the bulk of a worktree's files, are effectively
    // always gitignored (so their events refetch a status that hasn't
    // changed), and under the packaged stat-poll backend every non-ignored
    // file costs a persistent per-file poller — the watcher's memory and idle
    // CPU scale directly with this set. Mirrors src/engine/watcher.ts.
    ignored: [
      /(?:^|[\\/])\.git(?:[\\/]|$)/,
      /(?:^|[\\/])\.zeros(?:[\\/]|$)/,
      /(?:^|[\\/])node_modules(?:[\\/]|$)/,
      /(?:^|[\\/])dist(?:[\\/]|$)/,
      /(?:^|[\\/])build(?:[\\/]|$)/,
      /(?:^|[\\/])out(?:[\\/]|$)/,
      /(?:^|[\\/])coverage(?:[\\/]|$)/,
      /(?:^|[\\/])target(?:[\\/]|$)/,
      /(?:^|[\\/])\.next(?:[\\/]|$)/,
      /(?:^|[\\/])\.nuxt(?:[\\/]|$)/,
      /(?:^|[\\/])\.turbo(?:[\\/]|$)/,
      /(?:^|[\\/])\.cache(?:[\\/]|$)/,
      /(?:^|[\\/])\.venv(?:[\\/]|$)/,
      /(?:^|[\\/])venv(?:[\\/]|$)/,
      /(?:^|[\\/])__pycache__(?:[\\/]|$)/,
      /(?:^|[\\/])\.pytest_cache(?:[\\/]|$)/,
      /\.zeros-tmp$/,
    ],
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignorePermissionErrors: true,
    usePolling,
    interval: options.worktreePollIntervalMs ?? (usePolling ? 750 : 100),
    awaitWriteFinish: {
      stabilityThreshold: options.awaitWriteFinishMs ?? 30,
      pollInterval: 10,
    },
  });

  let resolveReady!: () => void;
  let readyResolved = false;
  const ready = new Promise<void>((resolveReadyPromise) => {
    resolveReady = () => {
      if (readyResolved) return;
      readyResolved = true;
      resolveReadyPromise();
    };
  });
  const scheduleWorktreeChange = (target: GitWatchTarget | null) => {
    if (stopped) return;
    if (target) pendingWorktreeTargets.set(target.root, target);
    else pendingWorktreeCoarse = true;
    if (worktreeTimer) clearTimeout(worktreeTimer);
    worktreeTimer = setTimeout(() => {
      worktreeTimer = null;
      if (stopped) return;
      const change = makeChange(
        [
          ...pendingWorktreeTargets.values(),
          ...(pendingWorktreeCoarse ? [null] : []),
        ],
        false,
        true,
      );
      pendingWorktreeTargets.clear();
      pendingWorktreeCoarse = false;
      onChange(change);
    }, options.worktreeDebounceMs ?? WORKTREE_DEBOUNCE_MS);
  };

  const rootKey = (root: string) => resolve(root);
  const isSuspended = (root: string) => suspendedRoots.has(rootKey(root));
  const isInsideSuspendedRoot = (filePath: string) => {
    const resolvedPath = resolve(filePath);
    for (const suspendedRoot of suspendedRoots.keys()) {
      const rel = relative(suspendedRoot, resolvedPath);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return true;
      }
    }
    return false;
  };
  const trackRetiredWatcher = (retirement: Promise<void>) => {
    retiredWatchers.add(retirement);
    void retirement.then(
      () => retiredWatchers.delete(retirement),
      () => retiredWatchers.delete(retirement),
    );
  };
  type RootWatcher = {
    watcher: FSWatcher;
    target: GitWatchTarget;
    polling: boolean;
  };
  // One Chokidar instance per semantic root is intentional. `unwatch(root)` on
  // a shared macOS FSEvents stream can keep following the inode after an atomic
  // rename. Closing the exact root's FSWatcher is the only authoritative
  // teardown before archive/delete recursively cleans the renamed checkout.
  const rootWatchers = new Map<string, RootWatcher>();
  const installRootWatcher = (
    target: GitWatchTarget,
    polling = options.usePolling ?? false,
    invalidateWhenReady = false,
  ): Promise<void> => {
    const key = rootKey(target.root);
    const native = chokidar.watch(target.root, watcherOptions(polling));
    const entry: RootWatcher = { watcher: native, target, polling };
    rootWatchers.set(key, entry);
    const becameReady = new Promise<void>((resolveRootReady) => {
      native.once("ready", () => {
        resolveRootReady();
        // A file can change after a native watcher fails but before its polling
        // replacement finishes its initial scan. Force one exact refresh at
        // the end of that handoff.
        if (invalidateWhenReady && rootWatchers.get(key) === entry) {
          scheduleWorktreeChange(entry.target);
        }
      });
    });
    native.on("all", (_event, filePath) => {
      if (rootWatchers.get(key) !== entry) return;
      const changed = changedTargetForPath(filePath, targetsByRoot);
      if (
        (changed && isSuspended(changed.root)) ||
        (!changed && isInsideSuspendedRoot(filePath))
      ) {
        return;
      }
      // An active root always has an owner. Falling back to its bound target
      // covers an OS path spelling that differs from path.resolve while still
      // retaining the exact workspace/coarse identity.
      scheduleWorktreeChange(changed ?? entry.target);
    });
    native.on("error", (error) => {
      if (rootWatchers.get(key) !== entry) return;
      const code = (error as NodeJS.ErrnoException).code;
      // Native fs.watch can exhaust a host's watcher pool (EMFILE/ENOSPC) on a
      // very large repo or a machine running many dev tools. Fall back only
      // this exact root to stat polling; unrelated workspaces stay live.
      if (
        !stopped &&
        !entry.polling &&
        (code === "EMFILE" || code === "ENOSPC")
      ) {
        console.warn(
          `[git-watch] native watcher unavailable (${code}); falling back to polling`,
        );
        rootWatchers.delete(key);
        trackRetiredWatcher(native.close().catch(() => {}));
        if (!isSuspended(entry.target.root)) {
          void installRootWatcher(entry.target, true, true);
        }
        return;
      }
      console.error("[git-watch] workspace watcher error:", error);
    });
    return becameReady;
  };

  const initialReady = Array.from(targetsByRoot.values()).map((target) =>
    installRootWatcher(target),
  );
  // `ready` also waits for the git-state PRIME tick (kicked off below) so a
  // caller that awaits it can rely on the next state change being diffed
  // against a complete baseline — see the bottom of this function.

  const syncWorkingTreeTargets = (nextTargets: GitWatchTarget[]) => {
    // A retired path becoming a live target again is a restore (or a fresh
    // owner at that exact semantic key). Drop the old-inode tombstone before
    // constructing the next set so the new checkout gets a fresh watcher.
    for (const target of nextTargets) {
      const key = rootKey(target.root);
      const suspension = suspendedRoots.get(key);
      if (suspension?.state !== "retired") continue;
      if (suspension.expiry) clearTimeout(suspension.expiry);
      suspendedRoots.delete(key);
    }
    const nextByRoot = new Map(
      nextTargets
        .filter((target) => !isSuspended(target.root))
        .map((target) => [target.root, target] as const),
    );
    targetsByRoot = nextByRoot;
    const nextByKey = new Map(
      Array.from(nextByRoot.values()).map((target) => [
        rootKey(target.root),
        target,
      ]),
    );
    for (const [key, entry] of rootWatchers) {
      const nextTarget = nextByKey.get(key);
      if (nextTarget) {
        entry.target = nextTarget;
        continue;
      }
      rootWatchers.delete(key);
      pendingWorktreeTargets.delete(entry.target.root);
      trackRetiredWatcher(entry.watcher.close().catch(() => {}));
    }
    for (const [key, target] of nextByKey) {
      if (rootWatchers.has(key)) continue;
      // A dynamic root can change after the target poll discovers it but
      // before Chokidar finishes its ignoreInitial scan. Publish one exact
      // refresh at readiness so that handoff window cannot swallow the first
      // edit to a restored or newly-created checkout.
      void installRootWatcher(target, options.usePolling ?? false, true);
    }
  };

  const tick = async (): Promise<void> => {
    // The dynamic-target read and the worktree-watcher sync stay synchronous
    // and run BEFORE the first await, so suspendRoot/stop never interleave
    // with them mid-tick.
    const watchTargets = readTargets(targets);
    if (!watchTargets) return;
    syncWorkingTreeTargets(watchTargets);

    const paths = new Map<
      string,
      {
        owners: Map<string, GitWatchTarget>;
        gitRefsChanged: boolean;
      }
    >();
    const addPath = (
      filePath: string,
      target: GitWatchTarget,
      gitRefsChanged = false,
    ) => {
      let watched = paths.get(filePath);
      if (!watched) {
        watched = { owners: new Map(), gitRefsChanged };
        paths.set(filePath, watched);
      } else if (gitRefsChanged) {
        watched.gitRefsChanged = true;
      }
      watched.owners.set(target.root, target);
    };
    const targetsByCommonDir = new Map<string, Map<string, GitWatchTarget>>();
    for (const target of watchTargets) {
      const gitDir = await resolveGitDir(target.root);
      if (stopped) return;
      if (!gitDir) continue;
      for (const f of GIT_STATE_FILES) {
        addPath(join(gitDir, f), target);
      }
      const commonDir = await resolveCommonGitDir(gitDir);
      let owners = targetsByCommonDir.get(commonDir);
      if (!owners) {
        owners = new Map();
        targetsByCommonDir.set(commonDir, owners);
      }
      owners.set(target.root, target);
    }
    for (const [commonDir, owners] of targetsByCommonDir) {
      const commonPaths = [
        ...COMMON_GIT_STATE_FILES.map((file) => join(commonDir, file)),
        ...(await collectCommonGitStatePaths(commonDir)),
      ];
      if (stopped) return;
      for (const filePath of commonPaths) {
        for (const target of owners.values()) addPath(filePath, target, true);
      }
    }

    // Stat every watched path concurrently — each stat is independent, and the
    // per-path change decision below only needs the resulting signatures.
    const sigs = await Promise.all(
      Array.from(paths.keys(), async (p) => [p, await signature(p)] as const),
    );
    if (stopped) return;
    const changedTargets = new Map<string, GitWatchTarget>();
    let gitRefsChanged = false;
    const seen = new Set<string>();
    for (const [p, sig] of sigs) {
      const watched = paths.get(p);
      if (!watched) continue;
      seen.add(p);
      if (primed && known.has(p) && !sigEqual(known.get(p) ?? null, sig)) {
        if (watched.gitRefsChanged) gitRefsChanged = true;
        for (const target of watched.owners.values()) {
          changedTargets.set(target.root, target);
        }
      }
      known.set(p, sig);
    }
    // Forget paths for worktrees that disappeared, so a later re-add re-primes
    // cleanly instead of diffing against a stale signature.
    for (const p of Array.from(known.keys())) {
      if (!seen.has(p)) known.delete(p);
    }
    primed = true;
    if (changedTargets.size > 0) {
      onChange(makeChange(changedTargets.values(), gitRefsChanged));
    }
  };

  // Single-flight guard: the tick's fs work is async now, so a slow tick (a
  // huge ref tree, a cold network volume) could still be running when the next
  // interval fires — skip instead of overlapping so poll pressure can never
  // pile up. The skipped state is picked up by the following tick's diff.
  let tickInFlight: Promise<void> | null = null;
  const runTick = () => {
    if (tickInFlight || stopped) return;
    tickInFlight = tick()
      .catch(() => {
        /* per-path fs errors are handled inside; nothing else may throw the poll away */
      })
      .finally(() => {
        tickInFlight = null;
      });
  };

  runTick(); // prime signatures so the first interval doesn't fire spuriously
  // `ready` = every initial worktree subscription is live AND the prime tick
  // has recorded its baseline signatures.
  void Promise.all([...initialReady, tickInFlight ?? Promise.resolve()]).then(
    resolveReady,
  );
  const timer = setInterval(
    runTick,
    options.pollIntervalMs ?? POLL_INTERVAL_MS,
  );
  timer.unref?.(); // never keep the engine process alive just for git polling

  return {
    ready,
    async suspendRoot(root: string) {
      const key = rootKey(root);
      if (suspendedRoots.has(key)) {
        // Workspace lifecycle is single-flight, so this is only a defensive
        // idempotency path. Keep the first suspension authoritative.
        return { resume() {}, retire() {} };
      }
      const suspension: {
        state: "suspended" | "retired";
        expiry: ReturnType<typeof setTimeout> | null;
      } = {
        state: "suspended",
        expiry: null,
      };
      suspendedRoots.set(key, suspension);
      const matches = Array.from(rootWatchers.entries()).filter(
        ([candidate]) => candidate === key,
      );
      for (const [candidate, entry] of matches) {
        rootWatchers.delete(candidate);
        pendingWorktreeTargets.delete(entry.target.root);
      }
      try {
        await Promise.all(matches.map(([, entry]) => entry.watcher.close()));
      } catch (error) {
        suspendedRoots.delete(key);
        const currentTargets = readTargets(targets);
        if (currentTargets) syncWorkingTreeTargets(currentTargets);
        throw error;
      }
      // Clear callbacks queued while the exact root watcher was closing.
      for (const [, entry] of matches) {
        pendingWorktreeTargets.delete(entry.target.root);
      }

      let settled = false;
      const resume = () => {
        if (settled) return;
        settled = true;
        suspendedRoots.delete(key);
        if (!stopped) {
          const currentTargets = readTargets(targets);
          if (currentTargets) syncWorkingTreeTargets(currentTargets);
        }
      };
      const retire = () => {
        if (settled) return;
        settled = true;
        const current = suspendedRoots.get(key);
        if (current !== suspension) return;
        current.state = "retired";
        // Bound old-path tombstones even when an archived workspace is never
        // restored. Sixty seconds is far beyond the queued FSEvents/background
        // cleanup handoff while keeping long-running engines bounded.
        current.expiry = setTimeout(() => {
          if (suspendedRoots.get(key) !== current) return;
          suspendedRoots.delete(key);
          if (stopped) return;
          const currentTargets = readTargets(targets);
          if (currentTargets) syncWorkingTreeTargets(currentTargets);
        }, 60_000);
        current.expiry.unref?.();
      };
      return { resume, retire };
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Wait out an in-flight poll tick: its post-await guards make it inert
      // once `stopped` is set, but letting it finish keeps teardown orderly
      // (no stray fs promises racing a caller that removes the roots next).
      if (tickInFlight) await tickInFlight;
      if (worktreeTimer) clearTimeout(worktreeTimer);
      worktreeTimer = null;
      pendingWorktreeTargets.clear();
      pendingWorktreeCoarse = false;
      for (const suspension of suspendedRoots.values()) {
        if (suspension.expiry) clearTimeout(suspension.expiry);
      }
      suspendedRoots.clear();
      resolveReady();
      const activeWatchers = Array.from(rootWatchers.values());
      rootWatchers.clear();
      await Promise.all(
        activeWatchers.map((entry) => entry.watcher.close().catch(() => {})),
      );
      await Promise.all(retiredWatchers);
    },
  };
}
