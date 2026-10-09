import {resolveCloudRuntime} from "../agents/containment/cloud-runtime-root.mjs";
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import {createCloudSshSession} from './cloud-ssh-session.mjs';
import {CloudHumanWorkloads} from './cloud-human-workloads';
import type { CloudExecutionBoundary } from '../agents/containment/cloud-execution-boundary';
import type { CloudWorkerConfiguration } from '../agents/containment/cloud-worker-config';
import { isCloudDeploymentOwner } from '../agents/containment/cloud-deployment-authority.mjs';
import type { CloudRuntimeServiceAccess } from '../cloud-runtime-registration';
import type { CloudRuntimeServiceStream } from './cloud-service-gateway';

export function cloudSshWorkerLaunch(worker: CloudWorkerConfiguration): { command: string; args: string[]; script: string } {
  const runtime = resolveCloudRuntime();
  if (worker.toolchain.node !== runtime.node || !path.isAbsolute(runtime.node)) throw new Error('Cloud SSH identity is unavailable');
  const script = path.join(runtime.workerRoot, 'apps/desktop/src/engine/transport/cloud-ssh-session.mjs');
  return { command: runtime.node, script, args: [script] };
}

export function parseCloudSshIntro(source: string): Extract<CloudRuntimeServiceStream['intro'], { kind: 'ssh' }> {
  if (Buffer.byteLength(source) > 1024) throw new Error('Invalid SSH introduction');
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSH introduction');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'hostKeySha256,kind,publicKey,version' || data.version !== 1 || data.kind !== 'ssh' ||
      typeof data.publicKey !== 'string' || typeof data.hostKeySha256 !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(data.hostKeySha256)) throw new Error('Invalid SSH introduction');
  const matched = /^ssh-ed25519 ([A-Za-z0-9+/]{68})\s*$/.exec(data.publicKey);
  if (!matched) throw new Error('Invalid SSH host key');
  const raw = Buffer.from(matched[1]!, 'base64');
  if (raw.length !== 51 || raw.readUInt32BE(0) !== 11 || raw.subarray(4,15).toString() !== 'ssh-ed25519' || raw.readUInt32BE(15) !== 32 ||
      raw.toString('base64') !== matched[1] || createHash('sha256').update(raw).digest('base64').replace(/=+$/,'') !== data.hostKeySha256) throw new Error('Invalid SSH host key');
  return { version: 1, kind: 'ssh', publicKey: `ssh-ed25519 ${matched[1]}`, hostKeySha256: data.hostKeySha256 };
}

/** Called only for an authenticated cloud engine. It owns SSH parsing and
 * supervises each same-user channel through the original workload registry. */
export class CloudRuntimeHumanServices {
  private paused = false;
  private readonly workers = new Set<{ close(): void; retired: Promise<void> }>();
  private readonly tunnels = new Map<Socket, { bytes: number }>();
  private lastTunnelTrafficAt: number | null = null;
  hasActiveWork(): boolean {
    const now = this.now();
    for (const [stream, traffic] of this.tunnels) {
      this.recordTunnelTraffic(stream, traffic, now);
    }
    return this.workers.size > 0 || (this.lastTunnelTrafficAt !== null && now - this.lastTunnelTrafficAt < 10 * 60_000);
  }
  private recordTunnelTraffic(stream: Socket, traffic: { bytes: number }, now: number): void {
    const bytes = stream.bytesRead + stream.bytesWritten;
    if (bytes > traffic.bytes) {
      traffic.bytes = bytes;
      this.lastTunnelTrafficAt = now;
    }
  }
  constructor(private readonly worker: CloudWorkerConfiguration, private readonly forbiddenPorts: () => readonly number[],
    private readonly now: () => number = () => performance.now(),
    private readonly boundary?: Pick<CloudExecutionBoundary, "prepareOwned">, private readonly failed: () => void = () => {}) {}

  /** Pause owns every in-flight launch and waits for its Host process-group
   * retirement proof before allowing final checkpoint capture. */
  async pause(): Promise<void> {
    this.paused = true;
    const active = [...this.workers];
    for (const worker of active) worker.close();
    if (!active.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(active.map(worker => worker.retired)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cloud SSH retirement was not confirmed')), 15_000); timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }
  resume(): void { this.paused = false; }

  async open(grant: CloudRuntimeServiceAccess): Promise<CloudRuntimeServiceStream> {
    if (this.paused) throw new Error('Cloud human services are paused');
    if (grant.kind === 'ssh' && grant.remotePort === null) return this.openSsh();
    if (grant.kind !== 'tunnel' || !Number.isSafeInteger(grant.remotePort) || grant.remotePort! < 1024 || grant.remotePort! > 65535 ||
        grant.remotePort === 22222 || this.forbiddenPorts().includes(grant.remotePort!)) throw new Error('Cloud tunnel destination is unavailable');
    const stream = connect({ host: '127.0.0.1', port: grant.remotePort! });
    // Traffic, rather than an unused listener or authority heartbeat, is work.
    // Socket byte counters observe both directions without consuming data.
    const traffic = { bytes: 0 };
    this.tunnels.set(stream, traffic);
    stream.once('close', () => {
      // A short request can finish entirely between idle observations. Retain
      // only its activity time, including bytes not observed before close.
      this.recordTunnelTraffic(stream, traffic, this.now());
      this.tunnels.delete(stream);
    });
    stream.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { stream.destroy(); reject(new Error('Cloud tunnel connection timed out')); }, 10_000); timer.unref();
        stream.once('connect', () => { clearTimeout(timer); resolve(); });
        stream.once('error', () => { clearTimeout(timer); reject(new Error('Cloud tunnel destination is unavailable')); });
      });
      stream.pause();
      return { stream, intro: { version: 1, kind: 'tunnel' }, close: () => stream.destroy() };
    } catch (error) { stream.destroy(); throw error; }
  }

  private async openSsh(): Promise<CloudRuntimeServiceStream> {
    const launch = cloudSshWorkerLaunch(this.worker);
    const info = lstatSync(launch.script);
    if (!info.isFile() || info.isSymbolicLink() || !isCloudDeploymentOwner(launch.script, info.uid) || (info.mode & 0o022) !== 0) throw new Error('Cloud SSH worker is unavailable');
    if (!this.boundary) throw new Error('Cloud SSH lifecycle is unavailable');
    const owned = new CloudHumanWorkloads(this.boundary, '/srv/zeros/workspace', this.failed);
    const incoming = new PassThrough(), outgoing = new PassThrough();
    const stream = Duplex.from({readable:outgoing,writable:incoming});
    const peer = Duplex.from({readable:incoming,writable:outgoing});
    const session = createCloudSshSession(peer, {cwd:'/srv/zeros/workspace',sftpServer:'/usr/lib/openssh/sftp-server',
      env:{HOME:'/srv/zeros/home/agent',PATH:`${resolveCloudRuntime().binRoot}:/usr/local/bin:/usr/bin:/bin`,
        LANG:'C.UTF-8',USER:'zeros-engine',LOGNAME:'zeros-engine',SHELL:'/bin/bash'},
      spawnProcess:(command,args,options)=>owned.spawnProcess(command,args,options),
      spawnPty:(command,args,options)=>owned.spawnPty(command,args,options),
    });
    let closed = false;
    let retirement: Promise<void> | null = null;
    const close = () => {
      if (retirement) return;
      retirement = Promise.resolve().then(() => owned.close()).then(() => {
        this.workers.delete(worker);
      }, error => { retirement = null; this.failed(); throw error; });
      void retirement.catch(() => {});
      if (!closed) {closed = true;session.close();stream.destroy();}
    };
    const worker = {close, get retired(): Promise<void> {
      if (!retirement) throw new Error("Cloud SSH retirement has not started");
      return retirement;
    }};
    this.workers.add(worker);
    stream.once('close',close);stream.on('error',close);
    try {
      if (this.paused) throw new Error('Cloud human services are paused');
      const intro = parseCloudSshIntro(JSON.stringify({version:1,kind:'ssh',publicKey:session.publicKey,hostKeySha256:session.hostKeySha256}));
      session.start();stream.pause();
      return {stream,intro,close};
    } catch(error) {close();await worker.retired;throw error;}
  }
}
