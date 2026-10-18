// ──────────────────────────────────────────────────────────
// Watch host client — engine-side driver for native worktree watching
// ──────────────────────────────────────────────────────────
//
// A packaged engine cannot arm a native file watcher in its own process (see
// watch-host.cjs). This client runs that Node host lazily, multiplexes every
// watched root over its stdio, and gives the git watcher one object per root
// with the same shape it already drives for Chokidar.
//
// The host is shared. If it dies after it was healthy, the client restarts it,
// re-arms every root and reports one root-level change per root, because
// events can be lost while no host was running. A host that keeps dying while
// it starts reports an error on every root instead, and the git watcher falls
// back to stat polling for those roots, the behavior before this host existed.
// ──────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorktreeWatchEvent =
  | "add"
  | "addDir"
  | "change"
  | "unlink"
  | "unlinkDir";

/** The part of Chokidar's FSWatcher that the git watcher drives. */
export interface WorktreeWatcher {
  on(
    event: "all",
    listener: (event: WorktreeWatchEvent, filePath: string) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "ready", listener: () => void): this;
  add(paths: string | readonly string[]): this;
  unwatch(paths: string | readonly string[]): this;
  getWatched(): Record<string, string[]>;
  close(): Promise<void>;
}

export interface WatchHostLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Thrown to a root when no host can watch it; the git watcher polls instead. */
export const WATCH_HOST_UNAVAILABLE = "EWATCHHOST";

/** Deaths this soon after a spawn count as start-up failures. */
const EARLY_DEATH_MS = 5_000;
/** Start-up failures tolerated before every root falls back to polling. */
const MAX_EARLY_DEATHS = 2;
const MAX_PARTIAL_LINE_CHARS = 8 * 1024 * 1024;

function hostError(code: string): Error {
  return Object.assign(new Error(`worktree watch host unavailable (${code})`), {
    code,
  });
}

class NativeRootWatcher implements WorktreeWatcher {
  private readonly allListeners = new Set<
    (event: WorktreeWatchEvent, filePath: string) => void
  >();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly readyListeners = new Set<() => void>();
  private ready = false;
  private closed = false;

  constructor(
    readonly root: string,
    private readonly release: (watcher: NativeRootWatcher) => void,
  ) {}

  on(
    event: "all",
    listener: (event: WorktreeWatchEvent, filePath: string) => void,
  ): this;
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
  // native watch has no per-folder subscription to add or remove.
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
    // A root retired before it armed must not leave a readiness wait behind.
    this.markReady();
    this.closed = true;
    this.allListeners.clear();
    this.errorListeners.clear();
    this.release(this);
  }

  markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    const listeners = [...this.readyListeners];
    this.readyListeners.clear();
    for (const listener of listeners) listener();
  }

  emit(event: WorktreeWatchEvent, filePath: string): void {
    if (this.closed) return;
    for (const listener of this.allListeners) listener(event, filePath);
  }

  fail(error: Error): void {
    if (this.closed) return;
    // The git watcher replaces (and closes) this root while handling the
    // error, so finish its readiness wait first.
    this.markReady();
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

export class WatchHostClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private spawnedAt = 0;
  private earlyDeaths = 0;
  private unavailable = false;
  private nextId = 1;
  private readonly roots = new Map<number, NativeRootWatcher>();
  private readonly ids = new Map<NativeRootWatcher, number>();

  private readonly earlyDeathMs: number;
  private readonly onUnavailable: (() => void) | undefined;

  constructor(
    private readonly launch: () => WatchHostLaunch | null,
    options: { earlyDeathMs?: number; onUnavailable?: () => void } = {},
  ) {
    this.earlyDeathMs = options.earlyDeathMs ?? EARLY_DEATH_MS;
    this.onUnavailable = options.onUnavailable;
  }

  /** Every root falls back to stat polling from here on. Report it once, so
   * the engine can restore the prompt Design refresh that polling lacks. */
  private markUnavailable(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    try {
      this.onUnavailable?.();
    } catch {
      /* a consumer's failure never disturbs watching */
    }
  }

  /** One native recursive watch for `root`, armed on the shared host. */
  watch(root: string): WorktreeWatcher {
    const watcher = new NativeRootWatcher(root, (closed) =>
      this.release(closed),
    );
    const id = this.nextId++;
    this.roots.set(id, watcher);
    this.ids.set(watcher, id);
    if (!this.ensure()) {
      queueMicrotask(() => watcher.fail(hostError(WATCH_HOST_UNAVAILABLE)));
    } else {
      this.send({ t: "watch", id, root });
    }
    return watcher;
  }

  /** Close every root and the host. Used when the engine stops. */
  dispose(): void {
    this.roots.clear();
    this.ids.clear();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  }

  /** Test seam: the live host process, if any. */
  hostProcessForTesting(): ChildProcess | null {
    return this.child;
  }

  private release(watcher: NativeRootWatcher): void {
    const id = this.ids.get(watcher);
    if (id === undefined) return;
    this.ids.delete(watcher);
    this.roots.delete(id);
    if (this.child) this.send({ t: "unwatch", id });
  }

  private ensure(): boolean {
    if (this.child) return true;
    if (this.unavailable) return false;
    const launch = this.launch();
    if (!launch) {
      this.markUnavailable();
      return false;
    }
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: launch.env,
      });
    } catch {
      this.markUnavailable();
      return false;
    }
    this.child = child;
    this.buffer = "";
    this.spawnedAt = Date.now();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk).replace(/\s+$/, "");
      if (text) console.error(`[watch-host] ${text}`);
    });
    // Our own pipe errors must not crash the engine; `close` handles the loss.
    child.stdin?.on("error", () => {});
    child.on("error", () => {
      if (this.child === child) this.onHostGone();
    });
    child.on("close", () => {
      if (this.child === child) this.onHostGone();
    });
    return true;
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PARTIAL_LINE_CHARS) {
      // A broken host; restart it rather than buffer without bound.
      this.buffer = "";
      this.child?.kill("SIGKILL");
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: {
      t?: string;
      id?: number;
      code?: string;
      events?: Array<[string, string]>;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const watcher =
      typeof message.id === "number" ? this.roots.get(message.id) : undefined;
    if (!watcher) return;
    if (message.t === "watching") {
      watcher.markReady();
    } else if (message.t === "events" && Array.isArray(message.events)) {
      for (const entry of message.events) {
        if (!Array.isArray(entry)) continue;
        const [event, filePath] = entry;
        if (typeof filePath !== "string") continue;
        if (event === "rescan") watcher.emit("addDir", watcher.root);
        else if (
          event === "add" ||
          event === "addDir" ||
          event === "change" ||
          event === "unlink" ||
          event === "unlinkDir"
        )
          watcher.emit(event, filePath);
      }
    } else if (message.t === "error") {
      const id = message.id!;
      this.roots.delete(id);
      this.ids.delete(watcher);
      watcher.fail(hostError(message.code || "EWATCH"));
    }
  }

  private onHostGone(): void {
    this.child = null;
    this.buffer = "";
    if (this.roots.size === 0) return;
    const early = Date.now() - this.spawnedAt < this.earlyDeathMs;
    this.earlyDeaths = early ? this.earlyDeaths + 1 : 0;
    if (this.earlyDeaths >= MAX_EARLY_DEATHS || !this.ensure()) {
      this.markUnavailable();
      const roots = [...this.roots.values()];
      this.roots.clear();
      this.ids.clear();
      for (const watcher of roots)
        watcher.fail(hostError(WATCH_HOST_UNAVAILABLE));
      return;
    }
    // Events may have been lost while no host ran: re-arm, then report one
    // root-level change so every consumer re-reads.
    for (const [id, watcher] of this.roots) {
      this.send({ t: "watch", id, root: watcher.root });
      watcher.emit("addDir", watcher.root);
    }
  }
}

/** Resolve watch-host.cjs: explicit, beside the packaged PTY host, or beside
 *  this module when the engine runs from source. */
export function resolveWatchHostScript(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.ZEROS_WATCH_HOST_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;
  const ptyHost = env.ZEROS_PTY_HOST_SCRIPT;
  if (ptyHost) {
    const sibling = path.join(path.dirname(ptyHost), "watch-host.cjs");
    if (existsSync(sibling)) return sibling;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.join(here, "watch-host.cjs");
    if (existsSync(sibling)) return sibling;
  } catch {
    /* compiled binary — no source path on disk */
  }
  return null;
}

/** The host runs on the same Node runtime as the PTY host: the Electron binary
 *  as Node in a packaged app. Without a configured runtime there is no host. */
export function watchHostLaunchFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): WatchHostLaunch | null {
  const runtime = env.ZEROS_PTY_HOST_RUNTIME;
  const script = resolveWatchHostScript(env);
  if (!runtime || !script) return null;
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1")
    childEnv.ELECTRON_RUN_AS_NODE = "1";
  return { command: runtime, args: [script], env: childEnv };
}

/** The watch host serves exactly one engine shape: a packaged Local engine on
 *  macOS, whose bun runtime cannot arm FSEvents itself. A cloud worker, a dev
 *  engine (which runs Chokidar natively) and every other platform keep the
 *  watcher they had, and so does an engine started without a Node runtime. */
export function createLocalWatchHost(context: {
  devRuntime: boolean;
  cloudWorker: boolean;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Called once if the host gives up and every root polls instead. */
  onUnavailable?: () => void;
}): WatchHostClient | null {
  if (context.devRuntime || context.cloudWorker || context.platform !== "darwin")
    return null;
  const env = context.env ?? process.env;
  if (!watchHostLaunchFromEnvironment(env)) return null;
  return new WatchHostClient(() => watchHostLaunchFromEnvironment(env), {
    onUnavailable: context.onUnavailable,
  });
}
