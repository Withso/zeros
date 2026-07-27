// ──────────────────────────────────────────────────────────
// File Watcher — Watch for CSS file changes
// ──────────────────────────────────────────────────────────
//
// Uses chokidar (pure JavaScript, no native bindings) so the
// engine bundles cleanly into a Bun single-file executable.
//
// Debounces per-file (50ms) to coalesce rapid editor saves.
//
// ──────────────────────────────────────────────────────────

import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { EngineCache } from "./cache";

export type FileChangeType = "create" | "update" | "delete";
export type FileChangeHandler = (filePath: string, type: FileChangeType, fileType: "css" | "jsx" | "other") => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(
    private root: string,
    private cache: EngineCache,
    private onChange?: FileChangeHandler
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.watcher = chokidar.watch(this.root, {
      ignored: [
        /(?:^|[\\/])\.git(?:[\\/]|$)/,
        /(?:^|[\\/])\.zeros(?:[\\/]|$)/,
        /(?:^|[\\/])node_modules(?:[\\/]|$)/,
        /(?:^|[\\/])dist(?:[\\/]|$)/,
        /(?:^|[\\/])build(?:[\\/]|$)/,
        /(?:^|[\\/])\.next(?:[\\/]|$)/,
        /\.zeros-tmp$/,
      ],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 20,
        pollInterval: 10,
      },
    });

    this.watcher
      .on("add", (p) => this.handleEvent(p, "create"))
      .on("change", (p) => this.handleEvent(p, "update"))
      .on("unlink", (p) => this.handleEvent(p, "delete"))
      .on("error", (err) => console.error("[Zeros] Watcher error:", err));

    console.log("[Zeros] File watcher started");
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private handleEvent(filePath: string, type: FileChangeType): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.processEvent(filePath, type);
      }, 50)
    );
  }

  private processEvent(filePath: string, type: FileChangeType): void {
    const ext = path.extname(filePath).toLowerCase();
    let fileType: "css" | "jsx" | "other";

    if (ext === ".css") {
      fileType = "css";
      if (type === "delete") {
        this.cache.removeFile(filePath);
      } else {
        this.cache.updateFile(filePath);
      }
    } else if (ext === ".tsx" || ext === ".jsx") {
      fileType = "jsx";
    } else {
      fileType = "other";
      return;
    }

    if (this.onChange) {
      this.onChange(filePath, type, fileType);
    }
  }
}
