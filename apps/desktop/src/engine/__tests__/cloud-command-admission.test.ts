import {mkdtemp,mkdir,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CloudCommandClaim} from "@zeros/protocol/cloud-commands";
import type {AgentNewSessionMessage,AgentLoadSessionMessage} from "@zeros/protocol/messages";
import {ZerosEngine} from "../zeros-engine";
import type {TransportClient} from "../transport/types";
import {closeZerosDb,setZerosDbPathForTesting} from "../db";
import {deleteChat,getChat,upsertChat} from "../db/chats";
import type {CloudAgentSelection} from "../agents/cloud-provider-execution";
import {AgentGateway} from "../agents/gateway";
import type {AgentAdapter} from "../agents/types";
import type {PreparedBoundary} from "../agents/containment/types";
import {testExecutionBoundary} from "../agents/__tests__/helpers/test-execution-boundary";

type Start=AgentNewSessionMessage|AgentLoadSessionMessage;
type Spawn={cloudExecution?:CloudAgentSelection;cloudExecutionId?:string;env?:Record<string,string>;cwd?:string};
const methods=ZerosEngine.prototype as unknown as {
  prepareCloudCommand(this:unknown,claim:CloudCommandClaim):Promise<void>;
  retireCloudCommand(this:unknown,claim:CloudCommandClaim):Promise<void>;
  cancelCloudCommandConversation(this:unknown,id:string):Promise<void>;
  deleteCloudConversation(this:unknown,id:string,operationId:string,client:TransportClient,remove:()=>Promise<unknown>):Promise<unknown>;
  agentSpawnOpts(this:unknown,message:Start,client:TransportClient,stage:string):Promise<Spawn>;
  validateCloudCommand(this:unknown,id:string,payload?:unknown):void;
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
    conversationExecution:new Map<string,string>(),sessionAgent:new Map<string,string>(),activePromptContexts:new Map(),
    agents:{endSession:vi.fn(async(_agentId:string,_executionId:string,_options?:{failClosed?:boolean})=>{}),cancel:vi.fn(async()=>{})},broadcast:vi.fn(),handleCloudRuntimeAuthorityLoss:vi.fn(),
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
    expect(captures[0]).toEqual({cwd:path.join(root,"workspace"),workspaceId:"workspace",env:{ZEROS_THINKING_EFFORT:"xhigh",ZEROS_FAST_MODE:"1"},
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
