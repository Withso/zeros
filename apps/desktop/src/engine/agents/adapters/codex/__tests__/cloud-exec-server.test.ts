import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {once} from "node:events";
import {Server} from "node:http";
import {connect,type Socket} from "node:net";
import {PassThrough} from "node:stream";
import {WebSocket} from "ws";
import {describe,expect,it,vi} from "vitest";
import {resolveCodexBinary} from "../binary-resolver";
import {CloudCodexExecServer} from "../cloud-exec-server";
import {CLOUD_CODEX_CONFIG} from "../cloud-policy";
import {codexAppServerFeatureArgs} from "../app-server";
import {createInterface} from "node:readline";
import type {CloudProviderExecution} from "../../../cloud-provider-execution";
import type {BoundaryProcess} from "../../../containment/types";

describe.skipIf(process.platform!=="linux")("cloud native executor wire (no model or credential)",()=>{
  it("initializes the real app-server with the complete cloud configuration in an empty private HOME",async()=>{
    const binary=await resolveCodexBinary({}),root=await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-codex-config-"));
    await mkdir(path.join(root,".codex"));
    const child=spawn(path.join(binary.sandboxRuntimeRoot!,"bin","codex"),["app-server",...codexAppServerFeatureArgs(true),
      ...Object.entries(CLOUD_CODEX_CONFIG).flatMap(([name,value])=>["-c",`${name}=${JSON.stringify(value)}`])],
      {cwd:root,env:{PATH:"/usr/bin:/bin",HOME:root,CODEX_HOME:path.join(root,".codex"),LANG:"C.UTF-8"},stdio:["pipe","pipe","pipe"]});
    const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    child.stdin.on("error",()=>{});let stderr="";child.stderr.on("data",bytes=>{stderr=(stderr+String(bytes)).slice(-4096);});
    const lines=createInterface({input:child.stdout});let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const response=Promise.race([once(lines,"line").then(([line])=>JSON.parse(String(line))),exited.then(()=>{throw new Error(`Pinned app-server configuration rejected: ${stderr}`);}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Pinned app-server initialize timed out")),5000);})]);
      child.stdin.write(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"qualification",version:"1"},capabilities:{experimentalApi:true}}})+"\n");
      expect(await response).toMatchObject({id:1,result:{codexHome:path.join(root,".codex")}});
    }finally{if(timer)clearTimeout(timer);lines.close();child.kill("SIGKILL");await exited;await rm(root,{recursive:true,force:true});}
  });
  it("does not leave a bridge listening when the executor exits during startup",async()=>{
    const listeners=vi.spyOn(Server.prototype,"listen");
    const abort=new AbortController(),domains=new Set<{stopAndProve():Promise<void>}>();let closing:Promise<void>|undefined;
    const close=()=>{abort.abort();return closing??=Promise.resolve().then(()=>Promise.all([...domains].map(domain=>domain.stopAndProve()))).then(()=>{});};
    const child={stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),wait:()=>Promise.resolve({code:1,signal:null}),stopAndProve:async()=>{}} as unknown as BoundaryProcess;
    const execution={lease:{assertLive(){if(abort.signal.aborted)throw new Error("retired");},signal:abort.signal,attach:(domain:{stopAndProve():Promise<void>})=>domains.add(domain),launch:async()=>child,close},coordinator:{workload:{spawn:vi.fn()}}} as unknown as CloudProviderExecution;
    try {
      await expect(CloudCodexExecServer.start(execution,"/opt/zeros/pinned/bin/codex")).rejects.toThrow("retired");
      await close();
      for(const server of listeners.mock.instances as Server[]) expect(server.listening).toBe(false);
    } finally {for(const server of listeners.mock.instances as Server[]) server.close();listeners.mockRestore();}
  });
  it("authenticates its private bridge and exchanges actual pinned executor frames over stdio",async()=>{
    const binary=await resolveCodexBinary({});expect(binary.source).toBe("bundled");
    expect(binary.sandboxRuntimeRoot).toBeTruthy();
    const nativeBinary=path.join(binary.sandboxRuntimeRoot!,"bin","codex");
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-executor-wire-"));await mkdir(path.join(root,".codex"));
    const abort=new AbortController(),domains=new Set<{stopAndProve():Promise<void>}>();let closing:Promise<void>|undefined;
    const close=vi.fn(()=>{
      abort.abort();return closing??=(async()=>{await Promise.all([...domains].map(domain=>domain.stopAndProve()));})();
    });
    const workloadSpawn=vi.fn(async()=>{
      const child=spawn(nativeBinary,["exec-server","--listen","stdio"],{cwd:root,env:{PATH:"/usr/bin:/bin",HOME:root,CODEX_HOME:path.join(root,".codex"),LANG:"C.UTF-8"},stdio:["pipe","pipe","pipe"]});
      const exited=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
      let stopped:Promise<void>|undefined;
      const domain:BoundaryProcess={pid:child.pid!,child,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,
        wait:()=>exited,signal:async signal=>{child.kill(signal);},stopAndProve:()=>stopped??=(async()=>{child.stdin.end();child.kill("SIGTERM");const timer=setTimeout(()=>child.kill("SIGKILL"),250);try{await exited;}finally{clearTimeout(timer);}})()};
      domains.add(domain);return domain;
    });
    const execution={lease:{assertLive(){if(abort.signal.aborted)throw new Error("retired");},signal:abort.signal,attach:(domain:{stopAndProve():Promise<void>})=>domains.add(domain),
      launch:async(callback:()=>Promise<BoundaryProcess>)=>callback(),close},coordinator:{workload:{spawn:workloadSpawn}}} as unknown as CloudProviderExecution;
    let socket:WebSocket|undefined,uncooperative:Socket|undefined,proofTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      const bridge=await CloudCodexExecServer.start(execution,"/opt/zeros/pinned/bin/codex");
      uncooperative=connect({host:"127.0.0.1",port:Number(new URL(bridge.url).port),allowHalfOpen:true});uncooperative.on("error",()=>{});
      await once(uncooperative,"connect");const rejection=once(uncooperative,"data");
      uncooperative.write("GET /wrong HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      expect(String((await rejection)[0])).toContain("403 Forbidden");
      expect(workloadSpawn.mock.calls[0]).toBeDefined();
      const denied=new WebSocket(bridge.url+"invalid");
      await new Promise<void>((resolve,reject)=>{denied.once("unexpected-response",(_request,response)=>{expect(response.statusCode).toBe(403);response.resume();denied.terminate();resolve();});denied.once("error",()=>{});denied.once("open",()=>reject(new Error("unauthorized connection accepted")));});
      socket=new WebSocket(bridge.url);await once(socket,"open");
      const initialize=once(socket,"message");socket.send(JSON.stringify({id:1,method:"initialize",params:{clientName:"qualification",resumeSessionId:null}}));
      const initialized=JSON.parse(String((await initialize)[0]));
      expect(initialized).toMatchObject({id:1,result:{environmentInfo:{executorVersion:"0.154.0",cwd:`file://${root}`}}});
      socket.send(JSON.stringify({method:"initialized",params:{}}));
      const info=once(socket,"message");socket.send(JSON.stringify({id:2,method:"environment/info",params:null}));
      expect(JSON.parse(String((await info)[0]))).toMatchObject({id:2,result:{cwd:`file://${root}`}});
      const badFrame=once(socket,"close");socket.send('{}\n{}');await badFrame;
      await Promise.race([close(),new Promise<never>((_,reject)=>{proofTimer=setTimeout(()=>reject(new Error("Uncooperative rejected peer prevented bridge retirement")),1000);})]);expect(abort.signal.aborted).toBe(true);
      expect(()=>bridge.url).toThrow("retired");
    }finally{if(proofTimer)clearTimeout(proofTimer);uncooperative?.destroy();socket?.terminate();await close();await rm(root,{recursive:true,force:true});}
  },20000);
});
