import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {lstat,mkdir,realpath} from "node:fs/promises";
import {CloudLanguageService} from "../agents/cloud-language-service";
import {CLOUD_LANGUAGE_FILE_HELPER,parseLanguageDocument} from "../agents/cloud-language-document";
import {LspError} from "../agents/lsp-rpc";
import {CloudSupervisedProcess} from "../agents/containment/cloud-supervised-process";
import {isCloudDeploymentOwner} from "../agents/containment/cloud-deployment-authority.mjs";
import type {CloudWorkerConfiguration} from "../agents/containment/cloud-worker-config";
import type {BoundaryProcess} from "../agents/containment/types";

const ROOT="/run/zeros/language-services",SUPERVISOR="/opt/zeros-runtime/cloud-process-supervisor";
const NODE="/opt/zeros-runtime/bin/node",WORKSPACE="/srv/zeros/workspace";
export function cloudLanguageLaunch(worker:CloudWorkerConfiguration,command:string,args:string[]){
  if(worker.uid!==10001||worker.gid!==10001||worker.toolchain.node!==NODE||worker.toolchain.bwrap!=="/usr/bin/bwrap"||
      worker.toolchain.setpriv!=="/usr/bin/setpriv"||command!==NODE)throw new LspError("denied");
  const script=args[0]==="--max-old-space-size=256"?args[1]:args[0];
  const permitted=script===CLOUD_LANGUAGE_FILE_HELPER&&args.length===1||
    script==="/opt/zeros/node_modules/typescript-language-server/lib/cli.mjs"&&args.join("\0")===["--max-old-space-size=256",script,"--stdio","--log-level","1"].join("\0")||
    script==="/opt/zeros/node_modules/pyright/langserver.index.js"&&args.join("\0")===["--max-old-space-size=256",script,"--stdio"].join("\0");
  if(!permitted)throw new LspError("denied");
  // Drop engine identity before creating a nested user/network namespace.
  // The namespace owns its loopback setup without CAP_NET_ADMIN in the engine.
  return {command:worker.toolchain.setpriv,script:script!,args:["--reuid=10001","--regid=10001","--clear-groups","--no-new-privs","--",worker.toolchain.bwrap,"--unshare-user","--unshare-pid","--unshare-net","--die-with-parent","--new-session","--ro-bind","/","/",
    "--proc","/proc","--dev","/dev","--size","67108864","--perms","1777","--tmpfs","/tmp","--tmpfs","/run","--tmpfs","/srv/zeros/home/agent",
    "--cap-drop","ALL","--",NODE,...args]};
}

/** Human LSP is independent of personal agent credentials. Each current edit
 * actor owns a private connection scope; fixed servers see a read-only worktree,
 * private /proc and scratch, no network and no inherited environment. */
export class CloudRuntimeLanguageServices {
  private paused=false;
  private readonly clients=new Map<string,{active:boolean;service:CloudLanguageService;processes:Set<BoundaryProcess>}>();
  constructor(private readonly worker:CloudWorkerConfiguration,private readonly failed:()=>void){}
  async request(id:string,authorized:()=>boolean,request:unknown):Promise<unknown>{
    if(this.paused||!authorized())throw new LspError("denied");
    let client=this.clients.get(id);
    if(!client){
      if(this.clients.size>=8)throw new LspError("capacity");
      const owner={active:true,service:null as unknown as CloudLanguageService,processes:new Set<BoundaryProcess>()};
      const retire=async(process:BoundaryProcess)=>{await process.stopAndProve();owner.processes.delete(process);};
      const assertLive=()=>{if(this.paused||!owner.active||!authorized())throw new LspError("denied");};
      const launch=async(command:string,args:string[])=>{
        assertLive();const launched=cloudLanguageLaunch(this.worker,command,args);
        for(const file of [SUPERVISOR,NODE,this.worker.toolchain.bwrap,launched.command,launched.script]){
          const stat=await lstat(file);
          if(!stat.isFile()||stat.isSymbolicLink()||!isCloudDeploymentOwner(file,stat.uid)||(stat.mode&0o022)!==0)throw new LspError("denied");
        }
        await mkdir(ROOT,{recursive:true,mode:0o700});const stat=await lstat(ROOT);
        if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0||await realpath(ROOT)!==ROOT)throw new LspError("denied");
        assertLive();
        const receipt=`${ROOT}/${randomBytes(16).toString("hex")}`;
        const child=spawn(SUPERVISOR,[receipt,String(process.pid),"--",launched.command,...launched.args],{
          cwd:WORKSPACE,env:{HOME:"/tmp",PATH:"/opt/zeros-runtime/bin:/usr/bin:/bin",LANG:"C.UTF-8",NODE_OPTIONS:"--max-old-space-size=256"},stdio:["pipe","pipe","pipe"]});
        child.on("error",()=>{});
        if(!child.pid)throw new LspError();
        const tracked=new CloudSupervisedProcess(child,receipt,this.failed);
        owner.processes.add(tracked);
        child.stdin.on("error",()=>{});child.stdout.on("error",()=>{});child.stderr.on("error",()=>{});
        try{assertLive();return tracked;}catch(error){await retire(tracked);throw error;}
      };
      owner.service=new CloudLanguageService({root:WORKSPACE,assertLive,launch,retire,failed:this.failed,
        settleLaunchFailure:async()=>{await Promise.all([...owner.processes].map(retire));},
        readDocument:async(file,signal)=>{
          if(signal?.aborted)throw new LspError();const child=await launch(NODE,[CLOUD_LANGUAGE_FILE_HELPER]);
          let output:string;try{output=await this.read(child,JSON.stringify({operation:"read",path:file,offset:0,length:65536}),signal);}finally{await retire(child);}assertLive();
          return parseLanguageDocument(output);
        }});
      client=owner;this.clients.set(id,owner);
    }
    return client.service.request(request);
  }
  private async read(child:BoundaryProcess,input:string,signal?:AbortSignal){
    let size=0;const chunks:Buffer[]=[];let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
    try{return await new Promise<string>((resolve,reject)=>{
      abort=()=>reject(new LspError());signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted){abort();return;}
      timer=setTimeout(()=>reject(new LspError("timeout")),5000);timer.unref?.();
      child.stdout?.on("data",chunk=>{size+=chunk.length;if(size>256*1024)reject(new LspError("output_limit"));else chunks.push(Buffer.from(chunk));});
      child.stdout?.once("error",()=>reject(new LspError()));child.stderr?.resume();
      child.stdout?.once("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));
      child.stdin?.end(input);
      void child.wait().then(exit=>{if(exit.code!==0)reject(new LspError());},()=>reject(new LspError()));
    });}finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);await child.stopAndProve();}
  }
  async release(id:string):Promise<void>{
    const client=this.clients.get(id);if(!client)return;client.active=false;
    await client.service.stopAndProve();
    await Promise.all([...client.processes].map(process=>process.stopAndProve()));
    if(this.clients.get(id)===client)this.clients.delete(id);
  }
  async pause():Promise<void>{
    this.paused=true;const results=await Promise.allSettled([...this.clients.keys()].map(id=>this.release(id)));
    if(results.some(result=>result.status==="rejected")){this.failed();throw new LspError();}
  }
  resume(){this.paused=false;}
}
