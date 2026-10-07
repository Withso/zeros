import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CloudWorkerConfiguration } from '../../agents/containment/cloud-worker-config';
const boundary = vi.hoisted(() => ({
  stat: vi.fn(), owner: vi.fn(), spawn: vi.fn(() => { throw new Error('qualified worker launch'); }),
}));
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  return { ...fs, lstatSync: (file: Parameters<typeof fs.lstatSync>[0]) =>
    String(file) === script ? boundary.stat(file) : fs.lstatSync(file) };
});
vi.mock('node:child_process', async (actual) => ({ ...await actual<typeof import('node:child_process')>(), spawn: boundary.spawn }));
vi.mock('../../agents/containment/cloud-deployment-authority.mjs', () => ({ isCloudDeploymentOwner: boundary.owner }));
import { CloudRuntimeHumanServices } from '../cloud-human-services';
import {testCloudRuntime,testCloudWorker} from "../../agents/__tests__/helpers/test-cloud-runtime";
vi.mock("../../agents/containment/cloud-runtime-root.mjs",async original=>({
  ...await original<typeof import("../../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime:(await import("../../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const worker:CloudWorkerConfiguration=testCloudWorker();
const grant = { version: 1 as const, audience: 'zeros-cloud-runtime-access-admission-v1' as const, admitted: true as const, grantId: 'grant', accountUserId: 'owner', authorityEpoch: 1, expiresAtMs: Date.now() + 5000, kind: 'ssh' as const, remotePort: null };
const script = `${testCloudRuntime().workerRoot}/apps/desktop/src/engine/transport/cloud-ssh-session.mjs`;
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
