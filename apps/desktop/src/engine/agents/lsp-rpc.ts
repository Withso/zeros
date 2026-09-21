import {isUtf8} from "node:buffer";
import type {BoundaryProcess} from "./containment/types";

const MAX_BODY=1024*1024,MAX_HEADER=1024,MAX_PENDING=8;
export class LspError extends Error {
  constructor(readonly code:"unavailable"|"capacity"|"timeout"|"output_limit"|"invalid_input"|"denied"|"conflict"="unavailable"){
    super("Workspace language service failed");
  }
}

/** LSP uses byte-counted Content-Length frames, not the Codex NDJSON wire.
 * Headers, bodies, pending calls and sustained traffic have independent bounds. */
export class LspRpc {
  private buffer:Buffer=Buffer.alloc(0);
  private bodyLength:number|null=null;
  private nextId=0;
  private closed=false;
  private windowStart=performance.now();
  private windowBytes=0;
  private windowFrames=0;
  private readonly pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void;cleanup():void}>();
  constructor(private readonly child:BoundaryProcess,private readonly failed:()=>void,
    private readonly configuration:Record<string,unknown>={}){
    child.stdin?.on("error",()=>this.fail());
    child.stdout?.on("error",()=>this.fail());
    child.stdout?.on("data",chunk=>this.consume(Buffer.from(chunk)));
    child.stderr?.on("data",chunk=>this.account(Buffer.byteLength(chunk)));
    child.stderr?.on("error",()=>this.fail());
    void child.wait().then(()=>this.fail(),()=>this.fail());
  }
  private account(bytes:number):boolean{
    if(this.closed)return false;
    if(performance.now()-this.windowStart>=1000){this.windowStart=performance.now();this.windowBytes=0;this.windowFrames=0;}
    this.windowBytes+=bytes;
    if(this.windowBytes>4*MAX_BODY){this.fail("output_limit");return false;}return true;
  }
  private consume(chunk:Buffer){
    if(!this.account(chunk.length))return;
    // A chunk can contain multiple full frames. Process incrementally without
    // ever retaining an arbitrary producer-sized concatenation.
    let cursor=0;
    while(cursor<chunk.length&&!this.closed){
      const budget=this.bodyLength===null?MAX_HEADER+4:Math.max(1,this.bodyLength);
      const length=Math.min(chunk.length-cursor,budget-this.buffer.length);
      if(length<=0){this.fail("output_limit");return;}
      this.buffer=Buffer.concat([this.buffer,chunk.subarray(cursor,cursor+length)]);cursor+=length;
      for(;;){
        if(this.bodyLength===null){
          const end=this.buffer.indexOf("\r\n\r\n");
          if(end<0){if(this.buffer.length>MAX_HEADER)this.fail("output_limit");break;}
          const header=this.buffer.subarray(0,end).toString("ascii");
          const lines=header.split("\r\n"),lengths=lines.filter(line=>/^Content-Length:/i.test(line));
          if(lengths.length!==1||!/^Content-Length: [1-9][0-9]{0,6}$/i.test(lengths[0]!)||
              lines.some(line=>!/^Content-(?:Length|Type): [\x20-\x7e]+$/i.test(line))){this.fail();return;}
          this.bodyLength=Number(lengths[0]!.slice(lengths[0]!.indexOf(":")+1));
          if(this.bodyLength>MAX_BODY){this.fail("output_limit");return;}
          this.buffer=this.buffer.subarray(end+4);
        }
        if(this.buffer.length<this.bodyLength!)break;
        const bytes=this.buffer.subarray(0,this.bodyLength!);this.buffer=this.buffer.subarray(this.bodyLength!);this.bodyLength=null;
        if(!isUtf8(bytes)||++this.windowFrames>2000){this.fail("output_limit");return;}
        try{this.receive(JSON.parse(bytes.toString("utf8")));}catch{this.fail();return;}
        if(this.closed||!this.buffer.length)break;
      }
    }
  }
  private receive(value:unknown){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new LspError();
    const message=value as Record<string,unknown>;
    if(message.jsonrpc!=="2.0")throw new LspError();
    if(typeof message.method==="string"){
      if(message.id!==undefined){
        if(!(typeof message.id==="string"&&message.id.length<=128)&&!Number.isSafeInteger(message.id))throw new LspError();
        // Servers receive only static configuration. They can never apply an
        // edit, run a command, watch arbitrary paths or prompt a human here.
        if(message.method==="workspace/configuration"){
          const items=(message.params as {items?:unknown[]})?.items;
          if(!Array.isArray(items)||items.length>32)throw new LspError();
          this.send({jsonrpc:"2.0",id:message.id,result:items.map(item=>{
            const section=(item as {section?:string})?.section;
            return typeof section==="string"&&Object.hasOwn(this.configuration,section)?this.configuration[section]??null:null;
          })});
        }else this.send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Unsupported request"}});
      }
      return; // Diagnostics and log messages stay private and are discarded.
    }
    if(!Number.isSafeInteger(message.id)||typeof message.id!=="number")throw new LspError();
    const entry=this.pending.get(message.id);if(!entry)return;
    if(!("result" in message)&&message.error===undefined)throw new LspError();
    this.pending.delete(message.id);entry.cleanup();
    if(message.error!==undefined)entry.reject(new LspError());else entry.resolve(message.result);
  }
  private send(message:unknown){
    if(this.closed||!this.child.stdin?.writable)throw new LspError();
    const body=Buffer.from(JSON.stringify(message));if(body.length>MAX_BODY)throw new LspError("output_limit");
    if(this.child.stdin.writableLength>MAX_BODY){this.fail("output_limit");throw new LspError("output_limit");}
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]),error=>{if(error)this.fail();});
  }
  notify(method:string,params:unknown){this.send({jsonrpc:"2.0",method,params});}
  request(method:string,params:unknown,signal?:AbortSignal,timeoutMs=10_000):Promise<unknown>{
    if(this.closed||signal?.aborted)return Promise.reject(new LspError());
    if(this.pending.size>=MAX_PENDING)return Promise.reject(new LspError("capacity"));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const cancel=(code:"timeout"|"unavailable")=>{
        const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);entry.cleanup();entry.reject(new LspError(code));
        try{this.notify("$/cancelRequest",{id});}catch{/* Retirement owns a broken transport. */}
      };
      const abort=()=>cancel("unavailable");
      const timer=setTimeout(()=>{cancel("timeout");this.fail();},timeoutMs);timer.unref?.();
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);};
      this.pending.set(id,{resolve,reject,cleanup});signal?.addEventListener("abort",abort,{once:true});
      try{this.send({jsonrpc:"2.0",id,method,params});}catch{this.fail();}
    });
  }
  private fail(code:"unavailable"|"output_limit"="unavailable"){
    if(this.closed)return;this.closed=true;this.buffer=Buffer.alloc(0);
    for(const entry of this.pending.values()){entry.cleanup();entry.reject(new LspError(code));}this.pending.clear();this.failed();
  }
  close(){this.fail();}
}
