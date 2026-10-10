import {mkdtemp,realpath,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {AgentGateway,type NewAgentSessionOptions} from "../gateway";
import type {AgentAdapter,AgentGatewayOptions} from "../types";
import {testExecutionBoundary} from "./helpers/test-execution-boundary";
import * as cloudExecutions from "../cloud-provider-execution";
import type { CloudQueuedPrompt } from "@zeros/protocol/cloud-commands";

describe("cloud gateway admission",()=>{
  it.each(["claude", "codex", "cursor"])("admits boolean Claude preferences only for %s without accepting loader overrides", async agentId => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-preferences-")));
    const workload = testExecutionBoundary();
    const factory = { prepare: vi.fn(async (input: { workload: unknown; providerSettings?: Record<string, string> }) => ({ boundary: input.workload,
      env: { ...input.providerSettings }, authorityId: "a".repeat(64) })) };
    const native = vi.fn(async (opts: { executionId: string }) => ({ session: { executionId: opts.executionId, sessionId: opts.executionId }, initialize: {} }));
    const resumed = vi.fn(async (opts: { executionId: string }) => ({ executionId: opts.executionId }));
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" }, cloudAgentExecutionFactory: factory,
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } } as AgentGatewayOptions);
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(agentId, { agentId, newSession: native, loadSession: resumed,
      disposeSession: async () => {}, dispose: async () => {} } as unknown as AgentAdapter);
    const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(), model: "test-model", source: { kind: "session", actorSessionId: randomUUID() } },
      env: { ZEROS_CLAUDE_AUTO_MEMORY: "0", ZEROS_CLAUDE_IDLE_COMPACTION: "1", NODE_OPTIONS: "untrusted" } } as NewAgentSessionOptions;
    try {
      await gateway.newSession(agentId, options);
      await gateway.loadSession(agentId, { version: 1, kind: "native", providerId: agentId, resumeId: "binding" }, options);
      for (const [{ providerSettings }] of factory.prepare.mock.calls) {
        if (agentId === "claude") expect(providerSettings).toMatchObject({ ZEROS_CLAUDE_AUTO_MEMORY: "0", ZEROS_CLAUDE_IDLE_COMPACTION: "1" });
        else {
          expect(providerSettings).not.toHaveProperty("ZEROS_CLAUDE_AUTO_MEMORY");
          expect(providerSettings).not.toHaveProperty("ZEROS_CLAUDE_IDLE_COMPACTION");
        }
        expect(providerSettings).not.toHaveProperty("NODE_OPTIONS");
      }
    } finally { await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    undefined, { autoMemoryEnabled: false, idleCompactionEnabled: true }, { autoMemoryEnabled: true, idleCompactionEnabled: false },
  ])("updates a retained Claude process from this command's preferences, including legacy defaults (%j)", async claudePreferences => {
    const boundary = {} as never;
    const execution = { background: { resume: vi.fn(async () => {}) }, lease: { close: vi.fn(async () => {}) } } as unknown as cloudExecutions.CloudProviderExecution;
    const original = cloudExecutions.cloudProviderExecution;
    const lookup = vi.spyOn(cloudExecutions, "cloudProviderExecution").mockImplementation(value => value === boundary ? execution : original(value));
    const reuse = vi.fn(), updateConfig = vi.fn(async () => {});
    const gateway = { executionBoundaries: new Map([["execution", boundary]]), adapterForSession: () => ({ assertBackgroundReuse: reuse }), updateConfig };
    const payload: CloudQueuedPrompt = { agentId: "claude", model: "claude-haiku-4-5", userMessageId: "message", modeRevision: 0,
      prompt: [{ type: "text", text: "test" }], ...(claudePreferences ? { claudePreferences } : {}) };
    const admission = { executionId: "execution", provider: "claude" as const, delegationId: randomUUID(), model: "claude-haiku-4-5",
      source: { kind: "command" as const, commandId: randomUUID(), claimId: randomUUID() } };
    try {
      await AgentGateway.prototype.resumeCloudExecution.call(gateway as unknown as AgentGateway, "claude", "execution", admission, payload);
      const env = { ZEROS_FAST_MODE: "0", ZEROS_CLAUDE_AUTO_MEMORY: claudePreferences?.autoMemoryEnabled === false ? "0" : "1",
        ZEROS_CLAUDE_IDLE_COMPACTION: claudePreferences?.idleCompactionEnabled === true ? "1" : "0" };
      expect(reuse).toHaveBeenCalledWith({ sessionId: "execution", env, modeId: undefined });
      expect(updateConfig).toHaveBeenCalledWith("claude", "execution", env);
      expect(execution.background!.resume).toHaveBeenCalledWith(admission);
      expect(execution.lease.close).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  it.each([
    ["claude", "accept-edits"], ["claude", "plan"], ["claude", "auto"],
    ["codex", "auto-edit"], ["codex", "ask"], ["cursor", "auto"], ["cursor", "plan"],
  ])("retains %s mode %s through both private new and resumed admissions",async(agentId,mode)=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"zeros-cloud-mode-")));
    const workload=testExecutionBoundary();
    const factory={prepare:vi.fn(async(input:{workload:unknown;providerSettings?:Record<string,string>})=>({boundary:input.workload,
      env:{...input.providerSettings},authorityId:"a".repeat(64)}))};
    const native=vi.fn(async(opts:{executionId:string})=>({session:{executionId:opts.executionId,sessionId:opts.executionId},initialize:{}}));
    const resumed=vi.fn(async(opts:{executionId:string})=>({executionId:opts.executionId}));
    const gateway=new AgentGateway({projectRoot:root,executionBoundary:{...workload,backend:"cloud-worker"},cloudAgentExecutionFactory:factory,
      events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}} as AgentGatewayOptions);
    (gateway as unknown as {adapters:Map<string,AgentAdapter>}).adapters.set(agentId,{agentId,newSession:native,loadSession:resumed,disposeSession:async()=>{},dispose:async()=>{}} as unknown as AgentAdapter);
    const options={cwd:root,conversationId:"conversation",cloudExecution:{delegationId:randomUUID(),model:"test-model",source:{kind:"session",actorSessionId:randomUUID()}},
      env:{ZEROS_PERMISSION_MODE:mode,ZEROS_FAST_MODE:"1",NODE_OPTIONS:"--require injected"}} as NewAgentSessionOptions;
    try{
      const created=await gateway.newSession(agentId,options);
      const resumedSession=await gateway.loadSession(agentId,{version:1,kind:"native",providerId:agentId,resumeId:"test-binding"},options);
      for(const session of [created,resumedSession]) {
        expect(session.boundary).toHaveProperty("browser",expect.objectContaining({
          version:1,provider:agentId,runtimeProfile:"zeros-cloud-worker-v3",credentialKind:"unknown",
          state:"unavailable",reason:"not-reported",
        }));
      }
      for(const method of [native,resumed])expect(method.mock.calls[0]?.[0]).not.toHaveProperty("browserUse");
      for(const call of factory.prepare.mock.calls)expect(call[0].providerSettings).toEqual({ZEROS_PERMISSION_MODE:mode,ZEROS_FAST_MODE:"1"});
      for(const method of [native,resumed])expect(method).toHaveBeenCalledWith(expect.objectContaining({env:{ZEROS_PERMISSION_MODE:mode,ZEROS_FAST_MODE:"1"}}));
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
