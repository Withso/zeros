import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorHostedAgents } from "../dev-environment/connection-monitor.mjs";
const boundary = vi.hoisted(() => ({ lease: vi.fn(async (_registry: unknown, _identity: unknown, operation: any) => operation({ state: { generation: 'test-generation', status: 'ready' } })) }));
vi.mock('../dev-environment/hosted-state.mjs', () => ({ withHostedLease: boundary.lease }));
beforeEach(() => vi.clearAllMocks());
describe('Dev generation rotation monitor',()=>{
  it('maintains connection authority when the Dev profile also has a fixture', async () => {
    const agents = vi.fn(async () => ({ state: 'ready' })), progress = vi.fn();
    await monitorHostedAgents({ registry: {}, identity: {}, generation: 'test-generation',
      profile: { fixture: {}, connections: { enabled: true } }, services: { agents }, progress, watch: false });
    expect(boundary.lease).toHaveBeenCalledOnce();
    expect(agents).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith('Dev agent connection references are current.');
  });
  it('checks connection authority without a fixture',async()=>{
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
