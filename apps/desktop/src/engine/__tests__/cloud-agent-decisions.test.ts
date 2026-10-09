import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import type { CloudActionDeliveryGuard } from "../cloud-action-runtime";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";

const prototype = ZerosEngine.prototype as unknown as {
  handleAgentMessage(this: unknown, message: EngineMessage, client: TransportClient): Promise<void>;
  isHostRelayClient(this: unknown, client: TransportClient): boolean;
  handleLegacyCloudAction(this: unknown, message: EngineMessage, client: TransportClient): Promise<void>;
  authorizeCloudAgentAction(this: unknown, executionId: string, actorSessionId?: string): Promise<void | CloudActionDeliveryGuard>;
};

function bootAuthorityFixture(foreignUser = false, afterAuthorize?: () => void) {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actorSessionId = randomUUID(), controller = new AbortController();
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true, time: { wall: () => 1_000_000, monotonic: () => 0 } });
  actors.confirm({ scope, actorSessionId, authorityEpoch: 1, confirmedUntilMs: 1_009_000, fundingConsentVersion: 1,
    fundingGrant: foreignUser ? { kind: "share", grantId: randomUUID(), grantRevision: 1 } : { kind: "owner" },
    actor: { userId: foreignUser ? randomUUID() : scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
      fingerprint: "a".repeat(64), role: foreignUser ? "developer" : "owner" } });
  const original = { executionId: "execution", actor: { userId: scope.fundingOwnerUserId } }, record = { claim: original, controller };
  let scheduled = false;
  const request = vi.fn(), authorizeActor = vi.fn((id: string, capability: "read" | "run") => {
    const actor = actors.authorizeCurrent(id, capability);
    if (!scheduled) { scheduled = true; if (afterAuthorize) queueMicrotask(afterAuthorize); }
    return actor;
  });
  const engine = { cloudAgentBoot: { active: true, authorizeActor },
    cloudLocalNativePump: { claimForExecution: () => original, record: () => record }, cancelRequested: new Set<string>(),
    cloudRuntimeRegistration: { agentExecutionRequest: request }, authorizeCloudAgentAction: prototype.authorizeCloudAgentAction };
  return { actors, actorSessionId, engine, controller, request };
}

function fixture(cloud = true) {
  const engine = {
    cloudWorker: cloud ? { uid: 10001 } : null,
    sessionAgent: new Map([["execution", "claude"]]),
    sessionChat: new Map([["execution", "chat"]]),
    permissionOwner: new Map([["permission", "first-device"]]),
    questionOwner: new Map([["question", "first-device"]]),
    pendingPermissionRequests: new Map([["permission", { agentId: "claude", request: { sessionId: "execution" } }]]),
    pendingQuestionRequests: new Map([["question", { agentId: "claude", request: { sessionId: "execution", nativeRequestId: "native-question" } }]]),
    agents: { answerPermission: vi.fn(), answerQuestion: vi.fn() },
    isHostRelayClient: prototype.isHostRelayClient,
  };
  const client: TransportClient = { id: "second-device", kind: "cloud", send: vi.fn(), close: vi.fn() };
  const dispatch = (message: Record<string, unknown>) => prototype.handleAgentMessage.call(engine,
    { id: "response", source: "browser", timestamp: 1, ...message } as EngineMessage, client);
  return { engine, client, dispatch };
}

describe("cloud decisions across devices", () => {
  it.each(["allowed", "foreign-user", "revoked", "stopped"])("authorizes an original boot control locally (%s)", async scenario => {
    const f = bootAuthorityFixture(scenario === "foreign-user");
    try {
      if (scenario === "revoked") f.actors.revoke(f.actorSessionId);
      if (scenario === "stopped") f.controller.abort();
      const result = prototype.authorizeCloudAgentAction.call(f.engine, "execution", f.actorSessionId);
      if (scenario === "allowed") {
        const guard = await result; expect(guard).toBeTypeOf("function");
        expect(() => guard?.()).not.toThrow();
      } else await expect(result).rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
      expect(f.request).not.toHaveBeenCalled();
    } finally { f.actors.dispose(); }
  });
  it.each(["AGENT_SET_MODE", "AGENT_SET_MODEL", "AGENT_UPDATE_CONFIG", "AGENT_COMPACT", "AGENT_GOAL_SET", "AGENT_GOAL_CLEAR", "AGENT_RETRY_SAFETY_REVIEW"] as const)(
    "rechecks original actor and Stop authority immediately before %s handoff", async type => {
      for (const cause of ["revocation", "stop", "current"] as const) {
        const f = bootAuthorityFixture(false, () => {
          if (cause === "revocation") f.actors.revoke(f.actorSessionId);
          if (cause === "stop") f.controller.abort();
        });
        try {
          const { engine, client, dispatch } = fixture(), native = vi.fn(async () => null);
          Object.assign(engine, f.engine, { remoteMayNotActOnSession: () => false, sessionLoadResponses: new Map(),
            cloudGoalClaim: () => null, scrubRelayUpdateConfigEnv: (env: unknown) => env });
          Object.assign(engine.agents, { setMode: native, setModel: native, updateConfig: native, compactContext: native,
            setGoal: native, clearGoal: native, retryDeniedAction: native });
          Object.assign(client, { cloudActor: { sessionId: f.actorSessionId, role: "owner" }, authorized: () => true });
          await dispatch({ type, agentId: "claude", sessionId: "execution", modeId: "plan", model: "model", env: {}, update: {}, retryId: "retry" });
          expect(native).toHaveBeenCalledTimes(cause === "current" ? 1 : 0);
          expect(f.request).not.toHaveBeenCalled();
        } finally { f.actors.dispose(); }
      }
    });
  it.each(["AGENT_PERMISSION_RESPONSE", "AGENT_QUESTION_RESPONSE"])("keeps old unnegotiated %s compatible while requiring ownership after negotiation", async type => {
    const { engine, client } = fixture();
    const handle = vi.fn(async (input: { kind: string }) => input.kind === "read" ? null : { outcome: "delivered" });
    const protocols = new WeakMap<TransportClient, number>();
    Object.assign(engine, { cloudActions: { handle }, cloudTurnProtocols: protocols });
    const reply = { id: "legacy", type, permissionId: "permission", questionId: "question", response: { outcome: { outcome: "cancelled" } } } as unknown as EngineMessage;
    await prototype.handleLegacyCloudAction.call(engine, reply, client);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: "submit", action: expect.objectContaining({ executionId: "execution", conversationId: "chat" }) }), undefined);
    protocols.set(client, 1); handle.mockClear();
    await expect(prototype.handleLegacyCloudAction.call(engine, reply, client)).rejects.toMatchObject({ code: "command_context_changed" });
    expect(handle).toHaveBeenCalledOnce();
  });
  it.each(["AGENT_PERMISSION_RESPONSE", "AGENT_QUESTION_RESPONSE"])("fences durable %s before submitting an action", async type => {
    const { engine, client } = fixture();
    const handle = vi.fn(async (input: { kind: string }) => input.kind === "read" ? null : { outcome: "delivered" });
    Object.assign(engine, { cloudActions: { handle } });
    const reply = { id: "reply", type, chatId: "chat", executionId: "retired-execution", permissionId: "permission", questionId: "question", response: { outcome: { outcome: "cancelled" } } } as unknown as EngineMessage;
    await expect(prototype.handleLegacyCloudAction.call(engine, reply, client)).rejects.toMatchObject({ code: "command_context_changed" });
    expect(handle).toHaveBeenCalledOnce(); expect(handle).toHaveBeenCalledWith({ kind: "read", operationId: "reply" }, undefined);
    expect(engine.pendingPermissionRequests.size).toBe(1); expect(engine.pendingQuestionRequests.size).toBe(1);
    await prototype.handleLegacyCloudAction.call(engine, { ...reply, executionId: "execution" } as EngineMessage, client);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: "submit", action: expect.objectContaining({ conversationId: "chat", executionId: "execution" }) }), undefined);
  });
  it.each(["AGENT_PERMISSION_RESPONSE", "AGENT_QUESTION_RESPONSE"])("rejects %s from a different execution without consuming the resolver", async type => {
    const { engine, dispatch } = fixture();
    await dispatch({ type, chatId: "chat", executionId: "retired-execution", permissionId: "permission", questionId: "question", response: { outcome: { outcome: "cancelled" } } });
    expect(engine.agents.answerPermission).not.toHaveBeenCalled(); expect(engine.agents.answerQuestion).not.toHaveBeenCalled();
    expect(engine.pendingPermissionRequests.size).toBe(1); expect(engine.pendingQuestionRequests.size).toBe(1);
  });
  it.each(["revoked", "disconnected", "allowed"])("checks actor credential delegation before a paid native control (%s)",async scenario=>{
    const {engine,client,dispatch}=fixture();let authorized=true;
    const compactContext=vi.fn(),authorizeCloudAgentAction=vi.fn(async()=>{
      if(scenario==="revoked")throw new Error("delegation revoked");
      if(scenario==="disconnected")authorized=false;
    });
    Object.assign(engine.agents,{compactContext});
    Object.assign(engine,{authorizeCloudAgentAction,remoteMayNotActOnSession:()=>false});
    Object.assign(client,{cloudActor:{sessionId:"actor",role:"developer"},authorized:()=>authorized});
    await dispatch({type:"AGENT_COMPACT",agentId:"claude",sessionId:"execution"});
    expect(authorizeCloudAgentAction).toHaveBeenCalledWith("execution","actor");
    expect(compactContext).toHaveBeenCalledTimes(scenario==="allowed"?1:0);
  });
  it("treats cloud view close as client-local while the shared queue and pending bind continue",async()=>{
    const {engine,client,dispatch}=fixture();
    const cancel=vi.fn(),endSession=vi.fn(),invalidateConversationBind=vi.fn(),handle=vi.fn();
    Object.assign(engine.agents,{cancel,endSession});
    Object.assign(engine,{cloudCommands:{handle},invalidateConversationBind,conversationExecution:new Map([["chat","execution"]])});
    Object.assign(client,{cloudActor:{sessionId:"actor",role:"viewer"},authorized:()=>true});
    for(const sessionId of ["execution",undefined])await dispatch({type:"AGENT_CLOSE_SESSION",agentId:"claude",chatId:"chat",...(sessionId?{sessionId}:{})});
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({type:"AGENT_SESSION_CLOSED",chatId:"chat"}));
    expect(cancel).not.toHaveBeenCalled();expect(endSession).not.toHaveBeenCalled();expect(handle).not.toHaveBeenCalled();
    expect(invalidateConversationBind).not.toHaveBeenCalled();expect(engine.sessionAgent.get("execution")).toBe("claude");
  });
  it.each(["AGENT_PERMISSION_RESPONSE", "AGENT_QUESTION_RESPONSE", "AGENT_STEER"])("routes %s through durable action admission", async type => {
    const { engine, dispatch } = fixture();
    const handleLegacyCloudAction = vi.fn();
    Object.assign(engine, { cloudActions: {}, handleLegacyCloudAction });
    await dispatch({ type });
    expect(handleLegacyCloudAction).toHaveBeenCalledOnce();
    expect(engine.agents.answerPermission).not.toHaveBeenCalled();
    expect(engine.agents.answerQuestion).not.toHaveBeenCalled();
  });
  it("does not permit direct prompts to bypass the durable cloud queue", async () => {
    const { engine, client, dispatch } = fixture();
    Object.assign(engine, { cloudCommands: { handle: vi.fn() } });
    await dispatch({ type: "AGENT_PROMPT", agentId: "claude", sessionId: "execution", prompt: [{ type: "text", text: "fixture" }] });
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: "AGENT_PROMPT_FAILED", error: expect.stringContaining("durable command identity") }));
  });
  it("routes Stop through persistence before the native cancellation path", async () => {
    const { engine, dispatch } = fixture();
    const handle = vi.fn(async () => ({}));
    Object.assign(engine, { cloudCommands: { handle }, sessionChat: new Map([["execution", "chat"]]), remoteMayNotActOnSession: () => false });
    await dispatch({ type: "AGENT_CANCEL", agentId: "claude", sessionId: "execution" });
    expect(handle).toHaveBeenCalledWith({ kind: "stop", conversationId: "chat", operationId: "response" },undefined);
  });
  it("serves collaborator provider inventory without probing or exposing another account",async()=>{
    const {engine,client,dispatch}=fixture();
    const listAgents=vi.fn(async()=>[{id:"claude",account:{email:"private@example.test"}}]),refreshRegistry=vi.fn();
    Object.assign(engine.agents,{listAgents,refreshRegistry});
    Object.assign(client,{cloudActor:{sessionId:"actor",deviceId:"device",fingerprint:"a".repeat(64),role:"viewer"}});
    await dispatch({type:"AGENT_LIST_AGENTS",force:true});
    expect(listAgents).not.toHaveBeenCalled();expect(refreshRegistry).not.toHaveBeenCalled();
    expect(JSON.stringify((client.send as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("private@example.test");
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({type:"AGENT_AGENTS_LIST",agents:expect.arrayContaining([expect.objectContaining({id:"claude"})])}));
  });
  it("allows another authenticated workspace device to settle a permission exactly once", async () => {
    const { engine, dispatch } = fixture();
    const message = { type: "AGENT_PERMISSION_RESPONSE", chatId: "chat", executionId: "execution", permissionId: "permission", response: { outcome: { outcome: "cancelled" } } };
    await dispatch(message);
    await dispatch(message);
    expect(engine.agents.answerPermission).toHaveBeenCalledExactlyOnceWith("permission", message.response);
    expect(engine.pendingPermissionRequests.size).toBe(0);
  });

  it("allows another device to answer the exact pending question and rejects late replay", async () => {
    const { engine, dispatch } = fixture();
    const message = { type: "AGENT_QUESTION_RESPONSE", chatId: "chat", executionId: "execution", questionId: "question", nativeRequestId: "native-question", response: { outcome: "dismissed" } };
    await dispatch(message);
    await dispatch(message);
    expect(engine.agents.answerQuestion).toHaveBeenCalledExactlyOnceWith("question", message.response, undefined);
  });

  it("does not consume a question for a mismatched native correlation or expired execution", async () => {
    const { engine, dispatch } = fixture();
    await dispatch({ type: "AGENT_QUESTION_RESPONSE", questionId: "question", nativeRequestId: "another-native-question", response: { outcome: "dismissed" } });
    expect(engine.pendingQuestionRequests.size).toBe(1);
    engine.sessionAgent.clear();
    await dispatch({ type: "AGENT_PERMISSION_RESPONSE", permissionId: "permission", response: { outcome: { outcome: "cancelled" } } });
    await dispatch({ type: "AGENT_QUESTION_RESPONSE", questionId: "question", response: { outcome: "dismissed" } });
    expect(engine.agents.answerPermission).not.toHaveBeenCalled();
    expect(engine.agents.answerQuestion).not.toHaveBeenCalled();
  });

  it("preserves the desktop relay's decision owner restriction", async () => {
    const { engine, dispatch } = fixture(false);
    await dispatch({ type: "AGENT_PERMISSION_RESPONSE", permissionId: "permission", response: { outcome: { outcome: "cancelled" } } });
    await dispatch({ type: "AGENT_QUESTION_RESPONSE", questionId: "question", response: { outcome: "dismissed" } });
    expect(engine.agents.answerPermission).not.toHaveBeenCalled();
    expect(engine.agents.answerQuestion).not.toHaveBeenCalled();
  });
});
