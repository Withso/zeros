import {describe,expect,it,vi} from "vitest";
import {AgentGateway} from "../gateway";
import type {AgentAdapter} from "../types";
import type {PreparedBoundary} from "../containment/types";
import {testExecutionBoundary} from "./helpers/test-execution-boundary";
const cloud=vi.hoisted(()=>({lookup:vi.fn()}));
vi.mock("../cloud-provider-execution",()=>({cloudProviderExecution:cloud.lookup}));
describe("cloud Stop authority",()=>{
  it("acknowledges proven retirement even if native cancellation never resolves",async()=>{
    cloud.lookup.mockReturnValue({lease:{close:vi.fn(async()=>{})}});
    const gateway=new AgentGateway({projectRoot:"/w",executionBoundary:testExecutionBoundary(),events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}});
    const state=gateway as unknown as {adapters:Map<string,AgentAdapter>;executionToAgent:Map<string,string>;executionBoundaries:Map<string,PreparedBoundary>};
    state.adapters.set("cursor",{agentId:"cursor",cancel:()=>new Promise(()=>{})} as unknown as AgentAdapter);state.executionToAgent.set("run","cursor");state.executionBoundaries.set("run",{} as PreparedBoundary);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([gateway.cancel("cursor","run"),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Native cancellation stranded proven Stop")),250);})]);}
    finally{if(timer)clearTimeout(timer);}
  });
  it("fences the lease before native cancellation and waits for background retirement proof",async()=>{
    let finish!:(()=>void);const proof=new Promise<void>(resolve=>{finish=resolve;});let fenced=false;
    const close=vi.fn(()=>{fenced=true;return proof;});cloud.lookup.mockReturnValue({lease:{close}});
    const cancel=vi.fn(async()=>{expect(fenced).toBe(true);});
    const gateway=new AgentGateway({projectRoot:"/w",executionBoundary:testExecutionBoundary(),events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}});
    const state=gateway as unknown as {adapters:Map<string,AgentAdapter>;executionToAgent:Map<string,string>;executionBoundaries:Map<string,PreparedBoundary>};
    state.adapters.set("cursor",{agentId:"cursor",cancel} as unknown as AgentAdapter);state.executionToAgent.set("run","cursor");state.executionBoundaries.set("run",{} as PreparedBoundary);
    let returned=false;const stop=gateway.cancel("cursor","run").then(()=>{returned=true;});
    await Promise.resolve();await Promise.resolve();expect(close).toHaveBeenCalledOnce();expect(returned).toBe(false);
    finish();await stop;expect(cancel).toHaveBeenCalledOnce();expect(returned).toBe(true);
  });
});
