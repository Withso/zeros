import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { statSync, rmSync } from 'node:fs';
import { writeFile, readFile, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudRuntimeHumanServices } from '../../../apps/desktop/src/engine/transport/cloud-human-services';
import { createCloudQualificationRuntime, type CloudQualificationRuntime } from './cloud-qualification-runtime';
import { cloudRoleIdentityProbe } from './cloud-role-identity';
import { cloudWorkspacePublicationPath } from '../../../apps/desktop/src/engine/agents/containment/cloud-workspace-paths';
import { createAttachmentTemporaryDirectory, type AttachmentTemporaryDirectory } from '../../../apps/desktop/src/engine/files/attachment-temporary-directory';

const { Client } = createRequire(import.meta.url)('ssh2');
export async function qualifyCloudHumanServices(context: CloudQualificationRuntime = createCloudQualificationRuntime()) {
const { configuration: worker, boundary, custody, workloads } = context;
const checks: string[] = [];
const marker = `/srv/zeros/workspace/.zeros-human-qualification-${randomUUID()}`;
const transfer = `${marker}-sftp`;
let phase = 'configuration';
let services: CloudRuntimeHumanServices | undefined;
let client: InstanceType<typeof Client> | undefined;
let temporary: AttachmentTemporaryDirectory | undefined;
let identityObserved = false, failed = false;

async function main() {
  custody.assertLive();
  assert(worker, 'Cloud worker configuration is unavailable');
  services = new CloudRuntimeHumanServices(worker, () => [22222], performance.now, boundary, ()=>{ throw new Error("Owned SSH retirement failed"); });
  phase = 'engine-launch';
  const peer = await services.open({ version: 1, audience: 'zeros-cloud-runtime-access-admission-v1', admitted: true, kind: 'ssh', remotePort: null, grantId: randomUUID(), accountUserId: randomUUID(), authorityEpoch: 1, expiresAtMs: Date.now() + 10_000 });
  assert.equal(peer.intro.kind, 'ssh');
  const intro = peer.intro as Extract<typeof peer.intro, { kind: 'ssh' }>;
  phase = 'handshake';
  const ssh = new Client(); client = ssh;
  ssh.on('error', () => {});
  const ready = new Promise<void>((resolve, reject) => { ssh.once('ready', resolve); ssh.once('error', () => reject(new Error('SSH handshake failed'))); });
  ssh.connect({ sock: peer.stream, username: 'zeros', authHandler: ['none'], readyTimeout: 10_000, hostHash: 'sha256',
    hostVerifier: (hex: string) => Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '') === intro.hostKeySha256 });
  await ready; checks.push('ssh-in-admitted-engine-view');
  const exec = (command: string, options: Record<string, unknown> = {}) => new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    ssh.exec(command, options, (error: Error | undefined, stream: any) => {
      if (error) { reject(new Error('SSH command failed')); return; }
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error('SSH command deadline')); }, 5000);
      const collect = (chunk: Buffer, error: boolean) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 65536) {
          clearTimeout(timer); stream.close(); reject(new Error('SSH qualification output limit')); return;
        }
        if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      stream.on('data', (chunk: Buffer) => collect(chunk, false));
      stream.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
      stream.once('error', () => { clearTimeout(timer); reject(new Error('SSH command transport failed')); });
      stream.once('close', (code: number) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    });
  });
  phase = 'identity';
  const script = cloudRoleIdentityProbe({ workloadDirectory: custody.entry.workload.directory, credential: "absent" }) + "process.stdout.write('shared-human-identity-qualified');";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const identity = await exec(`${quote(worker.toolchain.node)} -e ${quote(script)}`);
  assert.equal(identity.code, 0); assert.equal(identity.stdout, 'shared-human-identity-qualified');
  assert.equal(identity.stderr, ''); identityObserved = true;
  checks.push('ssh-engine-identity');
  phase = 'attachment-publication';
  temporary = await createAttachmentTemporaryDirectory('/srv/zeros/workspace');
  const staged = `${temporary.path}/payload`;
  await writeFile(staged, 'complete attachment', { flag: 'wx', mode: 0o600 });
  // This path consists only of fixed image names and mkdtemp entropy. Never
  // interpolate a user attachment name or payload into the workload command.
  assert.match(staged, /^\/srv\/zeros\/attachment-staging\/zeros-attachment-[A-Za-z0-9_-]+\/payload$/);
  const shared = await exec(`cat ${staged}`);
  assert.equal(shared.code, 0); assert.equal(shared.stdout, "complete attachment");
  // Computer workspaces expose the primary through a separate bind mount.
  // Use the same admitted, shared-mount destination as real attachment writes.
  await rename(staged, cloudWorkspacePublicationPath(transfer));
  assert.equal(await readFile(transfer, 'utf8'), 'complete attachment');
  rmSync(transfer);
  await temporary.dispose(); temporary = undefined;
  checks.push('shared-engine-attachment-staging', 'same-mount-atomic-attachment-publication');
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
  assert.equal(statSync(transfer).uid, worker.uid); await promisify(sftp.unlink.bind(sftp))(transfer); sftp.end(); checks.push('ssh-sftp');
  phase = 'owned-group-retirement';
  // The long-running command and background child remain in their ORIGINAL
  // Host group. Arbitrary setsid escapes are outside this lifecycle witness.
  const running = exec(`/bin/sh -c 'trap "" HUP TERM; while :; do printf x >> ${marker}; sleep 0.1; done' & wait`).catch(()=>null);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { if (statSync(marker).size > 0) break; } catch {} await new Promise(resolve=>setTimeout(resolve,20)); }
  assert(statSync(marker).size > 0);
  await services.pause(); await running;
  const before = statSync(marker).size;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(statSync(marker).size, before); checks.push('ssh-original-group-descendants-retired');
}
await main().catch(() => { failed = true; }).finally(async () => {
  try {
    client?.destroy(); await services?.pause();
    const inspection = await workloads.inspect();
    assert(inspection.complete && !inspection.pendingLaunches && !inspection.failedRetirements && !inspection.workloadPids.length);
    custody.assertLive();
    await temporary?.dispose();
    for (const file of [marker, transfer]) rmSync(file, { force: true });
  } catch { failed = true; }
});
return { sameEngineIdentity: !failed && identityObserved, noSandbox: !failed && identityObserved, phase, checks,
  ...(failed ? { error: 'Cloud human service qualification failed' } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualifyCloudHumanServices().then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.sameEngineIdentity) process.exitCode = 1;
  }).catch(() => { process.stdout.write(`${JSON.stringify({ sameEngineIdentity: false, noSandbox: false })}\n`); process.exitCode = 1; });
}
