import {describe,expect,it,vi} from 'vitest';
import {hasCloudUserProcesses} from '../cloud-idle-stop';
const empty={complete:true,pendingLaunches:0,failedRetirements:0,workloadPids:[],infrastructurePids:[]};
describe('owned cloud idle inspections',()=>{
 it('counts only original workload membership including same-user sleeping work',async()=>{
  const inspect=vi.fn(async()=>({...empty,workloadPids:[process.pid+1]}));
  expect(await hasCloudUserProcesses({inspect})).toBe(true);expect(inspect).toHaveBeenCalledOnce();
 });
 it('accepts a complete original empty/infrastructure view without scanning UIDs',async()=>{
  expect(await hasCloudUserProcesses({inspect:async()=>({...empty,infrastructurePids:[process.pid+1]})})).toBe(false);
  expect(await hasCloudUserProcesses({inspect:async()=>empty})).toBe(false);
 });
 it('does not use worker-UID scan callbacks as same-user ownership proof',async()=>{
  const list=vi.fn(async()=>['12']),read=vi.fn(async()=> 'Uid: 10001 10001 10001 10001');
  // Old internal scan fields may survive a loaded caller. New idle ownership
  // comes only from the original registry, never UID/argv/name discovery.
  const options={inspect:async()=>empty,list,read};
  expect(await hasCloudUserProcesses(options)).toBe(false);
  expect(list).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
 });
 it.each(['missing','failed','pending','incomplete'])('refuses %s original proof',async state=>{
  const inspect=async()=>state==='failed'?Promise.reject(new Error('read failed')):{...empty,complete:state!=='incomplete',pendingLaunches:state==='pending'?1:0};
  expect(await hasCloudUserProcesses(state==='missing'?{}:{inspect})).toBe(true);
 });
});
