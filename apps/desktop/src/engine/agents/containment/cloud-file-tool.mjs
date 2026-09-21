/** Runs only as the credential-free workload UID inside its prepared boundary.
 * The trusted engine validates the discriminated operation schema before stdin.
 * stdout is bounded tool data, never an engine RPC or an authorization claim. */
import {constants} from "node:fs";
import {open,opendir,rename,link,rm,lstat} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {isUtf8} from "node:buffer";
const ROOT=process.cwd(),MAX=1024*1024;
function fail(code){throw Object.assign(new Error("Workspace file operation failed"),{toolCode:code});}
const inside=value=>value===ROOT||value.startsWith(`${ROOT}${path.sep}`);
async function directory(parts){
  // Walk from the process's pinned cwd through open directory descriptors.
  // Refuse symlinks at every component; a lexical/realpath precheck followed
  // by a normal open would allow an ancestor to be swapped between the two.
  let handle=await open(".",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{for(const component of parts){
    const next=await open(`/proc/self/fd/${handle.fd}/${component}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    await handle.close();handle=next;
  }return handle;}catch(error){await handle.close();throw error;}
}
function parts(value){
  const candidate=path.resolve(ROOT,value);if(!inside(candidate))fail("denied");
  return path.relative(ROOT,candidate).split(path.sep).filter(Boolean);
}
async function lockDirectory(handle){
  // The lock belongs to the inherited open file description and remains held
  // by this process after flock exits. All helper writers share the directory
  // inode across execution namespaces; crashes release the lock automatically.
  await new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/flock",["--exclusive","--wait","5","3"],{
      env:{PATH:"/usr/bin:/bin",LANG:"C"},stdio:["ignore","ignore","ignore",handle.fd],
    });
    child.once("error",()=>reject(Object.assign(new Error("File lock unavailable"),{toolCode:"unavailable"})));
    child.once("exit",code=>code===0?resolve():reject(Object.assign(new Error("File lock timed out"),{toolCode:"timeout"})));
  });
}
function sha(bytes){return createHash("sha256").update(bytes).digest("hex");}
async function boundedBytes(handle){
  const chunks=[];let size=0;
  for(;;){const buffer=Buffer.alloc(Math.min(65536,MAX+1-size));const {bytesRead}=await handle.read(buffer,0,buffer.length,size);
    if(!bytesRead)break;size+=bytesRead;if(size>MAX)fail("output_limit");chunks.push(buffer.subarray(0,bytesRead));}
  return Buffer.concat(chunks,size);
}
async function readAll(file){
  let handle;try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if(error.code==="ENOENT")return null;throw error;}
  try{const stat=await handle.stat();if(!stat.isFile())fail("denied");if(stat.size>MAX)fail("output_limit");return await boundedBytes(handle);}
  finally{await handle.close();}
}
async function run(input){
  if(input.operation==="list"){
    const handle=await directory(parts(input.path)),entries=[];let truncated=false;
    try{for await(const entry of await opendir(`/proc/self/fd/${handle.fd}`)){if(entries.length>=input.limit){truncated=true;break;}entries.push(entry);}
      return {entries:entries.sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>({name:entry.name,type:entry.isDirectory()?"directory":entry.isSymbolicLink()?"symlink":"file"})),truncated};
    }finally{await handle.close();}
  }
  const components=parts(input.path),leaf=components.pop();if(!leaf)fail("denied");
  const parent=await directory(components),file=`/proc/self/fd/${parent.fd}/${leaf}`;
  try{
  if(input.operation==="read"){
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=await handle.stat();if(!stat.isFile())fail("denied");
      const whole=stat.size<=MAX?await boundedBytes(handle):null;
      let bytes;
      if(whole)bytes=whole.subarray(input.offset,input.offset+input.length);
      else {const buffer=Buffer.alloc(input.length),{bytesRead}=await handle.read(buffer,0,buffer.length,input.offset);bytes=buffer.subarray(0,bytesRead);}
      const encoding=isUtf8(bytes)?"utf8":"base64";
      return {encoding,content:bytes.toString(encoding),offset:input.offset,nextOffset:input.offset+bytes.length,totalBytes:whole?.length??stat.size,sha256:whole?sha(whole):null};
    }finally{await handle.close();}
  }
  if(input.operation!=="write"&&input.operation!=="replace")fail("invalid_input");
  await lockDirectory(parent);
  const before=await readAll(file);
  if((before?sha(before):null)!==input.expectedSha256)fail("conflict");
  let content=input.content;
  if(input.operation==="replace"){
    if(!before)fail("not_found");if(!isUtf8(before))fail("denied");const old=before.toString("utf8"),first=old.indexOf(input.oldText);
    if(first<0||old.indexOf(input.oldText,first+1)>=0)fail("conflict");
    content=old.slice(0,first)+input.newText+old.slice(first+input.oldText.length);
  }
  const bytes=Buffer.from(content);if(bytes.length>MAX)fail("output_limit");
  const temporary=path.join(path.dirname(file),`.zeros-write-${randomUUID()}`);let handle;
  try{handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await handle.writeFile(bytes);await handle.sync();
    if(before){const stat=await lstat(file);await handle.chmod(stat.mode&0o777);}
    await handle.close();handle=null;
    if(before){
      // Shell/editor writes do not participate in advisory locks. Recheck after
      // staging to catch intervening changes; CAS serializes helper writers,
      // but cannot promise exclusion against arbitrary noncooperating writes.
      const current=await readAll(file);if(!current||sha(current)!==input.expectedSha256)fail("conflict");
      await rename(temporary,file);
    }else{
      // Atomic no-replace publication: never overwrite a concurrent creator,
      // including shell/editor writers that do not take our advisory lock.
      try{await link(temporary,file);}catch(error){if(error.code==="EEXIST")fail("conflict");throw error;}
    }
    await parent.sync();return {bytes:bytes.length,sha256:sha(bytes)};
  }finally{await handle?.close().catch(()=>{});await rm(temporary,{force:true}).catch(()=>{});}
  }finally{await parent.close();}
}
try{
  let size=0;const chunks=[];
  for await(const chunk of process.stdin){size+=chunk.length;if(size>256*1024)fail("invalid_input");chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify({ok:true,data:await run(input)}));
}catch(error){const mapped=error.toolCode??({ENOENT:"not_found",EACCES:"denied",EPERM:"denied",ELOOP:"denied",ENOTDIR:"denied"}[error.code])??"unavailable";
  process.stdout.write(JSON.stringify({ok:false,error:mapped}));}
