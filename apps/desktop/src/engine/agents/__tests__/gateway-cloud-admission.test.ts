import {mkdtemp,realpath,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {AgentGateway,type NewAgentSessionOptions} from "../gateway";
import type {AgentAdapter,AgentGatewayOptions} from "../types";
import {testExecutionBoundary} from "./helpers/test-execution-boundary";

describe("cloud gateway admission",()=>{
  it("does not put a caller's title-generation key into a utility workload",async()=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-title-")));
    const workload=testExecutionBoundary(),prepare=vi.fn(workload.prepare.bind(workload)),native=vi.fn(async()=>({text:"unsafe"}));
    const factory={prepare:vi.fn()};
    const gateway=new AgentGateway({projectRoot:root,executionBoundary:{...workload,prepare,backend:"cloud-worker"},cloudAgentExecutionFactory:factory,
      events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}});
    (gateway as unknown as {adapters:Map<string,AgentAdapter>}).adapters.set("claude",{agentId:"claude",generateText:native,dispose:async()=>{}} as unknown as AgentAdapter);
    try{
      expect(await gateway.generateTitle("claude",{model:"haiku",systemPrompt:"test",prompt:"title",env:{ANTHROPIC_API_KEY:"synthetic-unadmitted-key"}})).toMatchObject({title:null});
      expect(prepare).not.toHaveBeenCalled();expect(factory.prepare).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();
    }finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
  });
  it.each(["newSession","loadSession","forkProviderBinding"] as const)("requires a credential grant before %s can touch a native provider",async stage=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-admit-")));
    const native=vi.fn();
    const gateway=new AgentGateway({projectRoot:root,executionBoundary:{...testExecutionBoundary(),backend:"cloud-worker"},
      events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}});
    const adapter={agentId:"claude",newSession:native,loadSession:native,dispose:async()=>{}} as unknown as AgentAdapter;
    (gateway as unknown as {adapters:Map<string,AgentAdapter>}).adapters.set("claude",adapter);
    try{
      const options={cwd:root,conversationId:"conversation",env:{ANTHROPIC_API_KEY:"untrusted-direct-key"}};
      await expect(stage==="newSession"?gateway.newSession("claude",options):stage==="loadSession"?gateway.loadSession("claude","existing",options):gateway.forkProviderBinding("claude",{version:1,kind:"native",providerId:"claude",resumeId:"existing"},options)).rejects.toThrow(/credential|admission/);
      expect(native).not.toHaveBeenCalled();
    }finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
  });
  it("separates the credential-free workload from the trusted private provider admission",async()=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-admit-")));
    const workload=testExecutionBoundary(),prepare=vi.fn(workload.prepare.bind(workload));
    const factory={prepare:vi.fn(async(input:{workload:unknown})=>({boundary:input.workload,env:{ANTHROPIC_API_KEY:"delegated-key",ANTHROPIC_MODEL:"qualified-model"},authorityId:"a".repeat(64)}))};
    const native=vi.fn(async(opts:{executionId:string})=>({session:{executionId:opts.executionId,sessionId:opts.executionId},initialize:{}}));
    const gateway=new AgentGateway({projectRoot:root,executionBoundary:{...workload,prepare,backend:"cloud-worker"},cloudAgentExecutionFactory:factory,
      events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}} as AgentGatewayOptions);
    (gateway as unknown as {adapters:Map<string,AgentAdapter>}).adapters.set("claude",{agentId:"claude",newSession:native,disposeSession:async()=>{},dispose:async()=>{}} as unknown as AgentAdapter);
    const selection={delegationId:randomUUID(),model:"qualified-model",source:{kind:"session",actorSessionId:randomUUID()}};
    try{
      await gateway.newSession("claude",{cwd:root,conversationId:"conversation",cloudExecution:selection,
        cliBinary:"/workspace/untrusted.sh",env:{ANTHROPIC_API_KEY:"untrusted-direct-key",NODE_OPTIONS:"--require injected",ZEROS_FAST_MODE:"1"}} as NewAgentSessionOptions);
      expect(factory.prepare).toHaveBeenCalledOnce();
      expect(factory.prepare.mock.calls[0]![0]).toMatchObject({admission:{provider:"claude",...selection},conversationId:"conversation"});
      expect(JSON.stringify(prepare.mock.calls)).not.toContain("untrusted-direct-key");
      expect(JSON.stringify(prepare.mock.calls)).not.toContain("injected");
      expect(native).toHaveBeenCalledWith(expect.objectContaining({cliBinary:undefined,env:{ANTHROPIC_API_KEY:"delegated-key",ANTHROPIC_MODEL:"qualified-model"}}));
    }finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
  });
});
