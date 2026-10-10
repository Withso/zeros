import {mkdtemp,mkdir,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CloudCommandClaim,CloudCommandEngineRequest} from "@zeros/protocol/cloud-commands";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import type {AgentNewSessionMessage,AgentLoadSessionMessage} from "@zeros/protocol/messages";
import {ZerosEngine} from "../zeros-engine";
import {CloudGoalRecorder} from "../cloud-goal-recorder";
import {CloudCommandRuntime} from "../cloud-command-runtime";
import type {TransportClient} from "../transport/types";
import {closeZerosDb,setZerosDbPathForTesting} from "../db";
import {deleteChat,getChat,upsertChat,setChatComposerMode} from "../db/chats";
import { windowChatMessages } from "../db/messages";
import type {CloudAgentSelection} from "../agents/cloud-provider-execution";
import {AgentGateway} from "../agents/gateway";
import {AgentFailureError, type AgentAdapter} from "../agents/types";
import { CLAUDE_ORGANIZATION_STARTUP_MESSAGES } from "@zeros/protocol/claude-startup-notice";
import type {PreparedBoundary} from "../agents/containment/types";
import {testExecutionBoundary} from "../agents/__tests__/helpers/test-execution-boundary";

type Start=AgentNewSessionMessage|AgentLoadSessionMessage;
type Spawn={cloudExecution?:CloudAgentSelection;cloudExecutionId?:string;env?:Record<string,string>;cwd?:string};
const methods=ZerosEngine.prototype as unknown as {
  prepareCloudCommand(this:unknown,claim:CloudCommandClaim):Promise<void>;
  dispatchCloudCommand(this:unknown,claim:CloudCommandClaim):Promise<unknown>;
  retireCloudCommand(this:unknown,claim:CloudCommandClaim,allowBackground?:boolean):Promise<void>;
  cancelCloudCommandConversation(this:unknown,id:string):Promise<void>;
  deleteCloudConversation(this:unknown,id:string,operationId:string,client:TransportClient,remove:()=>Promise<unknown>):Promise<unknown>;
  agentSpawnOpts(this:unknown,message:Start,client:TransportClient,stage:string):Promise<Spawn>;
  validateCloudCommand(this:unknown,id:string,payload?:unknown):void;
  handleCloudEventOperation(this:unknown,params:Record<string,unknown>):Promise<unknown>;
  publishCloudCommandFailure(this:unknown,claim:Pick<CloudCommandClaim,"commandId"|"conversationId"|"payload"> & {executionId:string|null},code:string,error?:unknown):void;
};
let root:string;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"zeros-command-admit-"));setZerosDbPathForTesting(path.join(root,"state.db"));await mkdir(path.join(root,"workspace"));});
afterEach(async()=>{closeZerosDb();setZerosDbPathForTesting(null);await rm(root,{recursive:true,force:true});});
function fixture(){
  upsertChat({id:"conversation",folder:path.join(root,"workspace"),agentId:"cursor",agentName:"Cursor",model:"old-model",effort:"low",
    permissionMode:"auto",lastModeId:null,prePlanModeId:null,fast:false,additionalDirectories:[],title:"test",createdAt:1,updatedAt:1,
    sessionId:null,providerBinding:null,providerMetadata:null,pinned:false,archived:false,sourceChatId:null,kind:"chat"});
  const claim:CloudCommandClaim={commandId:randomUUID(),claimId:randomUUID(),conversationId:"conversation",executionId:randomUUID(),dispatchAllowed:true,
    actor:{userId:randomUUID(),deviceId:randomUUID(),deviceKeyVersion:1,fingerprint:"a".repeat(64),role:"developer"},
    payload:{agentId:"cursor",agentCredentialGrantId:randomUUID(),model:"grok-4.6",effort:"xhigh",fast:true,userMessageId:randomUUID(),modeRevision:0,prompt:[{type:"text",text:"test"}]}};
  const captures:Spawn[]=[];
  const engine={root:path.join(root,"workspace"),cloudWorker:{version:3},cloudCommandAdmissions:new WeakMap(),cloudCommandSessions:new Map(),
    cloudGoals:new CloudGoalRecorder(async(claim,_sequence,goal)=>({version:1,conversationId:claim.conversationId,revision:1,goal})),
    conversationExecution:new Map<string,string>(),sessionAgent:new Map<string,string>(),activePromptContexts:new Map(),retiringCloudExecutions:new Set<string>(),
    agents:{cloudNativeCapabilities:vi.fn(()=>undefined),endSession:vi.fn(async(_agentId:string,_executionId:string,_options?:{failClosed?:boolean})=>{}),cancel:vi.fn(async()=>{})},broadcast:vi.fn(),handleCloudRuntimeAuthorityLoss:vi.fn(),
    validateCloudCommand:methods.validateCloudCommand,workspace:{workspaceIdForCwd:()=>"workspace"},
    assertRemoteWorkspaceOperable:vi.fn(()=>path.join(root,"workspace")),invalidateConversationBind:vi.fn(),markCancelIntent:vi.fn(),
    clearAgentExecutionRoute:vi.fn((id:string)=>{engine.sessionAgent.delete(id);if(engine.conversationExecution.get("conversation")===id)engine.conversationExecution.delete("conversation");}),
    handleAgentMessage:vi.fn(async(message:Start,client:TransportClient)=>{
      captures.push(await methods.agentSpawnOpts.call(engine,message,client,"newSession"));
      engine.conversationExecution.set("conversation",claim.executionId);engine.sessionAgent.set(claim.executionId,"cursor");
    }),
  };
  return {claim,engine,captures};
}
function failingRetirement(engine:ReturnType<typeof fixture>["engine"],executionId:string){
  const gateway=new AgentGateway({projectRoot:root,executionBoundary:testExecutionBoundary(),events:{
    onSessionUpdate:()=>{},onPermissionRequest:()=>{},onQuestionRequest:()=>{},onAgentStderr:()=>{},onAgentExit:()=>{},
  }});
  const state=gateway as unknown as {adapters:Map<string,AgentAdapter>;executionToAgent:Map<string,string>;executionBoundaries:Map<string,PreparedBoundary>};
  const proof=vi.fn(async()=>{throw new Error("descendant remains");});
  state.adapters.set("cursor",{agentId:"cursor",disposeSession:async()=>{}} as unknown as AgentAdapter);
  state.executionToAgent.set(executionId,"cursor");
  state.executionBoundaries.set(executionId,{revoke:async()=>{},stopAndProve:proof} as unknown as PreparedBoundary);
  engine.agents.endSession=vi.fn(gateway.endSession.bind(gateway));
  return proof;
}
describe("cloud engine credential admission",()=>{
  it.each([
    ["org_config_required_unavailable", "protocol-error", "cloud_provider_start_protocol_error"],
    ["org_config_refused", "auth-required", "cloud_provider_start_auth_required"],
  ] as const)("retains the known Claude %s remedy across cloud history reload", (reason, kind, code) => {
    const { claim, engine } = fixture();
    upsertChat({ ...getChat("conversation")!, agentId: "claude" });
    claim.payload = { ...claim.payload, agentId: "claude" };
    const failure = new AgentFailureError({ kind, stage: "newSession", agentId: "claude",
      message: "Native organization settings service returned an error. Try to sign in.",
      advice: CLAUDE_ORGANIZATION_STARTUP_MESSAGES[reason] });
    methods.publishCloudCommandFailure.call(engine, claim, code, failure);
    closeZerosDb();
    expect(windowChatMessages(claim.conversationId, 100).map(row => JSON.parse(row.payload))).toMatchObject([
      { recoveryFailure: { kind, message: failure.failure.message } },
      { code: reason, message: failure.failure.message, turnFailure: { kind } },
    ]);
    expect(engine.broadcast).toHaveBeenCalledWith(expect.objectContaining({ error: code, failure: expect.objectContaining({ kind }) }));
  });

  it.each([
    undefined, ...[false, true].flatMap(autoMemoryEnabled => [false, true].map(idleCompactionEnabled => ({ autoMemoryEnabled, idleCompactionEnabled }))),
  ])("derives Claude preference env from the admitted durable command, including legacy commands (%j)", async claudePreferences => {
    const { claim, engine, captures } = fixture();
    upsertChat({ ...getChat("conversation")!, agentId: "claude" });
    claim.payload = { ...claim.payload, agentId: "claude", model: "claude-haiku-4-5", ...(claudePreferences ? { claudePreferences } : {}) };
    engine.handleAgentMessage.mockImplementation(async (message, client) => {
      captures.push(await methods.agentSpawnOpts.call(engine, message, client, "newSession"));
      engine.conversationExecution.set("conversation", claim.executionId);
      engine.sessionAgent.set(claim.executionId, "claude");
    });
    await methods.prepareCloudCommand.call(engine, claim);
    const expected = { ZEROS_CLAUDE_AUTO_MEMORY: claudePreferences?.autoMemoryEnabled === false ? "0" : "1",
      ZEROS_CLAUDE_IDLE_COMPACTION: claudePreferences?.idleCompactionEnabled === true ? "1" : "0" };
    expect(engine.handleAgentMessage.mock.calls[0]?.[0].env).toMatchObject(expected);
    expect(captures[0]?.env).toMatchObject(expected);
  });

  it("keeps a typed startup refusal instead of replacing it with generic admission failure", async () => {
    const { claim, engine } = fixture();
    const failure = new CloudCommandFailureError({ stage: "containment", category: "canary_failed" });
    engine.handleAgentMessage.mockImplementationOnce(async (_message, client) => {
      client.send({ type: "AGENT_ERROR", code: failure.code, message: failure.failure.message, failure: failure.failure } as never);
    });
    await expect(methods.prepareCloudCommand.call(engine, claim)).rejects.toMatchObject({ code: failure.code });
  });
  it("retains the provider failure kind in the receipt", async () => {
    const { claim, engine } = fixture(); await methods.prepareCloudCommand.call(engine, claim);
    engine.handleAgentMessage.mockImplementationOnce(async (_message, client) => {
      client.send({ type: "AGENT_PROMPT_FAILED", error: "Provider verification required",
        failure: { kind: "verification-required", stage: "prompt", message: "Verify the provider account" } } as never);
    });
    expect(await methods.dispatchCloudCommand.call(engine, claim)).toMatchObject({ state: "failed", resultCode: "cloud_provider_prompt_verification_required" });
  });
  it("saves and broadcasts a turn-owned startup error before a device can hydrate", () => {
    const { claim, engine } = fixture();
    methods.publishCloudCommandFailure.call(engine, claim, "cloud_admission_authority_http_4xx");
    const messages = windowChatMessages(claim.conversationId, 100).map(row => JSON.parse(row.payload));
    expect(messages).toMatchObject([
      { id: claim.payload.userMessageId, role: "user", text: "test", recoveryFailure: { kind: "protocol-error" } },
      { kind: "error_notice", recoverable: false, turnFailure: { turnId: claim.payload.userMessageId, kind: "protocol-error" } },
    ]);
    expect(engine.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "AGENT_PROMPT_FAILED", requestId: claim.commandId,
      error: "cloud_admission_authority_http_4xx", failure: { kind: "protocol-error", message: expect.any(String), agentId: "cursor", stage: "initialize" } }));
  });
  it("retains the same terminal error through repeated recovery and a database reopen", () => {
    const { claim, engine } = fixture(), now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(10);
      methods.publishCloudCommandFailure.call(engine, claim, "command_dispatch_rejected");
      const saved = windowChatMessages(claim.conversationId, 100);
      closeZerosDb();
      now.mockReturnValue(20);
      methods.publishCloudCommandFailure.call(engine, claim, "command_dispatch_rejected");
      expect(windowChatMessages(claim.conversationId, 100)).toEqual(saved);
      expect(saved.map(row => JSON.parse(row.payload))).toMatchObject([
        { id: claim.payload.userMessageId, recoveryFailure: { message: expect.stringContaining("Review the conversation") } },
        { turnFailure: { turnId: claim.payload.userMessageId }, message: expect.stringContaining("Review the conversation") },
      ]);
    } finally { now.mockRestore(); }
  });
  it("hydrates an uncertain old-engine receipt into durable VM history without invoking a provider", async () => {
    const { claim, engine } = fixture(), dispatch = vi.fn();
    const receipt = { commandId: claim.commandId, position: 1, state: "uncertain" as const, payload: claim.payload,
      executionId: claim.executionId, generation: 1, resultCode: "engine_interrupted", createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString() };
    const runtime = new CloudCommandRuntime({
      request: async input => input.kind === "claim" ? null : { version: 1, conversationId: claim.conversationId,
        revision: 1, paused: false, pending: [], receipts: [receipt] },
      validate: () => {}, execution: () => null, dispatch, cancel: async () => {}, changed: () => {},
      interrupted: (conversationId, row) => { if (row.payload) methods.publishCloudCommandFailure.call(engine,
        { conversationId, commandId: row.commandId, executionId: row.executionId, payload: row.payload }, "engine_interrupted"); },
    });
    try {
      await runtime.handle({ kind: "snapshot", conversationId: claim.conversationId });
      closeZerosDb();
      expect(windowChatMessages(claim.conversationId, 100).map(row => JSON.parse(row.payload))).toMatchObject([
        { id: claim.payload.userMessageId, recoveryFailure: { kind: "protocol-error", message: expect.stringContaining("Review the conversation") } },
        { code: "engine_interrupted", turnFailure: { turnId: claim.payload.userMessageId } },
      ]);
      expect(dispatch).not.toHaveBeenCalled(); expect(engine.handleAgentMessage).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });
  it("preserves another actor's retained execution when a claim fails validation before admission",async()=>{
    const {claim,engine}=fixture(),incoming={...claim,actor:{...claim.actor!,userId:randomUUID()}};
    engine.conversationExecution.set("conversation",claim.executionId);engine.sessionAgent.set(claim.executionId,"cursor");
    Object.assign(engine.agents,{hasRetainedCloudExecution:()=>true});
    let claimed=false;
    const request=vi.fn(async(input:CloudCommandEngineRequest)=>{
      if(input.kind==="claim"){
        if(claimed)return null;claimed=true;setChatComposerMode("conversation","design",0);
        return {...incoming,claimId:input.claimId,executionId:input.executionId};
      }
      return {version:1,conversationId:"conversation",revision:1,paused:false,pending:[],receipts:[]};
    });
    const prepare=vi.fn((c:CloudCommandClaim)=>methods.prepareCloudCommand.call(engine,c)),release=vi.fn(),dispatch=vi.fn(async()=>({state:"succeeded" as const,resultCode:null}));
    const runtime=new CloudCommandRuntime({request,validate:(id,payload)=>methods.validateCloudCommand.call(engine,id,payload),execution:()=>claim.executionId,
      retainedExecution:()=>claim.executionId,releaseRetainedExecution:release,prepare,retire:(c,result)=>methods.retireCloudCommand.call(engine,c,result.state==="succeeded"),
      dispatch,cancel:async()=>{},changed:()=>{}});
    try{
      runtime.kick("conversation");await vi.waitFor(()=>expect(request.mock.calls.some(([r])=>r.kind==="settle")).toBe(true));
      expect(prepare).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(engine.agents.endSession).not.toHaveBeenCalled();
      expect(engine.conversationExecution.get("conversation")).toBe(claim.executionId);expect(release).toHaveBeenCalledWith(claim.executionId);
    }finally{runtime.close();}
  });
  it("retains cleanup authority when a new provider launch fails after admission began",async()=>{
    const {claim,engine}=fixture();engine.handleAgentMessage.mockRejectedValueOnce(new Error("native launch failed"));
    await expect(methods.prepareCloudCommand.call(engine,claim)).rejects.toThrow("native launch failed");
    await methods.retireCloudCommand.call(engine,claim,false);
    expect(engine.agents.endSession).toHaveBeenCalledWith("cursor",claim.executionId,{failClosed:true});
  });
  it("marks deferred background retirement as intentional until the descendant proof finishes",async()=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    let retire!:()=>Promise<void>;
    Object.assign(engine.agents,{completeCloudForeground:vi.fn(async(_a:string,_e:string,callback:()=>Promise<void>)=>{retire=callback;return true;})});
    await methods.retireCloudCommand.call(engine,claim);
    engine.agents.endSession.mockImplementation(async()=>{expect(engine.retiringCloudExecutions.has(claim.executionId)).toBe(true);});
    await retire();expect(engine.agents.endSession).toHaveBeenCalledOnce();expect(engine.retiringCloudExecutions.size).toBe(0);
  });
  it("proves retained descendant retirement even if native cancellation fails",async()=>{
    const {claim,engine}=fixture();engine.conversationExecution.set("conversation",claim.executionId);engine.sessionAgent.set(claim.executionId,"cursor");
    Object.assign(engine.agents,{hasRetainedCloudExecution:()=>true});engine.agents.cancel.mockRejectedValueOnce(new Error("native cancel failed"));
    await expect(methods.cancelCloudCommandConversation.call(engine,"conversation")).rejects.toThrow("native cancel failed");
    expect(engine.agents.endSession).toHaveBeenCalledWith("cursor",claim.executionId,{failClosed:true});
  });
  it("settles the foreground without retiring a leased native background task",async()=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    Object.assign(engine.agents,{completeCloudForeground:vi.fn(async()=>true)});
    await methods.retireCloudCommand.call(engine,claim);
    expect(engine.agents.endSession).not.toHaveBeenCalled();
    expect(engine.conversationExecution.get("conversation")).toBe(claim.executionId);
    expect(engine.cloudCommandSessions.size).toBe(0);
  });
  it.each(["missing", "empty"])("retires an admitted execution when background inspection is %s",async inspection=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    if(inspection==="empty")Object.assign(engine.agents,{completeCloudForeground:vi.fn(async()=>false)});
    await methods.retireCloudCommand.call(engine,claim);
    expect(engine.agents.endSession).toHaveBeenCalledTimes(1);
    expect(engine.agents.endSession).toHaveBeenCalledWith("cursor",claim.executionId,{failClosed:true});
    expect(engine.conversationExecution.has("conversation")).toBe(false);
    expect(engine.cloudCommandSessions.size).toBe(0);
  });
  it("reuses the retained execution for an authorized next turn without releasing native history",async()=>{
    const {claim,engine}=fixture();
    engine.conversationExecution.set("conversation",claim.executionId);engine.sessionAgent.set(claim.executionId,"cursor");
    const resume=vi.fn(async()=>{});
    Object.assign(engine.agents,{hasRetainedCloudExecution:()=>true,resumeCloudExecution:resume});
    await methods.prepareCloudCommand.call(engine,claim);
    expect(resume).toHaveBeenCalledOnce();expect(engine.agents.endSession).not.toHaveBeenCalled();
    expect(engine.handleAgentMessage).not.toHaveBeenCalled();
  });
  it("does not retire another actor's background execution when reuse is rejected",async()=>{
    const {claim,engine}=fixture();
    engine.conversationExecution.set("conversation",claim.executionId);engine.sessionAgent.set(claim.executionId,"cursor");
    Object.assign(engine.agents,{hasRetainedCloudExecution:()=>true,resumeCloudExecution:vi.fn(async()=>{throw new Error("actor changed");})});
    await expect(methods.prepareCloudCommand.call(engine,claim)).rejects.toThrow("actor changed");
    await methods.retireCloudCommand.call(engine,claim);
    expect(engine.agents.endSession).not.toHaveBeenCalled();
    expect(engine.conversationExecution.get("conversation")).toBe(claim.executionId);
  });
  it("admits a transcript fork through the destination credential before settling",async()=>{
    const {claim,engine}=fixture(),source=getChat("conversation")!;
    upsertChat({...source,id:"source"});upsertChat({...source,sourceChatId:"source"});
    claim.payload.operation={version:1,kind:"fork",sourceConversationId:"source",strategy:"transcript"};
    await methods.prepareCloudCommand.call(engine,claim);
    expect(engine.handleAgentMessage).toHaveBeenCalledWith(expect.objectContaining({type:"AGENT_NEW_SESSION",chatId:"conversation"}),expect.anything(),0,true);
    expect(getChat("source")).toEqual({...source,id:"source"});
  });
  it("runs typed goals without creating a prompt turn and returns a durable snapshot",async()=>{
    const {claim,engine}=fixture();
    claim.payload.agentId="codex";
    claim.payload.operation={version:1,kind:"goal",action:"set",update:{objective:"Finish"}};
    const goal={objective:"Finish",status:"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    const setGoal=vi.fn(async()=>goal),clearGoal=vi.fn(async()=>{});
    Object.assign(engine.agents,{setGoal,getGoal:vi.fn(async()=>goal),clearGoal});
    engine.cloudCommandSessions.set(claim.commandId,{claim,controller:new AbortController()});
    expect(await methods.dispatchCloudCommand.call(engine,claim)).toEqual({state:"succeeded",resultCode:null,result:{version:1,goal}});
    expect(setGoal).toHaveBeenCalledWith("codex", claim.executionId, { objective: "Finish" }, "user");
    claim.payload.operation={version:1,kind:"goal",action:"clear"};
    await methods.dispatchCloudCommand.call(engine,claim);
    expect(clearGoal).toHaveBeenCalledWith("codex", claim.executionId, "user");
    expect(engine.handleAgentMessage).not.toHaveBeenCalled();
  });
  it("rejects a fork whose source belongs to a different workspace or was deleted",()=>{
    const {claim,engine}=fixture(),source=getChat("conversation")!;
    upsertChat({...source,id:"destination",sourceChatId:"conversation"});
    claim.conversationId="destination";
    claim.payload.operation={version:1,kind:"fork",sourceConversationId:"conversation",strategy:"transcript"};
    expect(()=>methods.validateCloudCommand.call(engine,"destination",claim.payload)).not.toThrow();
    upsertChat({...source,folder:root});
    expect(()=>methods.validateCloudCommand.call(engine,"destination",claim.payload)).toThrow();
    deleteChat("conversation");
    expect(()=>methods.validateCloudCommand.call(engine,"destination",claim.payload)).toThrow();
  });
  it("includes confirmed live session metadata in a reconnect snapshot without admitting work", async () => {
    const { engine, claim } = fixture();
    engine.conversationExecution.set("conversation", claim.executionId);
    const session = { modes: { currentModeId: "ask", availableModes: [] } };
    const initialize = { protocolVersion: 1, agentCapabilities: { steering: true } };
    Object.assign(engine, { cloudEvents: { snapshot: (capture: () => unknown) => ({ snapshot: capture() }) },
      sessionLoadResponses: new Map([[claim.executionId, session]]), pendingPermissionRequests: new Map(), pendingQuestionRequests: new Map() });
    Object.assign(engine.agents, { agentInitializeSnapshot: vi.fn(() => initialize) });
    expect(await methods.handleCloudEventOperation.call(engine, { request: { kind: "snapshot", conversationId: "conversation" } })).toMatchObject({
      snapshot: { executionId: claim.executionId, session, initialize },
    });
    expect(engine.handleAgentMessage).not.toHaveBeenCalled();
  });
  it("restores durable background tasks alongside session modes without overwriting newer native tasks",async()=>{
    const {engine,claim}=fixture();engine.conversationExecution.set("conversation",claim.executionId);
    const session={modes:{currentModeId:"ask",availableModes:[]}},task={taskId:"child",name:"Child",startedAt:1,updatedAt:1};
    const durable={sessionUpdate:"background_tasks_update",tasks:[task],waiting:true};
    const sessions=new Map<string,Record<string,unknown>>([[claim.executionId,session]]);
    Object.assign(engine,{cloudEvents:{snapshot:(capture:()=>unknown)=>({snapshot:capture()})},sessionLoadResponses:sessions,
      pendingPermissionRequests:new Map(),pendingQuestionRequests:new Map()});
    Object.assign(engine.agents,{readCloudBackgroundTasks:vi.fn(async()=>durable),agentInitializeSnapshot:()=>null});
    const request={request:{kind:"snapshot",conversationId:"conversation"}};
    expect(await methods.handleCloudEventOperation.call(engine,request)).toMatchObject({snapshot:{session:{...session,backgroundTasks:durable}}});
    const newer={...durable,tasks:[]};sessions.set(claim.executionId,{...session,backgroundTasks:newer});
    expect(await methods.handleCloudEventOperation.call(engine,request)).toMatchObject({snapshot:{session:{backgroundTasks:newer}}});
  });
  it("attempts strict retirement and quarantines when native cancellation fails",async()=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    engine.agents.cancel.mockRejectedValueOnce(new Error("cancel proof failed"));
    await expect(methods.cancelCloudCommandConversation.call(engine,"conversation")).rejects.toThrow("cancel proof failed");
    expect(engine.agents.endSession).toHaveBeenCalledWith("cursor",claim.executionId,{failClosed:true});
    expect(engine.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();
    expect(engine.cloudCommandSessions.size).toBe(1);
  });
  it("retains the deletion fence and metadata after uncertain cancellation",async()=>{
    const {engine}=fixture(),remove=vi.fn(),deletions=new Set();
    Object.assign(engine,{cloudCommands:{handle:vi.fn(async()=>({}))},cloudConversationDeletions:deletions,
      cancelCloudCommandConversation:vi.fn(async()=>{throw new Error("uncertain cancellation");}),sessionChat:new Map()});
    const client={cloudActor:{sessionId:"actor"},authorized:()=>true} as unknown as TransportClient;
    await expect(methods.deleteCloudConversation.call(engine,"conversation",randomUUID(),client,remove)).rejects.toThrow("uncertain");
    expect(engine.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();expect(deletions.has("conversation")).toBe(true);
    expect(remove).not.toHaveBeenCalled();expect(getChat("conversation")).not.toBeNull();
  });
  it("accepts an authorized retry of an already deleted conversation",async()=>{
    const {engine}=fixture(),remove=vi.fn(async()=>({ok:true}));deleteChat("conversation");
    Object.assign(engine,{cloudCommands:{handle:vi.fn()},cloudConversationDeletions:new Set()});
    const client={cloudActor:{sessionId:"actor"},authorized:()=>true} as unknown as TransportClient;
    await expect(methods.deleteCloudConversation.call(engine,"conversation",randomUUID(),client,remove)).resolves.toEqual({ok:true});
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not forget a real Gateway boundary that cannot prove retirement",async()=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    const receiver=engine.handleAgentMessage.mock.calls[0]![1];
    const proof=failingRetirement(engine,claim.executionId);
    await expect(methods.retireCloudCommand.call(engine,claim)).rejects.toThrow("descendant remains");
    expect(proof).toHaveBeenCalledOnce();expect(engine.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();
    expect(engine.cloudCommandSessions.size).toBe(1);expect(engine.cloudCommandAdmissions.has(receiver)).toBe(true);
  });
  it("quarantines instead of replacing an idle execution without retirement proof",async()=>{
    const {claim,engine}=fixture();engine.conversationExecution.set("conversation","old");engine.sessionAgent.set("old","cursor");
    failingRetirement(engine,"old");
    await expect(methods.prepareCloudCommand.call(engine,claim)).rejects.toThrow("descendant remains");
    expect(engine.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();expect(engine.handleAgentMessage).not.toHaveBeenCalled();
    expect(engine.conversationExecution.get("conversation")).toBe("old");
  });
  it("starts from the persisted conversation and exact command actor without a device or ambient key",async()=>{
    const {claim,engine,captures}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    expect(engine.handleAgentMessage.mock.calls[0]?.[0]).toMatchObject({id:claim.commandId,type:"AGENT_NEW_SESSION",chatId:"conversation",workspaceId:"workspace"});
    expect(captures[0]).toEqual({cwd:path.join(root,"workspace"),workspaceId:"workspace",env:{ZEROS_THINKING_EFFORT:"xhigh",ZEROS_FAST_MODE:"1",ZEROS_PERMISSION_MODE:"auto"},
      cloudExecutionId:claim.executionId,cloudExecution:{delegationId:claim.payload.agentCredentialGrantId,model:"grok-4.6",source:{kind:"command",commandId:claim.commandId,claimId:claim.claimId}}});
    const receiver=engine.handleAgentMessage.mock.calls[0]![1];expect(receiver.accountUserId).toBe(claim.actor!.userId);
    await methods.retireCloudCommand.call(engine,claim);expect(engine.agents.endSession).toHaveBeenCalledWith("cursor",claim.executionId,{failClosed:true});
    expect(engine.cloudCommandSessions.size).toBe(0);expect(engine.cloudCommandAdmissions.has(receiver)).toBe(false);
  });
  it("retires a previous idle process and cold-resumes the saved native identity",async()=>{
    const {claim,engine}=fixture(),chat=getChat("conversation")!;
    upsertChat({...chat,providerBinding:{version:1,kind:"native",providerId:"cursor",resumeId:"native-history"}});
    engine.conversationExecution.set("conversation","old");engine.sessionAgent.set("old","cursor");
    await methods.prepareCloudCommand.call(engine,claim);
    expect(engine.agents.endSession).toHaveBeenCalledWith("cursor","old",{failClosed:true});
    expect(engine.handleAgentMessage.mock.calls[0]?.[0]).toMatchObject({id:claim.commandId,type:"AGENT_LOAD_SESSION",providerBinding:{resumeId:"native-history"}});
    await methods.retireCloudCommand.call(engine,claim);
  });
  it("rejects unsigned claims and client-created receiver lookalikes before admission",async()=>{
    const {claim,engine}=fixture();
    await expect(methods.prepareCloudCommand.call(engine,{...claim,actor:undefined})).rejects.toThrow("authority");
    const receiver:TransportClient={id:`cloud-command:${claim.commandId}`,kind:"cloud",send:vi.fn(),close:vi.fn(),cloudCommandActor:claim.actor};
    await expect(methods.agentSpawnOpts.call(engine,{id:randomUUID(),source:"browser",timestamp:Date.now(),type:"AGENT_NEW_SESSION",agentId:"cursor",chatId:"conversation",env:{CURSOR_API_KEY:"injected"}},receiver,"newSession")).rejects.toThrow("admitted durable command");
    expect(engine.agents.endSession).not.toHaveBeenCalled();
  });
  it("retains cleanup ownership and quarantines after unproven retirement",async()=>{
    const {claim,engine}=fixture();await methods.prepareCloudCommand.call(engine,claim);
    engine.agents.endSession.mockRejectedValueOnce(new Error("proof failed"));
    await expect(methods.retireCloudCommand.call(engine,claim)).rejects.toThrow("proof failed");
    expect(engine.handleCloudRuntimeAuthorityLoss).toHaveBeenCalledOnce();expect(engine.cloudCommandSessions.size).toBe(1);
    await methods.retireCloudCommand.call(engine,claim);
  });
});
