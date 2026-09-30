import {readdir,readFile,readlink} from "node:fs/promises";

type Inspection={read(path:string):Promise<string>;list(path:string):Promise<string[]>;link(path:string):Promise<string>};
const native:Inspection={read:path=>readFile(path,"utf8"),list:path=>readdir(path),link:path=>readlink(path)};
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==="ENOENT"||(error as NodeJS.ErrnoException).code==="ESRCH";

/** Detect listeners only in the execution's tracked descendant trees, including
 * children created on another native thread and reparented namespace children.
 * Reads no argv/environment/content and never signals a guessed PID. The
 * boundary's existing proof owner is the only authority that can stop them. */
export async function hasCloudBackgroundServers(roots:readonly number[],io:Inspection=native):Promise<boolean>{
  const seen=new Set<number>(),queue=[...roots];let entries=0;
  while(queue.length){
    const pid=queue.shift()!;
    if(!Number.isSafeInteger(pid)||pid<1||seen.has(pid))continue;
    if(seen.size>=512)throw new Error("Cloud process observation capacity exceeded");seen.add(pid);
    let threads:string[];
    try{threads=await io.list(`/proc/${pid}/task`);}catch(error){if(missing(error))continue;throw error;}
    if(threads.length>256)throw new Error("Cloud process observation capacity exceeded");
    for(const tid of threads){
      if(!/^[1-9][0-9]*$/.test(tid))continue;
      let children:string;
      try{children=await io.read(`/proc/${pid}/task/${tid}/children`);}catch(error){if(missing(error))continue;throw error;}
      if(children.length>8192)throw new Error("Cloud process observation capacity exceeded");
      for(const child of children.trim().split(/\s+/))if(/^[1-9][0-9]*$/.test(child))queue.push(Number(child));
    }
    let descriptors:string[];
    try{descriptors=await io.list(`/proc/${pid}/fd`);}catch(error){if(missing(error))continue;throw error;}
    entries+=descriptors.length;if(entries>8192)throw new Error("Cloud process observation capacity exceeded");
    const sockets=new Set<string>();
    for(const descriptor of descriptors){
      if(!/^[0-9]+$/.test(descriptor))continue;
      let link:string;
      try{link=await io.link(`/proc/${pid}/fd/${descriptor}`);}catch(error){if(missing(error))continue;throw error;}
      const socket=/^socket:\[([0-9]+)\]$/.exec(link);if(socket)sockets.add(socket[1]!);
    }
    if(!sockets.size)continue;
    for(const protocol of ["tcp","tcp6"]){
      let table:string;
      try{table=await io.read(`/proc/${pid}/net/${protocol}`);}catch(error){if(missing(error))continue;throw error;}
      if(table.length>2*1024*1024)throw new Error("Cloud socket observation capacity exceeded");
      for(const line of table.split("\n").slice(1)){
        const fields=line.trim().split(/\s+/);
        if(fields[3]==="0A"&&sockets.has(fields[9]!))return true;
      }
    }
  }
  return false;
}
