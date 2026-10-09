import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HostExecutionBoundary} from '../../agents/containment/host-boundary';
import {CloudOwnedWorkloadRegistry} from '../../agents/containment/cloud-owned-workloads';
import {CloudHumanWorkloads} from '../cloud-human-workloads';
import type {BoundaryRequest,AdmissionControl} from '../../agents/containment/types';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.reverse())await close();cleanup.length=0;});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'human-workloads-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const registry=new CloudOwnedWorkloadRegistry(),host=new HostExecutionBoundary({projectRoot:root,supervisorRuntime:process.execPath,supervisorScript:path.resolve('apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs')});
 const boundary={prepareOwned:(request:BoundaryRequest,control:AdmissionControl&{kind:'ssh';role:'workload'})=>registry.prepare(host,request,control,control)};
 const workloads=new CloudHumanWorkloads(boundary,root);cleanup.push(()=>workloads.close());
 return{root,registry,boundary,workloads};
}
describe('human workload groups on the original shared registry',()=>{
 it('owns every process independently and stops descendants without stopping its sibling',async()=>{
  const a=await fixture(),b=await fixture();
  const first=await a.workloads.spawnProcess('/bin/sh',['-c','sleep 60 & wait'],{cwd:a.root,env:{PATH:'/usr/bin:/bin'}});
  const second=await b.workloads.spawnProcess('/bin/sh',['-c','sleep 60'],{cwd:b.root,env:{PATH:'/usr/bin:/bin'}});
  expect(first.pid).toBeGreaterThan(0);expect(second.pid).toBeGreaterThan(0);
  await a.workloads.close();expect(a.registry.snapshot().scopes).toEqual([]);
  expect(b.registry.snapshot().scopes).toHaveLength(1);expect(()=>process.kill(second.pid!,0)).not.toThrow();
 });
 it('registers a pending preparation before Stop and refuses its late native spawn',async()=>{
  const f=await fixture();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const boundary={prepareOwned:vi.fn(async(request:BoundaryRequest,control:AdmissionControl&{kind:'ssh';role:'workload'})=>{await gate;return f.boundary.prepareOwned(request,control);})};
  const owned=new CloudHumanWorkloads(boundary,f.root);const launch=owned.spawnProcess('/bin/sh',['-c','sleep 60'],{cwd:f.root,env:{PATH:'/usr/bin:/bin'}});
  const failure=expect(launch).rejects.toThrow();let stopped=false;
  const stop=owned.close().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  release();await failure;await stop;expect(f.registry.snapshot().scopes).toEqual([]);
 });
 it('retains failed retirement as busy and permits an exact proof retry',async()=>{
  const f=await fixture();const original=await f.boundary.prepareOwned({executionId:'failed-human',actor:'repo-code-task',cwd:f.root,workspaceRoot:f.root},{kind:'ssh',role:'workload'});
  const stop=vi.fn().mockRejectedValueOnce(new Error('proof failed')).mockImplementation(()=>original.stopAndProve());
  const failure=vi.fn();const owned=new CloudHumanWorkloads({prepareOwned:async()=>({...original,stopAndProve:stop})},f.root,failure);
  await owned.spawnProcess('/bin/sh',['-c','sleep 60'],{cwd:f.root,env:{PATH:'/usr/bin:/bin'}});
  await expect(owned.close()).rejects.toThrow('proof failed');expect(owned.hasActiveWork()).toBe(true);expect(failure).toHaveBeenCalled();
  await owned.close();expect(owned.hasActiveWork()).toBe(false);
 });
});
