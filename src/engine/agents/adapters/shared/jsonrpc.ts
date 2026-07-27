// ──────────────────────────────────────────────────────────
// Line-delimited JSON-RPC 2.0 client over stdio.
// ──────────────────────────────────────────────────────────
//
// Framing: one JSON object per line on stdin/stdout. No length-prefix
// (LSP-style) — that's what the Codex app-server (the sole consumer
// today) speaks. Originally hand-tested against the gemini-cli 0.39.1
// reference implementation when the protocol module was first written.
//
// Bidirectional: we send requests + notifications; the agent sends
// responses to our requests, agent-initiated requests (e.g.
// session/request_permission), and notifications (session/update).
//
// Request lifecycle:
//   1. send({ jsonrpc:"2.0", id, method, params })
//   2. agent responds with { jsonrpc:"2.0", id, result } or
//      { jsonrpc:"2.0", id, error: { code, message, data? } }
//   3. pending Map<id, deferred> resolves; per-request timeout cleared.
//
// Default request timeout 60s. Long agent turns should not be modeled as one
// long JSON-RPC request timeout; callers keep the request ACK short and wait
// for streaming completion with their own progress/inactivity watchdog.
//
// ──────────────────────────────────────────────────────────

import type { ChildProcess } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** M9: hard cap on a single un-newlined JSON-RPC line, mirroring the NDJSON
 *  parser's 8 MB cap. A line that exceeds it is dropped (resync to next newline)
 *  so a runaway CLI can't OOM the engine and kill every in-flight chat. */
const MAX_JSONRPC_LINE_BYTES = 8 * 1024 * 1024;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  constructor(method: string, error: JsonRpcError) {
    super(`${method}: ${error.message}`);
    this.name = "JsonRpcRequestError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface JsonRpcClientOptions {
  /** Tag emitted into log lines (e.g. "codex"). */
  logTag?: string;
  /** Forward every line we write to stdin (off by default). */
  onOutbound?: (line: string) => void;
  /** Forward every line we read from stdout (off by default). */
  onInbound?: (line: string) => void;
  /** Override the default 60s request timeout. */
  defaultTimeoutMs?: number;
}

/** Minimal line-delimited JSON-RPC 2.0 client. Created against an
 *  already-spawned ChildProcess; the caller owns the subprocess
 *  lifecycle. */
export class JsonRpcStdioClient {
  private nextId = 1;
  // Keyed on the STRINGIFIED request id. Outbound ids are numbers, but a
  // spec-loose agent may echo the id as a string; stringifying both ends keeps
  // number↔string echoes correlated (Number(id) coercion would miss on NaN).
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private stdoutBuffer = "";
  private closed = false;
  private readonly defaultTimeoutMs: number;
  private readonly logTag: string;
  private readonly onOutbound?: (line: string) => void;
  private readonly onInbound?: (line: string) => void;

  constructor(
    private readonly child: ChildProcess,
    options: JsonRpcClientOptions = {},
  ) {
    this.logTag = options.logTag ?? "jsonrpc";
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onOutbound = options.onOutbound;
    this.onInbound = options.onInbound;

    if (!child.stdin || !child.stdout) {
      throw new Error("JsonRpcStdioClient requires stdin + stdout to be piped");
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.feedStdout(chunk));
    child.stdout.on("end", () => this.handleClose("stdout closed"));
    child.on("close", () => this.handleClose("child closed"));
    child.on("error", (err) => this.handleClose(`child error: ${err.message}`));
  }

  /** Send a JSON-RPC request and await its response. */
  request<T = unknown>(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error(`[${this.logTag}] cannot send ${method}: client is closed`),
      );
    }
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new Error(
            `[${this.logTag}] request "${method}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method,
      });
      this.writeFrame(frame);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  /** Register a handler for inbound requests from the agent. The
   *  handler's return value (or thrown error) is sent back as the
   *  JSON-RPC response. Throwing a JsonRpcRequestError preserves the
   *  code; any other error becomes code -32000. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Register a handler for inbound notifications from the agent. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Settle every pending request with the given error and stop
   *  accepting new ones. Does NOT kill the subprocess — the caller
   *  owns the lifecycle. */
  close(reason = "client closed"): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`[${this.logTag}] ${reason}`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  // ── internals ──────────────────────────────────────────

  private writeFrame(frame: unknown): void {
    const line = JSON.stringify(frame) + "\n";
    this.onOutbound?.(line.trimEnd());
    this.child.stdin?.write(line);
  }

  private feedStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // M9: cap an un-newlined line so a runaway CLI can't grow the buffer until
    // the engine OOMs. On overflow drop the partial line and resync to the next
    // newline.
    if (this.stdoutBuffer.length > MAX_JSONRPC_LINE_BYTES) {
      const nlOverflow = this.stdoutBuffer.indexOf("\n");
      this.stdoutBuffer = nlOverflow === -1 ? "" : this.stdoutBuffer.slice(nlOverflow + 1);
      console.warn(
        `[${this.logTag}] JSON-RPC line exceeded ${MAX_JSONRPC_LINE_BYTES} bytes — dropped + resynced`,
      );
      return;
    }
    let nl = this.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
      nl = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.onInbound?.(line);
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Some agents print non-JSON banners on first connect — ignore.
      return;
    }

    const id = frame.id as number | string | null | undefined;
    const method = frame.method as string | undefined;
    const result = "result" in frame ? frame.result : undefined;
    const error = frame.error as JsonRpcError | undefined;

    if (id != null && method == null) {
      // Response to one of our requests. Key on the stringified id so an agent
      // that echoes the id as a string (or otherwise re-typed) still correlates.
      const key = String(id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (error) {
        pending.reject(new JsonRpcRequestError(pending.method, error));
      } else {
        pending.resolve(result);
      }
      return;
    }

    if (id != null && method) {
      // Inbound request — agent asks us something.
      void this.handleInboundRequest(id, method, frame.params);
      return;
    }

    if (method) {
      // Notification.
      const handler = this.notificationHandlers.get(method);
      if (handler) {
        try {
          handler(frame.params);
        } catch {
          /* notifications are fire-and-forget; swallow */
        }
      }
    }
  }

  private async handleInboundRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.writeFrame({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const jrErr =
        err instanceof JsonRpcRequestError
          ? { code: err.code, message: err.message, data: err.data }
          : {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            };
      this.writeFrame({ jsonrpc: "2.0", id, error: jrErr });
    }
  }

  private handleClose(reason: string): void {
    this.close(reason);
  }
}
