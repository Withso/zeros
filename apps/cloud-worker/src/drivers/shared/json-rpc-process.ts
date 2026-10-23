import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

export interface RpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => unknown;
  onClose: (error: Error) => void;
  redact: (message: string) => string;
}

/** Bounded JSONL over pipes. Native stderr is drained, never forwarded or logged. */
export class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private disposePromise?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(private readonly options: RpcProcessOptions) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe", windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code) => {
        this.fail(new RpcError(`Codex app-server exited${code === null ? "" : ` (${code})`}.`));
        resolve();
      });
    });
    this.child.on("error", () => this.fail(new RpcError("Could not start Codex app-server.")));
    this.child.stdin.on("error", () => this.fail(new RpcError("Codex app-server input closed.")));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.resume();
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("Codex app-server is closed."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new RpcError(`Codex ${method} timed out.`);
        reject(error);
        // A lost mutation receipt is uncertain. Retire the process rather than
        // accepting another turn that could duplicate still-running work.
        this.fail(error);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }

  private write(frame: unknown): void {
    if (this.closed) return;
    try {
      if (this.child.stdin.writableLength > 8 * 1024 * 1024) throw new Error();
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch { this.fail(new RpcError("Codex app-server input failed.")); }
  }

  private read(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
      this.fail(new RpcError("Codex app-server frame exceeded its size limit."));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0 && !this.closed) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
        const value = frame as Record<string, unknown>;
        if (typeof value.method === "string") {
          if (typeof value.id === "number" || typeof value.id === "string") {
            try { this.write({ id: value.id, result: this.options.onRequest(value.method, value.params) }); }
            catch (error) { this.write({ id: value.id, error: { code: error instanceof RpcError ? error.code ?? -32603 : -32603, message: "Unsupported worker request." } }); }
          } else this.options.onNotification(value.method, value.params);
        } else if (typeof value.id === "number") {
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          this.pending.delete(value.id);
          clearTimeout(pending.timer);
          if (value.error && typeof value.error === "object") {
            // Keep structured provider evidence until classification. Flattening
            // JSON-RPC data here loses model-access and authentication codes.
            const error = JSON.parse(this.options.redact(JSON.stringify(value.error))) as Record<string, unknown>;
            pending.reject(new RpcError(typeof error.message === "string" ? error.message : "Codex request failed.", typeof error.code === "number" ? error.code : undefined, error.data));
          } else if ("result" in value) pending.resolve(value.result);
          else { pending.reject(new RpcError("Invalid Codex response.")); throw new Error(); }
        } else throw new Error();
      } catch { this.fail(new RpcError("Invalid Codex app-server frame.")); }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.options.onClose(error);
    void this.dispose();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = Promise.resolve().then(async () => {
      this.fail(new RpcError("Codex app-server was disposed."));
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.kill("SIGTERM");
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 500);
      try { await this.exited; } finally { clearTimeout(kill); }
    });
    return this.disposePromise;
  }
}
