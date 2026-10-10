import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,open,readdir,readlink,realpath,rename,rm,rmdir,symlink,type FileHandle} from "node:fs/promises";
import path from "node:path";
import {encodeCloudCommandFailure} from "@zeros/protocol/cloud-commands";
import {AgentFailureError} from "../types";
import {prepareHistoryCustomization,readHistoryCustomization,writeHistoryCustomization,type HistoryCustomization} from "./cloud-customization-history";
import {isCloudNativeHome,type CloudNativeHome} from "./cloud-native-home";

export const CLOUD_NATIVE_HISTORY_ROOT="/srv/zeros/state/native-agent-history";
export type CloudNativeProvider="claude"|"cursor"|"codex";
export type CloudNativeHistoryMount={provider:CloudNativeProvider;directory:string};
const providers=new Set(["claude","cursor","codex"]);
const identity=/^[A-Za-z0-9._:-]{1,128}$/;
type CloudNativeHistoryInput={root:string;conversationId:string;provider:CloudNativeProvider;uid:number;gid:number;customization?:HistoryCustomization;nativeHome?:CloudNativeHome};

/** Keep the closed receipt and a safe explanation in the existing turn banner.
 * Unsafe SDK entries stay in place until explicit repair; acquisition never
 * fabricates an empty native session or follows their targets. */
export class CloudNativeHistoryError extends AgentFailureError {
  readonly code=encodeCloudCommandFailure({stage:"containment",category:"environment_setup_failed"});
  constructor() {
    super({kind:"protocol-error",stage:"initialize",message:"This conversation's saved history contains an unsupported file, so the agent can't resume it. The history is kept unchanged. Start a new conversation to continue."});
    this.name="CloudNativeHistoryError";
  }
}

/** Open before inspecting metadata; all later IO stays on this descriptor. */
async function openPhysicalHistoryDirectory(directory: string): Promise<FileHandle> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat(), current = await lstat(directory);
    if (!metadata.isDirectory() || metadata.uid !== process.geteuid?.() || current.isSymbolicLink() ||
        current.dev !== metadata.dev || current.ino !== metadata.ino || await realpath(directory) !== directory)
      throw new Error("Cloud native history contains an unsafe root");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function openHistoryEntry(file: string) {
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new CloudNativeHistoryError(); }
  try {
    const metadata = await handle.stat();
    if ((!metadata.isFile() && !metadata.isDirectory()) || metadata.isFile() && metadata.nlink !== 1)
      throw new CloudNativeHistoryError();
    return { handle, metadata };
  } catch (error) { await handle.close(); throw error; }
}

/** Copy only transcript bytes through opened source and destination roots.
 * A path replacement cannot redirect writes into a different directory. */
async function copyPhysicalNativeHistory(source: string, target: string): Promise<void> {
  const sourceRoot = await openPhysicalHistoryDirectory(source);
  let targetRoot: FileHandle | undefined;
  try {
    targetRoot = await openPhysicalHistoryDirectory(target);
    if ((await readdir("/proc/self/fd/" + targetRoot.fd)).length)
      throw new Error("Cloud native transcript target must be empty");
    let entries = 0, bytes = 0;
    async function copy(directory: FileHandle, destination: FileHandle): Promise<void> {
      for (const name of await readdir("/proc/self/fd/" + directory.fd)) {
        if (++entries > 25000) throw new Error("Cloud native history exceeds its limit");
        const { handle, metadata: actual } = await openHistoryEntry("/proc/self/fd/" + directory.fd + "/" + name);
        try {
          const outputPath = "/proc/self/fd/" + destination.fd + "/" + name;
          if (actual.isDirectory()) {
            await mkdir(outputPath, { mode: 0o700 });
            const child = await open(outputPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { await copy(handle, child); } finally { await child.close(); }
          } else {
            if (actual.size > 128 * 1024 * 1024 || (bytes += actual.size) > 2 * 1024 * 1024 * 1024)
              throw new Error("Cloud native history exceeds its limit");
            const output = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
              const buffer = Buffer.alloc(64 * 1024); let offset = 0;
              while (offset < actual.size) {
                const chunk = await handle.read(buffer, 0, Math.min(buffer.length, actual.size - offset), offset);
                if (!chunk.bytesRead) throw new Error("Cloud native history changed during capture");
                let written = 0;
                while (written < chunk.bytesRead) written += (await output.write(buffer, written, chunk.bytesRead - written)).bytesWritten;
                offset += chunk.bytesRead;
              }
              const after = await handle.stat();
              if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.nlink !== 1)
                throw new Error("Cloud native history changed during capture");
              await output.sync();
            } finally { await output.close(); }
          }
        } finally { await handle.close(); }
      }
      await destination.sync();
    }
    await copy(sourceRoot, targetRoot);
  } finally { await targetRoot?.close(); await sourceRoot.close(); }
}

/** The root and lock are engine-owned. Only this conversation's transcript
 * directory is shared with its HOME; authentication remains per execution.
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

/** Inspect the transcript slot through physical parent descriptors. A legacy
 * copy may contain the only uncaptured turns, so nonempty or ambiguous slots
 * stay intact. Only our exact link, a missing slot or an empty slot is safe. */
async function orphanTranscriptReclaimable(execution:FileHandle,provider:CloudNativeProvider,canonical:string):Promise<boolean> {
  const opened:FileHandle[]=[];
  let directory=execution;
  try {
    for(const segment of ["home","."+provider]) {
      try {
        directory=await open("/proc/self/fd/"+directory.fd+"/"+segment,
          constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        opened.push(directory);
      } catch(error) {return (error as NodeJS.ErrnoException).code==="ENOENT";}
    }
    const name=provider==="claude"?"projects":provider==="codex"?"sessions":"zeros-store";
    const slot="/proc/self/fd/"+directory.fd+"/"+name;
    let transcript:FileHandle;
    try {transcript=await open(slot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      if(code==="ENOENT")return true;
      if(code!=="ELOOP"&&code!=="ENOTDIR")return false;
      return await readlink(slot)===canonical;
    }
    opened.push(transcript);
    return (await readdir("/proc/self/fd/"+transcript.fd)).length===0;
  } catch {return false;}
  finally {for(const handle of opened.reverse())await handle.close();}
}

/** Called only while this conversation's original kernel lock is held. The
 * current branded HOME is retained; other execution slots have no live writer.
 * Legacy physical transcripts and ambiguous entries are preserved, not merged.
 * Removal is anchored to the provider directory and never follows links. */
async function reclaimOrphanNativeHomes(home:CloudNativeHome,conversationId:string,provider:CloudNativeProvider,canonical:string):Promise<void> {
  if(!isCloudNativeHome(home))throw new Error("Cloud native HOME reclamation identity is invalid");
  const container=path.dirname(home.paths.directory),conversation=path.dirname(container);
  if(path.basename(container)!==provider||
    path.basename(conversation)!==createHash("sha256").update(conversationId).digest("hex")||
    path.basename(path.dirname(conversation))!=="native-agent-homes")
    throw new Error("Cloud native HOME reclamation identity is invalid");
  const directory=await openPhysicalHistoryDirectory(container);
  let preserved=0;
  try {
    for(const entry of await readdir("/proc/self/fd/"+directory.fd,{withFileTypes:true})) {
      if(entry.name===path.basename(home.paths.directory))continue;
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)||!entry.isDirectory()) {preserved++;continue;}
      const slot="/proc/self/fd/"+directory.fd+"/"+entry.name;
      let execution:FileHandle|undefined;
      try {
        execution=await open(slot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const original=await execution.stat();
        if(original.uid!==process.geteuid?.()||!await orphanTranscriptReclaimable(execution,provider,canonical)) {
          preserved++;continue;
        }
        const current=await open(slot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try {
          const actual=await current.stat();
          if(actual.dev!==original.dev||actual.ino!==original.ino) {preserved++;continue;}
          await rm(slot,{recursive:true,force:true});
        } finally {await current.close();}
      } catch {preserved++;}
      finally {await execution?.close();}
    }
    if(preserved)console.warn(`[cloud-native-history] preserved ${preserved} orphan execution HOME(s) with legacy or ambiguous transcripts; acquisition will continue`);
    await directory.sync();
  } finally {await directory.close();}
}

export async function acquireCloudNativeHistory(input:CloudNativeHistoryInput) {
  return acquireHistory(input, false);
}
async function acquireHistory(input:CloudNativeHistoryInput,copyOnly:boolean) {
  if(!providers.has(input.provider))throw new Error("Cloud native history provider is invalid");
  if (input.uid !== process.geteuid?.() || input.gid !== process.getegid?.())
    throw new Error("Cloud native history requires the engine identity");
  const {owner,lock}=await lockConversation(input);
  try{
    if(input.nativeHome)await reclaimOrphanNativeHomes(input.nativeHome,input.conversationId,input.provider,path.join(owner,input.provider));
    await lstat(path.join(owner,".deleted")).then(()=>{throw new Error("Cloud conversation was deleted");},error=>{if(error.code!=="ENOENT")throw error;});
    // A crash between the two directory renames leaves an ambiguous stage or
    // backup. Preserve it under the lock rather than creating empty history or
    // guessing which transcript was committed. Recovery needs explicit custody.
    const retained = await readdir(owner);
    if (retained.length > 25000 || retained.some(name => name.startsWith(`.capture-${input.provider}-`)))
      throw new Error("Cloud native history requires recovery");
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
      for(const name of await readdir("/proc/self/fd/" + handle.fd)){
        if(++entries>25000)throw new Error("Cloud native history exceeds its limit");
        const {handle:child,metadata:actual}=await openHistoryEntry("/proc/self/fd/" + handle.fd + "/" + name);
        try{
          if(actual.isFile()&&(actual.size>128*1024*1024||(bytes+=actual.size)>2*1024*1024*1024))
            throw new Error("Cloud native history exceeds its limit");
          if(actual.isDirectory())await adopt(child);
        }finally{await child.close();}
      }
    }
    const handle=await openPhysicalHistoryDirectory(directory);
    try{await adopt(handle);}finally{await handle.close();}
    let releasePromise: Promise<void> | undefined;
    let writes = Promise.resolve();
    let bound = false;
    const enqueue = (operation: () => Promise<void>): Promise<void> => {
      if (releasePromise) return Promise.reject(new Error("Cloud native history is released"));
      const pending = writes.then(operation);
      // The caller owns each operation's failure. Keep subsequent retries and
      // release serialized even after a failed copy, without unlocking early.
      writes = pending.catch(() => {});
      return pending;
    };
    return {mount:{provider:input.provider,directory},redactor:customization?.redactor,fresh:customization?.fresh??false,handoff:customization?.handoff,
      record:customization?.record,
      materialize(target: string) {
        return enqueue(() => copyPhysicalNativeHistory(directory, target));
      },
      bind(target: string) {
        return enqueue(async () => {
          if (bound) throw new Error("Cloud native history already has a writable binding");
          const source = await openPhysicalHistoryDirectory(directory);
          let destination: FileHandle | undefined, parent: FileHandle | undefined;
          try {
            destination = await openPhysicalHistoryDirectory(target);
            if ((await readdir("/proc/self/fd/" + destination.fd)).length)
              throw new Error("Cloud native transcript target must be empty");
            parent = await openPhysicalHistoryDirectory(path.dirname(target));
            const entry = "/proc/self/fd/" + parent.fd + "/" + path.basename(target);
            // rmdir cannot follow a substituted leaf link. The parent remains
            // anchored while the empty execution slot receives its history link.
            await rmdir(entry);
            await symlink(directory, entry, "dir");
            await parent.sync();
            bound = true;
          } finally { await parent?.close(); await destination?.close(); await source.close(); }
        });
      },
      capture(source: string) {
        return enqueue(async () => {
        if (bound) throw new Error("Cloud native history uses its writable binding");
        const stage = path.join(owner, `.capture-${input.provider}-${randomUUID()}`);
        const backup = `${stage}.previous`;
        await mkdir(stage, { mode: 0o700 });
        let replaced = false;
        try {
          await copyPhysicalNativeHistory(source, stage);
          const parent = await open(owner, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            await rename(directory, backup);
            try { await rename(stage, directory); replaced = true; }
            catch (error) { await rename(backup, directory); throw error; }
            await parent.sync();
            await rm(backup, { recursive: true, force: true });
            await parent.sync();
          } finally { await parent.close(); }
        } finally {
          if (!replaced) await rm(stage, { recursive: true, force: true });
        }
        });
      },
      confirmBinding() {
        if (releasePromise) return Promise.resolve();
        return enqueue(async () => { await customization?.confirmBinding(); });
      },
      release() {
        // Complete all admitted copies and acknowledged writes before unlocking.
        // A late operation must never overwrite the next owner's transcript.
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
      await copyPhysicalNativeHistory(source.mount.directory,destination.mount.directory);
      const customization=await readHistoryCustomization(path.dirname(source.mount.directory),input.provider);
      if(customization)await writeHistoryCustomization(path.dirname(destination.mount.directory),input.provider,customization);
    } finally {await destination.release();}
    return await fork();
  } finally {await source.release();}
}
