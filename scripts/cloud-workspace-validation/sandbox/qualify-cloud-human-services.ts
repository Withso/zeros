import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { statSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { CloudRuntimeHumanServices } from '../../../apps/desktop/src/engine/transport/cloud-human-services';
import { loadCloudWorkerConfiguration } from '../../../apps/desktop/src/engine/agents/containment/cloud-worker-config';

const { Client } = createRequire(import.meta.url)('ssh2');
const checks: string[] = [];
const marker = `/srv/zeros/workspace/.zeros-human-qualification-${randomUUID()}`;
const transfer = `${marker}-sftp`;
let phase = 'configuration';
let services: CloudRuntimeHumanServices | undefined;
let client: InstanceType<typeof Client> | undefined;

async function main() {
  const worker = loadCloudWorkerConfiguration();
  assert(worker, 'Cloud worker configuration is unavailable');
  services = new CloudRuntimeHumanServices(worker, () => [22222]);
  phase = 'worker-launch';
  const peer = await services.open({ version: 1, audience: 'zeros-cloud-runtime-access-admission-v1', admitted: true, kind: 'ssh', remotePort: null, grantId: randomUUID(), accountUserId: randomUUID(), authorityEpoch: 1, expiresAtMs: Date.now() + 10_000 });
  assert.equal(peer.intro.kind, 'ssh');
  const intro = peer.intro as Extract<typeof peer.intro, { kind: 'ssh' }>;
  phase = 'handshake';
  const ssh = new Client(); client = ssh;
  ssh.on('error', () => {});
  const ready = new Promise<void>((resolve, reject) => { ssh.once('ready', resolve); ssh.once('error', () => reject(new Error('SSH handshake failed'))); });
  ssh.connect({ sock: peer.stream, username: 'zeros', authHandler: ['none'], readyTimeout: 10_000, hostHash: 'sha256',
    hostVerifier: (hex: string) => Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '') === intro.hostKeySha256 });
  await ready; checks.push('ssh-worker-in-admitted-engine-view');
  const exec = (command: string, options: Record<string, unknown> = {}) => new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    ssh.exec(command, options, (error: Error | undefined, stream: any) => {
      if (error) { reject(new Error('SSH command failed')); return; }
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error('SSH command deadline')); }, 5000);
      stream.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      stream.once('error', () => { clearTimeout(timer); reject(new Error('SSH command transport failed')); });
      stream.once('close', (code: number) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    });
  });
  phase = 'identity';
  const identity = await exec("id -u; id -g; awk '/^NoNewPrivs:|^CapEff:/{print}' /proc/self/status");
  assert.equal(identity.code, 0); assert.match(identity.stdout, /^10001\n10001\n/);
  assert.match(identity.stdout, /NoNewPrivs:\s+1/); assert.match(identity.stdout, /CapEff:\s+0+/);
  checks.push('ssh-workload-identity');
  phase = 'exec-pty';
  assert.deepEqual(await exec('printf output; printf error >&2; exit 17'), { stdout: 'output', stderr: 'error', code: 17 });
  checks.push('ssh-exec-output-and-exit');
  phase = 'pty';
  const pty = await exec('stty size', { pty: { cols: 91, rows: 29, term: 'xterm-256color' } });
  assert.equal(pty.code, 0); assert.match(pty.stdout, /29 91/); checks.push('ssh-exec-and-pty');
  phase = 'sftp';
  const sftp: any = await new Promise((resolve, reject) => ssh.sftp((error: Error | undefined, value: unknown) => error ? reject(new Error('SFTP handshake failed')) : resolve(value)));
  const bytes = Buffer.alloc(8192, 0x53);
  await promisify(sftp.writeFile.bind(sftp))(transfer, bytes, { flag: 'wx', mode: 0o600 });
  const read = await promisify(sftp.readFile.bind(sftp))(transfer);
  assert.equal(createHash('sha256').update(read).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(statSync(transfer).uid, 10001); await promisify(sftp.unlink.bind(sftp))(transfer); sftp.end(); checks.push('ssh-sftp');
  phase = 'namespace-retirement';
  // A detached writer ignoring shell-session signals must still die with the
  // PID namespace. This also exercises the final-checkpoint drain boundary.
  assert.equal((await exec(`setsid /bin/sh -c 'trap "" HUP TERM; while :; do printf x >> ${marker}; sleep 0.1; done' </dev/null >/dev/null 2>&1 & printf started`)).stdout, 'started');
  await new Promise(resolve => setTimeout(resolve, 350));
  await services.pause();
  const before = statSync(marker).size; assert(before > 0);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(statSync(marker).size, before); checks.push('ssh-detached-descendants-retired');
  process.stdout.write(JSON.stringify({ secure: true, checks }) + '\n');
}
main().catch(() => {
  process.stdout.write(JSON.stringify({ secure: false, phase, checks, error: 'Cloud human service qualification failed' }) + '\n');
  process.exitCode = 1;
}).finally(async () => {
  client?.destroy(); await services?.pause().catch(() => {});
  for (const file of [marker, transfer]) rmSync(file, { force: true });
});
