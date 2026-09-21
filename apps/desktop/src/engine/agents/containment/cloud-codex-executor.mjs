import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";

// Fixed image helper, executed only inside the credential-free workload. The
// executor needs writable temporary metadata, never a provider's auth HOME.
const binary=process.argv[2];
if(!binary||!path.isAbsolute(binary)||path.resolve(binary)!==binary||!binary.startsWith("/opt/zeros/"))throw new Error("Invalid workload executor");
const home=await mkdtemp("/tmp/zeros-codex-executor-");
try{
  const child=spawn(binary,["exec-server","--listen","stdio"],{cwd:process.cwd(),env:{
    HOME:home,CODEX_HOME:home,PATH:"/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",SHELL:"/bin/bash",
  },stdio:"inherit"});
  await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{process.exitCode=code??(signal?1:0);resolve();});});
}finally{await rm(home,{recursive:true,force:true});}
