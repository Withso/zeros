import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CloudCommandClaim,CloudCommandResult} from "@zeros/protocol/cloud-commands";
import type {AgentGoal,SessionNotification} from "@zeros/protocol/agent-events";
import {ZerosEngine} from "../zeros-engine";
import type {AgentGateway} from "../agents/gateway";
import {closeZerosDb,setZerosDbPathForTesting} from "../db";
import {getChat,upsertChat} from "../db/chats";
import {CloudAgentConnection} from "../../renderer/platform/bridge/cloud-agent-connection";
import type {RuntimeClient} from "../../renderer/platform/bridge/ws-client";
import type {WireRecord} from "../../renderer/platform/bridge/cloud-runtime-wire";

const goal:AgentGoal={objective:"Finish the task",status:"active",tokenBudget:1000,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
const capabilities={version:1 as const,goals:true,nativeFork:true,transcriptFork:true,nativeReview:true,connectedApps:false,multiAgent:true};
const binding={version:1 as const,providerId:"codex",kind:"native" as const,resumeId:"empty-native-thread"};
type State={
  cloudWorker:unknown;cloudCommands:unknown;
  cloudCommandSessions:Map<string,unknown>;sessionAgent:Map<string,string>;sessionChat:Map<string,string>;
  agents:Pick<AgentGateway,"cloudNativeCapabilities"|"getGoal"> & {events:{onSessionUpdate(agentId:string,notification:SessionNotification):void}};
  persistProviderIdentityForChat(chatId:string,agentId:string,providerBinding:typeof binding):void;
  dispatchCloudCommand(claim:CloudCommandClaim):Promise<CloudCommandResult>;
  handleAgentMessage:(_message:unknown,receiver:{send(message:unknown):void})=>Promise<void>;
};
let root:string;
beforeEach(()=>{root=mkdtempSync(path.join(os.tmpdir(),"zeros-native-state-"));setZerosDbPathForTesting(path.join(root,"zeros.db"));});
afterEach(()=>{closeZerosDb();setZerosDbPathForTesting(null);rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function fixture(){
  upsertChat({id:"conversation",folder:root,agentId:"codex",agentName:"Codex",model:"test-model",effort:"high",permissionMode:"auto",lastModeId:null,prePlanModeId:null,fast:false,additionalDirectories:[],title:"Fork",createdAt:1,updatedAt:1,sessionId:null,providerBinding:null,providerMetadata:null,pinned:false,archived:false,sourceChatId:"source",kind:"chat"});
  const claim:CloudCommandClaim={commandId:randomUUID(),claimId:randomUUID(),conversationId:"conversation",executionId:randomUUID(),payload:{agentId:"codex",model:"test-model",agentCredentialGrantId:randomUUID(),userMessageId:randomUUID(),modeRevision:0,prompt:[{type:"text",text:"work"}]}};
  const engine=new ZerosEngine({root,port:29898}) as unknown as State;
  engine.cloudWorker={version:3};engine.cloudCommandSessions.set(claim.commandId,{claim,controller:new AbortController()});
  engine.sessionAgent.set(claim.executionId,"codex");engine.sessionChat.set(claim.executionId,claim.conversationId);
  return {engine,claim};
}
describe("cloud native state across retirement",()=>{
  it("leaves an admitted transcript destination unbound until its first real prompt",()=>{
    const {engine,claim}=fixture();claim.payload.operation={version:1,kind:"fork",sourceConversationId:"source",strategy:"transcript"};
    engine.persistProviderIdentityForChat("conversation","codex",binding);
    expect(getChat("conversation")?.providerBinding).toBeNull();expect(getChat("conversation")?.sessionId).toBeNull();
    // The admission execution retires. The next command must start fresh;
    // only that real prompt is allowed to publish its resumable binding.
    engine.cloudCommandSessions.clear();
    engine.persistProviderIdentityForChat("conversation","codex",{...binding,resumeId:"prompt-thread"});
    expect(getChat("conversation")?.providerBinding?.resumeId).toBe("prompt-thread");
  });
  it.each(["cancelled","failed"] as const)("reloads a confirmed live goal clear/set after %s without a post-Stop provider read",async outcome=>{
    const {engine,claim}=fixture();
    let confirmed:unknown;
    const confirmGoal=vi.fn(async(_claim:CloudCommandClaim,_sequence:number,value:AgentGoal|null)=>{
      confirmed={version:1,conversationId:claim.conversationId,revision:10,goal:value};return confirmed;
    });
    engine.cloudCommands={confirmGoal};
    vi.spyOn(engine.agents,"cloudNativeCapabilities").mockReturnValue(capabilities);
    const getGoal=vi.spyOn(engine.agents,"getGoal").mockRejectedValue(new Error("lease retired"));
    const next=outcome==="cancelled"?null:{...goal,objective:"Confirmed replacement",status:"paused" as const};
    engine.handleAgentMessage=async(_message,receiver)=>{
      // The real gateway event callback observes the native acknowledgement
      // before Stop/failure revokes the provider and its lease.
      engine.agents.events.onSessionUpdate("codex",{sessionId:claim.executionId,update:{sessionUpdate:"goal_update",goal:next}});
      const identity = { agentId: "codex", requestId: claim.commandId, executionId: claim.executionId, sessionId: claim.executionId };
      receiver.send(outcome==="cancelled"?{ ...identity, type:"AGENT_PROMPT_COMPLETE",stopReason:"cancelled",response:{stopReason:"cancelled",userMessageId:claim.payload.userMessageId}}
        :{ ...identity, type:"AGENT_PROMPT_FAILED",error:"Native protocol failure",failure:{kind:"protocol-error",stage:"prompt",message:"Native protocol failure"}});
    };
    const result=await engine.dispatchCloudCommand(claim);
    expect(result.state).toBe(outcome);
    const receipt={commandId:randomUUID(),position:1,state:"succeeded",payload:null,executionId:"old",generation:1,resultCode:null,createdAt:"2026-09-29T00:00:00Z",updatedAt:"2026-09-29T00:00:01Z",result:{version:1,goal}};
    const request=vi.fn(async(message:WireRecord)=>({type:"WORKSPACE_RESPONSE",result:message.op==="cloudCommands.conversation"?{conversationId:claim.conversationId,modeRevision:0,nativeCommandsVersion:1}:message.op==="cloudEvents.request"?{snapshot:{conversationId:claim.conversationId,activeTurn:null}}:{version:1,conversationId:claim.conversationId,revision:10,paused:true,pending:[],receipts:[receipt],...(confirmed?{nativeGoal:confirmed}:{})}}));
    const connection=new CloudAgentConnection({request,status:"connected"} as unknown as RuntimeClient,"local-main",async()=>randomUUID()),update=vi.fn();
    connection.on("AGENT_SESSION_UPDATE",update);
    try{
      await connection.request({type:"AGENT_LOAD_SESSION",agentId:"codex",chatId:claim.conversationId,env:{OPENAI_MODEL:"test-model"}});
      await vi.waitFor(()=>expect(update).toHaveBeenCalled());
      expect((update.mock.calls.at(-1)?.[0] as WireRecord).notification).toMatchObject({update:{goal:next}});
      expect(confirmGoal).toHaveBeenCalled();expect(getGoal).not.toHaveBeenCalled();
    }finally{connection.dispose();}
  });
});
