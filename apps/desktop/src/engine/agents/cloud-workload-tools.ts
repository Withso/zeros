import {randomUUID} from "node:crypto";
import {isUtf8} from "node:buffer";
import path from "node:path";
import {finished} from "node:stream/promises";
import {z} from "zod";
import {CloudAgentToolInputSchema,type CloudAgentToolBridge,type CloudAgentToolResult} from "@zeros/protocol/cloud-agent-tools";
import type {BoundaryProcess,PreparedBoundary} from "./containment/types";
import type {CloudAgentLease} from "./cloud-agent-lease";
import {CloudLanguageService} from "./cloud-language-service";
import {parseLanguageDocument} from "./cloud-language-document";
import {LspError} from "./lsp-rpc";

const MAX_OUTPUT=1024*1024,MAX_JOBS=8,MAX_CALLS=4;
const FILE_HELPER="/opt/zeros/apps/desktop/src/engine/agents/containment/cloud-file-tool.mjs";
type Job={process:BoundaryProcess;chunks:Buffer[];start:number;end:number;exit:{code:number|null;signal:string|null}|null;
  done:Promise<void>;timer:ReturnType<typeof setTimeout>;touched:number;timedOut:boolean};
type ToolError=Extract<CloudAgentToolResult,{ok:false}>["error"];
function unavailable(code:ToolError="unavailable"){return Object.assign(new Error("Cloud workload operation failed"),{toolCode:code});}

/** Model tools execute only under the credential-free workload UID. The
 * execution owns every pending spawn, process, bounded output buffer and lease. */
export class CloudWorkloadTools implements CloudAgentToolBridge {
  readonly inputSchema=z.toJSONSchema(CloudAgentToolInputSchema) as Record<string,unknown>;
  private readonly jobs=new Map<string,Job>();
  private readonly active=new Set<BoundaryProcess>();
  private readonly launches=new Set<Promise<BoundaryProcess>>();
  private calls=0;
  private reservedJobs=0;
  private retired=false;
  private closing:Promise<void>|null=null;
  private languageService:CloudLanguageService|null=null;
  private readonly env:Record<string,string>;
  constructor(readonly lease:CloudAgentLease,private readonly boundary:PreparedBoundary,private readonly cwd:string){
    if(!path.isAbsolute(cwd)||path.resolve(cwd)!==cwd||!(cwd==="/srv/zeros/workspace"||cwd.startsWith("/srv/zeros/workspace/")))
      throw new Error("Cloud workload root is invalid");
    this.env={HOME:"/srv/zeros/home/agent",PATH:"/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",
      USER:"zeros-agent",LOGNAME:"zeros-agent",SHELL:"/bin/bash",TMPDIR:"/tmp",ZEROS_WORKTREE_PATH:cwd};
    lease.attach(this);lease.attach(boundary);
  }
  private assertLive(){if(this.retired)throw unavailable();this.lease.assertLive();}
  private async bounded<T>(operation:Promise<T>,timeoutMs:number,signal?:AbortSignal):Promise<T>{
    const signals=[this.lease.signal,...(signal?[signal]:[])];let timer:ReturnType<typeof setTimeout>|undefined;
    let abort=()=>{};
    try{return await Promise.race([operation,new Promise<never>((_,reject)=>{
      abort=()=>reject(unavailable());for(const source of signals)source.addEventListener("abort",abort,{once:true});
      timer=setTimeout(()=>reject(unavailable("timeout")),timeoutMs);timer.unref?.();
      if(signals.some(source=>source.aborted))abort();
    })]);}finally{if(timer)clearTimeout(timer);for(const source of signals)source.removeEventListener("abort",abort);}
  }
  private async retire(process:BoundaryProcess){await this.lease.retire(process);this.active.delete(process);}
  private stopSoon(process:BoundaryProcess){void this.retire(process).catch(()=>this.lease.close().catch(()=>{}));}
  async call(raw:unknown,signal?:AbortSignal):Promise<CloudAgentToolResult>{
    const parsed=CloudAgentToolInputSchema.safeParse(raw);
    if(!parsed.success)return {ok:false,error:"invalid_input"};
    if(this.calls>=MAX_CALLS)return {ok:false,error:"capacity"};
    this.calls++;
    try{
      this.assertLive();if(signal?.aborted)throw unavailable();
      await this.bounded(this.lease.validate(),5000,signal);this.assertLive();if(signal?.aborted)throw unavailable();
      const input=parsed.data;
      if(input.operation==="lsp"){
        this.languageService??=new CloudLanguageService({root:this.cwd,assertLive:()=>this.assertLive(),
          launch:(command,args)=>this.start(command,args),retire:process=>this.retire(process),
          settleLaunchFailure:async()=>{await Promise.allSettled([...this.launches]);await this.boundary.stopAndProve();},
          readDocument:async(file,signal)=>{const result=await this.collect("/opt/zeros-runtime/bin/node",[FILE_HELPER],JSON.stringify({operation:"read",path:file,offset:0,length:65536}),signal);
            if(result.code!==0||result.truncated)throw unavailable();return parseLanguageDocument(result.output);},
          failed:()=>{void this.lease.close().catch(()=>{});}});
        const data=await this.languageService.request(input.request,signal);this.assertLive();return {ok:true,data};
      }
      if(input.operation==="exec"){
        this.prune();if(this.jobs.size+this.reservedJobs>=MAX_JOBS)return {ok:false,error:"capacity"};
        this.reservedJobs++;let process:BoundaryProcess;
        try{process=await this.start("/bin/bash",["--noprofile","--norc","-c",input.command],signal,Math.min(5000,input.timeoutMs));}finally{this.reservedJobs--;}
        if(signal?.aborted){await this.retire(process);throw unavailable();}this.assertLive();
        const id=randomUUID(),job=this.trackJob(process,input.timeoutMs);this.jobs.set(id,job);
        if(input.background)return {ok:true,data:{processId:id,...this.snapshot(job,0)}};
        try{
          await this.bounded(job.done,input.timeoutMs+5000,signal);this.assertLive();
          if(job.timedOut)return {ok:false,error:"timeout"};
          return {ok:true,data:{processId:id,...this.snapshot(job,0)}};
        }catch(error){await this.retire(process);throw error;}
      }
      if(input.operation==="poll"||input.operation==="input"||input.operation==="stop"){
        const job=this.jobs.get(input.processId);if(!job)return {ok:false,error:"not_found"};job.touched=Date.now();
        if(input.operation==="input"){
          if(job.exit||!job.process.stdin?.writable)return {ok:false,error:"unavailable"};
          await this.bounded(new Promise<void>((resolve,reject)=>job.process.stdin!.write(input.text,error=>error?reject(unavailable()):resolve())),5000,signal);
          if(input.close)job.process.stdin.end();
        }else if(input.operation==="stop"){await this.retire(job.process);await this.bounded(job.done,3000,signal);}
        return {ok:true,data:this.snapshot(job,input.operation==="poll"?input.cursor:job.end)};
      }
      if(input.operation==="search"){
        const target=path.resolve(this.cwd,input.path);
        if(target!==this.cwd&&!target.startsWith(`${this.cwd}/`))return {ok:false,error:"denied"};
        const result=await this.collect("/usr/bin/rg",["--json","--max-count","100","--max-filesize","1M","--regexp",input.pattern,"--",target],undefined,signal);
        return {ok:true,data:{output:result.output,code:result.code,truncated:result.truncated}};
      }
      const encoded=JSON.stringify(input);if(Buffer.byteLength(encoded)>256*1024)return {ok:false,error:"invalid_input"};
      const result=await this.collect("/opt/zeros-runtime/bin/node",[FILE_HELPER],encoded,signal);
      if(result.code!==0||result.truncated)return {ok:false,error:result.truncated?"output_limit":"unavailable"};
      const value:unknown=JSON.parse(result.output);
      if(!value||typeof value!=="object"||!("ok" in value))return {ok:false,error:"unavailable"};
      if(value.ok===true&&"data" in value)return {ok:true,data:value.data};
      const error="error" in value?value.error:null;
      return {ok:false,error:["invalid_input","unavailable","conflict","not_found","denied","output_limit","timeout"].includes(String(error))?error as ToolError:"unavailable"};
    }catch(error){return {ok:false,error:error instanceof LspError?error.code:(error as {toolCode?:ToolError}).toolCode??"unavailable"};}
    finally{this.calls--;}
  }
  private async start(command:string,args:string[],signal?:AbortSignal,timeoutMs=5000):Promise<BoundaryProcess>{
    this.assertLive();if(signal?.aborted)throw unavailable();let cancelled=false;
    const env=args.some(arg=>arg.endsWith("/typescript-language-server/lib/cli.mjs")||arg.endsWith("/pyright/langserver.index.js"))
      ?{...this.env,NODE_OPTIONS:"--max-old-space-size=256"}:this.env;
    const pending=this.lease.launch(()=>this.boundary.spawn({command,args,cwd:this.cwd,env,stdio:"pipe"})).then(async process=>{
      this.active.add(process);process.stdin?.on("error",()=>{});
      try{this.assertLive();if(cancelled||signal?.aborted)throw unavailable();return process;}catch(error){await this.retire(process);throw error;}
    });
    this.launches.add(pending);
    void pending.finally(()=>this.launches.delete(pending)).catch(()=>{});
    try{return await this.bounded(pending,timeoutMs,signal);}
    catch(error){
      cancelled=true;
      // An uncertain spawn cannot be forgotten or keep renewing credentials.
      // The lease retains its launch reservation until the late child is reaped;
      // its independent retirement ladder quarantines a permanently hung spawn.
      void this.lease.close().catch(()=>{});throw error;
    }
  }
  private drainOutput(process:BoundaryProcess){return this.bounded(Promise.all([process.stdout,process.stderr]
    .filter(stream=>stream!==null).map(stream=>finished(stream,{cleanup:true}))),3000);}
  private trackJob(process:BoundaryProcess,timeoutMs:number):Job{
    const job:Job={process,chunks:[],start:0,end:0,exit:null,done:Promise.resolve(),touched:Date.now(),timedOut:false,
      timer:setTimeout(()=>{job.timedOut=true;this.stopSoon(process);},timeoutMs)};job.timer.unref?.();
    const data=(chunk:Buffer|string)=>{
      const bytes=Buffer.from(chunk);job.chunks.push(bytes);job.end+=bytes.length;
      while(job.end-job.start>MAX_OUTPUT&&job.chunks.length){const first=job.chunks[0]!;const drop=Math.min(first.length,job.end-job.start-MAX_OUTPUT);
        if(drop===first.length)job.chunks.shift();else job.chunks[0]=first.subarray(drop);job.start+=drop;}
    };
    process.stdout?.on("data",data);process.stderr?.on("data",data);
    job.done=process.wait().then(async exit=>{
      clearTimeout(job.timer);await this.retire(process);await this.drainOutput(process);
      job.exit={code:exit.code,signal:exit.signal};job.touched=Date.now();
    });
    void job.done.catch(()=>this.lease.close().catch(()=>{}));return job;
  }
  private snapshot(job:Job,cursor:number){
    const start=Math.max(job.start,Math.min(cursor,job.end));
    const end=Math.min(start+65536,job.end);
    const bytes=Buffer.concat(job.chunks).subarray(start-job.start,end-job.start),encoding=isUtf8(bytes)?"utf8":"base64";
    return {output:bytes.toString(encoding),encoding,cursor:end,hasMore:end<job.end,
      truncated:cursor<job.start,state:job.exit?"exited":"running",exit:job.exit,timedOut:job.timedOut};
  }
  private prune(){
    for(const[id,job]of this.jobs)if(job.exit&&Date.now()-job.touched>60_000)this.jobs.delete(id);
    const completed=[...this.jobs].filter(([,job])=>job.exit).sort((a,b)=>a[1].touched-b[1].touched);
    while(this.jobs.size+this.reservedJobs>=MAX_JOBS&&completed.length)this.jobs.delete(completed.shift()![0]);
  }
  private async collect(command:string,args:string[],input:string|undefined,signal?:AbortSignal){
    const process=await this.start(command,args,signal);let size=0,truncated=false;const chunks:Buffer[]=[];
    const output=(chunk:Buffer|string)=>{const data=Buffer.from(chunk);size+=data.length;
      if(size>MAX_OUTPUT){truncated=true;this.stopSoon(process);}else chunks.push(data);};
    process.stdout?.on("data",output);process.stderr?.resume();
    try{
      if(signal?.aborted)throw unavailable();process.stdin?.end(input);
      const exit=await this.bounded(process.wait(),30000,signal);await this.retire(process);await this.drainOutput(process);this.assertLive();
      return {output:Buffer.concat(chunks).toString("utf8"),code:exit.code,truncated};
    }finally{await this.retire(process);}
  }
  stopAndProve():Promise<void>{
    this.retired=true;if(this.closing)return this.closing;
    const closing=(async()=>{
      for(const job of this.jobs.values())clearTimeout(job.timer);
      await this.languageService?.stopAndProve();
      do{
        if(this.launches.size)await Promise.allSettled([...this.launches]);
        const results=await Promise.allSettled([...this.active].map(process=>this.retire(process)));
        if(results.some(result=>result.status==="rejected"))throw new Error("Cloud workload process retirement is incomplete");
      }while(this.active.size||this.launches.size);
      this.jobs.clear();
    })();this.closing=closing;void closing.finally(()=>{if(this.closing===closing)this.closing=null;}).catch(()=>{});return closing;
  }
}
