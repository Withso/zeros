import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CloudWorkerConfiguration } from '../../agents/containment/cloud-worker-config';
const boundary = vi.hoisted(() => ({
  stat: vi.fn(), owner: vi.fn(), spawn: vi.fn(() => { throw new Error('qualified worker launch'); }),
}));
vi.mock('node:fs', async (actual) => ({ ...await actual<typeof import('node:fs')>(), lstatSync: boundary.stat }));
vi.mock('node:child_process', async (actual) => ({ ...await actual<typeof import('node:child_process')>(), spawn: boundary.spawn }));
vi.mock('../../agents/containment/cloud-deployment-authority.mjs', () => ({ isCloudDeploymentOwner: boundary.owner }));
import { CloudRuntimeHumanServices } from '../cloud-human-services';
const worker: CloudWorkerConfiguration = { version: 2, backend: 'cloud-worker', profile: 'zeros-cloud-worker-v2', uid: 10001, gid: 10001,
  toolchain: { node: '/opt/zeros-runtime/bin/node', setpriv: '/usr/bin/setpriv', supervisor: '/opt/zeros/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs', bwrap: '/usr/bin/bwrap' } };
const grant = { version: 1 as const, audience: 'zeros-cloud-runtime-access-admission-v1' as const, admitted: true as const, grantId: 'grant', accountUserId: 'owner', authorityEpoch: 1, expiresAtMs: Date.now() + 5000, kind: 'ssh' as const, remotePort: null };
const script = '/opt/zeros/apps/desktop/src/engine/transport/cloud-ssh-session.mjs';
beforeEach(() => {
  vi.clearAllMocks(); boundary.owner.mockReturnValue(true);
  boundary.stat.mockReturnValue({ uid: 65534, mode: 0o444, isFile: () => true, isSymbolicLink: () => false });
});
describe('SSH worker image ownership in the admitted engine namespace', () => {
  it('accepts host-root ownership mapped to the overflow UID only through the existing deployment authority check', async () => {
    await expect(new CloudRuntimeHumanServices(worker, () => []).open(grant)).rejects.toThrow('qualified worker launch');
    expect(boundary.owner).toHaveBeenCalledWith(script, 65534);
    expect(boundary.spawn).toHaveBeenCalledOnce();
  });
  it('rejects an overflow owner outside the admitted read-only image view', async () => {
    boundary.owner.mockReturnValue(false);
    await expect(new CloudRuntimeHumanServices(worker, () => []).open(grant)).rejects.toThrow('Cloud SSH worker is unavailable');
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it.each(['writable', 'symlink', 'directory'])('rejects an unsafe worker even if its owner is trusted: %s', kind => {
    boundary.stat.mockReturnValue({ uid: 0, mode: kind === 'writable' ? 0o666 : 0o444, isFile: () => kind !== 'directory', isSymbolicLink: () => kind === 'symlink' });
    return expect(new CloudRuntimeHumanServices(worker, () => []).open(grant)).rejects.toThrow('Cloud SSH worker is unavailable');
  });
});
