import type {ChildProcess} from "node:child_process";
import {constants} from "node:fs";
import {lstat,open,rm} from "node:fs/promises";
import type {BoundaryProcess,BoundaryProcessExit} from "./types";
const PROOF="zeros-process-domain-reaped-v1\n";

/** The private receipt comes from the immutable outer subreaper, after ECHILD.
 * Killing the reaper itself can never produce a successful retirement proof. */
export class CloudSupervisedProcess implements BoundaryProcess {
  readonly requiresOwnedSignals=true;
  readonly pid:number;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  private readonly exited:Promise<BoundaryProcessExit>;
  private proven=false;
  private stopping:Promise<void>|null=null;
  constructor(readonly child:ChildProcess,private readonly receipt:string,private readonly onFailure:()=>void=()=>{}){
    if(!child.pid)throw new Error("Private process did not start");
    this.pid=child.pid;this.stdin=child.stdin;this.stdout=child.stdout;this.stderr=child.stderr;
    child.on("error",()=>{});
    this.exited=new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)resolve({code:child.exitCode,signal:child.signalCode});
      else child.once("exit",(code,signal)=>resolve({code,signal}));
    });
  }
  wait(){return this.exited;}
  async signal(_signal:NodeJS.Signals):Promise<void>{
    const deadline=performance.now()+4000;
    while(this.child.exitCode===null&&this.child.signalCode===null){
      try{await lstat(this.receipt);break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(performance.now()>=deadline)throw new Error("Private process did not become ready for retirement");
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill("SIGTERM");
  }
  stopAndProve():Promise<void>{
    if(this.proven)return Promise.resolve();if(this.stopping)return this.stopping;
    const operation=(async()=>{
      await this.signal("SIGTERM");let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([this.exited,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("Private process retirement is incomplete")),4000);timer.unref?.();
      })]);}finally{if(timer)clearTimeout(timer);}
      const handle=await open(this.receipt,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await handle.stat();
        if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0||stat.size!==Buffer.byteLength(PROOF))
          throw new Error("Private process retirement is unproven");
        const bytes=Buffer.alloc(Buffer.byteLength(PROOF)+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
        if(bytesRead!==Buffer.byteLength(PROOF)||bytes.subarray(0,bytesRead).toString()!==PROOF)
          throw new Error("Private process retirement is unproven");
      }finally{await handle.close();}
      await rm(this.receipt);this.proven=true;
    })();this.stopping=operation;
    void operation.catch(()=>this.onFailure());
    void operation.finally(()=>{if(this.stopping===operation)this.stopping=null;}).catch(()=>{});return operation;
  }
}
