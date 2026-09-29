import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,open,readdir,realpath,rm,type FileHandle} from "node:fs/promises";
import path from "node:path";
import {prepareHistoryCustomization,readHistoryCustomization,writeHistoryCustomization,type HistoryCustomization} from "./cloud-customization-history";

export const CLOUD_NATIVE_HISTORY_ROOT="/srv/zeros/state/native-agent-history";
export type CloudNativeProvider="claude"|"cursor"|"codex";
export type CloudNativeHistoryMount={provider:CloudNativeProvider;directory:string};
const providers=new Set(["claude","cursor","codex"]);
const identity=/^[A-Za-z0-9._:-]{1,128}$/;

/** The root and lock are engine-owned. Only this conversation's transcript
 * directory enters its private coordinator; no authentication HOME is durable.
 * A kernel lock prevents simultaneous SDK writers, including engine restarts. */
async function lockConversation(input:{root:string;conversationId:string}):Promise<{owner:string;lock:FileHandle}>{
  if(!identity.test(input.conversationId)||!path.isAbsolute(input.root)||path.resolve(input.root)!==input.root)
    throw new Error("Cloud native history identity is invalid");
  await mkdir(input.root,{recursive:true,mode:0o700});
  const root=await lstat(input.root);
  if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid?.()||(root.mode&0o077)!==0||await realpath(input.root)!==input.root)
    throw new Error("Cloud native history root is not engine-owned");
  const key=createHash("sha256").update(input.conversationId).digest("hex");
  const owner=path.join(input.root,key);await mkdir(owner,{mode:0o700}).catch(error=>{if(error.code!=="EEXIST")throw error;});
  const ownerStat=await lstat(owner);
  if(!ownerStat.isDirectory()||ownerStat.isSymbolicLink()||ownerStat.uid!==process.getuid?.()||(ownerStat.mode&0o077)!==0)
    throw new Error("Cloud native history owner is invalid");
  const lock=await open(path.join(owner,".lock"),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  try{
    const stat=await lock.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)
      throw new Error("Cloud native history lock is invalid");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn("/usr/bin/flock",["--exclusive","--nonblock","3"],{stdio:["ignore","ignore","ignore",lock.fd],env:{},timeout:5000});
      child.once("error",()=>reject(new Error("Cloud native history lock is unavailable")));
      child.once("exit",code=>code===0?resolve():reject(new Error("Cloud conversation already has an active native execution")));
    });
    return {owner,lock};
  }catch(error){await lock.close();throw error;}
}

export async function acquireCloudNativeHistory(input:{root:string;conversationId:string;provider:CloudNativeProvider;uid:number;gid:number;customization?:HistoryCustomization}) {
  return acquireHistory(input, false);
}
async function acquireHistory(input:{root:string;conversationId:string;provider:CloudNativeProvider;uid:number;gid:number;customization?:HistoryCustomization},copyOnly:boolean) {
  if(!providers.has(input.provider))throw new Error("Cloud native history provider is invalid");
  const {owner,lock}=await lockConversation(input);
  try{
    await lstat(path.join(owner,".deleted")).then(()=>{throw new Error("Cloud conversation was deleted");},error=>{if(error.code!=="ENOENT")throw error;});
    const directory=path.join(owner,input.provider);await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=="EEXIST")throw error;});
    if (!input.customization && !copyOnly && await readHistoryCustomization(owner,input.provider))
      throw new Error("Native history requires its customization authority");
    const customization = input.customization ? await prepareHistoryCustomization({ parent:owner,conversationId:input.conversationId,provider:input.provider,
      customization:input.customization,hasNativeContent:(await readdir(directory)).length>0 }) : undefined;
    if (customization?.fresh) {
      // A different actor never receives the previous actor's raw native store.
      // The gateway starts a fresh native binding with the scrubbed handoff.
      await rm(directory,{recursive:true,force:true}); await mkdir(directory,{mode:0o700});
    }
    // Restores are written by the engine identity. Validate and adopt only
    // regular, single-link transcript entries before handing them to the SDK.
    let entries=0,bytes=0;
    async function adopt(handle:FileHandle):Promise<void>{
      for(const name of await readdir(`/proc/self/fd/${handle.fd}`)){
        if(++entries>25000)throw new Error("Cloud native history exceeds its limit");
        const item=`/proc/self/fd/${handle.fd}/${name}`,stat=await lstat(item);
        if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))throw new Error("Cloud native history contains an unsafe entry");
        const child=await open(item,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(stat.isDirectory()?constants.O_DIRECTORY:0));
        try{
          const actual=await child.stat();
          if(actual.dev!==stat.dev||actual.ino!==stat.ino||actual.isDirectory()!==stat.isDirectory()||
            (!actual.isDirectory()&&(!actual.isFile()||actual.nlink!==1)))
            throw new Error("Cloud native history contains an unsafe entry");
          if(actual.isFile()&&(actual.size>128*1024*1024||(bytes+=actual.size)>2*1024*1024*1024))
            throw new Error("Cloud native history exceeds its limit");
          if(actual.isDirectory())await adopt(child);
          await child.chown(input.uid,input.gid);
        }finally{await child.close();}
      }
      await handle.chown(input.uid,input.gid);
    }
    const handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await adopt(handle);}finally{await handle.close();}
    let releasePromise: Promise<void> | undefined;
    let writes = Promise.resolve();
    return {mount:{provider:input.provider,directory},redactor:customization?.redactor,fresh:customization?.fresh??false,handoff:customization?.handoff,
      record:customization?.record,
      confirmBinding() {
        if (releasePromise) return Promise.resolve();
        writes = writes.then(() => customization?.confirmBinding());
        return writes;
      },
      release() {
        // Complete acknowledged writes before unlocking. A late confirmation
        // must never overwrite the next owner's metadata after retirement.
        return releasePromise ??= (async () => {
          try { await writes; await customization?.save(); } finally { await lock.close(); }
        })();
      }};
  }catch(error){await lock.close();throw error;}
}

/** Keep the lock inode and a tiny durable tombstone. Removing either while
 * releasing the lock would let a stale parallel admission recreate the store. */
export async function deleteCloudNativeHistory(input:{root:string;conversationId:string}):Promise<void>{
  const {owner,lock}=await lockConversation(input);
  try{
    const marker=await open(path.join(owner,".deleted"),constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try{
      const stat=await marker.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.())throw new Error("Cloud history deletion fence is invalid");
      await marker.writeFile("zeros-native-conversation-deleted-v1\n");await marker.sync();
    }finally{await marker.close();}
    for(const provider of providers){await rm(path.join(owner,provider),{recursive:true,force:true});await rm(path.join(owner,`.customization-${provider}.json`),{force:true});}
    const parent=await open(owner,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await parent.sync();}finally{await parent.close();}
  }finally{await lock.close();}
}

/** Hold the source kernel lock through native fork admission and retirement.
 * The destination starts empty and receives an independent byte copy, never a
 * hard link. Its ordinary execution acquires its own lock before any SDK runs.
 * Failed/uncertain forks retain their copy and must not be replayed. */
export async function copyCloudNativeForkHistory<T>(input: {
  root: string; conversationId: string; destinationConversationId: string;
  provider: CloudNativeProvider; uid: number; gid: number;
}, fork: () => Promise<T>): Promise<T> {
  if (input.conversationId === input.destinationConversationId) throw new Error("Fork conversations must be distinct");
  const source = await acquireHistory(input,true);
  try {
    const destination = await acquireHistory({...input, conversationId: input.destinationConversationId},true);
    try {
      if ((await readdir(destination.mount.directory)).length) throw new Error("Fork destination history must be empty");
      let entries=0,bytes=0;
      async function copy(directory: FileHandle, target: string): Promise<void> {
        for (const name of await readdir(`/proc/self/fd/${directory.fd}`)) {
          if (++entries > 25000) throw new Error("Cloud native history exceeds its limit");
          const entry=`/proc/self/fd/${directory.fd}/${name}`, stat=await lstat(entry);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
            throw new Error("Cloud native history contains an unsafe entry");
          const handle=await open(entry,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(stat.isDirectory()?constants.O_DIRECTORY:0));
          try {
            const actual=await handle.stat();
            if (actual.dev!==stat.dev || actual.ino!==stat.ino || actual.isDirectory()!==stat.isDirectory() ||
              (!actual.isDirectory() && (!actual.isFile() || actual.nlink!==1))) throw new Error("Cloud native history contains an unsafe entry");
            if (actual.isDirectory()) {
              await mkdir(path.join(target,name),{mode:0o700});
              await copy(handle,path.join(target,name));
            } else {
              if (actual.size>128*1024*1024 || (bytes+=actual.size)>2*1024*1024*1024) throw new Error("Cloud native history exceeds its limit");
              const output=await open(path.join(target,name),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
              try {
                const buffer=Buffer.alloc(64*1024);
                let offset=0;
                while(offset<actual.size) {
                  const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,actual.size-offset),offset);
                  if(!bytesRead)throw new Error("Cloud native history changed during fork");
                  let written=0;
                  while(written<bytesRead)written+=(await output.write(buffer,written,bytesRead-written)).bytesWritten;
                  offset+=bytesRead;
                }
                const after=await handle.stat();
                if(after.size!==actual.size || after.mtimeMs!==actual.mtimeMs)throw new Error("Cloud native history changed during fork");
                await output.sync();
              } finally {await output.close();}
            }
          } finally {await handle.close();}
        }
      }
      const directory=await open(source.mount.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {await copy(directory,destination.mount.directory);} finally {await directory.close();}
      const customization=await readHistoryCustomization(path.dirname(source.mount.directory),input.provider);
      if(customization)await writeHistoryCustomization(path.dirname(destination.mount.directory),input.provider,customization);
    } finally {await destination.release();}
    return await fork();
  } finally {await source.release();}
}
