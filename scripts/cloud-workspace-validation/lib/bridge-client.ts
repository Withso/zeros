// ──────────────────────────────────────────────────────────
// A minimal Node client for validating the Zeros cloud bridge protocol.
// ──────────────────────────────────────────────────────────
//
// Speaks just enough of the wire protocol to exercise a cloud engine:
//   • connect → wait for ENGINE_READY → send CONNECTED (protocol handshake)
//   • request(op, params) → WORKSPACE_REQUEST / WORKSPACE_RESPONSE (e.g. file.tree)
//   • ptyCreate / ptyWrite + PTY_DATA / PTY_EXIT streaming
//
// It is deliberately NOT the renderer's RuntimeClient — it's a throwaway probe
// for the load-tests. The envelope (id/timestamp) is hand-rolled, while the
// protocol version comes from the shared contract so drift cannot silently turn
// this into a minimum-version compatibility probe. Uses the `ws` package
// (already a repo dep).
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import { PROTOCOL_VERSION } from "../../../packages/protocol/src/version";

export type BridgeMessage = Record<string, unknown> & {
  type: string;
  source?: "browser" | "engine";
  id?: string;
  requestId?: string;
};

export type ClientBridgeMessage = Omit<BridgeMessage, "source"> & {
  source?: "browser";
};

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeClientOpts {
  /** Clean ws(s)://…/ws URL built by config.bridgeWsUrl. */
  url: string;
  /** Daytona preview-proxy token → `x-daytona-preview-token`. */
  previewToken?: string;
  /** Zeros bridge bearer token → the browser-compatible, non-negotiated
   * `zeros-cloud-token.<base64url>` WebSocket protocol carrier. */
  cloudToken?: string;
  /** Account access JWT sent only inside CONNECTED after the WSS gates pass. */
  accountToken?: string;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ptyData: Array<(sessionId: string, data: string) => void> =
    [];
  private readonly ptyExit: Array<
    (sessionId: string, code: number | null) => void
  > = [];
  private readonly messageListeners = new Set<
    (message: BridgeMessage) => void
  >();
  private readyResolve:
    | ((info: { root: string; version: string }) => void)
    | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reqTimeout: number;

  engineRoot = "";
  engineVersion = "";

  constructor(private readonly opts: BridgeClientOpts) {
    this.reqTimeout = opts.requestTimeoutMs ?? 15_000;
    if (
      !Number.isInteger(this.reqTimeout) ||
      this.reqTimeout < 100 ||
      this.reqTimeout > 10 * 60_000
    ) {
      throw new Error("bridge request timeout is invalid");
    }
    if (
      opts.cloudToken !== undefined &&
      (opts.cloudToken.length < 16 ||
        Buffer.byteLength(opts.cloudToken, "utf8") > 4_096 ||
        /[\0\r\n]/.test(opts.cloudToken))
    ) {
      throw new Error("cloud bridge token is invalid");
    }
  }

  /** Open the socket, wait for ENGINE_READY, send CONNECTED. Resolves with the
   *  engine root + version once the handshake is in flight. */
  connect(): Promise<{ root: string; version: string }> {
    if (this.ws) {
      return Promise.reject(new Error("bridge client is already connected"));
    }
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const headers: Record<string, string> = {};
      if (this.opts.previewToken) {
        headers["x-daytona-preview-token"] = this.opts.previewToken;
      }
      const protocols = this.opts.cloudToken
        ? [
            "zeros-v1",
            `zeros-cloud-token.${Buffer.from(this.opts.cloudToken, "utf8").toString("base64url")}`,
          ]
        : undefined;
      const clientOptions =
        Object.keys(headers).length > 0 ? { headers } : undefined;
      const ws = protocols
        ? new WebSocket(this.opts.url, protocols, clientOptions)
        : new WebSocket(this.opts.url, clientOptions);
      this.ws = ws;

      this.readyTimer = setTimeout(
        () => this.failAll("ws ENGINE_READY timed out (10s)"),
        10_000,
      );
      this.readyTimer.unref?.();
      ws.on("error", (err) =>
        this.failAll(
          err instanceof Error ? err.message : `socket error: ${String(err)}`,
        ),
      );
      ws.on("close", (code, reason) => {
        if (this.ws === ws) this.ws = null;
        this.failAll(`socket closed ${code} ${reason}`);
      });
      ws.on("message", (data) => {
        let msg: BridgeMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.dispatch(msg);
      });
    });
  }

  private dispatch(msg: BridgeMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(msg);
      } catch {
        // A diagnostic listener must not break bridge protocol dispatch.
      }
    }
    switch (msg.type) {
      case "ENGINE_READY": {
        this.engineRoot = String(msg.root ?? "");
        this.engineVersion = String(msg.version ?? "");
        // Reply with CONNECTED to complete the protocol handshake.
        try {
          this.sendMessage({
            type: "CONNECTED",
            source: "browser",
            capabilities: [],
            protocolVersion: PROTOCOL_VERSION,
            ...(this.opts.accountToken
              ? { authToken: this.opts.accountToken }
              : {}),
          });
          if (this.readyTimer) clearTimeout(this.readyTimer);
          this.readyTimer = null;
          this.readyResolve?.({
            root: this.engineRoot,
            version: this.engineVersion,
          });
          this.readyResolve = null;
          this.readyReject = null;
        } catch (error) {
          this.failAll(
            error instanceof Error
              ? error.message
              : "could not complete bridge handshake",
          );
        }
        break;
      }
      case "CONNECTION_REJECTED":
        this.failAll(
          `engine rejected the connection: ${String(msg.reason)} — ${String(msg.message ?? "")}`,
        );
        break;
      case "WORKSPACE_RESPONSE": {
        const p = this.pending.get(String(msg.requestId));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.requestId));
          p.resolve(msg.result);
        }
        break;
      }
      case "WORKSPACE_ERROR": {
        const p = this.pending.get(String(msg.requestId));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.requestId));
          p.reject(new Error(`${String(msg.code)}: ${String(msg.message)}`));
        }
        break;
      }
      case "PTY_CREATED": {
        const p = this.pending.get(String(msg.requestId));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.requestId));
          p.resolve(msg);
        }
        break;
      }
      case "PTY_DATA":
        for (const cb of this.ptyData)
          cb(String(msg.sessionId), String(msg.data));
        break;
      case "PTY_EXIT":
        for (const cb of this.ptyExit)
          cb(
            String(msg.sessionId),
            msg.exitCode === null ? null : Number(msg.exitCode),
          );
        break;
      default:
        break;
    }
  }

  /** Send one protocol envelope. The validation harness exposes this narrow
   * primitive for live provider qualification; callers still receive every
   * inbound frame through the schema-validating engine. */
  sendMessage(fields: ClientBridgeMessage): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("bridge WebSocket is not open");
    }
    const id = randomUUID();
    // `browser` is the single canonical client-origin discriminator in the
    // shared protocol. Force it here so an operator call site cannot recreate
    // the historical non-canonical source discriminator that the engine
    // correctly dropped at its trust boundary.
    const envelope = {
      ...fields,
      source: "browser" as const,
      id,
      timestamp: Date.now(),
    };
    this.ws.send(JSON.stringify(envelope));
    return id;
  }

  /** Observe sanitized protocol frames for operator-only qualification logic.
   * Returns an idempotent unsubscribe closure. */
  onMessage(listener: (message: BridgeMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** WORKSPACE_REQUEST → result (e.g. op="file.tree", params={workspaceId:"local-main"}). */
  request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.sendMessage({
        type: "WORKSPACE_REQUEST",
        source: "browser",
        op,
        params,
      });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${op}" timed out (${this.reqTimeout}ms)`));
      }, this.reqTimeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** PTY_CREATE → PTY_CREATED (resolved by requestId = the create message id). */
  ptyCreate(args: {
    sessionId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    ephemeral?: boolean;
  }): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      const id = this.sendMessage({
        type: "PTY_CREATE",
        source: "browser",
        sessionId: args.sessionId,
        cwd: args.cwd,
        cols: args.cols ?? 80,
        rows: args.rows ?? 24,
        ephemeral: args.ephemeral ?? true,
      });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("PTY_CREATE timed out"));
      }, this.reqTimeout);
      this.pending.set(id, {
        resolve: (m) => resolve(m as BridgeMessage),
        reject,
        timer,
      });
    });
  }

  ptyWrite(sessionId: string, data: string): void {
    this.sendMessage({
      type: "PTY_WRITE",
      source: "browser",
      sessionId,
      data,
    });
  }

  onPtyData(cb: (sessionId: string, data: string) => void): void {
    this.ptyData.push(cb);
  }
  onPtyExit(cb: (sessionId: string, code: number | null) => void): void {
    this.ptyExit.push(cb);
  }

  /** Liveness check — the bridge has no app-level ping in the protocol, so this
   *  drives a cheap real op (project.list) and confirms a response. */
  async ping(): Promise<void> {
    await this.request("project.list", {});
  }

  private failAll(reason: string): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const error = new Error(reason);
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.failAll("bridge client closed");
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    try {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    } catch {
      /* ignore */
    }
    if (ws.readyState === WebSocket.CLOSED) return;
    const forceClose = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }, 1_000);
    forceClose.unref?.();
    ws.once("close", () => clearTimeout(forceClose));
  }
}
