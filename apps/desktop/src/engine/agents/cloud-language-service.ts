import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {CloudLspRequestSchema,type CloudLspLanguage} from "@zeros/protocol/cloud-lsp";
import type {BoundaryProcess} from "./containment/types";
import {LspError,LspRpc} from "./lsp-rpc";

export type LspDocument={text:string;sha256:string};
export type CloudLanguageHost={
  root:string;
  assertLive():void;
  launch(command:string,args:string[]):Promise<BoundaryProcess>;
  retire(process:BoundaryProcess):Promise<void>;
  readDocument(file:string,signal?:AbortSignal):Promise<LspDocument>;
  /** A rejected launch may still own a child arriving after its deadline. */
  settleLaunchFailure?():Promise<void>;
  failed():void;
};
type Server={process:BoundaryProcess;rpc:LspRpc;documents:Map<string,{sha256:string;version:number}>;version:number;touched:number};
// Across every human connection and agent execution in this engine. Capacity
// is returned only after proven descendant retirement, including late spawns.
let reservedServers=0;
const MAX_SERVERS=4,MAX_DOCUMENTS=32;
const SERVERS={typescript:"/opt/zeros/node_modules/typescript-language-server/lib/cli.mjs",python:"/opt/zeros/node_modules/pyright/langserver.index.js"};
const position=(value:unknown):value is {line:number;character:number}=>{
  if(!value||typeof value!=="object")return false;const p=value as Record<string,unknown>;
  return Number.isSafeInteger(p.line)&&Number.isSafeInteger(p.character)&&Number(p.line)>=0&&Number(p.character)>=0&&Number(p.line)<=1_000_000&&Number(p.character)<=1_000_000;
};
const range=(value:unknown)=>{
  if(!value||typeof value!=="object")return null;const r=value as Record<string,unknown>;
  return position(r.start)&&position(r.end)&&
    (r.start.line<r.end.line||(r.start.line===r.end.line&&r.start.character<=r.end.character))
    ?{start:{line:r.start.line,character:r.start.character},end:{line:r.end.line,character:r.end.character}}:null;
};
// Reject terminal control sequences while preserving ordinary Unicode labels.
// eslint-disable-next-line no-control-regex
function label(value:unknown,limit=1024){return typeof value==="string"&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)?value.slice(0,limit):null;}

/** Each connection/execution owns its document handles. No actor can close
 * another actor's server. All supported methods are disk-backed and typed. */
export class CloudLanguageService {
  private readonly servers=new Map<string,Promise<Server>>();
  private queue:Promise<unknown>=Promise.resolve();
  private queued=0;
  private closed=false;
  private retirementFailed=false;
  private closing:Promise<void>|null=null;
  private readonly timer:ReturnType<typeof setInterval>;
  constructor(private readonly host:CloudLanguageHost){
    if(!path.isAbsolute(host.root)||path.resolve(host.root)!==host.root)throw new LspError("denied");
    this.timer=setInterval(()=>{
      try{this.assertLive();}catch{void this.stopAndProve().catch(()=>host.failed());return;}
      for(const [key,pending]of this.servers)void pending.then(server=>{
        if(!this.queued&&Date.now()-server.touched>30_000)void this.stop(key).catch(()=>host.failed());
      },()=>{});
    },1000);this.timer.unref?.();
  }
  private assertLive(){if(this.closed)throw new LspError();this.host.assertLive();}
  private file(input:string){
    const file=path.resolve(this.host.root,input),relative=path.relative(this.host.root,file);
    if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||
        relative.split(path.sep).some(part=>part===".git"||part===".zeros"||part===".env"||part.startsWith(".env.")))throw new LspError("denied");
    return file;
  }
  async request(raw:unknown,signal?:AbortSignal):Promise<unknown>{
    const parsed=CloudLspRequestSchema.safeParse(raw);if(!parsed.success)throw new LspError("invalid_input");
    this.assertLive();if(signal?.aborted)throw new LspError();
    if(this.queued>=8)throw new LspError("capacity");this.queued++;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      this.assertLive();if(signal?.aborted)throw new LspError();
      const request=parsed.data,key=request.language==="python"?"python":"typescript";
      if("path" in request)this.file(request.path);
      if(request.kind==="stop"){await this.stop(key);return {state:"stopped"};}
      // Close never starts a server, and only touches this caller's handles.
      if(request.kind==="close"){
        const pending=this.servers.get(key);if(!pending)return {state:"closed"};
        const server=await pending,uri=pathToFileURL(this.file(request.path)).href;
        if(server.documents.delete(uri))server.rpc.notify("textDocument/didClose",{textDocument:{uri}});
        return {state:"closed"};
      }
      const server=await this.server(key);this.assertLive();
      server.touched=Date.now();
      if(request.kind==="start")return {state:"running",language:request.language,diskOnly:true};
      if(request.kind==="workspaceSymbols"){
        // Refresh every open document before a workspace query, so normal file
        // writes do not leave retained overlays stale indefinitely.
        for(const uri of server.documents.keys())await this.sync(server,fileURLToPath(uri),request.language,signal);
        const raw=await server.rpc.request("workspace/symbol",{query:request.query},signal);
        const result=await this.symbols(raw,undefined,signal);this.assertLive();if(signal?.aborted)throw new LspError();
        return {symbols:result,consistency:"disk_best_effort",limit:500};
      }
      const file=this.file(request.path),document=await this.sync(server,file,request.language,signal),uri=pathToFileURL(file).href;
      if(request.kind==="open")return {state:"open",sha256:document.sha256,version:server.documents.get(uri)!.version};
      if(request.kind==="completions"){
        const lines=document.text.split(/\r?\n/),line=lines[request.position.line];
        if(line===undefined||request.position.character>line.length)throw new LspError("invalid_input");
      }
      const result=await server.rpc.request(request.kind==="documentSymbols"?"textDocument/documentSymbol":"textDocument/completion",
        {textDocument:{uri},...(request.kind==="completions"?{position:request.position}:{})},signal);
      const output=request.kind==="documentSymbols"?await this.symbols(result,file,signal):this.completions(result);
      // Results carry an exact document digest; refuse a disk edit racing the
      // query instead of presenting stale positions as current authority.
      if((await this.readDocument(file,signal)).sha256!==document.sha256)throw new LspError("conflict");
      this.assertLive();if(signal?.aborted)throw new LspError();
      return {...(request.kind==="documentSymbols"?{symbols:output}:{completions:output}),sha256:document.sha256,limit:500};
    });
    this.queue=operation;
    try{return await this.bounded(operation,30_000,signal);}
    catch(error){
      if(signal?.aborted||(error instanceof LspError&&error.code==="timeout"))void this.stopAndProve().catch(()=>this.host.failed());
      throw error;
    }finally{this.queued--;}
  }
  private async bounded<T>(operation:Promise<T>,timeoutMs:number,signal?:AbortSignal):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
    try{return await Promise.race([operation,new Promise<never>((_,reject)=>{
      abort=()=>reject(new LspError());signal?.addEventListener("abort",abort,{once:true});
      timer=setTimeout(()=>reject(new LspError("timeout")),Math.max(0,timeoutMs));timer.unref?.();if(signal?.aborted)abort();
    })]);}finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);}
  }
  private async readDocument(file:string,signal?:AbortSignal,timeoutMs=5000){
    const abort=new AbortController(),combined=signal?AbortSignal.any([abort.signal,signal]):abort.signal;
    try{return await this.bounded(this.host.readDocument(file,combined),timeoutMs,combined);}finally{abort.abort();}
  }
  private async sync(server:Server,file:string,language:CloudLspLanguage,signal?:AbortSignal):Promise<LspDocument>{
    this.assertLive();const document=await this.readDocument(file,signal);this.assertLive();
    if(Buffer.byteLength(document.text)>65536||!/^[a-f0-9]{64}$/.test(document.sha256))throw new LspError("output_limit");
    const uri=pathToFileURL(file).href,previous=server.documents.get(uri);
    if(!previous&&server.documents.size>=MAX_DOCUMENTS)throw new LspError("capacity");
    if(!previous||previous.sha256!==document.sha256){
      const version=++server.version;
      if(previous)server.rpc.notify("textDocument/didChange",{textDocument:{uri,version},contentChanges:[{text:document.text}]});
      else server.rpc.notify("textDocument/didOpen",{textDocument:{uri,languageId:language,version,text:document.text}});
      server.documents.set(uri,{version,sha256:document.sha256});
    }return document;
  }
  private async server(key:"typescript"|"python"):Promise<Server>{
    this.assertLive();
    const existing=this.servers.get(key);
    if(existing){
      const server=await existing,retiring=this.stopping.get(server);
      if(retiring){
        await retiring;this.assertLive();
        return this.server(key);
      }
      this.assertLive();return server;
    }
    if(reservedServers>=MAX_SERVERS)throw new LspError("capacity");reservedServers++;
    let child:BoundaryProcess|undefined;
    const pending=(async()=>{
      try{
        child=await this.host.launch("/opt/zeros-runtime/bin/node",["--max-old-space-size=256",SERVERS[key],"--stdio",...(key==="typescript"?["--log-level","1"]:[])]);
        this.assertLive();
        const rpc=new LspRpc(child,()=>{void this.stop(key).catch(()=>this.host.failed());},{
          python:{pythonPath:"/usr/bin/python3",analysis:{diagnosticMode:"openFiles",autoSearchPaths:false,useLibraryCodeForTypes:false}},
          "python.analysis":{diagnosticMode:"openFiles",autoSearchPaths:false,useLibraryCodeForTypes:false},
        });
        const server:Server={process:child,rpc,documents:new Map(),version:0,touched:Date.now()};
        await rpc.request("initialize",{processId:null,rootUri:pathToFileURL(this.host.root).href,
          workspaceFolders:[{uri:pathToFileURL(this.host.root).href,name:"workspace"}],
          capabilities:{general:{positionEncodings:["utf-16"]},workspace:{configuration:true,applyEdit:false},textDocument:{completion:{completionItem:{snippetSupport:false}}}},
          initializationOptions:key==="typescript"?{disableAutomaticTypingAcquisition:true,maxTsServerMemory:256,
            tsserver:{path:"/opt/zeros/node_modules/typescript/lib/tsserver.js"},plugins:[]}:undefined},undefined,15_000);
        this.assertLive();rpc.notify("initialized",{});return server;
      }catch{
        if(child){try{await this.host.retire(child);reservedServers--;}catch{this.retirementFailed=true;this.host.failed();}}
        else{
          try{await this.host.settleLaunchFailure?.();reservedServers--;}
          catch{this.retirementFailed=true;this.host.failed();}
        }
        throw new LspError();
      }
    })();
    this.servers.set(key,pending);
    void pending.catch(()=>{if(this.servers.get(key)===pending)this.servers.delete(key);});
    return pending;
  }
  private async stop(key:string){
    const pending=this.servers.get(key);if(!pending)return;
    let server:Server;try{server=await pending;}catch{return;}
    // A single retirement promise owns capacity even when timeout, Stop and
    // shutdown race. Keep the map entry until proof is available.
    if(this.stopping.has(server))return this.stopping.get(server)!;
    const stopping=(async()=>{
      server.rpc.close();await this.host.retire(server.process);
      if(this.servers.get(key)===pending)this.servers.delete(key);reservedServers--;
    })();this.stopping.set(server,stopping);return stopping;
  }
  private readonly stopping=new WeakMap<Server,Promise<void>>();
  stopAndProve():Promise<void>{
    this.closed=true;clearInterval(this.timer);if(this.closing)return this.closing;
    const pending=(async()=>{
      try{
        const results=await this.bounded(Promise.allSettled([...this.servers.keys()].map(key=>this.stop(key))),5000);
        if(this.retirementFailed||results.some(result=>result.status==="rejected"))throw new LspError();
      }catch{this.retirementFailed=true;this.host.failed();throw new LspError();}
    })();
    this.closing=pending;return pending;
  }
  private completions(raw:unknown){
    const list=Array.isArray(raw)?raw:raw&&typeof raw==="object"?(raw as {items?:unknown}).items:[];
    if(!Array.isArray(list))return [];
    return list.slice(0,500).flatMap(value=>{
      if(!value||typeof value!=="object")return [];const item=value as Record<string,unknown>,name=label(item.label);
      if(name===null)return [];const insert=label(item.insertText,16384),detail=label(item.detail,2048);
      return [{label:name,...(Number.isSafeInteger(item.kind)&&Number(item.kind)>=1&&Number(item.kind)<=25?{kind:item.kind}:{}),
        ...(detail!==null?{detail}:{}),...(insert!==null&&item.insertTextFormat!==2?{insertText:insert}:{})}];
    });
  }
  private async symbols(raw:unknown,currentFile?:string,signal?:AbortSignal){
    if(!Array.isArray(raw))return [];
    const result:unknown[]=[],verified=new Set<string>(),attempted=new Set<string>();
    let visited=0;const deadline=performance.now()+5000;
    const visit=async(values:unknown[],depth:number)=>{
      if(depth>8)return;
      for(const value of values){
        this.assertLive();if(signal?.aborted)throw new LspError();if(performance.now()>=deadline)throw new LspError("timeout");
        if(result.length>=500||++visited>2000)return;if(!value||typeof value!=="object")continue;
        const symbol=value as Record<string,unknown>,name=label(symbol.name);
        if(name===null||!Number.isSafeInteger(symbol.kind)||Number(symbol.kind)<1||Number(symbol.kind)>26)continue;
        let file=currentFile,location=symbol.range;
        if(symbol.location&&typeof symbol.location==="object"){
          const loc=symbol.location as Record<string,unknown>;
          try{if(typeof loc.uri!=="string"||!loc.uri.startsWith("file:///"))continue;file=this.file(fileURLToPath(loc.uri));location=loc.range;}catch{continue;}
        }
        const bounds=range(location);if(!file||!bounds)continue;
        if(!verified.has(file)){
          if(attempted.has(file)||attempted.size>=50)continue;attempted.add(file);
          try{await this.readDocument(file,signal,Math.max(0,deadline-performance.now()));}
          catch(error){if(signal?.aborted||error instanceof LspError&&error.code==="timeout")throw error;continue;}verified.add(file);
        }
        result.push({name,kind:symbol.kind,path:path.relative(this.host.root,file),range:bounds});
        if(Array.isArray(symbol.children))await visit(symbol.children,depth+1);
      }
    };
    await visit(raw,0);return result;
  }
}
