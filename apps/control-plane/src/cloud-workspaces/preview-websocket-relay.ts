import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type ClientOptions, type RawData } from "ws";
import { assertProviderPreviewEndpoint, type CloudProviderEngineEndpoint } from "./provider.js";

export type CloudPreviewSocketGrant = {
  grantId: string; workspaceId: string; organizationId: string; generation: number;
  resourceId: string; remotePort: number | null; expiresAtMs: number;
  endpoint: CloudProviderEngineEndpoint; headers: Record<string, string>; release(): void;
  /** A trusted coordinator may route its native service to a fixed path. */
  upstreamPath?: string;
};
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
type Pair = { client: WebSocket | null; remote: WebSocket | null; grant: CloudPreviewSocketGrant | null; retire(status?: number): void };
const sizeOf = (data: RawData) => Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;

/** Public preview transport; browser capabilities and provider credentials
 * terminate here. Database authority is renewed independently of traffic.
 * Frames, total buffers, admission work and per-grant sockets are bounded. */
export class CloudPreviewWebSocketRelay {
  private readonly protocols = new WeakMap<IncomingMessage, string>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: (_offered, req) => this.protocols.get(req) || false });
  private readonly pairs = new Set<Pair>();
  private closed = false;
  private pending = 0;
  private admissionTokens = 32;
  private lastAdmissionRefill = performance.now();
  private readonly authorityCheckMs: number;
  constructor(private readonly options: {
    recognizes(request: Request): boolean;
    resolve(request: Request): Promise<CloudPreviewSocketGrant | null>;
    revalidate(request: Request, grant: CloudPreviewSocketGrant): Promise<number | null>;
    openUpstream?: (url: string, protocols: string[], options: ClientOptions) => WebSocket;
    authorityCheckMs?: number;
    authorizeUpgrade?: (request: Request) => { protocols: string[] } | null;
  }) {
    this.authorityCheckMs = options.authorityCheckMs ?? 5_000;
    if (!Number.isSafeInteger(this.authorityCheckMs) || this.authorityCheckMs < 25 || this.authorityCheckMs > 5_000) throw new Error("Invalid preview authority interval");
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let request: Request;
    try {
      if (typeof req.headers.host !== "string" || !/^[A-Za-z0-9.:-]{1,260}$/.test(req.headers.host) || !req.url?.startsWith("/") || req.url.startsWith("//")) return false;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      request = new Request(`https://${req.headers.host}${req.url}`, { headers });
      if (!this.options.recognizes(request)) return false;
    } catch { return false; }
    socket.on("error", () => {});
    const reject = (status: number) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy()); };
    if (this.closed) { reject(503); return true; }
    const capability = req.headers["x-zeros-preview-capability"], key = req.headers["sec-websocket-key"];
    const authorization = this.options.authorizeUpgrade?.(request);
    const authorized = this.options.authorizeUpgrade ? authorization !== null : typeof capability === "string" && /^zwp_[A-Za-z0-9_-]{43}$/.test(capability);
    if (!authorized || req.method !== "GET" ||
      req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" || !/^[+/0-9A-Za-z]{22}==$/.test(key) || head.byteLength > MAX_FRAME_BYTES) { reject(401); return true; }
    const now = performance.now(); this.admissionTokens = Math.min(32, this.admissionTokens + Math.max(0, now - this.lastAdmissionRefill) / 500); this.lastAdmissionRefill = now;
    if (this.pending >= 32 || this.admissionTokens < 1) { reject(429); return true; }
    this.admissionTokens--;
    const offered = authorization?.protocols ?? (req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
    if (offered.length > 16 || offered.some(value => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(value)) || new Set(offered).size !== offered.length) { reject(401); return true; }
    let retired = false, upgraded = false, expiresAt = 0, checking = false;
    let authorityTimer: ReturnType<typeof setTimeout> | undefined, authorityDeadline: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const pair: Pair = { client: null, remote: null, grant: null, retire: status => {
      if (retired) return; retired = true;
      clearTimeout(handshake); clearTimeout(lifetime); clearTimeout(authorityTimer); clearTimeout(authorityDeadline); clearInterval(pingTimer);
      this.protocols.delete(req); this.pairs.delete(pair); pair.client?.terminate(); pair.remote?.terminate(); pair.grant?.release();
      if (!upgraded && status) reject(status); else socket.destroy();
    } };
    const handshake = setTimeout(() => pair.retire(503), 10_000); handshake.unref();
    const lifetime = setTimeout(() => pair.retire(), 30 * 60_000); lifetime.unref();
    this.pairs.add(pair); socket.once("close", () => pair.retire()); this.pending++;
    const renew = (expiry: number) => {
      if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + 10_000) { pair.retire(401); return; }
      expiresAt = expiry; clearTimeout(authorityDeadline); clearTimeout(authorityTimer);
      authorityDeadline = setTimeout(() => pair.retire(), expiry - Date.now()); authorityDeadline.unref();
      authorityTimer = setTimeout(() => {
        if (retired || checking || !pair.grant) return;
        checking = true;
        void this.options.revalidate(request, pair.grant).then(next => {
          checking = false; if (retired) return;
          if (Date.now() >= expiresAt || next === null) pair.retire(); else renew(next);
        }, () => pair.retire());
      }, Math.max(1, Math.min(this.authorityCheckMs, Math.floor((expiry - Date.now()) / 2)))); authorityTimer.unref();
    };
    const admit = async () => {
      let grant: CloudPreviewSocketGrant | null;
      try { grant = await this.options.resolve(request); } finally { this.pending--; }
      if (retired) { grant?.release(); return; }
      if (!grant) { pair.retire(401); return; }
      pair.grant = grant;
      const active = [...this.pairs].filter(candidate => candidate.grant);
      if (active.length > 16 || active.filter(candidate => candidate.grant!.grantId === grant.grantId).length > 4) { pair.retire(429); return; }
      assertProviderPreviewEndpoint({url: grant.endpoint.url, headerName: grant.endpoint.headerName ?? "x-zeros-endpoint-validation", headerValue: grant.endpoint.headerValue ?? "none"});
      if ((grant.endpoint.headerName === undefined) !== (grant.endpoint.headerValue === undefined) ||
          ["x-zeros-runtime-service", "sec-websocket-protocol"].includes(grant.endpoint.headerName ?? "")) { pair.retire(502); return; }
      renew(grant.expiresAtMs); if (retired) return;
      const url = new URL(grant.endpoint.url), original = new URL(request.url);
      url.protocol = "wss:"; url.pathname = grant.upstreamPath ?? original.pathname; url.search = grant.upstreamPath ? "" : original.search;
      const remote = (this.options.openUpstream ?? ((target, protocols, clientOptions) => new WebSocket(target, protocols, clientOptions)))(url.toString(), offered,
        { headers: { ...grant.headers, ...(grant.endpoint.headerName ? { [grant.endpoint.headerName]: grant.endpoint.headerValue } : {}) }, followRedirects: false, handshakeTimeout: 10_000,
          perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
      pair.remote = remote;
      remote.on("error", () => pair.retire(502)); remote.once("close", () => pair.retire(502));
      remote.once("unexpected-response", (_request, response) => { response.destroy(); pair.retire(502); });
      remote.once("open", () => {
        if (retired || this.closed || Date.now() >= expiresAt) { pair.retire(); return; }
        try {
          this.protocols.set(req, remote.protocol);
          this.server.handleUpgrade(req, socket, head, client => {
            upgraded = true; pair.client = client; clearTimeout(handshake); this.protocols.delete(req);
            client.on("error", () => pair.retire()); client.once("close", () => pair.retire());
            const forward = (target: WebSocket, data: RawData, binary: boolean) => {
              const size = sizeOf(data); let buffered = 0;
              for (const current of this.pairs) buffered += (current.client?.bufferedAmount ?? 0) + (current.remote?.bufferedAmount ?? 0);
              if (target.readyState !== WebSocket.OPEN || size > MAX_FRAME_BYTES || target.bufferedAmount + size > MAX_FRAME_BYTES || buffered + size > MAX_BUFFERED_BYTES) { pair.retire(); return; }
              target.send(data, { binary, compress: false }, error => { if (error) pair.retire(); });
            };
            client.on("message", (data, binary) => forward(remote, data, binary)); remote.on("message", (data, binary) => forward(client, data, binary));
            let localAlive = true, remoteAlive = true;
            client.on("pong", () => { localAlive = true; }); remote.on("pong", () => { remoteAlive = true; });
            pingTimer = setInterval(() => {
              if (!localAlive || !remoteAlive) { pair.retire(); return; }
              localAlive = false; remoteAlive = false; client.ping(); remote.ping();
            }, 20_000); pingTimer.unref();
          });
        } catch { pair.retire(502); }
      });
    };
    void admit().catch(() => pair.retire(503));
    return true;
  }
  close(): void { this.closed = true; for (const pair of [...this.pairs]) pair.retire(503); this.server.close(); }
}
