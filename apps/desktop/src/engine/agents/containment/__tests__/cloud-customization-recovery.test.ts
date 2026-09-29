import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {acquireCloudNativeHistory,copyCloudNativeForkHistory,deleteCloudNativeHistory} from '../cloud-native-history';
import {prepareHistoryCustomization} from '../cloud-customization-history';
const a={owner:'a'.repeat(64),currentKeyVersion:1,keys:{'1':randomBytes(32).toString('base64url')}},b={...a,owner:'b'.repeat(64)};
const secret='v7b-synthetic-historical-secret';
const parent=(root:string,id:string)=>path.join(root,createHash('sha256').update(id).digest('hex'));

it.each(['claude','cursor','codex'] as const)('interrupted reset before purge retries safely for %s',async provider=>{
 const root=await mkdtemp('/tmp/v7b-history-'),input={root,conversationId:'c',provider,uid:process.getuid!(),gid:process.getgid!()};
 try{
  const first=await acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[secret]}});
  first.record?.({sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Earlier safe context.'}}});
  await writeFile(path.join(first.mount.directory,'raw-history'),secret);await first.release();
  await prepareHistoryCustomization({parent:parent(root,'c'),conversationId:'c',provider,customization:{authority:b,secrets:[]},hasNativeContent:true});
  const next=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  try{expect(next.fresh).toBe(true);expect(await readdir(next.mount.directory)).toEqual([]);expect(next.redactor!.value(secret)).toBe('[redacted]');}finally{await next.release();}
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['claude','cursor','codex'] as const)('interrupted reset after purge still requires a fresh provider binding for %s',async provider=>{
 const root=await mkdtemp('/tmp/v7b-history-'),input={root,conversationId:'c',provider,uid:process.getuid!(),gid:process.getgid!()};
 try{
  const first=await acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[secret]}});
  await writeFile(path.join(first.mount.directory,'raw-history'),secret);await first.release();
  const changed=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  expect(changed.fresh).toBe(true);await changed.release(); // startup failed before any new binding was created/persisted
  const retry=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  try{expect(await readdir(retry.mount.directory)).toEqual([]);expect(retry.fresh).toBe(true);}finally{await retry.release();}
 }finally{await rm(root,{recursive:true,force:true});}
});
it('copies encrypted fork dictionaries, reseals keys, isolates new owners and deletes protection with history',async()=>{
 const root=await mkdtemp('/tmp/v7b-history-'),input={root,conversationId:'source',provider:'codex' as const,uid:process.getuid!(),gid:process.getgid!()};
 try{
  const source=await acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[secret]}});
  await writeFile(path.join(source.mount.directory,'raw-history'),secret);await source.release();
  await copyCloudNativeForkHistory({...input,destinationConversationId:'fork'},async()=>{});
  const forkParent=parent(root,'fork'),metadata=path.join(forkParent,'.customization-codex.json');
  expect(await readFile(metadata,'utf8')).not.toContain(secret);
  const rotated={...a,currentKeyVersion:2,keys:{...a.keys,'2':randomBytes(32).toString('base64url')}};
  const fork=await acquireCloudNativeHistory({...input,conversationId:'fork',customization:{authority:rotated,secrets:[]}});
  try{expect(fork.fresh).toBe(false);expect(fork.redactor!.value(await readFile(path.join(fork.mount.directory,'raw-history'),'utf8'))).toBe('[redacted]');}finally{await fork.release();}
  expect(JSON.parse(await readFile(metadata,'utf8'))).toMatchObject({context:'fork',keyVersion:2});
  const next=await acquireCloudNativeHistory({...input,conversationId:'fork',customization:{authority:{...rotated,owner:b.owner},secrets:[]}});
  try{expect(next.fresh).toBe(true);expect(await readdir(next.mount.directory)).toEqual([]);}finally{await next.release();}
  expect(await readFile(path.join(source.mount.directory,'raw-history'),'utf8')).toBe(secret);
  await deleteCloudNativeHistory({...input,conversationId:'fork'});
  expect(await readdir(forkParent)).toEqual(expect.arrayContaining(['.deleted','.lock']));
  expect((await readdir(forkParent)).some(n=>n.startsWith('.customization')||n==='codex')).toBe(false);
  await expect(acquireCloudNativeHistory({...input,conversationId:'fork',customization:{authority:a,secrets:[]}})).rejects.toThrow(/deleted/);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('keeps the reset pending through retirement, and clears it only after binding persistence is confirmed',async()=>{
 const root=await mkdtemp('/tmp/zeros-history-confirm-'),input={root,conversationId:'c',provider:'claude' as const,uid:process.getuid!(),gid:process.getgid!()};
 try{
  const first=await acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[secret]}});
  first.record?.({sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Earlier safe context.'}}});
  await writeFile(path.join(first.mount.directory,'raw-history'),secret);await first.release();
  const changed=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  await changed.release();
  const retry=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  expect(retry.fresh).toBe(true);expect(retry.handoff).toBe('Earlier safe context.');
  await changed.confirmBinding(); // stale completion must not overwrite the active acquisition
  await retry.release();
  const confirmed=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  expect(confirmed.fresh).toBe(true);expect(confirmed.handoff).toBe('Earlier safe context.');
  await writeFile(path.join(confirmed.mount.directory,'new-provider-history'),'New owner context.');
  await Promise.all([confirmed.confirmBinding(),confirmed.release()]);
  const resumed=await acquireCloudNativeHistory({...input,customization:{authority:b,secrets:[]}});
  try{expect(resumed.fresh).toBe(false);expect(await readFile(path.join(resumed.mount.directory,'new-provider-history'),'utf8')).toBe('New owner context.');}finally{await resumed.release();}
 }finally{await rm(root,{recursive:true,force:true});}
});
it('fails closed for absent authority, missing encryption keys and a tampered envelope',async()=>{
 const root=await mkdtemp('/tmp/v7b-history-'),input={root,conversationId:'c',provider:'codex' as const,uid:process.getuid!(),gid:process.getgid!()};
 try{
  const initial=await acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[secret]}});await initial.release();
  await expect(acquireCloudNativeHistory(input)).rejects.toThrow(/authority/);
  await expect(acquireCloudNativeHistory({...input,customization:{authority:{...a,keys:{'1':randomBytes(32).toString('base64url')}},secrets:[]}})).rejects.toThrow(/protection/);
  const file=path.join(parent(root,'c'),'.customization-codex.json'),envelope=JSON.parse(await readFile(file,'utf8'));
  envelope.context='other';await writeFile(file,JSON.stringify(envelope));
  await expect(acquireCloudNativeHistory({...input,customization:{authority:a,secrets:[]}})).rejects.toThrow(/protection/);
 }finally{await rm(root,{recursive:true,force:true});}
});
