import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { cloudSshWorkerLaunch,parseCloudSshIntro,CloudRuntimeHumanServices } from '../cloud-human-services';
import type { CloudWorkerConfiguration } from '../../agents/containment/cloud-worker-config';
const {utils}=createRequire(import.meta.url)('ssh2');
import {testCloudRuntime,testCloudWorker} from "../../agents/__tests__/helpers/test-cloud-runtime";
vi.mock("../../agents/containment/cloud-runtime-root.mjs",async original=>({
  ...await original<typeof import("../../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime:(await import("../../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const worker:CloudWorkerConfiguration=testCloudWorker();
const intro=()=>{const keys=utils.generateKeyPairSync('ed25519'),raw=utils.parseKey(keys.public).getPublicSSH();return{version:1,kind:'ssh',publicKey:keys.public,hostKeySha256:createHash('sha256').update(raw).digest('base64').replace(/=+$/,'')};};
describe('cloud human service process boundary',()=>{
 it('counts forwarding traffic for ten minutes but never lets an unused listener renew activity',()=>{
  let now=0;
  const services=new CloudRuntimeHumanServices(worker,()=>[],()=>now);
  const stream={bytesRead:0,bytesWritten:0};
  const tunnels=(services as unknown as {tunnels:Map<typeof stream,{bytes:number}>}).tunnels;
  tunnels.set(stream,{bytes:0});
  expect(services.hasActiveWork()).toBe(false);
  now=600_000;expect(services.hasActiveWork()).toBe(false);
  stream.bytesWritten=1;expect(services.hasActiveWork()).toBe(true);
  now+=600_000;expect(services.hasActiveWork()).toBe(false);
 });
 it('launches the pinned SSH helper as the engine without privilege-drop or sandbox wrappers',()=>{
  const runtime=testCloudRuntime();
  expect(cloudSshWorkerLaunch(worker)).toEqual({command:runtime.node,
   script:`${runtime.workerRoot}/apps/desktop/src/engine/transport/cloud-ssh-session.mjs`,
   args:[`${runtime.workerRoot}/apps/desktop/src/engine/transport/cloud-ssh-session.mjs`]});
 });
 it('rejects unpinned or relative Node executables',()=>{
  for(const node of ['node','/srv/zeros/workspace/node','/bin/bash'])
   expect(()=>cloudSshWorkerLaunch({...worker,toolchain:{...worker.toolchain,node}})).toThrow();
 });
 it('validates the actual SSH public key and fingerprint',()=>{
  const expected=intro();expect(parseCloudSshIntro(JSON.stringify(expected))).toEqual({...expected,publicKey:expected.publicKey.trim()});
 });
 it.each(['fingerprint','key type','extra field','oversized'])('rejects an invalid worker introduction: %s',kind=>{
  const value=intro();
  if(kind==='fingerprint')value.hostKeySha256='a'.repeat(43);
  if(kind==='key type')value.publicKey=value.publicKey.replace('ssh-ed25519','ssh-rsa');
  if(kind==='extra field')Object.assign(value,{environment:'must not be disclosed'});
  expect(()=>parseCloudSshIntro(kind==='oversized'?' '.repeat(1025):JSON.stringify(value))).toThrow();
 });

});
