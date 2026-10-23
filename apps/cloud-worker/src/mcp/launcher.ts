import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface McpHttpLaunchOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  listenUrl: string;
  workspaceRoot: string;
  homeDirectory?: string;
  startupTimeoutMs?: number;
  terminateTimeoutMs?: number;
}

export function resolveMcpCwd(cwd: string | undefined, workspaceRoot: string, homeDirectory = homedir()): string {
  return !cwd ? workspaceRoot : cwd === "~" ? homeDirectory
    : cwd.startsWith("~/") ? resolve(homeDirectory, cwd.slice(2)) : resolve(workspaceRoot, cwd);
}

export function loopbackMcpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.hash)
    throw new Error("A launched MCP endpoint must be a loopback HTTP URL.");
  // Do not resolve a user-controlled localhost DNS answer outside loopback.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function listening(url: URL, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
    const finish = (result: boolean) => { signal.removeEventListener("abort", abort); socket.destroy(); resolve(result); };
    const abort = () => { socket.destroy(); reject(signal.reason); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(150, () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One explicitly configured process. No shell, background retry or health
 * polling: startup work exists only while a caller needs the endpoint. */
export class McpHttpLauncher {
  readonly endpoint: string;
  private readonly url: URL;
  private child?: ChildProcess;
  private childClosed?: Promise<void>;
  private starting?: Promise<void>;
  private controller?: AbortController;
  private waiters = 0;
  private ready = false;
  private closed = false;
  private disposing?: Promise<void>;

  constructor(private readonly options: McpHttpLaunchOptions) {
    this.url = loopbackMcpUrl(options.listenUrl);
    this.endpoint = this.url.href;
    if (!options.command.trim() || [options.command, ...(options.args ?? []), options.cwd ?? ""].some(value => value.includes("\0")))
      throw new Error("Invalid MCP launch configuration.");
  }

  async ensureRunning(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("MCP launcher is closed.");
    signal?.throwIfAborted();
    if (this.ready) return;
    if (!this.starting) {
      this.controller = new AbortController();
      const controller = this.controller;
      this.starting = this.start(controller.signal).finally(() => {
        if (this.controller === controller) { this.starting = undefined; this.controller = undefined; }
      });
    }
    this.waiters++;
    try { await untilAborted(this.starting, signal); }
    finally { if (--this.waiters === 0 && !this.ready) this.controller?.abort(); }
  }

  private async start(cancel: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(this.options.startupTimeoutMs ?? 15_000)]);
    try {
      await this.stopProcess();
      if (await listening(this.url, signal)) throw new Error("MCP endpoint is already in use.");
      signal.throwIfAborted();
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: resolveMcpCwd(this.options.cwd, this.options.workspaceRoot, this.options.homeDirectory),
        env: { ...process.env, ...this.options.env }, shell: false, detached: process.platform !== "win32", stdio: "ignore",
      });
      this.child = child;
      let exited = false;
      this.childClosed = new Promise(resolve => child.once("close", () => { exited = true; if (this.child === child) this.ready = false; resolve(); }));
      child.once("error", () => { exited = true; });
      while (!signal.aborted) {
        if (exited) throw new Error("MCP process did not start.");
        if (await listening(this.url, signal)) {
          if (exited || this.closed) throw new Error("MCP process did not start.");
          this.ready = true;
          return;
        }
        await delay(75, undefined, { signal });
      }
      throw new Error("MCP process did not start before the deadline.");
    } catch (error) {
      await this.stopProcess();
      if (signal.aborted) throw new Error("MCP process startup was cancelled or timed out.");
      throw error;
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.child, closed = this.childClosed;
    this.child = undefined; this.childClosed = undefined; this.ready = false;
    if (!child) return;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.terminateTimeoutMs ?? 750); })]); }
    finally { clearTimeout(timer); }
    // Also reap descendants when the parent exits before them.
    kill("SIGKILL");
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true; this.controller?.abort();
    return this.disposing = (async () => { await this.starting?.catch(() => {}); await this.stopProcess(); })();
  }
}
