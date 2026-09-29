import {describe,expect,it,vi} from "vitest";
import {composerCommandsFor} from "@zeros/protocol/agent-events";
import {cloudWorkspaceKey} from "../../../platform/bridge/cloud-workspace-key";
import {filterCloudNativeCommands} from "../cloud-native-ui";
import {admitTranscriptFork} from "../fork-chat";
const cwd=cloudWorkspaceKey({organizationId:"11111111-1111-4111-8111-111111111111",workspaceId:"22222222-2222-4222-8222-222222222222"});
describe("cloud native UI admission",()=>{
  it("hides unqualified goals and native review while preserving Local commands",()=>{
    const commands=composerCommandsFor("codex");
    expect(filterCloudNativeCommands(commands,"/local",undefined)).toBe(commands);
    expect(filterCloudNativeCommands(commands,cwd,undefined).map(row=>row.name)).not.toEqual(expect.arrayContaining(["goal","review"]));
    const capabilities={version:1 as const,goals:true,nativeReview:true,nativeFork:false,transcriptFork:true,connectedApps:false,multiAgent:false};
    expect(filterCloudNativeCommands(commands,cwd,capabilities).map(row=>row.name)).toEqual(expect.arrayContaining(["goal","review"]));
  });
  it.each(["claude","cursor","codex"])("admits an explicit cloud transcript handoff for %s without copying a provider binding",async agentId=>{
    const request=vi.fn(async()=>({type:"AGENT_CONVERSATION_FORKED"}));
    await admitTranscriptFork({folder:cwd,id:"source",agentId},{id:"destination"},request);
    expect(request).toHaveBeenCalledWith({type:"AGENT_FORK_CONVERSATION",sourceChatId:"source",destinationChatId:"destination",agentId,forkStrategy:"transcript"});
    await admitTranscriptFork({folder:"/local",id:"source",agentId},{id:"local-destination"},request);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
