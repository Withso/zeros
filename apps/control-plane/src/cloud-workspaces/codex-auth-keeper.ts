import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {constants} from "node:fs";
import {lstat,mkdtemp,open,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import os from "node:os";
import path from "node:path";
import {CODEX_AUTH_RUNTIME_VERSION,parseCodexNativeCache,type CodexNativeAuthCache} from "./codex-auth-cache.js";

const require=createRequire(import.meta.url);
let active=0;
function unavailable(){return new Error("Codex authentication renewal is unavailable");}
export type CodexAuthRenewer=(cache:CodexNativeAuthCache,dispatch:()=>Promise<void>)=>Promise<CodexNativeAuthCache>;

async function binary(){
  if(process.platform!=="linux"||!["x64","arm64"].includes(process.arch))throw unavailable();
  const manifest=require.resolve("@openai/codex/package.json"),main=JSON.parse(await readFile(manifest,"utf8")) as {version?:unknown};
  if(main.version!==CODEX_AUTH_RUNTIME_VERSION)throw unavailable();
  const platformRequire=createRequire(manifest),platform=platformRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`);
  const target=process.arch==="x64"?"x86_64-unknown-linux-musl":"aarch64-unknown-linux-musl";
  const executable=path.join(path.dirname(platform),"vendor",target,"bin","codex"),stat=await lstat(executable);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)!==0)throw unavailable();return executable;
}

class AuthRpc {
  private pending:Buffer=Buffer.alloc(0);
  private total=0;
  private id=0;
  private failed=false;
  private readonly requests=new Map<number,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private readonly child:ChildProcessWithoutNullStreams){
    child.stdin.on("error",()=>this.fail());child.stdout.on("error",()=>this.fail());child.stderr.on("error",()=>this.fail());
    child.once("error",()=>this.fail());child.once("exit",()=>this.fail());
    child.stderr.on("data",chunk=>{this.total+=chunk.length;if(this.total>1024*1024)this.fail();});
    child.stdout.on("data",chunk=>{
      this.total+=chunk.length;if(this.failed||this.total>1024*1024){this.fail();return;}
      this.pending=Buffer.concat([this.pending,chunk]);if(this.pending.length>131072){this.fail();return;}
      for(;;){const end=this.pending.indexOf(10);if(end<0)break;const line=this.pending.subarray(0,end);this.pending=this.pending.subarray(end+1);
        try{
          const value:unknown=JSON.parse(line.toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw unavailable();
          const response=value as Record<string,unknown>;
          // Auth-only keepers have no host capabilities. An unexpected
          // server request is a protocol failure, never a forwarded tool call.
          if("method" in response){if("id" in response)throw unavailable();continue;}
          if(typeof response.id!=="number")throw unavailable();const entry=this.requests.get(response.id);if(!entry)continue;
          if(!("result" in response)||"error" in response)throw unavailable();
          clearTimeout(entry.timer);this.requests.delete(response.id);entry.resolve(response.result);
        }catch{this.fail();return;}
      }
    });
  }
  request(method:"initialize"|"account/read",params:unknown){
    if(this.failed||this.requests.size>=2)return Promise.reject(unavailable());
    const id=++this.id;return new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(),method==="initialize"?1500:4500);timer.unref();this.requests.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n",error=>{if(error)this.fail();});
    });
  }
  initialized(){if(this.failed)throw unavailable();this.child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');}
  close(){this.fail();}
  private fail(){if(this.failed)return;this.failed=true;this.pending=Buffer.alloc(0);
    for(const entry of this.requests.values()){clearTimeout(entry.timer);entry.reject(unavailable());}this.requests.clear();}
}

async function retire(child:ChildProcessWithoutNullStreams){
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>((resolve,reject)=>{
    const finish=()=>{clearTimeout(kill);clearTimeout(deadline);resolve();};
    const signal=(value:NodeJS.Signals)=>{try{process.kill(-child.pid!,value);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")reject(unavailable());}};
    const kill=setTimeout(()=>signal("SIGKILL"),500),deadline=setTimeout(()=>reject(unavailable()),1500);kill.unref();deadline.unref();
    child.once("close",finish);signal("SIGTERM");
  });
}

/** A short-lived trusted auth-only process. No repository, caller config,
 * proxy/endpoint overrides, tools or model RPCs can enter this environment. */
export const renewCodexNativeAuth:CodexAuthRenewer=async(cache,dispatch)=>{
  if(active>=2)throw unavailable();active++;
  let directory:string|undefined,child:ChildProcessWithoutNullStreams|undefined,rpc:AuthRpc|undefined;
  let stopped=false;
  try{
    const original=parseCodexNativeCache(cache),executable=await binary();
    directory=await mkdtemp(path.join(os.tmpdir(),"zeros-codex-auth-"));
    await writeFile(path.join(directory,"auth.json"),JSON.stringify(original.cache),{mode:0o600,flag:"wx"});
    // Persist dispatch BEFORE native startup: even initialize/load may change
    // native authentication behavior in a future qualified CLI version.
    await dispatch();
    child=spawn(executable,["-c",'cli_auth_credentials_store="file"',"-c",'forced_login_method="chatgpt"',"app-server"],{
      cwd:directory,env:{PATH:"/usr/bin:/bin",HOME:directory,CODEX_HOME:directory,XDG_CONFIG_HOME:directory,XDG_CACHE_HOME:directory,LANG:"C.UTF-8",RUST_LOG:"off"},
      detached:true,stdio:["pipe","pipe","pipe"]});
    // spawn failures emit error asynchronously even when no PID was created.
    // Install handlers before testing the return value.
    rpc=new AuthRpc(child);if(!child.pid)throw unavailable();
    try{
      await rpc.request("initialize",{clientInfo:{name:"zeros_auth_keeper",version:"1"},capabilities:{experimentalApi:false}});rpc.initialized();
      await rpc.request("account/read",{refreshToken:true});
    }catch{/* A durable native cache can survive an RPC failure; inspect only after retirement. */}
    await retire(child);stopped=true;rpc.close();
    const handle=await open(path.join(directory,"auth.json"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let updated;
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0||stat.size>65536)throw unavailable();
      const bytes=Buffer.alloc(65537),read=await handle.read(bytes,0,bytes.length,0);if(read.bytesRead>65536)throw unavailable();
      updated=parseCodexNativeCache(JSON.parse(bytes.subarray(0,read.bytesRead).toString("utf8")));bytes.fill(0);
    }finally{await handle.close();}
    if(!updated.bindingSha256.equals(original.bindingSha256)||JSON.stringify(updated.cache)===JSON.stringify(original.cache))throw unavailable();
    return updated.cache;
  }catch{throw unavailable();}
  finally{
    rpc?.close();
    try{if(child&&!stopped)await retire(child);stopped=true;}
    finally{
      // Erase the on-disk bundle even if process exit cannot be proven. Keep
      // the capacity reservation in that case, so failures cannot spawn an
      // unbounded number of trusted authentication processes.
      if(directory)await rm(directory,{recursive:true,force:true});if(stopped)active--;
    }
  }
};
