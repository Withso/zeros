import { describe, expect, it, vi } from "vitest";
import { monitorHostedAgents } from "../dev-environment/hosted-agent-monitor.mjs";
vi.mock('../dev-environment/hosted-state.mjs',()=>({withHostedLease:async(_registry:unknown,_identity:unknown,operation:any)=>operation({state:{generation:'test-generation',status:'ready'}})}));
describe('Dev generation rotation monitor',()=>{
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
