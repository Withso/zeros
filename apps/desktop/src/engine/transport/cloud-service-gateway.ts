import type { IncomingMessage } from 'node:http';
import { Transform, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { CloudRuntimeServiceAccess } from '../cloud-runtime-registration';

const HEADER = 'x-zeros-runtime-service';
const TOKEN = /^zsh_[A-Za-z0-9_-]{43}$/;
const PROTOCOL = 'zeros.service.v1';
const AUTH_PROTOCOL = 'zeros.authorization.';
const MAX_STREAMS = 8;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
export type CloudRuntimeServiceStream = {
  stream: Duplex;
  intro: { version: 1; kind: 'ssh'; publicKey: string; hostKeySha256: string } | { version: 1; kind: 'tunnel' };
  close(): void;
};

export function cloudServiceToken(headers: IncomingMessage['headers']): string | null {
  const direct = headers[HEADER];
  const offered = (headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (offered.length > 2 || new Set(offered).size !== offered.length ||
      offered.some(value => value !== PROTOCOL && !value.startsWith(AUTH_PROTOCOL))) return null;
  const carried = offered.filter(value => value.startsWith(AUTH_PROTOCOL));
  if (carried.length > 1 || (carried.length && !offered.includes(PROTOCOL))) return null;
  const token = direct ?? carried[0]?.slice(AUTH_PROTOCOL.length);
  if (typeof token !== 'string' || !TOKEN.test(token) ||
      (direct !== undefined && carried.length && token !== carried[0]!.slice(AUTH_PROTOCOL.length))) return null;
  return token;
}

function limitedStream(): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    done(bytes > MAX_TRANSFER_BYTES ? new Error('Service transfer limit') : null, chunk);
  } });
}

/** Provider-independent byte transport for SSH and one admitted loopback port.
 * Authenticate before starting a process or connecting a socket. Every stream
 * renews its current generation/account/grant lease; the deadline is separate
 * from renewal so a hung control plane cannot extend access. */
export class CloudRuntimeServiceGateway {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false, handleProtocols: offered => offered.has(PROTOCOL) ? PROTOCOL : false });
  private readonly streams = new Set<() => void>();
  private closed = false;
  private paused = false;
  private pendingVerifications = 0;
  constructor(private readonly options: {
    verify(token: string): Promise<CloudRuntimeServiceAccess | null>;
    open(grant: CloudRuntimeServiceAccess): Promise<CloudRuntimeServiceStream>;
    forbiddenPorts(): readonly number[];
  }) {}

  private allowed(grant: CloudRuntimeServiceAccess | null, kind: string): grant is CloudRuntimeServiceAccess {
    if (!grant || grant.kind !== kind || !Number.isSafeInteger(grant.expiresAtMs) ||
        grant.expiresAtMs <= Date.now() || grant.expiresAtMs > Date.now() + 10_000) return false;
    return kind === 'ssh' ? grant.remotePort === null : Number.isSafeInteger(grant.remotePort) &&
      grant.remotePort! >= 1024 && grant.remotePort! <= 65535 && grant.remotePort !== 22222 &&
      !this.options.forbiddenPorts().includes(grant.remotePort!);
  }

  private async verify(token: string): Promise<CloudRuntimeServiceAccess | null> {
    if (this.pendingVerifications >= MAX_STREAMS) return null;
    this.pendingVerifications++;
    try { return await this.options.verify(token); } finally { this.pendingVerifications--; }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const kind = req.url === '/services/v1/ssh' ? 'ssh' : req.url === '/services/v1/tunnel' ? 'tunnel' : null;
    if (!kind) return false;
    socket.on('error', () => {});
    const deny = (status: number) => socket.end(`HTTP/1.1 ${status} Service unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    const token = cloudServiceToken(req.headers), key = req.headers['sec-websocket-key'];
    if (!token || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[+/0-9A-Za-z]{22}==$/.test(key) ||
        !(req.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()).includes('upgrade') || head.length > MAX_FRAME_BYTES) { deny(401); return true; }
    if (this.closed || this.paused) { deny(503); return true; }
    if (this.streams.size >= MAX_STREAMS) { deny(429); return true; }
    socket.pause();
    let finished = false, upgraded = false;
    let peer: CloudRuntimeServiceStream | null = null;
    let client: import('ws').WebSocket | null = null;
    let expiresAt = 0;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let leaseDeadline: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const finish = (status?: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(handshake); clearTimeout(lifetime); clearTimeout(renewal); clearTimeout(leaseDeadline); clearInterval(ping);
      this.streams.delete(abort);
      peer?.close(); client?.terminate();
      if (!upgraded && status) deny(status); else socket.destroy();
    };
    const abort = () => finish();
    const handshake = setTimeout(() => finish(503), 10_000); handshake.unref();
    const lifetime = setTimeout(abort, 30 * 60_000); lifetime.unref();
    this.streams.add(abort); socket.once('close', abort);
    const run = async () => {
      const grant = await this.verify(token);
      if (finished) return;
      if (!this.allowed(grant, kind)) { finish(401); return; }
      const renew = (current: CloudRuntimeServiceAccess) => {
        expiresAt = current.expiresAtMs;
        clearTimeout(leaseDeadline);
        const remaining = expiresAt - Date.now();
        leaseDeadline = setTimeout(abort, Math.max(0, remaining)); leaseDeadline.unref();
        renewal = setTimeout(() => {
          void this.verify(token).then(next => {
            if (finished) return;
            if (Date.now() >= expiresAt || !this.allowed(next, kind) || next.grantId !== grant.grantId ||
                next.accountUserId !== grant.accountUserId || next.authorityEpoch !== grant.authorityEpoch || next.remotePort !== grant.remotePort) { finish(); return; }
            renew(next);
          }, abort);
        }, Math.max(1, Math.floor(remaining / 2))); renewal.unref();
      };
      renew(grant);
      const opened = await this.options.open(grant);
      if (finished) { opened.close(); return; }
      peer = opened;
      if (opened.intro.version !== 1 || opened.intro.kind !== kind || Buffer.byteLength(JSON.stringify(opened.intro)) > 1024) { finish(502); return; }
      if (Date.now() >= expiresAt) { finish(401); return; }
      this.server.handleUpgrade(req, socket, head, ws => {
        if (finished) { ws.terminate(); return; }
        upgraded = true; client = ws; clearTimeout(handshake);
        ws.on('error', abort); ws.once('close', abort);
        ws.on('message', (_data, binary) => { if (!binary) finish(); });
        ws.send(JSON.stringify(opened.intro), { binary: false, compress: false }, error => { if (error) finish(); });
        const bytes = createWebSocketStream(ws, { highWaterMark: MAX_FRAME_BYTES });
        void pipeline(bytes, limitedStream(), opened.stream).then(abort, abort);
        void pipeline(opened.stream, limitedStream(), bytes).then(abort, abort);
        let alive = true;
        ws.on('pong', () => { alive = true; });
        ping = setInterval(() => { if (!alive) finish(); else { alive = false; ws.ping(); } }, 20_000); ping.unref();
        socket.resume();
      });
    };
    void run().catch(() => finish(503));
    return true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) for (const abort of [...this.streams]) abort();
  }
  close(): void {
    this.closed = true;
    for (const abort of [...this.streams]) abort();
    this.server.close();
  }
}
