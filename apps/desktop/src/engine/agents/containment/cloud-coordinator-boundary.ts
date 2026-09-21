import {spawn,type ChildProcess} from "node:child_process";
import {randomBytes} from "node:crypto";
import {chown,lstat,mkdir,realpath,readlink,rm} from "node:fs/promises";
import type {CloudAgentAccessMaterial} from "@zeros/protocol/cloud-agent-execution";
import {CLOUD_CORE_PROVIDER_RESTRICTIONS,type ExecutionBoundaryStatus} from "@zeros/protocol/containment";
import type {CloudAgentLease} from "../cloud-agent-lease";
import {loadCloudWorkerConfiguration} from "./cloud-worker-config";
import {cloudCoordinatorArguments,cloudCoordinatorEnvironment,CLOUD_COORDINATOR_HOME,CLOUD_COORDINATOR_CWD,CLOUD_COORDINATOR_UID} from "./cloud-coordinator-view.mjs";
import {CloudSupervisedProcess} from "./cloud-supervised-process";
import {attestCloudCoordinator} from "./cloud-coordinator-attestation";
import {acquireCloudNativeHistory,CLOUD_NATIVE_HISTORY_ROOT} from "./cloud-native-history";
import type {BoundaryLaunchSpec,BoundaryProcess,BoundarySpawnRequest,PortLease,PortRequest,PreparedBoundary} from "./types";

const ROOT="/run/zeros/coordinators";
const NODE="/opt/zeros-runtime/bin/node";
const BWRAP="/usr/bin/bwrap";
const SUPERVISOR="/opt/zeros-runtime/cloud-process-supervisor";
const AUTH_ENV=new Set(["ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","CURSOR_API_KEY","OPENAI_API_KEY"]);
const STARTUP_ENV=new Set(["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS","CLAUDE_CODE_STARTUP_FAILURE_RESULTS","NODE_USE_ENV_PROXY"]);
const CANARY=`const fs=require('node:fs');const status=fs.readFileSync('/proc/self/status','utf8');
if(process.getuid()!==10004||process.getgid()!==10004||!/^CapEff:\\s+0+$/m.test(status))process.exit(91);
for(const name of ['/srv/zeros/state','/srv/zeros/home/agent','/run/zeros','/etc/zeros'])if(fs.existsSync(name))process.exit(92);
if(fs.readlinkSync('/proc/self/ns/pid')===process.argv[1])process.exit(93);
for(const directory of ['/home/zeros-agent','/srv/zeros/workspace','/tmp','/dev/shm']){const file=directory+'/.zeros-canary';fs.writeFileSync(file,'canary',{flag:'wx'});fs.unlinkSync(file);}
try{fs.writeFileSync('/.zeros-denied','denied',{flag:'wx'});process.exit(94);}catch(error){if(!['EACCES','EROFS','EPERM'].includes(error.code))process.exit(95);}
process.stdout.write('zeros-private-coordinator-v3');`;

/** The credential-bearing view is never the workspace execution boundary.
 * Every provider-native process gets this fixed private mount/PID view; tools
 * use the separate workload boundary retained by the trusted coordinator. */
export class CloudCoordinatorBoundary implements PreparedBoundary {
  readonly generation;
  readonly status:ExecutionBoundaryStatus;
  readonly attestation:Promise<void>;
  readonly providerHomePath=CLOUD_COORDINATOR_HOME;
  private readonly processes=new Set<BoundaryProcess>();
  private readonly launches=new Set<string>();
  private retired=false;
  private closing:Promise<void>|null=null;
  private env:Record<string,string>;
  private constructor(readonly lease:CloudAgentLease,readonly workload:PreparedBoundary,
    private readonly directory:string,env:Record<string,string>,private readonly history:Awaited<ReturnType<typeof acquireCloudNativeHistory>>){
    this.generation=workload.generation;this.status={...workload.status,parity:{level:"restricted",
      restrictions:[...new Set([...workload.status.parity.restrictions,...CLOUD_CORE_PROVIDER_RESTRICTIONS[lease.admission.provider]])].sort()}};
    delete this.status.cloudExecution;
    this.env=env;this.attestation=workload.attestation;
  }
  static async prepare(lease:CloudAgentLease,workload:PreparedBoundary,conversationId:string,settings?:Record<string,string>):Promise<CloudCoordinatorBoundary>{
    const configuration=loadCloudWorkerConfiguration();
    if(configuration?.version!==3)throw new Error("Private cloud agents require the qualified v3 runtime");
    lease.assertLive();await workload.attestation;lease.assertLive();
    await mkdir(ROOT,{recursive:true,mode:0o700});
    const root=await lstat(ROOT);
    if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==0||(root.mode&0o077)!==0||await realpath(ROOT)!==ROOT)
      throw new Error("Private coordinator root is not engine-owned");
    const directory=`${ROOT}/${randomBytes(16).toString("hex")}`;
    await mkdir(directory,{mode:0o700});
    let boundary:CloudCoordinatorBoundary|undefined;
    let history:Awaited<ReturnType<typeof acquireCloudNativeHistory>>|undefined;
    try{
      history=await acquireCloudNativeHistory({root:CLOUD_NATIVE_HISTORY_ROOT,conversationId,provider:lease.admission.provider,
        uid:CLOUD_COORDINATOR_UID,gid:CLOUD_COORDINATOR_UID});
      for(const name of ["home","scratch"]){await mkdir(`${directory}/${name}`,{mode:0o700});await chown(`${directory}/${name}`,CLOUD_COORDINATOR_UID,CLOUD_COORDINATOR_UID);}
      const providerHome=`${directory}/home/.${lease.admission.provider}`;
      await mkdir(providerHome,{mode:0o700});await chown(providerHome,CLOUD_COORDINATOR_UID,CLOUD_COORDINATOR_UID);
      const material=lease.takeMaterial(),env=cloudCoordinatorEnvironment(material,lease.admission.model,settings);
      boundary=new CloudCoordinatorBoundary(lease,workload,directory,env,history);lease.attach(boundary);
      // No real credential enters even the canary until the private view proves
      // its role. Admission material remains in the trusted engine meanwhile.
      const owned=boundary;
      const parentNamespace=await readlink("/proc/self/ns/pid");
      const canary=await lease.launch(()=>owned.spawn({command:NODE,args:["-e",CANARY,parentNamespace],cwd:CLOUD_COORDINATOR_CWD,
        env:Object.fromEntries(Object.entries(env).filter(([name])=>!AUTH_ENV.has(name))),stdio:"pipe"},true));
      await attestCloudCoordinator(lease,canary);
      lease.assertLive();
      await lease.validate();return boundary;
    }catch(error){
      // close marks authority retired synchronously; its bounded retry ladder
      // owns uncertain cleanup, so admission never waits forever on a canary.
      void lease.close().catch(()=>{});
      if(!boundary){await history?.release();await rm(directory,{recursive:true,force:true});}
      throw error;
    }
  }
  environment():Record<string,string>{this.assertLive();return {...this.env};}
  codexExternalAuth():Extract<CloudAgentAccessMaterial,{kind:"codex-chatgpt"}>|null{
    this.assertLive();return this.lease.codexAuth()?.material??null;
  }
  private assertLive():void{if(this.retired)throw new Error("Private coordinator is retired");this.lease.assertLive();}
  wrapSpawn(request:BoundarySpawnRequest):BoundaryLaunchSpec{return this.launchSpec(request,false);}
  private launchSpec(request:BoundarySpawnRequest,canary:boolean):BoundaryLaunchSpec{
    this.assertLive();
    const env=canary?{...request.env}:{...this.env};
    if(!canary)for(const name of STARTUP_ENV)if(request.env[name]==="1")env[name]="1";
    const arguments_=cloudCoordinatorArguments(this.directory,request.command,request.args,this.history.mount);
    if(this.launches.size+this.processes.size>=16)throw new Error("Private coordinator process capacity exceeded");
    const receipt=`${this.directory}/${randomBytes(16).toString("hex")}`;this.launches.add(receipt);
    return {command:SUPERVISOR,args:[receipt,String(process.pid),"--",BWRAP,...arguments_],cwd:"/",env,stdio:request.stdio??"pipe"};
  }
  trackProcess(child:ChildProcess):BoundaryProcess{
    const receipt=child.spawnargs[1];
    if(child.spawnfile!==SUPERVISOR||!receipt||!this.launches.has(receipt)||child.spawnargs[2]!==String(process.pid)||child.spawnargs[3]!=="--"||child.spawnargs[4]!==BWRAP){
      void this.lease.close().catch(()=>{});throw new Error("Private coordinator launch identity is invalid");
    }
    const tracked=new CloudSupervisedProcess(child,receipt,()=>{void this.lease.close().catch(()=>{});});this.processes.add(tracked);
    this.launches.delete(receipt);
    void tracked.wait().then(async()=>{await this.lease.retire(tracked);this.processes.delete(tracked);})
      .catch(()=>this.lease.close().catch(()=>{}));
    // attach takes immediate cleanup ownership even if the lease is already
    // retired. Never rely on a boundary that may have finished its last drain.
    this.lease.attach(tracked);
    if(this.retired||this.lease.signal.aborted){void this.lease.close().catch(()=>{});throw new Error("Private coordinator is retired");}
    return tracked;
  }
  cancelUnstartedLaunch(launch:BoundaryLaunchSpec):void{
    if(launch.command!==SUPERVISOR||launch.args[1]!==String(process.pid)||launch.args[2]!=="--"||launch.args[3]!==BWRAP)
      throw new Error("Private coordinator launch identity is invalid");
    this.launches.delete(launch.args[0]!);
  }
  trackProcessGroup():BoundaryProcess{throw new Error("Private coordinator does not admit external process groups");}
  async spawn(request:BoundarySpawnRequest,canary=false):Promise<BoundaryProcess>{
    this.assertLive();
    // wrap/spawn/track are synchronous: lease cancellation cannot interleave.
    const launch=this.launchSpec(request,canary);
    let child:ChildProcess;
    try{child=spawn(launch.command,[...launch.args],{cwd:launch.cwd,env:launch.env,stdio:["pipe","pipe","pipe"],detached:true});}
    catch(error){this.cancelUnstartedLaunch(launch);throw error;}
    child.on("error",()=>{});
    if(!child.pid){this.cancelUnstartedLaunch(launch);throw new Error("Private coordinator could not start");}
    return this.trackProcess(child);
  }
  requestPort(_request:PortRequest):Promise<PortLease>{return Promise.reject(new Error("Private coordinator cannot expose listening services"));}
  activePorts(){return this.workload.activePorts();}
  portDiscoveryStatus(){return this.workload.portDiscoveryStatus();}
  onPortsChanged(listener:Parameters<PreparedBoundary["onPortsChanged"]>[0]){return this.workload.onPortsChanged(listener);}
  revoke():Promise<void>{return this.stopAndProve();}
  stopAndProve():Promise<void>{
    this.retired=true;this.env={};if(this.closing)return this.closing;
    const closing=(async()=>{
      if(this.launches.size)throw new Error("Private coordinator launch retirement is incomplete");
      do{
        const stopped=await Promise.allSettled([...this.processes].map(async process=>{await process.stopAndProve();this.processes.delete(process);}));
        if(stopped.some(result=>result.status==="rejected"))throw new Error("Private coordinator retirement is incomplete");
      }while(this.processes.size);
      await rm(this.directory,{recursive:true,force:true,maxRetries:2});
      await this.history.release();
    })();this.closing=closing;void closing.finally(()=>{if(this.closing===closing)this.closing=null;}).catch(()=>{});return closing;
  }
}
