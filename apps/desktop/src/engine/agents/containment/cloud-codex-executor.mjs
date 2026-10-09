import {spawn} from "node:child_process";
import path from "node:path";
import {resolveCloudRuntimeChild,assertCloudRuntimeChildPath} from "./cloud-runtime-root.mjs";

// The parent supplies the original physical per-conversation HOME/XDG and
// credential-free actor environment. This helper preserves those paths.
const binary=process.argv[2];
const runtime=resolveCloudRuntimeChild();
if(!binary||!path.isAbsolute(binary)||path.resolve(binary)!==binary||!binary.startsWith(`${runtime.workerRoot}/`))throw new Error("Invalid workload executor");
if(runtime.profile==="v4")assertCloudRuntimeChildPath(binary);
const child=spawn(binary,["exec-server","--listen","stdio"],{cwd:process.cwd(),env:{
    // The workload parent supplies only its filtered, actor-scoped environment;
    // it never inherits the credential-bearing coordinator's process env.
    ...process.env,
    PATH:`${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin`,SHELL:"/bin/bash",
  },stdio:"inherit"});
  await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{process.exitCode=code??(signal?1:0);resolve();});});
