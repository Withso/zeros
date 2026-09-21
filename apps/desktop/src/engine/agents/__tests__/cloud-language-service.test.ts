import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PassThrough,Transform} from "node:stream";
import {describe,it,expect,afterEach,vi} from "vitest";
import type {BoundaryProcess} from "../containment/types";
import {CloudLanguageService,type CloudLanguageHost} from "../cloud-language-service";
import {parseLanguageDocument} from "../cloud-language-document";

const roots:string[]=[],services:CloudLanguageService[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.stopAndProve();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.useRealTimers();});
async function nativeFixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),"zeros-lsp-test-"));roots.push(root);
  const children:BoundaryProcess[]=[];
  const host:CloudLanguageHost={root,assertLive:()=>{},failed:vi.fn(),
    readDocument:async file=>{const text=await readFile(file,"utf8");return {text,sha256:createHash("sha256").update(text).digest("hex")};},
    retire:async process=>process.stopAndProve(),
    launch:async(_command,args)=>{
      const actual=args.map(value=>value.replace("/opt/zeros/",process.cwd()+"/"));
      const child=spawn(process.execPath,actual,{cwd:root,env:{PATH:"/usr/bin:/bin",HOME:root,NODE_OPTIONS:"--max-old-space-size=256"},stdio:["pipe","pipe","pipe"],detached:process.platform!=="win32"});
      // Only test transport substitution. Production launch pins immutable
      // paths; this adapter rewrites the initialization path for a local probe.
      let pending=Buffer.alloc(0);
      const stdin=new Transform({transform(chunk,_encoding,done){
        pending=Buffer.concat([pending,chunk]);
        for(;;){const end=pending.indexOf("\r\n\r\n");if(end<0)break;const length=Number(/Content-Length: (\d+)/.exec(pending.subarray(0,end).toString())?.[1]);if(pending.length<end+4+length)break;
          const body=Buffer.from(pending.subarray(end+4,end+4+length).toString().replaceAll("/opt/zeros/",process.cwd()+"/"));
          this.push(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));pending=pending.subarray(end+4+length);}
        done();}});stdin.pipe(child.stdin);
      const wait=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
      let stopping:Promise<void>|undefined;
      const processHandle={pid:child.pid!,stdin,stdout:child.stdout,stderr:child.stderr,wait:()=>wait,signal:async()=>{child.kill("SIGTERM");},
        stopAndProve:()=>stopping??=(async()=>{try{if(process.platform!=="win32")process.kill(-child.pid!,"SIGKILL");else child.kill("SIGKILL");}catch{/* already exited */}await wait;})()} satisfies BoundaryProcess;
      children.push(processHandle);return processHandle;
    }};
  const service=new CloudLanguageService(host);services.push(service);return {root,service,host,children};
}
describe("portable native language tools",()=>{
  it.each(["typescript","javascript","python"] as const)("runs pinned %s symbols, completions, disk refresh, close and stop",async language=>{
    const {root,service}=await nativeFixture();const file=language==="python"?"sample.py":language==="javascript"?"sample.js":"sample.ts";
    const first=language==="python"?"def greet(name):\n    return name\n\ngre\n":"export function greet(name: string) { return name; }\ngre\n".replace(language==="javascript"?": string":"never-matches","");
    await writeFile(path.join(root,file),first);
    const opened=await service.request({kind:"open",language,path:file});expect(opened).toMatchObject({state:"open"});
    const symbols=await service.request({kind:"documentSymbols",language,path:file}) as {symbols:{name:string}[]};
    expect(symbols.symbols.some(symbol=>symbol.name==="greet")).toBe(true);
    const line=language==="python"?3:1;
    const completions=await service.request({kind:"completions",language,path:file,position:{line,character:3}}) as {completions:{label:string}[]};
    expect(completions.completions.some(item=>item.label==="greet")).toBe(true);
    await writeFile(path.join(root,file),first.replaceAll("greet","welcome"));
    const refreshed=await service.request({kind:"documentSymbols",language,path:file}) as {symbols:{name:string}[]};
    expect(refreshed.symbols.some(symbol=>symbol.name==="welcome")).toBe(true);expect(refreshed.symbols.some(symbol=>symbol.name==="greet")).toBe(false);
    expect(await service.request({kind:"workspaceSymbols",language,query:"welcome"})).toMatchObject({consistency:"disk_best_effort"});
    expect(await service.request({kind:"close",language,path:file})).toEqual({state:"closed"});
    expect(await service.request({kind:"stop",language})).toEqual({state:"stopped"});
  },20000);
  it("rejects arbitrary protocol, configuration, escaped and private paths",async()=>{
    const {service,host}=await nativeFixture();const launch=vi.spyOn(host,"launch");
    for(const request of [{kind:"executeCommand",language:"python"},{kind:"start",language:"python",env:{SECRET:"value"}}])
      await expect(service.request(request)).rejects.toMatchObject({code:"invalid_input"});
    for(const file of ["../escape.py",".zeros/private.py",".env",".git/config"])
      await expect(service.request({kind:"open",language:"python",path:file})).rejects.toMatchObject({code:"denied"});
    expect(launch).not.toHaveBeenCalled();
  });
  it("retires a late start after checkpoint pause and never returns it as running",async()=>{
    const {host,service}=await nativeFixture();let deliver!:(child:BoundaryProcess)=>void;
    host.launch=()=>new Promise(resolve=>{deliver=resolve;});
    const started=service.request({kind:"start",language:"python"}).catch(error=>error.code);
    await Promise.resolve();await Promise.resolve();const closed=service.stopAndProve();
    const retire=vi.fn(async()=>{}),child={stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),stopAndProve:retire} as unknown as BoundaryProcess;
    deliver(child);expect(await started).toBe("unavailable");await closed;expect(retire).toHaveBeenCalledOnce();
  });
  it("refuses truncated/binary or mismatched file-helper results",()=>{
    for(const data of [{encoding:"base64",content:"YWJj",totalBytes:3},{encoding:"utf8",content:"abc",totalBytes:4},{encoding:"utf8",content:"abc",totalBytes:3,sha256:"0".repeat(64)}])
      expect(()=>parseLanguageDocument(JSON.stringify({ok:true,data}))).toThrow();
  });
  it("waits for idle retirement before accepting a new start",async()=>{
    const {host,service,root,children}=await nativeFixture();
    await writeFile(path.join(root,"sample.py"),"def fresh():\n    pass\n");
    await service.request({kind:"start",language:"python"});
    let release!:()=>void;
    const previousRetire=host.retire;
    host.retire=async child=>{await new Promise<void>(resolve=>{release=resolve;});await previousRetire(child);};
    // Idle/native-error retirement happens outside the public request queue.
    const stopped=(service as unknown as {stop(key:string):Promise<void>}).stop("python");
    while(!release)await Promise.resolve();
    let finished=false;
    const restarted=service.request({kind:"start",language:"python"}).then(result=>{finished=true;return result;});
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    const completedBeforeProof=finished;
    host.retire=previousRetire;release();await stopped;
    expect(await restarted).toMatchObject({state:"running"});
    expect(completedBeforeProof).toBe(false);
    expect(children).toHaveLength(2);
    expect(await service.request({kind:"documentSymbols",language:"python",path:"sample.py"})).toMatchObject({symbols:[{name:"fresh"}]});
  },20000);
  it("projects symbol ranges without arbitrary server fields",async()=>{
    const {service,host,root}=await nativeFixture();await writeFile(path.join(root,"sample.py"),"a=1\n");
    const project=(service as unknown as {symbols(raw:unknown,file:string):Promise<unknown>}).symbols.bind(service);
    const result=await project([{name:"a",kind:13,range:{start:{line:0,character:0,privateData:"sentinel-secret"},end:{line:0,character:1}}}],path.join(root,"sample.py"));
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");expect(host.failed).not.toHaveBeenCalled();
  });
  it("bounds failed symbol path probes as well as successful paths",async()=>{
    const {service,host,root}=await nativeFixture();const read=vi.spyOn(host,"readDocument").mockRejectedValue(new Error("missing"));
    const project=(service as unknown as {symbols(raw:unknown):Promise<unknown>}).symbols.bind(service);
    const symbols=Array.from({length:1000},(_,index)=>({name:"missing",kind:13,location:{uri:"file://"+root+"/missing"+index+".py",range:{start:{line:0,character:0},end:{line:0,character:1}}}}));
    expect(await project(symbols)).toEqual([]);expect(read.mock.calls.length).toBeLessThanOrEqual(50);
  });
  it("retains a failed launch reservation until the host proves late-spawn cleanup",async()=>{
    const {service,host}=await nativeFixture();let settle!:()=>void;
    host.launch=async()=>{throw new Error("launch deadline");};
    const prove=vi.fn(()=>new Promise<void>(resolve=>{settle=resolve;}));
    (host as CloudLanguageHost & {settleLaunchFailure():Promise<void>}).settleLaunchFailure=prove;
    let completed=false;const request=service.request({kind:"start",language:"python"}).catch(()=>{completed=true;});
    for(let turn=0;turn<8;turn++)await Promise.resolve();
    const called=prove.mock.calls.length,early=completed;settle?.();await request;
    expect(called).toBe(1);expect(early).toBe(false);
  });
  it("bounds a stalled symbol-file probe and propagates cancellation to its owned helper",async()=>{
    const {service,host,root}=await nativeFixture();vi.useFakeTimers();let seen:AbortSignal|undefined;
    host.readDocument=(_file,signal?:AbortSignal)=>{seen=signal;return new Promise(()=>{});};
    const project=(service as unknown as {symbols(raw:unknown,file:string):Promise<unknown>}).symbols.bind(service);
    const projected=expect(project([{name:"x",kind:13,range:{start:{line:0,character:0},end:{line:0,character:1}}}],path.join(root,"x.py"))).rejects.toMatchObject({code:"timeout"});
    await vi.advanceTimersByTimeAsync(5001);expect(seen?.aborted).toBe(true);await projected;
  });

});
