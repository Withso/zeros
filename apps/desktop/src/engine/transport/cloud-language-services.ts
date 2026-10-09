import {resolveCloudRuntime} from "../agents/containment/cloud-runtime-root.mjs";
import {randomUUID} from "node:crypto";
import {lstat} from "node:fs/promises";
import {CloudLanguageService} from "../agents/cloud-language-service";
import {cloudLanguageFileHelper,parseLanguageDocument} from "../agents/cloud-language-document";
import {LspError} from "../agents/lsp-rpc";
import type {CloudExecutionBoundary} from "../agents/containment/cloud-execution-boundary";
import {isCloudDeploymentOwner} from "../agents/containment/cloud-deployment-authority.mjs";
import type {CloudWorkerConfiguration} from "../agents/containment/cloud-worker-config";
import type {BoundaryProcess, PreparedBoundary} from "../agents/containment/types";

const WORKSPACE="/srv/zeros/workspace";
export function cloudLanguageLaunch(worker:CloudWorkerConfiguration,command:string,args:string[]){
  const runtime=resolveCloudRuntime(),NODE=runtime.node;
  if(worker.toolchain.node!==NODE||command!==NODE)throw new LspError("denied");
  const script=args[0]==="--max-old-space-size=256"?args[1]:args[0];
  const permitted=script===cloudLanguageFileHelper()&&args.length===1||
    script===`${runtime.workerRoot}/node_modules/typescript-language-server/lib/cli.mjs`&&args.join("\0")===["--max-old-space-size=256",script,"--stdio","--log-level","1"].join("\0")||
    script===`${runtime.workerRoot}/node_modules/pyright/langserver.index.js`&&args.join("\0")===["--max-old-space-size=256",script,"--stdio"].join("\0");
  if(!permitted)throw new LspError("denied");
  return {command:NODE,script:script!,args:[...args]};
}

/** Human LSP is independent of personal agent credentials. Each current edit
 * actor owns a connection scope; pinned servers inherit the engine identity,
 * shared checkout and normal VM network with an explicit environment. */
export class CloudRuntimeLanguageServices {
  private paused=false;
  private readonly clients=new Map<string,{active:boolean;service:CloudLanguageService;processes:Set<BoundaryProcess>; preparation:Promise<PreparedBoundary>|null}>();
  constructor(private readonly worker:CloudWorkerConfiguration,private readonly failed:()=>void,
    private readonly boundary:Pick<CloudExecutionBoundary,"prepareOwned">){}
  /** Exact engine-owned pinned helper roots. The shared registry retains their
   * ownership and checkpoint pause still proves retirement. */
  idleProcessRoots(): number[] {
    return [...this.clients.values()].flatMap(client => [...client.processes])
      .map(process => process.pid);
  }
  async request(id:string,authorized:()=>boolean,request:unknown):Promise<unknown>{
    const runtime=resolveCloudRuntime(),NODE=runtime.node;
    if(this.paused||!authorized())throw new LspError("denied");
    let client=this.clients.get(id);
    if(!client){
      if(this.clients.size>=8)throw new LspError("capacity");
      const owner={active:true,service:null as unknown as CloudLanguageService,processes:new Set<BoundaryProcess>(),preparation:null as Promise<PreparedBoundary>|null};
      const retire=async(process:BoundaryProcess)=>{await process.stopAndProve();owner.processes.delete(process);};
      const assertLive=()=>{if(this.paused||!owner.active||!authorized())throw new LspError("denied");};
      const launch=async(command:string,args:string[])=>{
        assertLive();const launched=cloudLanguageLaunch(this.worker,command,args);
        for(const file of [NODE,launched.script]){
          const stat=await lstat(file);
          if(!stat.isFile()||stat.isSymbolicLink()||!isCloudDeploymentOwner(file,stat.uid)||(stat.mode&0o022)!==0)throw new LspError("denied");
        }
        assertLive();
        owner.preparation ??= this.boundary.prepareOwned({executionId:`human-language-${randomUUID()}`,actor:"repo-code-task",
          providerId:"human-language",cwd:WORKSPACE,workspaceRoot:WORKSPACE},{kind:"language-service",role:"infrastructure"});
        const prepared=await owner.preparation;
        assertLive();
        const tracked=await prepared.spawn({command:launched.command,args:launched.args,cwd:WORKSPACE,
          env:{HOME:"/tmp",PATH:`${runtime.binRoot}:/usr/bin:/bin`,LANG:"C.UTF-8",NODE_OPTIONS:"--max-old-space-size=256"},stdio:"pipe"});
        owner.processes.add(tracked);
        tracked.stdin?.on("error",()=>{});tracked.stdout?.on("error",()=>{});tracked.stderr?.on("error",()=>{});
        try{assertLive();return tracked;}catch(error){await retire(tracked);throw error;}
      };
      owner.service=new CloudLanguageService({root:WORKSPACE,assertLive,launch,retire,failed:this.failed,
        settleLaunchFailure:async()=>{await Promise.all([...owner.processes].map(retire));},
        readDocument:async(file,signal)=>{
          if(signal?.aborted)throw new LspError();const child=await launch(NODE,[cloudLanguageFileHelper()]);
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
    if(client.preparation) await (await client.preparation).stopAndProve();
    if(this.clients.get(id)===client)this.clients.delete(id);
  }
  async pause():Promise<void>{
    this.paused=true;const results=await Promise.allSettled([...this.clients.keys()].map(id=>this.release(id)));
    if(results.some(result=>result.status==="rejected")){this.failed();throw new LspError();}
  }
  resume(){this.paused=false;}
}
