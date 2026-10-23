import { spawn, type ChildProcess } from "node:child_process";
import type { HostEvent } from "./native-types";

interface Options {
  path: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
  onEvent(event: HostEvent): void; onClose(error: Error): void;
  redact(message: string): string;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; clean(): void }
const kinds = new Set(["started", "delta", "step", "message", "result", "error"]);

/** SDK logs cannot become protocol frames. A dedicated IPC channel is bounded
 * in both directions; the complete native process group dies with its host. */
export class CursorProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private nextId = 0;
  private pendingBytes = 0;
  private closed = false;
  private disposing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.child = spawn(process.execPath, [options.path], { cwd: options.cwd, env: options.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true, windowsHide: true });
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.fail(new Error("Cursor host exited before the session closed.")); resolve();
    }));
    this.child.on("error", () => this.fail(new Error("Could not start Cursor host.")));
    this.child.on("disconnect", () => this.fail(new Error("Cursor host disconnected.")));
    this.child.on("message", raw => this.receive(raw));
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error("Cursor host request was interrupted."));
    if (this.pending.size >= 128) return Promise.reject(new Error("Too many pending Cursor controls."));
    const id = ++this.nextId, frame = { id, method, params };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > 16 * 1024 * 1024 || this.pendingBytes + bytes > 32 * 1024 * 1024)
      return Promise.reject(new Error("Cursor host input exceeded its limit."));
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.take(id)?.reject(new Error("Cursor host request was interrupted.")); };
      const timer = setTimeout(() => {
        const error = new Error(`Cursor ${method} timed out.`);
        this.take(id)?.reject(error);
        // A timed-out send may already have reached the model. Retire it;
        // steering uncertainty is a receipt outcome, never an automatic retry.
        if (method !== "steer") this.fail(error);
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject,
        clean: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      this.pendingBytes += bytes;
      try {
        this.child.send(frame, error => {
          this.pendingBytes -= bytes;
          if (error) this.fail(new Error("Cursor host input closed."));
        });
      } catch { this.pendingBytes -= bytes; this.fail(new Error("Cursor host input failed.")); }
    });
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = Promise.resolve().then(async () => {
      this.fail(new Error("Cursor host was disposed."));
      this.signal("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); }
      finally { clearTimeout(timer); this.signal("SIGKILL"); }
      await this.exited;
    });
    return this.disposing;
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); } catch { /* Already reaped. */ }
  }
  private take(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending) { this.pending.delete(id); pending.clean(); }
    return pending;
  }
  private receive(raw: unknown): void {
    if (this.closed) return;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024 * 1024) throw new Error();
      const frame = raw as Record<string, unknown>;
      if (frame.t === "reply" && Number.isSafeInteger(frame.id)) {
        const pending = this.take(frame.id as number);
        if (!pending) return;
        if (typeof frame.error === "string") pending.reject(new Error(this.options.redact(frame.error)));
        else pending.resolve(frame.value);
      } else if (frame.t === "event" && typeof frame.turnId === "string" && kinds.has(frame.kind as string)) {
        this.options.onEvent(frame as unknown as HostEvent);
      } else throw new Error();
    } catch { this.fail(new Error("Invalid Cursor host frame.")); }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.take(id)?.reject(error);
    this.options.onClose(error);
    void this.dispose();
  }
}
