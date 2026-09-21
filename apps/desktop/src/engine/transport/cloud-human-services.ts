import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { CloudWorkerConfiguration } from '../agents/containment/cloud-worker-config';
import { isCloudDeploymentOwner } from '../agents/containment/cloud-deployment-authority.mjs';
import type { CloudRuntimeServiceAccess } from '../cloud-runtime-registration';
import type { CloudRuntimeServiceStream } from './cloud-service-gateway';

export function cloudSshWorkerLaunch(worker: CloudWorkerConfiguration): { command: string; args: string[]; script: string } {
  if (worker.uid !== 10001 || worker.gid !== 10001 || !path.isAbsolute(worker.toolchain.node) ||
      !path.isAbsolute(worker.toolchain.setpriv) || !path.isAbsolute(worker.toolchain.bwrap) || !path.isAbsolute(worker.toolchain.supervisor)) throw new Error('Cloud SSH identity is unavailable');
  const script = path.resolve(path.dirname(worker.toolchain.supervisor), '../../transport/cloud-ssh-session.mjs');
  // A fresh devpts mount belongs to this admitted namespace. Inheriting the
  // outer engine's device mount prevents an unprivileged worker from opening
  // terminals, even though ordinary pipe-based commands still work.
  return { command: worker.toolchain.bwrap, args: [
    '--unshare-pid', '--die-with-parent', '--new-session', '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--cap-drop', 'ALL', '--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_SETGID', '--', worker.toolchain.setpriv,
    '--reuid=10001', '--regid=10001', '--clear-groups', '--no-new-privs', '--', worker.toolchain.node, script,
  ], script };
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

/** Called only for an admitted cloud worker. SSH parsing runs after setpriv;
 * all child environment values are explicit and contain no admission secret. */
export class CloudRuntimeHumanServices {
  private paused = false;
  private readonly workers = new Set<{ close(): void; retired: Promise<void> }>();
  constructor(private readonly worker: CloudWorkerConfiguration, private readonly forbiddenPorts: () => readonly number[]) {}

  /** Kernel PID namespaces include detached descendants. Closing the worker
   * and awaiting its namespace supervisor makes final checkpoints wait for
   * human shell writers as well as the engine's normal PTY registry. */
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
    const child = spawn(launch.command, launch.args, { cwd: '/', env: {
      HOME: '/srv/zeros/home/agent', PATH: '/opt/zeros-runtime/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
    }, stdio: ['pipe','pipe','pipe'] });
    child.stdin.on('error', () => {}); child.stdout.on('error', () => {}); child.stderr.resume();
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2_000); timer.unref();
        child.once('exit', () => clearTimeout(timer));
      }
    };
    const worker = { close, retired: new Promise<void>(resolve => child.once('close', () => resolve())) };
    this.workers.add(worker);
    void worker.retired.then(() => this.workers.delete(worker));
    try {
      const intro = await new Promise<Extract<CloudRuntimeServiceStream['intro'], { kind: 'ssh' }>>((resolve, reject) => {
        let pending = Buffer.alloc(0), settled = false;
        const finish = (error?: Error, source?: string, remainder?: Buffer) => {
          if (settled) return; settled = true;
          clearTimeout(timer); child.stdout.off('data', data); child.off('error', failed); child.off('exit', failed);
          child.stdout.pause();
          if (error) { reject(error); return; }
          try { if (remainder?.length) child.stdout.unshift(remainder); resolve(parseCloudSshIntro(source!)); }
          catch { reject(new Error('Cloud SSH worker introduction is invalid')); }
        };
        const failed = () => finish(new Error('Cloud SSH worker is unavailable'));
        const data = (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);
          const newline = pending.indexOf(10);
          if (newline > 1024 || (newline < 0 && pending.length > 1024)) { failed(); return; }
          if (newline >= 0) finish(undefined, pending.subarray(0,newline).toString('utf8'), pending.subarray(newline+1));
        };
        const timer = setTimeout(failed, 10_000); timer.unref();
        child.once('error', failed); child.once('exit', failed); child.stdout.on('data', data);
      });
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      child.on('error', () => stream.destroy());
      child.once('exit', () => stream.destroy());
      stream.once('close', close); stream.on('error', close);
      if (this.paused) { close(); throw new Error('Cloud human services are paused'); }
      return { stream, intro, close };
    } catch (error) { close(); throw error; }
  }
}
