import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";
import type {ChildProcess} from "node:child_process";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CloudAgentLease} from "../../cloud-agent-lease";
import {CloudCoordinatorBoundary} from "../cloud-coordinator-boundary";
import type {PreparedBoundary} from "../types";
const mocked=vi.hoisted(()=>({stop:vi.fn(),rm:vi.fn()}));
vi.mock("node:fs/promises",async original=>({...await original<typeof import("node:fs/promises")>(),rm:mocked.rm}));
vi.mock("../cloud-supervised-process",()=>({CloudSupervisedProcess:class{
  wait(){return new Promise(()=>{});}stopAndProve(){return mocked.stop();}
}}));
async function fixture(){
  mocked.stop.mockResolvedValue(undefined);mocked.rm.mockResolvedValue(undefined);
  const admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"cursor" as const,model:"grok-4.6",source:{kind:"session" as const,actorSessionId:randomUUID()}};
  const request=vi.fn(async(input:{kind:string})=>input.kind==="release"?{released:true}:{leaseId:randomUUID(),authorityId:"a".repeat(64),expiresAt:new Date(Date.now()+45000).toISOString(),credentialVersion:1,credentialKind:"cursor-api-key",provider:"cursor",model:"grok-4.6",material:{kind:"cursor-api-key",apiKey:"synthetic-cursor-key"}});
  const lease=await CloudAgentLease.admit(admission,request,new AbortController().signal,{onRetirementFailure:vi.fn()});
  const Constructor=CloudCoordinatorBoundary as unknown as new(lease:CloudAgentLease,workload:PreparedBoundary,directory:string,env:Record<string,string>,history:unknown)=>CloudCoordinatorBoundary;
  const boundary=new Constructor(lease,{generation:"test",status:{parity:{restrictions:[]}},attestation:Promise.resolve()} as unknown as PreparedBoundary,`/run/zeros/coordinators/${"a".repeat(32)}`,{},
    {mount:{provider:"cursor",directory:`/srv/zeros/state/native-agent-history/${"b".repeat(64)}/cursor`},release:async()=>{}});
  lease.attach(boundary);
  return {lease,boundary,request};
}
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers();});
describe("private coordinator launch ownership",()=>{
  it("declares native provider limitations without pretending to qualify core tools",async()=>{
    const {lease,boundary}=await fixture();
    try{
      expect(boundary.status.parity).toEqual({level:"restricted",restrictions:[
        "additional-directories-disabled","native-session-fork-disabled",
        "provider-native-extensions-restricted","user-mcp-disabled",
      ]});
      expect(boundary.status).not.toHaveProperty("cloudExecution");
    }finally{await lease.close();}
  });
  it("cannot release authority while a wrapped launch has not been tracked",async()=>{
    vi.useFakeTimers();const {lease,boundary,request}=await fixture();
    const launch=boundary.wrapSpawn({command:"/usr/bin/true",args:[],cwd:"/",env:{}});
    await expect(lease.close()).rejects.toThrow(/retirement/);
    expect(request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(0);
    const child=Object.assign(new EventEmitter(),{pid:123,spawnfile:launch.command,spawnargs:[launch.command,...launch.args]}) as ChildProcess;
    expect(()=>boundary.trackProcess(child)).toThrow(/retired/);
    await lease.close();expect(mocked.stop).toHaveBeenCalled();
    expect(request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(1);
  });
  it("does not reserve an invalid launch",async()=>{
    vi.useFakeTimers();const {lease,boundary}=await fixture();
    for(let i=0;i<20;i++)expect(()=>boundary.wrapSpawn({command:"/srv/zeros/workspace/untrusted",args:[],cwd:"/",env:{}})).toThrow(/command/);
    await lease.close();
  });
});
