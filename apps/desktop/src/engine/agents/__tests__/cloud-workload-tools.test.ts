import {execFileSync,spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {CloudAgentLease} from "../cloud-agent-lease";
import {CloudWorkloadTools} from "../cloud-workload-tools";
import type {BoundaryProcess,BoundarySpawnRequest,PreparedBoundary} from "../containment/types";
const roots:string[]=[],hosts:CloudWorkloadTools[]=[];
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-tools-"));roots.push(root);
  const domains=new Set<{stopAndProve():Promise<void>}>();
  const controller=new AbortController();
  const lease={signal:controller.signal,assertLive:()=>{if(controller.signal.aborted)throw new Error("retired");},validate:async()=>{},
    attach:(domain:{stopAndProve():Promise<void>})=>domains.add(domain),
    launch:async(spawn:()=>Promise<BoundaryProcess>)=>{const child=await spawn();domains.add(child);return child;},
    retire:async(domain:{stopAndProve():Promise<void>})=>{await domain.stopAndProve();domains.delete(domain);},
    close:async()=>{controller.abort();for(const domain of domains)await domain.stopAndProve();},
  } as unknown as CloudAgentLease;
  const launched=vi.fn(async(request:BoundarySpawnRequest):Promise<BoundaryProcess>=>{
    const command=request.command==="/opt/zeros-runtime/bin/node"?process.execPath:request.command;
    const args=request.args.map(arg=>arg.endsWith("/cloud-file-tool.mjs")?path.resolve("apps/desktop/src/engine/agents/containment/cloud-file-tool.mjs"):arg);
    const child=spawn(command,args,{cwd:root,env:{...request.env},stdio:"pipe",detached:true});
    const exit=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
    return {pid:child.pid!,child,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,wait:()=>exit,signal:async()=>{child.kill();},
      stopAndProve:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exit;}};
  });
  const boundary={spawn:launched,stopAndProve:async()=>{}} as unknown as PreparedBoundary;
  const tools=new CloudWorkloadTools(lease,boundary,"/srv/zeros/workspace");hosts.push(tools);return {root,tools,launched,domains,lease,controller};
}
afterEach(async()=>{for(const host of hosts.splice(0))await host.stopAndProve();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe.skipIf(process.platform!=="linux")("credential-free cloud workspace tools",()=>{
  it("refuses FIFOs immediately without waiting for another writer",async()=>{
    const {root,tools}=await fixture();execFileSync("mkfifo",[path.join(root,"pipe")]);
    expect(await tools.call({operation:"read",path:"pipe"},AbortSignal.timeout(500))).toEqual({ok:false,error:"denied"});
  });
  it.each(["existing","new"])("serializes concurrent compare-and-write requests across helper processes for %s files",async(kind)=>{
    const {root}=await fixture(),file=path.join(root,"shared.txt"),preload=path.join(root,"pause-write.mjs"),gate=path.join(root,"publish"),ready=path.join(root,"ready");
    if(kind==="existing")await writeFile(file,"original");
    await writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.open;fs.open=async function(file,...args){const handle=await original(file,...args);
        if(!String(file).includes('.zeros-write-'))return handle;
        return new Proxy(handle,{get(target,key){if(key==='writeFile')return async(...values)=>{
          await fs.writeFile(process.env.TEST_READY,'ready');
          for(;;){try{await fs.access(process.env.TEST_GATE);break;}catch{await new Promise(r=>setTimeout(r,5));}}
          return target.writeFile(...values);
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
      };syncBuiltinESMExports();`);
    const input={operation:"write",path:"shared.txt",expectedSha256:kind==="existing"?createHash("sha256").update("original").digest("hex"):null};
    const run=(content:string,pause=false)=>{
      const child=spawn(process.execPath,[...(pause?["--import",preload]:[]),path.resolve("apps/desktop/src/engine/agents/containment/cloud-file-tool.mjs")],{cwd:root,
        env:{PATH:process.env.PATH,...(pause?{NODE_OPTIONS:`--import=${preload}`,TEST_GATE:gate,TEST_READY:ready}:{})},stdio:"pipe"});
      child.stdin.end(JSON.stringify({...input,content}));const output:Buffer[]=[];child.stdout.on("data",chunk=>output.push(chunk));child.stderr.resume();
      return new Promise<{ok:boolean;error?:string}>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>{try{if(code!==0)throw new Error("helper failed");resolve(JSON.parse(Buffer.concat(output).toString()));}catch(error){reject(error);}});});
    };
    const first=run("first",true);let second:ReturnType<typeof run>|undefined;
    try{await vi.waitFor(async()=>expect(await readFile(ready,"utf8")).toBe("ready"));second=run("second");await new Promise(resolve=>setTimeout(resolve,100));}
    finally{await writeFile(gate,"publish");}
    const results=await Promise.all([first,second!]);expect(results.filter(result=>result.ok)).toHaveLength(1);
    expect(results.filter(result=>!result.ok)).toEqual([{ok:false,error:"conflict"}]);
  });
  it.each([false,true])("preserves raw output bytes across page and eviction boundaries (eviction=%s)",async(evicted)=>{
    const {tools,launched}=await fixture();
    const original=Buffer.from(evicted?"€"+"x".repeat(1024*1024-1):"x".repeat(65535)+"€");
    launched.mockImplementationOnce(async()=>{
      const stdout=new PassThrough(),stderr=new PassThrough();setTimeout(()=>{stdout.end(original);stderr.end();},10);
      return {pid:123,stdin:new PassThrough(),stdout,stderr,wait:async()=>({code:0,signal:null}),signal:async()=>{},stopAndProve:async()=>{}} as BoundaryProcess;
    });
    let result=await tools.call({operation:"exec",command:"ignored"});
    if(!result.ok)throw new Error("output collection failed");
    const id=(result.data as {processId:string}).processId;const bytes:Buffer[]=[];
    for(;;){if(!result.ok)throw new Error("output page failed");const page=result.data as {output:string;encoding:BufferEncoding;cursor:number;hasMore:boolean};
      bytes.push(Buffer.from(page.output,page.encoding));if(!page.hasMore)break;result=await tools.call({operation:"poll",processId:id,cursor:page.cursor});}
    expect(Buffer.concat(bytes)).toEqual(original.subarray(Math.max(0,original.length-1024*1024)));
  });
  it.each(["cancel","deadline"])("bounds a pending spawn on %s and owns the late child",async(mode)=>{
    vi.useFakeTimers();
    const {tools,launched,controller}=await fixture();let deliver!:(process:BoundaryProcess)=>void;
    const gate=new Promise<BoundaryProcess>(resolve=>{deliver=resolve;});launched.mockImplementationOnce(()=>gate);
    const stopped=vi.fn(async()=>{}),child={pid:123,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),wait:async()=>({code:0,signal:null}),signal:async()=>{},stopAndProve:stopped} as BoundaryProcess;
    const abort=new AbortController();let result:unknown;
    const operation=tools.call({operation:"exec",command:"ignored",background:true},abort.signal).then(value=>{result=value;});
    try{
      await vi.advanceTimersByTimeAsync(1);expect(launched).toHaveBeenCalledOnce();
      if(mode==="cancel")abort.abort();
      await vi.advanceTimersByTimeAsync(mode==="cancel"?1:5001);
      expect(result).toMatchObject({ok:false});expect(controller.signal.aborted).toBe(true);
    }finally{deliver(child);await operation;await vi.advanceTimersByTimeAsync(1);vi.useRealTimers();}
    expect(stopped).toHaveBeenCalled();expect(result).not.toMatchObject({ok:true});
  });
  it("collects final output delivered after the exit notification",async()=>{
    const {tools,launched}=await fixture();const stdout=new PassThrough(),stderr=new PassThrough();
    launched.mockImplementationOnce(async()=>{
      const exit={code:0,signal:null};
      setTimeout(()=>{stdout.end("final bytes");stderr.end();},20);
      return {pid:123,stdin:new PassThrough(),stdout,stderr,wait:async()=>exit,signal:async()=>{},stopAndProve:async()=>{}} as BoundaryProcess;
    });
    expect(await tools.call({operation:"exec",command:"ignored"})).toMatchObject({ok:true,data:{output:"final bytes",state:"exited"}});
  });
  it("reuses bounded completed-process capacity and releases each retired child",async()=>{
    const {tools,domains}=await fixture();
    for(let index=0;index<12;index++){
      const result=await tools.call({operation:"exec",command:"printf complete"});
      expect(result.ok).toBe(true);if(result.ok)expect(result.data).toMatchObject({output:"complete",state:"exited",exit:{code:0}});
    }
    expect(domains.size).toBe(2);
  });
  it("roundtrips files with stale-edit checks and refuses paths outside the worktree",async()=>{
    const {tools,root,launched}=await fixture();
    const created=await tools.call({operation:"write",path:"example.txt",content:"one two three",expectedSha256:null});expect(created.ok).toBe(true);
    const read=await tools.call({operation:"read",path:"example.txt",offset:4,length:3});expect(read.ok).toBe(true);
    if(!read.ok)throw new Error("read failed");const data=read.data as {content:string;sha256:string};
    expect(read.data).toMatchObject({content:"two",encoding:"utf8"});
    expect(await tools.call({operation:"replace",path:"example.txt",oldText:"two",newText:"four",expectedSha256:data.sha256})).toMatchObject({ok:true});
    expect(await tools.call({operation:"replace",path:"example.txt",oldText:"four",newText:"five",expectedSha256:data.sha256})).toEqual({ok:false,error:"conflict"});
    expect(await readFile(path.join(root,"example.txt"),"utf8")).toBe("one four three");
    expect(await tools.call({operation:"read",path:"../outside"})).toEqual({ok:false,error:"denied"});
    await symlink(os.tmpdir(),path.join(root,"escape"));
    expect(await tools.call({operation:"write",path:"escape/example.txt",content:"bad",expectedSha256:null})).toEqual({ok:false,error:"denied"});
    for(const [request] of launched.mock.calls){expect(request.env).not.toHaveProperty("ANTHROPIC_API_KEY");expect(request.env).not.toHaveProperty("CURSOR_API_KEY");expect(request.env).not.toHaveProperty("OPENAI_API_KEY");}
  });
  it("bounds file listings and refuses ambiguous replacement",async()=>{
    const {root,tools}=await fixture();for(let i=0;i<4;i++)await writeFile(path.join(root,`file${i}`),"repeat repeat");
    const listed=await tools.call({operation:"list",path:".",limit:2});expect(listed).toMatchObject({ok:true,data:{truncated:true}});
    const read=await tools.call({operation:"read",path:"file0"});if(!read.ok)throw new Error("read failed");
    expect(await tools.call({operation:"replace",path:"file0",oldText:"repeat",newText:"once",expectedSha256:(read.data as {sha256:string}).sha256})).toEqual({ok:false,error:"conflict"});
  });
});
