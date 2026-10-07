import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorHostedAgents } from "../dev-environment/hosted-agent-monitor.mjs";
const boundary = vi.hoisted(() => ({ lease: vi.fn(async (_registry: unknown, _identity: unknown, operation: any) => operation({ state: { generation: 'test-generation', status: 'ready' } })) }));
vi.mock('../dev-environment/hosted-state.mjs', () => ({ withHostedLease: boundary.lease }));
beforeEach(() => vi.clearAllMocks());
describe('Dev generation rotation monitor',()=>{
  it('refuses native fixture monitoring before acquiring a lease or preparing agent authority', async () => {
    const agents = vi.fn(), mutation = vi.fn(), progress = vi.fn();
    await expect(monitorHostedAgents({ registry: {}, identity: {}, generation: 'test-generation', profile: { fixture: {}, connections: { enabled: true } },
      services: { agents }, mutation, progress, watch: false })).rejects.toMatchObject({ status: 409, code: 'release_worker_images_retired' });
    expect(boundary.lease).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
    expect(agents).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
  });
  it('checks connection authority even when image qualification has no fixture',async()=>{
    const agents=vi.fn(async()=>({state:'ready'}));
    await monitorHostedAgents({registry:{},identity:{},generation:'test-generation',profile:{connections:{enabled:true}},services:{agents},watch:false});
    expect(agents).toHaveBeenCalledOnce();
  });
  it('preserves the disabled no-fixture path',async()=>{
    const agents=vi.fn();
    await monitorHostedAgents({registry:{},identity:{},generation:'test-generation',profile:{},services:{agents},watch:false});
    expect(agents).not.toHaveBeenCalled();
  });
});
