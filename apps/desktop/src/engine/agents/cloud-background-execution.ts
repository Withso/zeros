import type {BackgroundTasksUpdate} from "@zeros/protocol/agent-events";
import {CloudBackgroundSnapshotSchema,type CloudAgentExecutionAdmission,type CloudBackgroundSnapshot} from "@zeros/protocol/cloud-agent-execution";
import type {CloudAgentLease} from "./cloud-agent-lease";
import {projectCloudBackgroundTasks} from "./cloud-background-snapshot";

/** A group stop retires this execution's server processes through its proven
 * boundary. Native task IDs still use the provider's individual stop port. */
export const CLOUD_BACKGROUND_SERVERS_TASK="zeros:workspace-server-processes";
type Callbacks={nativeWork():boolean|Promise<boolean>;publish(update:BackgroundTasksUpdate):void;retire():Promise<void>};

export class CloudBackgroundExecution {
  private phase:"foreground"|"background"|"closed"="foreground";
  private native:BackgroundTasksUpdate={sessionUpdate:"background_tasks_update",tasks:[],waiting:false};
  private tail:Promise<unknown>=Promise.resolve();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private callbacks:Callbacks|null=null;
  private revision=0;
  private lastSnapshot="";
  private reserved=false;
  private serverStartedAt:number|null=null;
  private refreshing:Promise<void>|null=null;
  private reading:Promise<BackgroundTasksUpdate>|null=null;
  private pending=0;
  private observation=0;
  private nativeTasksActive=false;
  constructor(private readonly lease:CloudAgentLease,readonly conversationId:string,private readonly servers:()=>Promise<boolean>){
    lease.signal.addEventListener("abort",()=>{
      this.phase="closed";this.clearTimer();this.reserved=false;
      this.callbacks?.publish({sessionUpdate:"background_tasks_update",tasks:[],waiting:false,activity:null});
    },{once:true});
  }
  get retained(){return this.phase==="background"&&!this.lease.signal.aborted;}
  get preservesNativeProcess(){return this.revision>0&&this.phase!=="closed"&&!this.lease.signal.aborted;}
  reserve(){if(this.retained)this.reserved=true;}
  releaseReservation(){this.reserved=false;this.schedule();}
  observe(update:BackgroundTasksUpdate){
    if(this.phase==="closed")return;
    this.observation++;
    // Provider output can be arbitrarily large. Project just the existing UI
    // fields, with bounds; never persist arbitrary native metadata or material.
    this.nativeTasksActive=update.tasks.length>0;
    this.native={...update,tasks:projectCloudBackgroundTasks(update.tasks)};
    this.schedule();
  }
  private serialize<T>(operation:()=>Promise<T>):Promise<T>{
    if(this.pending>=16)return Promise.reject(new Error("Cloud background operation capacity exceeded"));
    this.pending++;
    const next=this.tail.then(operation).finally(()=>{this.pending--;});this.tail=next.catch(()=>{});return next;
  }
  private clearTimer(){if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private schedule(){
    if(!this.retained||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.refresh().catch(()=>{});},2000);this.timer.unref?.();
  }
  private async snapshot():Promise<{snapshot:CloudBackgroundSnapshot;observed:number}>{
    this.lease.assertLive();
    const nativeWork=await this.callbacks!.nativeWork();
    const servers=await this.servers();this.lease.assertLive();
    const tasks=[...this.native.tasks];
    // A server without a provider-native task record still owns the boundary.
    // Grouping is explicit: its stop control stops this execution, never a PID
    // inferred from renderer input or a sibling conversation's processes.
    if(servers&&tasks.length===0){
      this.serverStartedAt??=Date.now();
      tasks.push({taskId:CLOUD_BACKGROUND_SERVERS_TASK,name:"Workspace server processes",taskType:"workspace-processes",
        startedAt:this.serverStartedAt,updatedAt:this.serverStartedAt});
    }else if(!servers)this.serverStartedAt=null;
    const processWork=nativeWork||servers||this.nativeTasksActive||tasks.length>0||!!(this.native.activity&&this.native.activity.state!=="idle");
    return {observed:this.observation,snapshot:CloudBackgroundSnapshotSchema.parse({tasks,waiting:tasks.length>0&&this.native.activity?.state!=="running",processWork,
      ...(this.native.activity!==undefined?{activity:this.native.activity}:{})})};
  }
  private publish(snapshot:CloudBackgroundSnapshot){
    const {processWork:_work,...update}=snapshot;
    this.callbacks?.publish({sessionUpdate:"background_tasks_update",...update});
  }
  async complete(callbacks:Callbacks):Promise<boolean>{
    this.callbacks=callbacks;
    return this.serialize(async()=>{
      if(this.phase==="closed"||this.lease.backgroundTasksVersion!==1)return false;
      try{
        const {snapshot,observed}=await this.snapshot();
        // Activity may arrive between inspection resolution and its awaiter.
        // Preserve ownership until the next exact observation in that case.
        if(observed!==this.observation)snapshot.processWork=true;
        if(!snapshot.processWork)return false;
        await this.lease.background({kind:"retain",conversationId:this.conversationId,revision:++this.revision,snapshot});
        this.lease.assertLive();this.phase="background";this.reserved=false;this.lastSnapshot=JSON.stringify(snapshot);
        if(observed===this.observation)this.publish(snapshot);this.schedule();return true;
      }catch{await this.lease.close();return false;}
    });
  }
  async resume(admission:CloudAgentExecutionAdmission):Promise<void>{
    await this.serialize(async()=>{
      if(!this.retained)throw new Error("Cloud background execution is no longer live");
      // CP independently binds the incoming dispatch claim to the original
      // actor, credential and conversation. Rejection cannot kill that actor's
      // still-authorized work or grant this caller its history lock.
      await this.lease.background({kind:"resume",conversationId:this.conversationId,admission});
      this.lease.assertLive();this.phase="foreground";this.reserved=false;this.clearTimer();
    });
  }
  refresh():Promise<void>{
    if(this.refreshing)return this.refreshing;
    const operation=this.serialize(async()=>{
      if(!this.retained||this.reserved)return;
      try{
        const {snapshot,observed}=await this.snapshot();
        if(this.reserved||observed!==this.observation)return;
        if(!snapshot.processWork){
          // All late native output was already emitted; now close through the
          // same descendant/history proof used for explicit workspace drains.
          this.phase="closed";this.clearTimer();this.publish(snapshot);await this.callbacks!.retire();return;
        }
        const encoded=JSON.stringify(snapshot);
        if(encoded!==this.lastSnapshot){
          await this.lease.background({kind:"sync",conversationId:this.conversationId,revision:++this.revision,snapshot});
          this.lastSnapshot=encoded;if(observed===this.observation)this.publish(snapshot);
        }
      }catch(error){await this.lease.close();throw error;}
      finally{this.schedule();}
    });
    this.refreshing=operation;
    void operation.finally(()=>{if(this.refreshing===operation)this.refreshing=null;}).catch(()=>{});
    return operation;
  }
  read():Promise<BackgroundTasksUpdate>{
    if(this.reading)return this.reading;
    const operation=this.serialize(async():Promise<BackgroundTasksUpdate>=>{
      const result=await this.lease.background({kind:"read",conversationId:this.conversationId});
      const {processWork:_work,...snapshot}=result.snapshot;
      return {sessionUpdate:"background_tasks_update",...snapshot};
    });
    this.reading=operation;
    void operation.finally(()=>{if(this.reading===operation)this.reading=null;}).catch(()=>{});return operation;
  }
  async stopServers():Promise<void>{
    await this.serialize(async()=>{
      if(!this.retained||this.reserved)throw new Error("Background server ownership changed");
      const {snapshot:current,observed}=await this.snapshot();
      if(this.reserved||observed!==this.observation||current.tasks.length!==1||current.tasks[0]?.taskId!==CLOUD_BACKGROUND_SERVERS_TASK)throw new Error("Background server ownership changed");
      this.phase="closed";this.clearTimer();await this.callbacks!.retire();
    });
  }
}
