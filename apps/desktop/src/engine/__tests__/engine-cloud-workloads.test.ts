import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../pty/node-pty-spawn',()=>({createNodePtyShell:vi.fn(),createTerminalMirror:vi.fn(),disposePtyHost:vi.fn()}));
import {ZerosEngine} from '../zeros-engine';
import {HostExecutionBoundary} from '../agents/containment/host-boundary';
import {CloudOwnedWorkloadRegistry} from '../agents/containment/cloud-owned-workloads';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.reverse())await close();closes.length=0;});
async function fixture(kind:'ssh'|'agent'='ssh'){
 const root=await mkdtemp(path.join(tmpdir(),'engine-owned-'));closes.push(()=>rm(root,{recursive:true,force:true}));
 const cloudWorkloads=new CloudOwnedWorkloadRegistry();closes.push(()=>cloudWorkloads.drain(cloudWorkloads.fence()));
 const host=new HostExecutionBoundary({projectRoot:root,supervisorScript:path.resolve('apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs'),supervisorRuntime:process.execPath});
 const scope=await cloudWorkloads.prepare(host,{executionId:'human-original',actor:'repo-code-task',cwd:root,workspaceRoot:root},undefined,{kind,role:'workload'});
 const child=await scope.spawn({command:'/bin/sh',args:['-c','sleep 60'],cwd:root,env:{PATH:'/usr/bin:/bin'}});
 const engine=Object.assign(Object.create(ZerosEngine.prototype),{root,running:false,cloudWorker:{},cloudWorkloads,
  cloudIdleStop:{close:vi.fn()},cloudLocalWriterLifecycle:null,cloudRuntimeAuthorityStopping:false});
 return{root,cloudWorkloads,scope,child,engine};
}
describe('engine owned workload lifecycle',()=>{
 it('closes every launch synchronously and proves original groups empty on partial-start Stop',async()=>{
  const f=await fixture();const stopped=f.engine.stop();
  expect(()=>f.cloudWorkloads.assertAccepting()).toThrow();await stopped;
  expect(await f.cloudWorkloads.inspect()).toMatchObject({complete:true,pendingLaunches:0,workloadPids:[],infrastructurePids:[]});
 });
 it('drains the original registry before the durable writer freeze and retains the seal ticket',async()=>{
  const f=await fixture();let frozen=false;
  Object.assign(f.engine,{cloudAgentBoot:{authorityActive:true,quiesceForSeal:vi.fn(),executionFactory:{disposeBoot:vi.fn()}},
   cloudCommands:{pauseClaims:vi.fn(),lifecycleDrained:()=>true},cloudActions:{hasActiveWork:()=>false},cloudEvents:{flush:vi.fn()},
   cloudRuntimeRegistration:{pauseRecordForRuntimeHandoff:vi.fn()},cloudLocalMirror:{},cloudLocalNativePump:{dispose:vi.fn()},
   cloudLocalWriterLifecycle:{drainAndSeal:async(options:any)=>{await options.retireNative();
    expect(await f.cloudWorkloads.inspect()).toMatchObject({complete:true,workloadPids:[]});frozen=true;},captureCheckpoint:vi.fn()},
  });
  await f.engine.sealCloudLocalWriter();expect(frozen).toBe(true);expect(()=>f.cloudWorkloads.assertAccepting()).toThrow();
 });
 it('never captures or resumes after failed group retirement',async()=>{
  const f=await fixture(),capture=vi.fn();
  const original=f.cloudWorkloads.drain.bind(f.cloudWorkloads);vi.spyOn(f.cloudWorkloads,'drain').mockRejectedValueOnce(new Error('original group proof failed'));
  Object.assign(f.engine,{cloudAgentBoot:{authorityActive:true,quiesceForSeal:vi.fn(),executionFactory:{disposeBoot:vi.fn()}},
   cloudCommands:{pauseClaims:vi.fn()},cloudRuntimeRegistration:{},cloudLocalMirror:{},cloudLocalNativePump:{dispose:vi.fn()},
   cloudLocalWriterLifecycle:{drainAndSeal:async(options:any)=>options.retireNative(),captureCheckpoint:capture}});
  await expect(f.engine.sealCloudLocalWriter()).rejects.toThrow('original group proof failed');expect(capture).not.toHaveBeenCalled();
  expect(()=>f.cloudWorkloads.assertAccepting()).toThrow();await original(f.cloudWorkloads.fence());
 });
 it('does not skip human workload observation using an unrelated idle native host',async()=>{
  const f=await fixture();f.engine.cloudAgentBoot={authorityActive:true,executionFactory:{bootScopeActivity:()=>({complete:true,
    foreground:0,reservedLaunches:0,background:0,idleHosts:1,scopes:[{phase:'idle',executionId:'other-native'}]})}};
  const inspect=vi.spyOn(f.cloudWorkloads,'inspect');
  expect(await f.engine.cloudIdleUserProcesses()).toBe(true);expect(inspect).toHaveBeenCalledOnce();
 });
 it('does not keep an empty census busy solely because native metadata remains',async()=>{
  const engine=Object.assign(Object.create(ZerosEngine.prototype),{cloudWorker:{},cloudWorkloads:new CloudOwnedWorkloadRegistry(),
   cloudAgentBoot:{authorityActive:true,executionFactory:{bootScopeActivity:()=>({complete:true,foreground:0,reservedLaunches:0,
    background:0,idleHosts:1,scopes:[{phase:'idle',executionId:'unregistered-native'}]})}}});
  const inspect=vi.spyOn(engine.cloudWorkloads,'inspect');
  expect(await engine.cloudIdleUserProcesses()).toBe(false);expect(inspect).toHaveBeenCalledOnce();
 });
 it('does not skip inspection even for the exact registered idle native group',async()=>{
  const f=await fixture('agent');f.engine.cloudAgentBoot={authorityActive:true,executionFactory:{bootScopeActivity:()=>({complete:true,
   foreground:0,reservedLaunches:0,background:0,idleHosts:1,scopes:[{phase:'idle',executionId:'human-original'}]})}};
  const inspect=vi.spyOn(f.cloudWorkloads,'inspect');
  expect(await f.engine.cloudIdleUserProcesses()).toBe(true);expect(inspect).toHaveBeenCalledOnce();
 });
});
