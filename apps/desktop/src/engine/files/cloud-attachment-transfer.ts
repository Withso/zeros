import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudActorRole } from "@zeros/protocol/cloud-actors";
import { cloudActorCan } from "@zeros/protocol/cloud-actors";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, contextAttachmentPath, parseContextAttachmentPath,
  safeAttachmentFilename, validateAttachmentFile, type AttachmentWriteResult } from "@zeros/protocol/attachment-policy";
import { QualifiedCloudFilePolicy } from "./cloud-file-policy";
import { publishCloudWorkspacePath } from "./cloud-workspace-ownership";
import { cloudWorkspacePublicationPath } from "../agents/containment/cloud-workspace-paths";
import { createAttachmentTemporaryDirectory, type AttachmentTemporaryDirectory } from "./attachment-temporary-directory";

export interface CloudAttachmentActor {
  userId: string;
  role: CloudActorRole;
  authorized: () => boolean;
  ownerRoots?: () => readonly string[];
}

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const input=z.object({attachmentId:id,filename:z.string().min(1).max(1024),mimeType:z.string().min(1).max(256),
  base64:z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES/3)*4),uploadId:id.optional(),offset:z.number().int().nonnegative().optional(),
  totalBytes:z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES).optional(),resolve:z.boolean().optional(),
  abort:z.boolean().optional(),diskPath:z.string().max(512).optional()});
const denied=()=>new CloudCommandFailureError({stage:"validation",category:"access_denied"});
const invalid=()=>new CloudCommandFailureError({stage:"validation",category:"protocol_error"});
const missing=()=>Object.assign(denied(),{message:"The saved attachment is not available — attach it again."});
const digest=(value: string)=>createHash("sha256").update(value).digest("hex");
const uploads=new Map<string,Upload>();
const records=new Map<string,string>();
type Upload={record:string;filename:string;mimeType:string;total:number;offset:number;busy:boolean;relativePath:string;
  parent:ReturnType<QualifiedCloudFilePolicy["openWriteParent"]>;policy:QualifiedCloudFilePolicy;
  temporary?:AttachmentTemporaryDirectory;file?:fsp.FileHandle;timer?:ReturnType<typeof setTimeout>};

async function dispose(key:string,upload:Upload){
  if(uploads.get(key)===upload)uploads.delete(key);
  if(records.get(upload.record)===key)records.delete(upload.record);
  clearTimeout(upload.timer);fs.closeSync(upload.parent.fd);
  await upload.file?.close();await upload.temporary?.dispose();
}
export async function resetCloudAttachmentTransfersForTests(){await Promise.all([...uploads].map(([key,upload])=>dispose(key,upload)));}
function assertActor(actor:CloudAttachmentActor){
  if(!z.string().uuid().safeParse(actor.userId).success||!cloudActorCan(actor.role,"run")||!actor.authorized())throw denied();
}
function fileResult(root:string,relativePath:string,mimeType:string,bytes:number,skipped=false):AttachmentWriteResult{
  return {absolutePath:path.join(root,relativePath),relativePath,mimeType,bytes,...(skipped?{skipped:true}:{})};
}
function openRecord(policy:QualifiedCloudFilePolicy,relativePath:string):number{
  const target=path.join(policy.root,relativePath);
  if(policy.assertPath(relativePath)!==target)throw denied();
  let parent=fs.openSync(policy.root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW),current=policy.root;
  try{
    for(const segment of path.dirname(relativePath).split("/")){
      policy.assertDescriptor(parent,current);
      const next=fs.openSync(`/proc/self/fd/${parent}/${segment}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      fs.closeSync(parent);parent=next;current=path.join(current,segment);policy.assertDescriptor(parent,current);
    }
    const fd=fs.openSync(`/proc/self/fd/${parent}/${path.basename(relativePath)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{policy.assertDescriptor(fd,target);const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.size>MAX_ATTACHMENT_BYTES)throw denied();return fd;
    }catch(error){fs.closeSync(fd);throw error;}
  }finally{fs.closeSync(parent);}
}
async function compareRecord(fd:number,file:fsp.FileHandle,total:number):Promise<boolean>{
  if(fs.fstatSync(fd).size!==total)return false;
  const left=Buffer.alloc(ATTACHMENT_CHUNK_BYTES),right=Buffer.alloc(ATTACHMENT_CHUNK_BYTES);
  for(let offset=0;offset<total;offset+=ATTACHMENT_CHUNK_BYTES){
    const length=Math.min(ATTACHMENT_CHUNK_BYTES,total-offset);
    const read=fs.readSync(fd,left,0,length,offset),other=await file.read(right,0,length,offset);
    if(read!==length||other.bytesRead!==length||!left.subarray(0,length).equals(right.subarray(0,length)))return false;
  }return true;
}

/** Dedicated cloud imports carry no general file-write authority. The engine
 * supplies root/actor; client IDs are projected into their exact actor/root
 * namespace. Native source handles and arbitrary source/destination paths are
 * never accepted. Local transfers retain the existing context graph writer. */
export async function transferCloudAttachment(root:string,args:Record<string,unknown>,actor:CloudAttachmentActor):Promise<AttachmentWriteResult>{
  assertActor(actor);
  if(args.nativeSourceId!==undefined)throw denied();
  const parsed=input.safeParse(args);if(!parsed.success)throw invalid();
  const value=parsed.data,filename=safeAttachmentFilename(value.filename);
  if(!validateAttachmentFile({name:filename,mimeType:value.mimeType,size:value.totalBytes??0}).ok)throw invalid();
  // The alias is an engine-owned mount projection, never supplied by a client.
  const logicalRoot=fs.realpathSync(root),publicationRoot=cloudWorkspacePublicationPath(logicalRoot);
  const recordId=`cloud_${digest(JSON.stringify([logicalRoot,actor.userId,value.attachmentId]))}`;
  let relativePath=contextAttachmentPath(recordId,filename);
  if(value.diskPath!==undefined){
    const saved=parseContextAttachmentPath(value.diskPath);
    if(!saved||saved.scope!==undefined||saved.folderId!==recordId||saved.filename==="."||saved.filename==="..")throw denied();
    if(value.resolve)relativePath=value.diskPath;
    else if(value.diskPath!==relativePath)throw denied();
  }
  const policy=new QualifiedCloudFilePolicy(publicationRoot,{canEdit:true,authorized:()=>actor.authorized()&&cloudActorCan(actor.role,"run"),
    privateRoots:[os.homedir(),"/srv/zeros/state","/srv/zeros/home","/opt/zeros","/etc/zeros"],
    ownerRoots:()=>actor.ownerRoots?.().map(cloudWorkspacePublicationPath)??[]});
  if(value.resolve){
    if(value.base64!==""||value.uploadId!==undefined||value.abort||value.offset!==undefined||value.totalBytes!==undefined)throw invalid();
    let fd:number|undefined;
    try{fd=openRecord(policy,relativePath);assertActor(actor);
      return fileResult(logicalRoot,relativePath,value.mimeType,fs.fstatSync(fd).size,true);
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw missing();throw denied();}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  const encoded=value.base64;
  if(encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw invalid();
  const chunk=Buffer.from(encoded,"base64");if(chunk.toString("base64")!==encoded||chunk.length>ATTACHMENT_CHUNK_BYTES)throw invalid();
  const single=value.uploadId===undefined;
  if(single&&(value.offset!==undefined||value.totalBytes!==undefined||value.abort!==undefined))throw invalid();
  const total=single?chunk.length:value.totalBytes,offset=single?0:value.offset;
  if(!value.abort&&(total===undefined||offset===undefined||offset>total||offset+chunk.length>total||(!chunk.length&&offset!==0)))throw invalid();
  const key=JSON.stringify([logicalRoot,actor.userId,value.uploadId??randomUUID()]);
  const record=JSON.stringify([logicalRoot,actor.userId,value.attachmentId]);
  let upload=uploads.get(key);
  if(value.abort){
    if(!upload||upload.record!==record)throw denied();if(upload.busy)throw new CloudCommandFailureError({stage:"validation",category:"lock_busy"});
    await dispose(key,upload);return {absolutePath:"",relativePath:"",mimeType:value.mimeType,bytes:0,pending:true};
  }
  if(upload?.busy)throw new CloudCommandFailureError({stage:"validation",category:"lock_busy"});
  if(upload&&(upload.record!==record||upload.filename!==filename||upload.mimeType!==value.mimeType||upload.total!==total))throw invalid();
  if(!upload){
    if(offset!==0)throw denied();
    if(uploads.size>=16||records.has(record))throw new CloudCommandFailureError({stage:"validation",category:"lock_busy"});
    try{upload={record,filename,mimeType:value.mimeType,total:total!,offset:0,busy:false,relativePath,
      parent:policy.openWriteParent(relativePath,path.join(publicationRoot,relativePath)),policy};}
    catch{throw denied();}
    uploads.set(key,upload);records.set(record,key);
  }
  upload.busy=true;clearTimeout(upload.timer);
  const selected=upload;
  try{
    selected.policy.assertDescriptor(selected.parent.fd,selected.parent.directory,true);assertActor(actor);
    if(!selected.file){selected.temporary=await createAttachmentTemporaryDirectory(logicalRoot);
      selected.file=await fsp.open(path.join(selected.temporary.path,"contents"),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}
    assertActor(actor);selected.policy.assertDescriptor(selected.parent.fd,selected.parent.directory,true);
    if(offset!<selected.offset){
      if(offset!+chunk.length>selected.offset)throw invalid();
      const previous=Buffer.alloc(chunk.length),read=await selected.file.read(previous,0,previous.length,offset);
      if(read.bytesRead!==chunk.length||!previous.equals(chunk))throw invalid();
    }else{
      if(offset!==selected.offset)throw invalid();
      // Temporary bytes stay outside the repository, never in the prompt queue.
      await fsp.writeFile(selected.file,chunk);selected.offset+=chunk.length;
    }
    selected.policy.assertDescriptor(selected.parent.fd,selected.parent.directory,true);assertActor(actor);
    if(selected.offset<selected.total){selected.timer=setTimeout(()=>{if(!selected.busy)void dispose(key,selected).catch(()=>{});},5*60_000);selected.timer.unref();
      return {absolutePath:"",relativePath:"",mimeType:value.mimeType,bytes:selected.offset,pending:true};}
    const destination=`/proc/self/fd/${selected.parent.fd}/${filename}`;
    let existing:number|undefined;
    try{existing=openRecord(selected.policy,selected.relativePath);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(existing!==undefined){
      try{if(!await compareRecord(existing,selected.file,selected.total))throw invalid();
        selected.policy.assertDescriptor(existing,selected.parent.target);assertActor(actor);
      }finally{fs.closeSync(existing);}
      return fileResult(logicalRoot,selected.relativePath,value.mimeType,selected.total,true);
    }
    selected.policy.assertDescriptor(selected.parent.fd,selected.parent.directory,true);assertActor(actor);
    // Hard-link publication is atomic and refuses a destination planted in the
    // gap. The pinned directory prevents an ancestor swap from redirecting it.
    await fsp.link(path.join(selected.temporary!.path,"contents"),destination);
    try{
      await fsp.unlink(path.join(selected.temporary!.path,"contents"));
      selected.policy.assertDescriptor(selected.parent.fd,selected.parent.directory,true);assertActor(actor);
      const published=fs.openSync(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try{selected.policy.assertDescriptor(published,selected.parent.target,true);publishCloudWorkspacePath(selected.parent.target,published);}
      finally{fs.closeSync(published);}
    }catch(error){await fsp.unlink(destination).catch(()=>{});throw error;}
    return fileResult(logicalRoot,selected.relativePath,value.mimeType,selected.total);
  }catch(error){
    if(error instanceof CloudCommandFailureError)throw error;
    throw denied();
  }finally{
    selected.busy=false;
    if(selected.offset>=selected.total||!selected.timer)await dispose(key,selected);
  }
}
