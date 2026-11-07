import fs from "node:fs";
import path from "node:path";
import type { WatchHostClient, WorktreeWatchEvent, WorktreeWatcher } from "./watch-host-client";

const IGNORED_SEGMENT = /(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/;

/** How a Local engine watches worktree content: through its native watch host
 * when it has one; on macOS without one, with one recursive watch per root in
 * this process, since a watch per directory is one FSEvents stream each and
 * Bun registers those one at a time; elsewhere with Chokidar (undefined). */
export function localWorktreeNativeWatcher(
  host: WatchHostClient | null,
  platform: NodeJS.Platform,
): ((root: string) => WorktreeWatcher) | undefined {
  if (host) return (root) => host.watch(root);
  if (platform === "darwin") return watchWorktreeRecursively;
  return undefined;
}

/** One recursive fs.watch for a worktree root, with the events the native
 * watch host reports (git/watch-host.cjs) for the same changes. */
export function watchWorktreeRecursively(root: string): WorktreeWatcher {
  return new RecursiveRootWatcher(root);
}

class RecursiveRootWatcher implements WorktreeWatcher {
  private readonly allListeners = new Set<(event: WorktreeWatchEvent, filePath: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly readyListeners = new Set<() => void>();
  /** Known directories, so a deleted path reports as unlinkDir when it was one. */
  private readonly directories = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private ready = false;
  private closed = false;

  constructor(readonly root: string) {
    // Callers attach their listeners first, as with the host's reply.
    queueMicrotask(() => this.start());
  }

  on(event: "all", listener: (event: WorktreeWatchEvent, filePath: string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "all" | "error", listener: never): this {
    if (event === "all") this.allListeners.add(listener);
    else this.errorListeners.add(listener);
    return this;
  }

  once(_event: "ready", listener: () => void): this {
    if (this.ready) queueMicrotask(listener);
    else this.readyListeners.add(listener);
    return this;
  }

  // Git-ignored folders are filtered by the git watcher itself. A recursive
  // watch has no per-folder subscription to add or remove.
  add(): this {
    return this;
  }

  unwatch(): this {
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markReady();
    this.closed = true;
    this.allListeners.clear();
    this.errorListeners.clear();
    try {
      this.watcher?.close();
    } catch {
      /* already closed */
    }
  }

  private start(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: true });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.watcher.on("change", (eventType, filename) => {
      if (this.closed) return;
      // The platform could not name the path: the git watcher rescans the root.
      if (filename == null) {
        this.emit("addDir", this.root);
        return;
      }
      const relative = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
      if (IGNORED_SEGMENT.test(relative)) return;
      this.classify(path.join(this.root, relative), eventType);
    });
    this.watcher.on("error", (error) => this.fail(error));
    this.markReady();
    this.learnDirectories();
  }

  private classify(filePath: string, eventType: string): void {
    if (eventType === "change") {
      this.emit("change", filePath);
      return;
    }
    fs.lstat(filePath, (error, stats) => {
      if (this.closed) return;
      if (!error) {
        const directory = stats.isDirectory();
        if (directory) this.directories.add(filePath);
        this.emit(directory ? "addDir" : "add", filePath);
        return;
      }
      if (!this.directories.has(filePath)) {
        this.emit("unlink", filePath);
        return;
      }
      const prefix = `${filePath}${path.sep}`;
      for (const directory of this.directories)
        if (directory === filePath || directory.startsWith(prefix)) this.directories.delete(directory);
      this.emit("unlinkDir", filePath);
    });
  }

  /** A directory-only walk, never a per-file stat, once per root. */
  private learnDirectories(): void {
    const queue = [this.root];
    const next = (): void => {
      if (this.closed) return;
      const directory = queue.pop();
      if (directory === undefined) return;
      fs.readdir(directory, { withFileTypes: true }, (error, children) => {
        if (this.closed) return;
        if (!error) {
          for (const child of children) {
            if (!child.isDirectory() || child.name === ".git" || child.name === "node_modules") continue;
            const childPath = path.join(directory, child.name);
            this.directories.add(childPath);
            queue.push(childPath);
          }
        }
        setImmediate(next);
      });
    };
    next();
  }

  private emit(event: WorktreeWatchEvent, filePath: string): void {
    for (const listener of this.allListeners) listener(event, filePath);
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const listener of this.readyListeners) queueMicrotask(listener);
    this.readyListeners.clear();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!(failure as NodeJS.ErrnoException).code) Object.assign(failure, { code: "EWATCH" });
    this.markReady();
    for (const listener of this.errorListeners) listener(failure);
  }
}
