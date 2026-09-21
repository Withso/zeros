import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { assertCloudSshWorkerIdentity,createCloudSshSession } from '../cloud-ssh-session.mjs';
const {Client}=createRequire(import.meta.url)('ssh2');

describe('cloud SSH workload session',()=>{
 const cleanup:Array<()=>void|Promise<void>>=[];
 afterEach(async()=>{for(const close of cleanup.reverse())await close();cleanup.length=0;});
 it('starts the admitted stream only once even before SSH negotiation',()=>{
  const stream=new Duplex({read(){},write(_data,_encoding,done){done();}});
  const session=createCloudSshSession(stream,{cwd:tmpdir(),env:{PATH:'/usr/bin:/bin'}});
  cleanup.push(()=>session.close());session.start();
  expect(()=>session.start()).toThrow('SSH session is not available');
 });
 it('serves SSH over admitted process pipes without a TCP listener',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const serverStream=Duplex.from({readable:input,writable:output});
  const clientStream=Duplex.from({readable:output,writable:input});
  const session=createCloudSshSession(serverStream,{cwd:tmpdir(),env:{PATH:'/usr/bin:/bin'}});
  cleanup.push(()=>session.close());session.start();
  const client=new Client();cleanup.push(()=>client.destroy());
  const ready=new Promise<void>((resolve,reject)=>{client.once('ready',resolve);client.once('error',reject);});
  client.connect({sock:clientStream,username:'zeros',authHandler:['none'],readyTimeout:3000});
  await ready;expect(await exec(client,"printf 'pipe transport'" )).toMatchObject({stdout:'pipe transport',code:0});
 });
 async function fixture(username='zeros',options:Record<string,unknown>={}){
  const cwd=await mkdtemp(path.join(tmpdir(),'zeros-ssh-'));cleanup.push(()=>rm(cwd,{recursive:true,force:true}));
  let session:any;
  const server=createServer(socket=>{session=createCloudSshSession(socket,{cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,LANG:'C.UTF-8'},...options});session.start();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(async()=>{session?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const client=new Client();cleanup.push(()=>client.destroy());
  const ready=new Promise<void>((resolve,reject)=>{client.once('ready',resolve);client.once('error',reject);});
  client.connect({host:'127.0.0.1',port:(server.address() as {port:number}).port,username,readyTimeout:3000,
    hostHash:'sha256',hostVerifier:(hash:string)=>Buffer.from(hash,'hex').toString('base64').replace(/=+$/,'')===session.hostKeySha256,
    authHandler:['none']});
  return{client,cwd,ready};
 }
 const exec=(client:any,command:string,options:Record<string,unknown>={})=>new Promise<{stdout:string;stderr:string;code:number}>((resolve,reject)=>{
  client.exec(command,options,(error:Error|null,channel:any)=>{
   if(error){reject(error);return;}let stdout='',stderr='';
   channel.on('data',(data:Buffer)=>{stdout+=data.toString();});channel.stderr.on('data',(data:Buffer)=>{stderr+=data.toString();});
   channel.on('error',reject);channel.on('close',(code:number)=>resolve({stdout,stderr,code}));
  });
 });
 it.each([
  {uid:0,gid:10001,groups:[],status:'NoNewPrivs:\t1\nCapEff:\t0000000000000000'},
  {uid:10001,gid:0,groups:[],status:'NoNewPrivs:\t1\nCapEff:\t0000000000000000'},
  {uid:10001,gid:10001,groups:[0],status:'NoNewPrivs:\t1\nCapEff:\t0000000000000000'},
  {uid:10001,gid:10001,groups:[],status:'NoNewPrivs:\t0\nCapEff:\t0000000000000000'},
  {uid:10001,gid:10001,groups:[],status:'NoNewPrivs:\t1\nCapEff:\t0000000000000001'},
 ])('rejects a privileged or elevation-capable worker %j',({status,...identity})=>{
  expect(()=>assertCloudSshWorkerIdentity(status,{...identity,platform:'linux'})).toThrow('unprivileged cloud worker');
 });
 it('accepts only the fixed Linux workload identity',()=>{
  expect(()=>assertCloudSshWorkerIdentity('NoNewPrivs:\t1\nCapEff:\t0000000000000000',{platform:'linux',uid:10001,gid:10001,groups:[10001]})).not.toThrow();
 });
 it('executes commands with independent stderr and exit status',async()=>{
  const f=await fixture();await f.ready;
  expect(await exec(f.client,"printf 'stdout'; printf 'stderr' >&2; exit 17")).toEqual({stdout:'stdout',stderr:'stderr',code:17});
 });
 it('refuses a Unix username selected by the client',async()=>{
  const f=await fixture('root');await expect(f.ready).rejects.toThrow();
 });
 it('does not accept environment injection',async()=>{
  const f=await fixture();await f.ready;
  expect(await exec(f.client,"printf '%s' \"${ZEROS_SSH_INJECTED-unset}\"",{env:{ZEROS_SSH_INJECTED:'injected'}})).toMatchObject({stdout:'unset',code:0});
 });
 it('releases sequential channels and never starts a second command on a channel',async()=>{
  const f=await fixture();await f.ready;
  for(let n=0;n<8;n++)expect(await exec(f.client,`printf '${n}'`)).toMatchObject({stdout:String(n),code:0});
 });
 it('rejects port forwarding because a tunnel needs its own port-scoped grant',async()=>{
  const f=await fixture();await f.ready;
  await expect(new Promise((resolve,reject)=>f.client.forwardOut('127.0.0.1',1234,'127.0.0.1',43001,(error:Error|null,channel:any)=>error?reject(error):resolve(channel)))).rejects.toThrow();
 });
 it('provides a PTY with validated dimensions',async()=>{
  const f=await fixture();await f.ready;
  const result=await exec(f.client,'stty size',{pty:{cols:91,rows:29,term:'xterm-256color'}});
  expect(result.stdout).toContain('29 91');expect(result.code).toBe(0);
 });
 it('preserves UTF-8 bytes split across SSH input packets',async()=>{
  const writes:Buffer[]=[];
  const f=await fixture('zeros',{spawnPty:()=>({onData(){},onExit(){},kill(){},pause(){},resume(){},write(data:string|Buffer){writes.push(Buffer.from(data));}})});
  await f.ready;
  const channel:any=await new Promise((resolve,reject)=>f.client.exec('cat',{pty:{cols:80,rows:24,term:'xterm'}},(error:Error|null,channel:any)=>error?reject(error):resolve(channel)));
  channel.write(Buffer.from([0xc3]));
  await vi.waitFor(()=>expect(writes).toHaveLength(1));
  channel.write(Buffer.from([0xa9]));
  await vi.waitFor(()=>expect(writes).toHaveLength(2));
  expect(Buffer.concat(writes)).toEqual(Buffer.from('é'));
 });
});
