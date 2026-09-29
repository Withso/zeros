import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import {CloudAgentLease} from "../cloud-agent-lease";
import {CloudBackgroundExecution,CLOUD_BACKGROUND_SERVERS_TASK} from "../cloud-background-execution";

afterEach(()=>vi.useRealTimers());
async function fixture(){
  vi.useFakeTimers();let now=Date.now();const leaseId=randomUUID();
  const admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"claude" as const,model:"qualified-model",source:{kind:"command" as const,commandId:randomUUID(),claimId:randomUUID()}};
  let stored={version:1 as const,leaseId,conversationId:"chat",phase:"background" as "background"|"foreground",deadline:new Date(now+4*60*60_000).toISOString(),revision:1,
    snapshot:{tasks:[],waiting:false,processWork:false} as {tasks: {taskId:string;name:string;startedAt:number;updatedAt:number}[];waiting:boolean;processWork:boolean}};
  const request=vi.fn(async(input:CloudAgentExecutionRequest)=>{
    if(input.kind==="release")return {released:true};
    if(input.kind==="background"){
      if(input.operation.kind==="retain"||input.operation.kind==="sync")stored={...stored,snapshot:input.operation.snapshot,revision:input.operation.revision,phase:input.operation.kind==="retain"?"background":stored.phase};
      if(input.operation.kind==="resume")stored={...stored,phase:"foreground"};
      return structuredClone(stored);
    }
    const lease={leaseId,expiresAt:new Date(now+45_000).toISOString(),credentialVersion:1};
    return input.kind==="admit"?{...lease,authorityId:"a".repeat(64),credentialKind:"claude-api-key",provider:"claude",model:admission.model,
      material:{kind:"claude-api-key",apiKey:"synthetic-background-test-key"},backgroundTasksVersion:1}:lease;
  });
  const lease=await CloudAgentLease.admit(admission,request,new AbortController().signal,{onRetirementFailure:vi.fn()},{wall:()=>now,monotonic:()=>now});
  const domain={stopAndProve:vi.fn(async()=>{})};lease.attach(domain);
  const servers=vi.fn(async()=>false);
  const background=new CloudBackgroundExecution(lease,"chat",servers);
  const callbacks={nativeWork:vi.fn(async()=>false),publish:vi.fn(),retire:vi.fn(async()=>{await lease.close();})};
  const task={taskId:"child",name:"Background child",startedAt:now,updatedAt:now};
  return {lease,background,request,callbacks,domain,admission,task,servers,advance:async(ms:number)=>{now+=ms;await vi.advanceTimersByTimeAsync(ms);}};
}
describe("leased native background execution",()=>{
  it.each(["一","\u0000","😀"])("bounds encoded snapshot bytes without retiring valid native work (%s)",async character=>{
    const f=await fixture(),original=f.request.getMockImplementation()!;const sizes:number[]=[];
    f.request.mockImplementation(async input=>{
      if(input.kind==="background"&&(input.operation.kind==="retain"||input.operation.kind==="sync")){
        const bytes=Buffer.byteLength(JSON.stringify(input.operation.snapshot));sizes.push(bytes);
        // The actual CP writer rejects this bound before executing SQL.
        if(bytes>192*1024)throw new Error("cloud_background_snapshot_invalid");
      }
      return original(input);
    });
    const update={sessionUpdate:"background_tasks_update" as const,waiting:true,tasks:Array.from({length:64},(_,i)=>({...f.task,taskId:`task-${i}`,
      name:character.repeat(512),taskType:character.repeat(128),command:character.repeat(2048),summary:character.repeat(2048),lastToolName:character.repeat(128)}))};
    try{
      f.background.observe(update);expect(await f.background.complete(f.callbacks)).toBe(true);
      f.background.observe({...update,tasks:update.tasks.map(task=>({...task,updatedAt:task.updatedAt+1}))});await f.background.refresh();
      expect(sizes).toHaveLength(2);expect(Math.max(...sizes)).toBeLessThanOrEqual(192*1024);
      expect((await f.background.read()).tasks.map(task=>task.taskId)).toEqual(update.tasks.map(task=>task.taskId));
      expect(f.domain.stopAndProve).not.toHaveBeenCalled();
    }finally{await f.lease.close();}
  });
  it("retains a server without native task metadata and stops only its owned execution",async()=>{
    const f=await fixture(),sibling=await fixture();f.servers.mockResolvedValue(true);sibling.servers.mockResolvedValue(true);
    await f.background.complete(f.callbacks);await sibling.background.complete(sibling.callbacks);
    expect(await f.background.read()).toMatchObject({tasks:[{taskId:CLOUD_BACKGROUND_SERVERS_TASK}]});
    await f.background.stopServers();expect(f.domain.stopAndProve).toHaveBeenCalledOnce();
    expect(sibling.domain.stopAndProve).not.toHaveBeenCalled();await sibling.lease.close();
  });
  it("does not stop a server when a queued claim acquires ownership during inspection",async()=>{
    const f=await fixture();f.servers.mockResolvedValue(true);await f.background.complete(f.callbacks);
    let finish!:(value:boolean)=>void;
    f.servers.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const stopping=f.background.stopServers();await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
    f.background.reserve();finish(true);
    await expect(stopping).rejects.toThrow("ownership changed");expect(f.domain.stopAndProve).not.toHaveBeenCalled();await f.lease.close();
  });
  it("coalesces reloads and never overwrites late output with an older persistence acknowledgement",async()=>{
    const f=await fixture();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.complete(f.callbacks);
    const a=f.background.read(),b=f.background.read();expect(a).toBe(b);await a;
    let release!:()=>void;const request=f.request.getMockImplementation()!;
    f.request.mockImplementation(async input=>{if(input.kind==="background"&&input.operation.kind==="sync")await new Promise<void>(resolve=>{release=resolve;});return request(input);});
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[{...f.task,name:"Older"}],waiting:true});
    const refreshing=f.background.refresh();await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    f.callbacks.publish.mockClear();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[{...f.task,name:"Latest"}],waiting:true});
    release();await refreshing;expect(f.callbacks.publish).not.toHaveBeenCalled();await f.lease.close();
  });
  it("parent completes before child, late output remains owned, and empty snapshot proves retirement",async()=>{
    const f=await fixture();
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});
    expect(await f.background.complete(f.callbacks)).toBe(true);expect(f.domain.stopAndProve).not.toHaveBeenCalled();
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[{...f.task,summary:"Late child output"}],waiting:true});
    await f.background.refresh();
    expect(await f.background.read()).toMatchObject({tasks:[{summary:"Late child output"}]});
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[],waiting:false});
    await f.background.refresh();expect(f.callbacks.retire).toHaveBeenCalledOnce();expect(f.domain.stopAndProve).toHaveBeenCalledOnce();
  });
  it("shares native history on a queued next turn and does not retire during its claim",async()=>{
    const f=await fixture();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.complete(f.callbacks);
    f.background.reserve();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[],waiting:false});await f.background.refresh();
    expect(f.callbacks.retire).not.toHaveBeenCalled();
    await f.background.resume({...f.admission,source:{kind:"command",commandId:randomUUID(),claimId:randomUUID()}});
    await f.background.refresh();expect(f.callbacks.retire).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([r])=>r.kind==="admit")).toHaveLength(1);await f.lease.close();
  });
  it("revocation, expiry and archive drain close descendants and prevent resurrection",async()=>{
    const f=await fixture();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.complete(f.callbacks);
    await f.lease.close();
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.refresh();
    expect(f.background.retained).toBe(false);expect(f.domain.stopAndProve).toHaveBeenCalledOnce();
    await expect(f.background.resume(f.admission)).rejects.toThrow();
  });
  it("a bounded runaway is retired even when the control plane keeps renewing",async()=>{
    const f=await fixture();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.complete(f.callbacks);
    // Renew successfully throughout the four hours. Neither a new snapshot
    // nor a fresh 45-second credential response may extend the original cap.
    for(let i=0;i<719;i++){await f.advance(20_000);expect(f.lease.signal.aborted).toBe(false);}
    await f.advance(20_000);
    expect(f.lease.signal.aborted).toBe(true);expect(f.domain.stopAndProve).toHaveBeenCalledOnce();
  });
  it("targeted native task completion preserves sibling work",async()=>{
    const f=await fixture(),other={...f.task,taskId:"sibling"};
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task,other],waiting:true});await f.background.complete(f.callbacks);
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[other],waiting:true});await f.background.refresh();
    expect(await f.background.read()).toMatchObject({tasks:[{taskId:"sibling"}]});expect(f.domain.stopAndProve).not.toHaveBeenCalled();await f.lease.close();
  });
  it("does not retire when late child activity races the completed process inspection",async()=>{
    const f=await fixture();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[f.task],waiting:true});await f.background.complete(f.callbacks);
    f.background.observe({sessionUpdate:"background_tasks_update",tasks:[],waiting:false});
    const inspecting=f.background as unknown as {snapshot():Promise<unknown>},inspect=inspecting.snapshot.bind(inspecting);
    vi.spyOn(inspecting,"snapshot").mockImplementationOnce(async()=>{
      const observed=await inspect();f.background.observe({sessionUpdate:"background_tasks_update",tasks:[{...f.task,taskId:"late-child"}],waiting:true});return observed;
    });
    await f.background.refresh();expect(f.domain.stopAndProve).not.toHaveBeenCalled();
    await f.background.refresh();expect(await f.background.read()).toMatchObject({tasks:[{taskId:"late-child"}]});await f.lease.close();
  });
});
