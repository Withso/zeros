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

type AnyMsg = Record<string, unknown> & { type: string; id?: string };

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
  /** Zeros bridge bearer token → `x-zeros-cloud-token`. */
  cloudToken?: string;
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
  private readyResolve:
    | ((info: { root: string; version: string }) => void)
    | null = null;
  private readonly reqTimeout: number;

  engineRoot = "";
  engineVersion = "";

  constructor(private readonly opts: BridgeClientOpts) {
    this.reqTimeout = opts.requestTimeoutMs ?? 15_000;
  }

  /** Open the socket, wait for ENGINE_READY, send CONNECTED. Resolves with the
   *  engine root + version once the handshake is in flight. */
  connect(): Promise<{ root: string; version: string }> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      const headers: Record<string, string> = {};
      if (this.opts.previewToken) {
        headers["x-daytona-preview-token"] = this.opts.previewToken;
      }
      if (this.opts.cloudToken) {
        headers["x-zeros-cloud-token"] = this.opts.cloudToken;
      }
      const ws = new WebSocket(
        this.opts.url,
        Object.keys(headers).length > 0 ? { headers } : undefined,
      );
      this.ws = ws;

      const openTimer = setTimeout(
        () => reject(new Error("ws open timed out (10s)")),
        10_000,
      );
      ws.on("open", () => clearTimeout(openTimer));
      ws.on("error", (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
      ws.on("close", (code, reason) =>
        this.failAll(`socket closed ${code} ${reason}`),
      );
      ws.on("message", (data) => {
        let msg: AnyMsg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.dispatch(msg);
      });
    });
  }

  private dispatch(msg: AnyMsg): void {
    switch (msg.type) {
      case "ENGINE_READY": {
        this.engineRoot = String(msg.root ?? "");
        this.engineVersion = String(msg.version ?? "");
        // Reply with CONNECTED to complete the protocol handshake.
        this.send({
          type: "CONNECTED",
          source: "client",
          capabilities: [],
          protocolVersion: PROTOCOL_VERSION,
        });
        this.readyResolve?.({
          root: this.engineRoot,
          version: this.engineVersion,
        });
        this.readyResolve = null;
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

  private send(fields: AnyMsg): string {
    const id = randomUUID();
    const envelope = { ...fields, id, timestamp: Date.now() };
    this.ws?.send(JSON.stringify(envelope));
    return id;
  }

  /** WORKSPACE_REQUEST → result (e.g. op="file.tree", params={workspaceId:"local-main"}). */
  request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.send({
        type: "WORKSPACE_REQUEST",
        source: "client",
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
  }): Promise<AnyMsg> {
    return new Promise((resolve, reject) => {
      const id = this.send({
        type: "PTY_CREATE",
        source: "client",
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
        resolve: (m) => resolve(m as AnyMsg),
        reject,
        timer,
      });
    });
  }

  ptyWrite(sessionId: string, data: string): void {
    this.send({ type: "PTY_WRITE", source: "client", sessionId, data });
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
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
