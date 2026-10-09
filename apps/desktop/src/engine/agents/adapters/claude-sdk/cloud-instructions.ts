import {constants,openSync,closeSync,fstatSync,readSync,readlinkSync,realpathSync} from "node:fs";
import path from "node:path";

/** Native project settings remain disabled: the CLI gates its instruction
 * scanner on that same unsafe source. Project instruction text is instead a
 * bounded engine-read append to the native preset. It cannot load settings,
 * helpers, hooks or plugins. Never use HOME or a renderer-selected root. */
export function cloudClaudeInstructions(cwd:string):string|undefined{
  return cloudInstructionFiles(cwd,["CLAUDE.md","AGENTS.md"]);
}

/** Callers select only fixed repository instruction names, never arbitrary
 * user paths. Cursor's rule discovery is separately bounded at its caller. */
export function cloudInstructionFiles(cwd:string,files:readonly string[]):string|undefined{
  let root:string;
  try{root=realpathSync(cwd);}catch{return undefined;}
  const instructions:string[]=[];
  let total=0;
  const selected=new Set<string>();
  for(const file of files.slice(0,256)){
    if(selected.size>=16)break;
    if(selected.has(file)||!(file==="CLAUDE.md"||file==="AGENTS.md"||/^\.cursor\/rules\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\.(?:md|mdc)$/.test(file)))continue;
    selected.add(file);
    let fd:number|undefined;
    try{
      fd=openSync(path.join(root,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=fstatSync(fd),actual=readlinkSync(`/proc/self/fd/${fd}`);
      if(!stat.isFile()||stat.size>64*1024||!actual.startsWith(root+path.sep))continue;
      const bytes=Buffer.alloc(64*1024+1),size=readSync(fd,bytes,0,bytes.length,0);
      if(size>64*1024)continue;
      const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,size));
      if(!text.trim())continue;
      const chunk=`Repository instructions (${file}):\n${text}`;
      const chunkBytes=Buffer.byteLength(chunk)+(instructions.length?2:0);
      if(total+chunkBytes>128*1024)continue;
      total+=chunkBytes;instructions.push(chunk);
    }catch{
      // Missing/unreadable optional instructions do not change admission.
    }finally{if(fd!==undefined){try{closeSync(fd);}catch{/* Optional file cleanup. */}}}
  }
  return instructions.length?instructions.join("\n\n"):undefined;
}
