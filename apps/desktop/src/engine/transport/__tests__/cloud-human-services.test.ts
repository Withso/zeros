import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
import { cloudSshWorkerLaunch,parseCloudSshIntro } from '../cloud-human-services';
import type { CloudWorkerConfiguration } from '../../agents/containment/cloud-worker-config';
const {utils}=createRequire(import.meta.url)('ssh2');
const worker:CloudWorkerConfiguration={version:2,backend:'cloud-worker',profile:'zeros-cloud-worker-v2',uid:10001,gid:10001,
 toolchain:{node:'/opt/zeros-runtime/bin/node',setpriv:'/usr/bin/setpriv',supervisor:'/opt/zeros/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs',bwrap:'/usr/bin/bwrap'}};
const intro=()=>{const keys=utils.generateKeyPairSync('ed25519'),raw=utils.parseKey(keys.public).getPublicSSH();return{version:1,kind:'ssh',publicKey:keys.public,hostKeySha256:createHash('sha256').update(raw).digest('base64').replace(/=+$/,'')};};
describe('cloud human service process boundary',()=>{
 it('launches the image-owned Node worker after dropping identity and privilege elevation',()=>{
  expect(cloudSshWorkerLaunch(worker)).toEqual({command:'/usr/bin/bwrap',script:'/opt/zeros/apps/desktop/src/engine/transport/cloud-ssh-session.mjs',
   args:['--unshare-pid','--die-with-parent','--new-session','--bind','/','/','--proc','/proc','--dev','/dev',
    '--cap-drop','ALL','--cap-add','CAP_SETUID','--cap-add','CAP_SETGID','--','/usr/bin/setpriv',
    '--reuid=10001','--regid=10001','--clear-groups','--no-new-privs','--','/opt/zeros-runtime/bin/node','/opt/zeros/apps/desktop/src/engine/transport/cloud-ssh-session.mjs']});
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
