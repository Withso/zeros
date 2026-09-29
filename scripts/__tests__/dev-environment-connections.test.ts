import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { archiveHosted, startHosted } from "../dev-environment/hosted-lifecycle.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { assertHostedCleanupTargets } from "../dev-environment/hosted-protection.mjs";
const profile:any={railway:{projectId:randomUUID(),serviceId:randomUUID(),protectedEnvironmentIds:[]},planetscale:{organization:'test',database:'test',protectedBranch:'main'},
  cloudflare:{},registry:{bucket:'registry',encryptionKey:'a'.repeat(64)},storage:{bucket:'objects'},boat:{}};
function setup(){const identity={owner:'a'.repeat(24),identity:'test'},state=newHostedGeneration(identity);return {identity,lease:{state,save:vi.fn(async()=>{}),fence:vi.fn(async()=>{})}};}
describe('persistent connection lifecycle',()=>{
  it('stops compute but retains the product DB while revocation needs GC retry',async()=>{
    const {lease}=setup(),calls:string[]=[];const services:any={lifecycleHooks:[{name:'connections',archive:async()=>{calls.push('revoke');throw new Error('offline');}}]};
    for(const name of ['stopBackend','deleteBackend','deleteWorkers','deleteImages','deleteWeb','deleteWebhook','deleteObjects','deleteDatabase'])services[name]=vi.fn(async()=>{calls.push(name)});
    await expect(archiveHosted(lease,profile,services)).rejects.toThrow('offline');
    expect(calls).toContain('stopBackend');expect(calls).toContain('deleteWorkers');expect(calls).not.toContain('deleteDatabase');
    services.lifecycleHooks[0].archive=async()=>{calls.push('revoked')};
    await archiveHosted(lease,profile,services);expect(calls.indexOf('revoked')).toBeLessThan(calls.indexOf('deleteDatabase'));expect(lease.state.status).toBe('archived');
  });
  it('retains revocation as a cleanup dependency if an operator removes the profile flag',async()=>{
    const {lease}=setup();lease.state.connectionRegistration={id:lease.state.generation};
    const services:any={};for(const name of ['stopBackend','deleteBackend','deleteWorkers','deleteImages','deleteWeb','deleteWebhook','deleteObjects','deleteDatabase'])services[name]=vi.fn(async()=>{});
    await expect(archiveHosted(lease,profile,services)).rejects.toThrow(/connection/i);
    expect(services.deleteWorkers).toHaveBeenCalled();expect(services.deleteDatabase).not.toHaveBeenCalled();
  });
  it('protects the entire broker project even before resource IDs exist',()=>{
    const {lease}=setup();
    expect(()=>assertHostedCleanupTargets(lease.state,{...profile,connections:{enabled:true,projectId:profile.railway.projectId}})).toThrow(/protected/i);
  });
  it('unions configured and recorded persistent projects for cleanup',()=>{
    const {lease}=setup();lease.state.connectionProtection={projectIds:[randomUUID()],environmentIds:[],serviceIds:[],volumeIds:[],names:[]};
    expect(()=>assertHostedCleanupTargets(lease.state,{...profile,connections:{enabled:true,projectId:profile.railway.projectId}})).toThrow(/protected/i);
  });
  it('rotates near-expiry authority on a same-source Run',async()=>{
    const {lease,identity}=setup(),call=vi.fn(async()=>{});lease.state.status='ready';lease.state.source={sourceSha256:'same'};
    lease.state.connectionRegistration={expiresAt:new Date(Date.now()+1000).toISOString()};
    const services:any={preflight:call,captureSource:async()=>({sourceSha256:'same'}),verify:call,lifecycleHooks:[{name:'connections',beforeDeploy:call}]};
    for(const name of ['ensureImage','ensureDatabase','ensureBackend','stopBackend','migrate','ensureWebhook','deployBackend','deployWeb'])services[name]=vi.fn(async()=>{});
    const {deploymentConfigFingerprint}=await import('../dev-environment/hosted-state.mjs');lease.state.configFingerprint=deploymentConfigFingerprint(lease.state,profile);
    expect((await startHosted(lease,identity,profile,services)).reused).toBe(false);expect(services.deployBackend).toHaveBeenCalled();
  });
});
