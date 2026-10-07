import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
 it('launches the image-owned Node worker after dropping identity and privilege elevation',()=>{
  expect(cloudSshWorkerLaunch(worker)).toEqual({command:'/usr/bin/bwrap',script:`${testCloudRuntime().workerRoot}/apps/desktop/src/engine/transport/cloud-ssh-session.mjs`,
   args:['--unshare-pid','--die-with-parent','--new-session','--bind','/','/','--proc','/proc','--dev','/dev',
    '--cap-drop','ALL','--cap-add','CAP_SETUID','--cap-add','CAP_SETGID','--','/usr/bin/setpriv',
    '--reuid=10001','--regid=10001','--clear-groups','--no-new-privs','--',testCloudRuntime().node,`${testCloudRuntime().workerRoot}/apps/desktop/src/engine/transport/cloud-ssh-session.mjs`]});
 });
 it('rejects root identity and relative executables',()=>{
  expect(()=>cloudSshWorkerLaunch({...worker,uid:0})).toThrow();
  expect(()=>cloudSshWorkerLaunch({...worker,toolchain:{...worker.toolchain,node:'node'}})).toThrow();
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
 it.runIf(process.getuid?.()!==10001)('refuses direct execution without the admitted workload identity',()=>{
  try{execFileSync(process.execPath,['apps/desktop/src/engine/transport/cloud-ssh-session.mjs'],{stdio:'pipe',timeout:5000});throw new Error('Worker unexpectedly ran');}
  catch(error){expect(error).toMatchObject({status:1});expect((error as {stderr:Buffer}).stderr.toString()).toBe('Cloud SSH worker unavailable\n');}
 });
});
