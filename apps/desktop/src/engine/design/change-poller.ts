import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// Design directory change poller — prompt canvas refresh when packaged
// ──────────────────────────────────────────────────────────
//
// Packaged engines stat-poll worktrees every 1.5 s, because Bun's compiled
// runtime deadlocks once a native FSEvents watcher is armed (see the
// startGitWatcher call in zeros-engine.ts). An open Design canvas should not
// wait that long for an edit made in a person's own editor, a Git checkout or
// an agent's shell script. While a Design tab shows a checkout (style-build
// presence), this polls only that checkout's active Design directory, bounded
// in files, on a short interval, and reports a change so the canvas re-reads
// at once. An agent's finished tool call asks for a check immediately.
// Polling stays stat-only: no native watcher is ever armed here.

export interface DesignChangePollerHost {
  /** Checkouts a Design tab shows now. */
  presentRoots(): readonly string[];
  /** The Design directory the canvas reads for a checkout, relative to it. */
  directory(root: string): string | null;
  /** The directory changed since the previous scan. */
  changed(root: string): void;
}

export interface DesignChangePollerOptions {
  intervalMs?: number;
  /** Larger directories are left to the worktree watcher. */
  maxFiles?: number;
  /** At most this many checkouts are polled at once. */
  maxRoots?: number;
}

const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_ROOTS = 8;
const MAX_REMEMBERED_DIRECTORIES = 64;

/** The Design directory each checkout's latest canvas read resolved. Reads
 * resolve it themselves (pointer, registration or discovery), so this is the
 * directory the canvas actually shows. */
const readDirectories = new Map<string, string>();

export function noteDesignSnapshotDirectory(root: string, directory: string): void {
  const key = path.resolve(root);
  readDirectories.delete(key);
  readDirectories.set(key, directory);
  while (readDirectories.size > MAX_REMEMBERED_DIRECTORIES)
    readDirectories.delete(readDirectories.keys().next().value!);
}

export function designSnapshotDirectory(root: string): string | null {
  return readDirectories.get(path.resolve(root)) ?? null;
}

/** A content signature of a Design directory: every regular file's path,
 * size, modification time and inode, ignoring dotfiles and Zeros temporary
 * files. Null when the directory is missing or exceeds `maxFiles`. */
export async function designDirectorySignature(
  directory: string,
  maxFiles = DEFAULT_MAX_FILES,
): Promise<string | null> {
  const entries: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    let children: Dirent[];
    try {
      children = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch {
      if (relative === "") return null;
      continue;
    }
    for (const child of children) {
      if (child.name.startsWith(".") || child.name.endsWith(".zeros-tmp")) continue;
      const file = relative ? `${relative}/${child.name}` : child.name;
      if (child.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!child.isFile()) continue;
      if (entries.length >= maxFiles) return null;
      const info = await stat(path.join(directory, file)).catch(() => null);
      if (info) entries.push(`${file}\0${info.size}\0${info.mtimeMs}\0${info.ino}`);
    }
  }
  entries.sort();
  return createHash("sha1").update(entries.join("\n")).digest("hex");
}

export class DesignChangePoller {
  private readonly baselines = new Map<string, { directory: string; signature: string | null }>();
  private readonly scans = new Map<string, Promise<void>>();
  /** A scan requested while one runs, and whether it reports a change. */
  private readonly rescans = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxFiles: number;
  private readonly maxRoots: number;
  private stopped = false;

  constructor(
    private readonly host: DesignChangePollerHost,
    options: DesignChangePollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxRoots = options.maxRoots ?? DEFAULT_MAX_ROOTS;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.baselines.clear();
    this.rescans.clear();
  }

  /** Scan one shown checkout now (a tool that may have written Design files
   * just finished). A checkout no Design tab shows has no baseline and costs
   * nothing; one being scanned is scanned again once that scan ends. */
  check(root: string): Promise<void> {
    const key = path.resolve(root);
    if (this.stopped || !this.baselines.has(key)) return Promise.resolve();
    return this.scan(key, true);
  }

  /** Another path already refreshed this checkout's canvas for its current
   * files (an agent's saved edit): take a new baseline without reporting it,
   * so the next interval does not refresh the canvas a second time. */
  absorb(root: string): Promise<void> {
    const key = path.resolve(root);
    if (this.stopped || !this.baselines.has(key)) return Promise.resolve();
    return this.scan(key, false);
  }

  /** One interval: forget checkouts no longer shown, scan the rest. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let roots: string[];
    try {
      roots = [...new Set(this.host.presentRoots().map((root) => path.resolve(root)))].slice(
        0,
        this.maxRoots,
      );
    } catch {
      return;
    }
    const shown = new Set(roots);
    for (const root of [...this.baselines.keys()])
      if (!shown.has(root)) this.baselines.delete(root);
    await Promise.all(roots.map((root) => this.scan(root, true)));
  }

  private scan(root: string, report: boolean): Promise<void> {
    const running = this.scans.get(root);
    if (running) {
      // A queued scan reports when any request for it does.
      this.rescans.set(root, (this.rescans.get(root) ?? false) || report);
      return running;
    }
    const scan = this.scanNow(root, report).finally(() => {
      this.scans.delete(root);
      const again = this.rescans.get(root);
      this.rescans.delete(root);
      if (again !== undefined && !this.stopped) void this.scan(root, again);
    });
    this.scans.set(root, scan);
    return scan;
  }

  private async scanNow(root: string, report: boolean): Promise<void> {
    let directory: string | null;
    try {
      directory = this.host.directory(root);
    } catch {
      directory = null;
    }
    if (!directory) {
      this.baselines.delete(root);
      return;
    }
    const signature = await designDirectorySignature(
      path.join(root, ...directory.split("/")),
      this.maxFiles,
    ).catch(() => null);
    if (this.stopped) return;
    const previous = this.baselines.get(root);
    this.baselines.set(root, { directory, signature });
    // The first scan of a shown directory only sets its baseline; a switch
    // to another directory refreshes through its own read.
    if (!report || !previous || previous.directory !== directory) return;
    if (signature === null || previous.signature === null) return;
    if (signature === previous.signature) return;
    try {
      this.host.changed(root);
    } catch {
      // A failed broadcast waits for the worktree watcher.
    }
  }
}
