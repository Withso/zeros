import {randomBytes} from "node:crypto";
import {createServer,type Server} from "node:http";
import {timingSafeEqual} from "node:crypto";
import type {Socket} from "node:net";
import {WebSocketServer,type WebSocket} from "ws";
import type {CloudProviderExecution} from "../../cloud-provider-execution";
import type {BoundaryProcess} from "../../containment/types";

const MAX_FRAME=4*1024*1024,MAX_BUFFER=8*1024*1024;
const HELPER="/opt/zeros/apps/desktop/src/engine/agents/containment/cloud-codex-executor.mjs";

/** Adapt the pinned native executor's JSONL stdio to its WebSocket protocol.
 * The capability URL stays in the private app-server; the workspace never
 * receives provider credentials, a listening socket, or an engine RPC API. */
export class CloudCodexExecServer {
  readonly environmentId=`zeros-${randomBytes(16).toString("hex")}`;
  private readonly capability=`/${randomBytes(32).toString("hex")}`;
  private readonly server:Server;
  private readonly sockets:WebSocketServer;
  private socket:WebSocket|null=null;
  private readonly connections=new Set<Socket>();
  private child:BoundaryProcess|null=null;
  private stopped=false;
  private buffer=Buffer.alloc(0);
  private closing:Promise<void>|null=null;
  private listening:Promise<void>|null=null;
  private constructor(private readonly execution:CloudProviderExecution){
    this.server=createServer({maxHeaderSize:8192},(_request,response)=>{response.writeHead(404);response.end();});
    this.server.maxConnections=8;
    this.server.on("connection",socket=>{
      this.connections.add(socket);socket.on("error",()=>socket.destroy());socket.once("close",()=>this.connections.delete(socket));
      if(this.stopped)socket.destroy();
    });
    this.server.headersTimeout=5000;this.server.requestTimeout=5000;this.server.keepAliveTimeout=1000;
    this.sockets=new WebSocketServer({noServer:true,maxPayload:MAX_FRAME,perMessageDeflate:false});
    this.server.on("upgrade",(request,socket,head)=>{
      const supplied=Buffer.from(request.url??""),expected=Buffer.from(this.capability);
      if(this.stopped||this.execution.lease.signal.aborted||this.socket||request.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        const deadline=setTimeout(()=>socket.destroy(),250);deadline.unref();socket.once("close",()=>clearTimeout(deadline));return;
      }
      this.sockets.handleUpgrade(request,socket,head,websocket=>this.connect(websocket));
    });
  }
  static async start(execution:CloudProviderExecution,binary:string):Promise<CloudCodexExecServer>{
    execution.lease.assertLive();
    if(!binary.startsWith("/opt/zeros/")||binary.endsWith(".js"))throw new Error("Cloud Codex requires the pinned native executable");
    const bridge=new CloudCodexExecServer(execution);execution.lease.attach(bridge);
    try{
      // Install the listening promise before yielding. Retirement must wait
      // for a pending bind before closing it, including an immediate child exit.
      execution.lease.assertLive();
      if(bridge.stopped)throw new Error("Cloud executor is retired");
      bridge.listening=new Promise<void>((resolve,reject)=>{
        bridge.server.once("error",reject);bridge.server.listen(0,"127.0.0.1",()=>{bridge.server.off("error",reject);resolve();});
      });
      await bridge.listening;
      execution.lease.assertLive();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        bridge.child=await Promise.race([execution.lease.launch(()=>execution.coordinator.workload.spawn({
          command:"/opt/zeros-runtime/bin/node",args:[HELPER,binary],cwd:"/srv/zeros/workspace",
          env:{HOME:"/srv/zeros/home/agent",PATH:"/opt/zeros-runtime/bin:/usr/bin:/bin",LANG:"C.UTF-8"},stdio:"pipe",
        })),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Cloud executor launch timed out")),5000);})]);
      }finally{if(timer)clearTimeout(timer);}
      execution.lease.assertLive();
      const child=bridge.child;if(!child.stdin||!child.stdout)throw new Error("Cloud executor pipes are unavailable");
      child.stdin.on("error",()=>bridge.fail());child.stdout.on("error",()=>bridge.fail());child.stderr?.resume();
      child.stdout.on("data",(bytes:Buffer)=>bridge.read(bytes));
      void child.wait().then(()=>bridge.fail(),()=>bridge.fail());
      // Observe an already exited executor before publishing its capability.
      await Promise.resolve();
      execution.lease.assertLive();return bridge;
    }catch(error){void execution.lease.close().catch(()=>{});throw error;}
  }
  get url():string{
    this.execution.lease.assertLive();const address=this.server.address();
    if(this.stopped||!address||typeof address==="string")throw new Error("Cloud executor is unavailable");
    return `ws://127.0.0.1:${address.port}${this.capability}`;
  }
  private fail(){if(!this.stopped)void this.execution.lease.close().catch(()=>{});}
  private connect(socket:WebSocket){
    this.socket=socket;
    socket.on("error",()=>this.fail());socket.on("close",()=>this.fail());
    socket.on("message",(raw,isBinary)=>{
      if(this.stopped||this.execution.lease.signal.aborted||isBinary||!this.child?.stdin?.writable){this.fail();return;}
      const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer);
      if(bytes.includes(10)||bytes.includes(13)||bytes.length>MAX_FRAME||this.child.stdin.writableLength>MAX_BUFFER){this.fail();return;}
      // Framing is pinned JSON, never an executable shell/string transport.
      try{const message=JSON.parse(bytes.toString("utf8"));if(!message||typeof message!=="object"||Array.isArray(message))throw new Error();}
      catch{this.fail();return;}
      if(!this.child.stdin.write(Buffer.concat([bytes,Buffer.from("\n")]))){
        socket.pause();this.child.stdin.once("drain",()=>{if(!this.stopped)socket.resume();});
      }
    });
  }
  private read(bytes:Buffer){
    if(this.stopped)return;
    if(this.buffer.length+bytes.length>MAX_BUFFER){this.fail();return;}
    this.buffer=Buffer.concat([this.buffer,bytes]);let newline:number;
    while((newline=this.buffer.indexOf(10))!==-1){
      const line=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);
      if(!line.length)continue;
      if(!this.socket||line.length>MAX_FRAME||this.socket.bufferedAmount>MAX_BUFFER){this.fail();return;}
      this.socket.send(line,{binary:false},error=>{if(error)this.fail();});
    }
    if(this.buffer.length>MAX_FRAME)this.fail();
  }
  stopAndProve():Promise<void>{
    if(this.closing)return this.closing;this.stopped=true;
    this.socket?.terminate();this.socket=null;this.buffer=Buffer.alloc(0);
    this.closing=Promise.resolve().then(async()=>{
      await this.listening?.catch(()=>{});
      for(const socket of this.connections)socket.destroy();
      this.sockets.close();this.server.closeAllConnections();
      await new Promise<void>(resolve=>this.server.close(()=>resolve()));
      if(this.child)await this.child.stopAndProve();
    }).catch(error=>{this.closing=null;throw error;});return this.closing;
  }
}
