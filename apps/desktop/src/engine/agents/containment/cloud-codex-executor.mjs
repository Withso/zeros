import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import {resolveCloudRuntimeChild,assertCloudRuntimeChildPath} from "./cloud-runtime-root.mjs";

// Fixed image helper, executed only inside the credential-free workload. The
// executor needs writable temporary metadata, never a provider's auth HOME.
const binary=process.argv[2];
const runtime=resolveCloudRuntimeChild();
if(!binary||!path.isAbsolute(binary)||path.resolve(binary)!==binary||!binary.startsWith(`${runtime.workerRoot}/`))throw new Error("Invalid workload executor");
if(runtime.profile==="v4")assertCloudRuntimeChildPath(binary);
const home=await mkdtemp("/tmp/zeros-codex-executor-");
try{
  const child=spawn(binary,["exec-server","--listen","stdio"],{cwd:process.cwd(),env:{
    HOME:home,CODEX_HOME:home,PATH:`${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin`,LANG:"C.UTF-8",SHELL:"/bin/bash",
  },stdio:"inherit"});
  await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{process.exitCode=code??(signal?1:0);resolve();});});
}finally{await rm(home,{recursive:true,force:true});}
