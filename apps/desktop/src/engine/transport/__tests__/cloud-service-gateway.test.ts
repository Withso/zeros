import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { cloudServiceToken,CloudRuntimeServiceGateway,type CloudRuntimeServiceStream } from '../cloud-service-gateway';
import type { CloudRuntimeServiceAccess } from '../../cloud-runtime-registration';
const token='zsh_'+'t'.repeat(43);
const grant=():CloudRuntimeServiceAccess=>({version:1,audience:'zeros-cloud-runtime-access-admission-v1',admitted:true,grantId:'grant',accountUserId:'owner',authorityEpoch:1,kind:'tunnel',remotePort:3000,expiresAtMs:Date.now()+5000});
const service=():CloudRuntimeServiceStream=>{const stream=new PassThrough();return{stream,intro:{version:1,kind:'tunnel'},close:vi.fn(()=>stream.destroy())};};
describe('cloud native service gateway',()=>{
 const cleanups:Array<()=>void|Promise<void>>=[];
 afterEach(async()=>{for(const close of cleanups.reverse())await close();cleanups.length=0;});
 async function fixture(options:Partial<ConstructorParameters<typeof CloudRuntimeServiceGateway>[0]>={}){
  const open=vi.fn(async()=>service());
  const gateway=new CloudRuntimeServiceGateway({verify:async()=>grant(),open,forbiddenPorts:()=>[43001],...options});
  const server=createServer((_req,res)=>res.writeHead(404).end());
  server.on('upgrade',(req,socket,head)=>{if(!gateway.handleUpgrade(req,socket,head))socket.destroy();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(async()=>{gateway.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return{gateway,open,url:`ws://127.0.0.1:${(server.address() as {port:number}).port}/services/v1/tunnel`};
 }
 const connect=(url:string,options:{token?:string;protocols?:string[]}={})=>{
  const ws=new WebSocket(url,options.protocols??[],{headers:options.protocols?{}:{'x-zeros-runtime-service':options.token??token}});
  cleanups.push(()=>{ws.on('error',()=>{});ws.terminate();});
  return{ws,ready:new Promise<any>((resolve,reject)=>{ws.once('error',reject);ws.once('message',(data,binary)=>binary?reject(new Error('missing intro')):resolve(JSON.parse(data.toString())));})};
 };
 it('accepts a header or browser subprotocol without echoing the credential',async()=>{
  expect(cloudServiceToken({'x-zeros-runtime-service':token})).toBe(token);
  expect(cloudServiceToken({'sec-websocket-protocol':`zeros.service.v1, zeros.authorization.${token}`})).toBe(token);
  const f=await fixture(),c=connect(f.url,{protocols:['zeros.service.v1',`zeros.authorization.${token}`]});
  expect(await c.ready).toEqual({version:1,kind:'tunnel'});expect(c.ws.protocol).toBe('zeros.service.v1');
 });
 it.each([
  {'x-zeros-runtime-service':'zwp_'+'t'.repeat(43)},
  {'x-zeros-runtime-service':token,'sec-websocket-protocol':'zeros.service.v1, zeros.authorization.zsh_'+'u'.repeat(43)},
  {'sec-websocket-protocol':`zeros.authorization.${token}`},
  {'sec-websocket-protocol':'zeros.service.v1, zeros.service.v1'},
 ])('rejects ambiguous or wrong-kind credentials %j',headers=>expect(cloudServiceToken(headers)).toBeNull());
 it('moves binary bytes with no credential in the application stream',async()=>{
  const f=await fixture(),c=connect(f.url);await c.ready;
  const response=new Promise<Buffer>(resolve=>c.ws.once('message',(data,binary)=>{expect(binary).toBe(true);resolve(Buffer.from(data as Buffer));}));
  c.ws.send(Buffer.from('application payload'));
  expect(await response).toEqual(Buffer.from('application payload'));
 });
 it('drains open streams and denies new admission while a final checkpoint is quiescing',async()=>{
  const f=await fixture(),c=connect(f.url);await c.ready;
  const closed=new Promise<void>(resolve=>c.ws.once('close',()=>resolve()));
  f.gateway.setPaused(true);await closed;
  await expect(connect(f.url).ready).rejects.toThrow('503');
  expect(f.open).toHaveBeenCalledOnce();
  f.gateway.setPaused(false);await connect(f.url).ready;
  expect(f.open).toHaveBeenCalledTimes(2);
 });
 it.each([null,{...grant(),kind:'preview' as const},{...grant(),remotePort:43001},{...grant(),remotePort:22},{...grant(),remotePort:null}])('denies invalid service admission before I/O',async admitted=>{
  const f=await fixture({verify:async()=>admitted}),c=connect(f.url);
  await expect(c.ready).rejects.toThrow();expect(f.open).not.toHaveBeenCalled();
 });
 it('closes a stream when its lease is revoked',async()=>{
  let active=true;
  const f=await fixture({verify:async()=>active?{...grant(),expiresAtMs:Date.now()+100}:null}),c=connect(f.url);await c.ready;
  active=false;await new Promise<void>(resolve=>c.ws.once('close',()=>resolve()));
  expect(c.ws.readyState).toBe(WebSocket.CLOSED);
 });
 it('enforces the access deadline while renewal hangs',async()=>{
  let count=0;
  const f=await fixture({verify:async()=>++count===1?{...grant(),expiresAtMs:Date.now()+120}:new Promise(()=>{})}),c=connect(f.url);await c.ready;
  await new Promise<void>(resolve=>c.ws.once('close',()=>resolve()));expect(count).toBe(2);
 });
 it('rejects text in the data stream',async()=>{
  const f=await fixture(),c=connect(f.url);await c.ready;
  const closed=new Promise<void>(resolve=>c.ws.once('close',()=>resolve()));c.ws.send('not binary');await closed;
 });
 it('bounds simultaneous streams',async()=>{
  const f=await fixture();for(let n=0;n<8;n++)await connect(f.url).ready;
  await expect(connect(f.url).ready).rejects.toThrow('429');expect(f.open).toHaveBeenCalledTimes(8);
 });
 it('closes an application connection that arrives after the client disconnects',async()=>{
  let resolveOpen!:(stream:CloudRuntimeServiceStream)=>void;
  const opened=service(),open=vi.fn(()=>new Promise<CloudRuntimeServiceStream>(resolve=>{resolveOpen=resolve;}));
  const f=await fixture({open}),c=connect(f.url);void c.ready.catch(()=>{});
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());c.ws.terminate();
  await new Promise(resolve=>setTimeout(resolve,10));resolveOpen(opened);
  await vi.waitFor(()=>expect(opened.close).toHaveBeenCalledOnce());
 });
});
