import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open,mkdir,writeFile,realpath} from "node:fs/promises";
import path from "node:path";
import {assertRegistryImageDigest} from "./snapshot-placement";

/** Export the exact declarative image into a fresh local OCI build context.
 * Only its explicit regular-file inputs enter the context, never the checkout,
 * operator environment, credentials, or an unbounded directory copy. */
type ImageContext = {dockerfile:string;contextList:readonly {sourcePath:string;archivePath:string}[]};
async function readBuildInputs(image:ImageContext,allowedSourceRoot:string){
  if(!path.isAbsolute(allowedSourceRoot)||image.contextList.length>128||Buffer.byteLength(image.dockerfile)>1024*1024)
    throw new Error("VM image build context is invalid");
  const root=await realpath(allowedSourceRoot);
  const entries: {relative:string;bytes:Buffer;mode:number}[]=[];
  const names=new Set<string>(["Dockerfile"]);let total=0;
  for(const item of image.contextList){
    // Docker COPY normalizes an absolute source relative to its build context.
    const relative=item.archivePath.replace(/^\/+/,"");
    if(!relative||relative.includes("\\")||/[\x00-\x1f\x7f]/.test(relative)||relative.split("/").some(p=>p===".."||p==="."||!p)||names.has(relative))
      throw new Error("VM image context contains an unsafe or duplicate destination");
    const source=await realpath(item.sourcePath);
    if(source!==path.resolve(item.sourcePath)||!source.startsWith(`${root}${path.sep}`))throw new Error("VM image source escaped its allowlist");
    const file=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const stat=await file.stat();total+=stat.size;
      if(!stat.isFile()||stat.size>1024*1024||total>8*1024*1024)throw new Error("VM image context source exceeds its bound");
      const buffer=Buffer.alloc(stat.size+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);const bytes=buffer.subarray(0,bytesRead);if(bytes.length!==stat.size)throw new Error("VM image context source changed while reading");
      entries.push({relative,bytes,mode:stat.mode&0o777});names.add(relative);
    }finally{await file.close();}
  }
  return entries;
}
function recipeHash(image:ImageContext,entries:{relative:string;bytes:Buffer;mode:number}[]):string{
  return createHash("sha256").update(JSON.stringify({dockerfile:image.dockerfile,files:entries.map(entry=>({
    path:entry.relative,mode:entry.mode&0o755,sha256:createHash("sha256").update(entry.bytes).digest("hex")
  })).sort((a,b)=>a.path.localeCompare(b.path,"en"))})).digest("hex");
}
export async function vmImageRecipeSha256(image:ImageContext,allowedSourceRoot:string):Promise<string>{
  return recipeHash(image,await readBuildInputs(image,allowedSourceRoot));
}
export async function writeVmImageContext(image:ImageContext,directory:string,allowedSourceRoot:string):Promise<string>{
  if(!path.isAbsolute(directory))throw new Error("VM image build context must be absolute");
  const entries=await readBuildInputs(image,allowedSourceRoot);
  await mkdir(directory,{mode:0o700});
  await writeFile(path.join(directory,"Dockerfile"),image.dockerfile,{mode:0o600,flag:"wx"});
  for(const item of entries){const target=path.join(directory,item.relative);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,item.bytes,{flag:"wx",mode:item.mode&0o755});}
  return recipeHash(image,entries);
}

export async function readVmImageReceipt(file:string,expected:{sourceCommit:string;imageContractSha256:string;recipeSha256:string}):Promise<string>{
  if(!path.isAbsolute(file))throw new Error("VM image receipt must have an absolute path");
  const descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw new Error("VM image receipt is not an owner-only regular file");});
  let value:Record<string,unknown>;
  try{
    const stat=await descriptor.stat();
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>4096)
      throw new Error("VM image receipt is not an owner-only regular file");
    const bytes=Buffer.alloc(4097);const {bytesRead}=await descriptor.read(bytes,0,bytes.length,0);
    if(bytesRead!==stat.size)throw new Error("VM image receipt changed while reading");
    value=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
  }finally{await descriptor.close();}
  if(value.version!==1||value.sourceCommit!==expected.sourceCommit||value.imageContractSha256!==expected.imageContractSha256||
    !/^[a-f0-9]{64}$/.test(expected.recipeSha256)||value.recipeSha256!==expected.recipeSha256)
    throw new Error("VM registry image receipt does not match the source and build contract");
  assertRegistryImageDigest(value.registryImage);return value.registryImage;
}
