import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";
import type { EngineMessage } from "../types";

const handle=(ZerosEngine.prototype as unknown as {
  handleMessage(this:unknown,message:EngineMessage,client:TransportClient):Promise<void>;
}).handleMessage;
function fixture(role:NonNullable<TransportClient["cloudActor"]>["role"]="viewer") {
  const client:TransportClient={id:randomUUID(),kind:"cloud",accountUserId:randomUUID(),
    cloudActor:{sessionId:randomUUID(),deviceId:randomUUID(),role,fingerprint:"a".repeat(64)},authorized:()=>true,send:vi.fn(),close:vi.fn()};
  const engine={accountAuth:null,clientAccount:new Map(),
    workspace:{remoteReadable:(op:string)=>["file.read","git.status"].includes(op),
      isWriteOp:(op:string)=>["file.write","git.commit","mcp.gateway.setHeaderSecret"].includes(op),
      isRemoteAllowed:(op:string)=>["file.read","git.status","file.write","git.commit","chats.upsert","mcp.gateway.setHeaderSecret"].includes(op)},
    handleAgentMessage:vi.fn(),handleWorkspaceMessage:vi.fn(),handlePtyCreate:vi.fn(),
    mayOperateTerminal:vi.fn(()=>true),pty:{write:vi.fn(),resize:vi.fn(),kill:vi.fn(),has:()=>true},explicitlyClosing:new Set()};
  const send=(body:Record<string,unknown>)=>handle.call(engine,{id:randomUUID(),timestamp:Date.now(),source:"browser",...body} as EngineMessage,client);
  return {client,engine,send};
}
describe("actor roles at the worker message boundary",()=>{
  it("admits Design inspection, editing and registration with separate roles",async()=>{
    for(const role of ["viewer","prompter","developer","manager","owner"] as const){
      const f=fixture(role);
      await f.send({type:"WORKSPACE_REQUEST",op:"design.foundation.open",params:{workspaceId:"local-main",frame:"frame.html"}});
      expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledOnce();f.engine.handleWorkspaceMessage.mockClear();
      await f.send({type:"WORKSPACE_REQUEST",op:"design.frame.create",params:{workspaceId:"local-main",title:"Frame"}});
      expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledTimes(["developer","manager","owner"].includes(role)?1:0);f.engine.handleWorkspaceMessage.mockClear();
      await f.send({type:"WORKSPACE_REQUEST",op:"design.initialize",params:{workspaceId:"local-main"}});
      expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledTimes(["manager","owner"].includes(role)?1:0);
    }
  });
  it("requires current edit authority and a typed language request",async()=>{
    for(const role of ["viewer","prompter","developer","manager","owner"] as const){
      const f=fixture(role);await f.send({type:"WORKSPACE_REQUEST",op:"cloudLsp.request",params:{request:{kind:"start",language:"python"}}});
      expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledTimes(["developer","manager","owner"].includes(role)?1:0);
      f.engine.handleWorkspaceMessage.mockClear();
      await f.send({type:"WORKSPACE_REQUEST",op:"cloudLsp.request",params:{request:{kind:"executeCommand",language:"python"}}});
      expect(f.engine.handleWorkspaceMessage).not.toHaveBeenCalled();
    }
  });
  it("allows a viewer to close its own cloud view without running an agent",async()=>{
    const f=fixture();await f.send({type:"AGENT_CLOSE_SESSION",agentId:"claude",chatId:"chat"});
    expect(f.engine.handleAgentMessage).toHaveBeenCalledOnce();
  });
  it("rejects viewer writes, provider calls, terminal control and unknown operations before dispatch",async()=>{
    const f=fixture();
    for(const body of [
      {type:"WORKSPACE_REQUEST",op:"file.write"},{type:"WORKSPACE_REQUEST",op:"chats.upsert"},
      {type:"WORKSPACE_REQUEST",op:"cloudCommands.createConversation"},{type:"WORKSPACE_REQUEST",op:"future.operation"},
      {type:"AGENT_NEW_SESSION",agentId:"claude"},{type:"AGENT_GENERATE_TITLE",agentId:"claude"},
      {type:"AGENT_FUTURE_CALL",agentId:"claude"},{type:"PTY_CREATE"},{type:"PTY_WRITE",sessionId:"terminal",data:"whoami"},
    ]) await f.send(body);
    expect(f.engine.handleWorkspaceMessage).not.toHaveBeenCalled();expect(f.engine.handleAgentMessage).not.toHaveBeenCalled();
    expect(f.engine.handlePtyCreate).not.toHaveBeenCalled();expect(f.engine.pty.write).not.toHaveBeenCalled();
    expect(f.client.send).toHaveBeenCalled();
  });
  it("allows shared reads and separates prompting from direct file and terminal editing",async()=>{
    const viewer=fixture();await viewer.send({type:"WORKSPACE_REQUEST",op:"file.read"});
    expect(viewer.engine.handleWorkspaceMessage).toHaveBeenCalledOnce();
    const prompter=fixture("prompter");await prompter.send({type:"AGENT_NEW_SESSION",agentId:"claude"});
    await prompter.send({type:"WORKSPACE_REQUEST",op:"file.write"});await prompter.send({type:"PTY_CREATE"});
    expect(prompter.engine.handleAgentMessage).toHaveBeenCalledOnce();expect(prompter.engine.handleWorkspaceMessage).not.toHaveBeenCalled();
    expect(prompter.engine.handlePtyCreate).not.toHaveBeenCalled();
    const developer=fixture("developer");await developer.send({type:"WORKSPACE_REQUEST",op:"file.write"});await developer.send({type:"PTY_CREATE"});
    expect(developer.engine.handleWorkspaceMessage).toHaveBeenCalledOnce();expect(developer.engine.handlePtyCreate).toHaveBeenCalledOnce();
  });
  it("does not let owner or manager use the local credential or host-administration surface",async()=>{
    for(const role of ["owner","manager"] as const) {
      const f=fixture(role);
      for(const body of [
        {type:"AGENT_AUTHENTICATE",agentId:"claude"},{type:"AGENT_VALIDATE_KEY",agentId:"claude",apiKey:"fixture"},
        {type:"WORKSPACE_REQUEST",op:"mcp.gateway.setHeaderSecret"},
        {type:"WORKSPACE_REQUEST",op:"cloudReplica.apply"},{type:"WORKSPACE_REQUEST",op:"workspace.delete"},
      ]) await f.send(body);
      expect(f.engine.handleAgentMessage).not.toHaveBeenCalled();expect(f.engine.handleWorkspaceMessage).not.toHaveBeenCalled();
    }
  });
  it("classifies nested durable requests instead of treating their shared route as a read",async()=>{
    const f=fixture(),commandId=randomUUID();
    await f.send({type:"WORKSPACE_REQUEST",op:"cloudCommands.request",params:{request:{kind:"read",commandId}}});
    expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledOnce();
    await f.send({type:"WORKSPACE_REQUEST",op:"cloudCommands.request",params:{request:{kind:"stop",conversationId:"chat",operationId:randomUUID()}}});
    await f.send({type:"WORKSPACE_REQUEST",op:"cloudActions.request",params:{request:{kind:"settle"}}});
    expect(f.engine.handleWorkspaceMessage).toHaveBeenCalledOnce();
  });
});
