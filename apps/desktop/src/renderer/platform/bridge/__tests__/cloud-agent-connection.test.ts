import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudAgentConnection } from "../cloud-agent-connection";
import { CloudEventReader } from "../cloud-event-reader";
import type { BridgeMessage } from "../messages";
import type { RuntimeClient } from "../ws-client";
import type { WireRecord } from "../cloud-runtime-wire";
import type {BackgroundTasksUpdate} from "@zeros/protocol/agent-events";
import {cloudSessionMetadata} from "../../../features/agent/cloud-session-metadata";
import {BLANK} from "../../../features/agent/sessions-store";
import type {AgentSessionState} from "../../../features/agent/use-agent-session";
import {loadedBackgroundTaskState} from "../../../features/agent/background-task-state";
import {cloudScopedId} from "../cloud-workspace-key";
import type {AgentSessionCreatedMessage} from "../messages";

const chat = "11111111-1111-4111-8111-111111111111";
const grant = "22222222-2222-4222-8222-222222222222";
function fixture(receiptIdentity: Record<string, unknown> = {}) {
  let enqueued: WireRecord | undefined;
  let state = "succeeded";
  const request = vi.fn(async (message: WireRecord) => {
    const params = message.params as WireRecord;
    const input = params.request as WireRecord;
    let result: unknown = { conversationId: chat, modeRevision: 0, permissionModeVersion: 1, nativeCommandsVersion: 1, claudePreferencesVersion: 1 };
    if (message.op === "cloudCommands.request") {
      if (input.kind === "snapshot")
        result = {
          version: 1,
          conversationId: chat,
          revision: 0,
          paused: false,
          pending: [],
          receipts: [],
        };
      if (input.kind === "mutate")
        enqueued = (input.mutation as WireRecord).action as WireRecord;
      if (input.kind === "read")
        result = {
          conversationId: chat,
          commandId: input.commandId,
          ...receiptIdentity,
          position: 1,
          state,
          payload: null,
          executionId: "execution",
          generation: 1,
          resultCode: null,
          createdAt: "2026-09-26T00:00:00Z",
          updatedAt: "2026-09-26T00:00:00Z",
        };
    }
    if (message.op === "cloudEvents.request")
      result = {
        snapshot: {
          conversationId: chat,
          executionId: "reconnected",
          activeTurn: { startedAt: 100 },
          initialize: {
            protocolVersion: 1,
            agentCapabilities: { steering: true },
          },
          session: {
            modes: {
              currentModeId: "ask",
              availableModes: [{ id: "ask", name: "Ask" }],
            },
          },
          permissions: [
            {
              permissionId: "pending",
              agentId: "codex",
              request: {
                sessionId: "reconnected",
                toolCall: { toolCallId: "tool" },
              },
            },
          ],
          questions: [],
        },
      };
    return { type: "WORKSPACE_RESPONSE", op: message.op, result };
  });
  const authorize = vi.fn(async () => grant);
  const connection = new CloudAgentConnection(
    { request, status: "connected" } as unknown as RuntimeClient,
    "local-main",
    authorize,
  );
  return {
    connection,
    request,
    authorize,
    getEnqueued: () => enqueued,
    setState: (value: string) => {
      state = value;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("cloud Claude preference carriage", () => {
  const choices = [
    { autoMemoryEnabled: true, idleCompactionEnabled: false },
    { autoMemoryEnabled: false, idleCompactionEnabled: false },
    { autoMemoryEnabled: true, idleCompactionEnabled: true },
    { autoMemoryEnabled: false, idleCompactionEnabled: true },
  ];
  it.each(choices)("retains %j across attachment replacement and a durable send", async claudePreferences => {
    const before = fixture(), after = fixture();
    try {
      await before.connection.request({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: chat,
        env: { ANTHROPIC_MODEL: "claude-haiku-4-5", ZEROS_CLAUDE_AUTO_MEMORY: claudePreferences.autoMemoryEnabled ? "1" : "0",
          ZEROS_CLAUDE_IDLE_COMPACTION: claudePreferences.idleCompactionEnabled ? "1" : "0" } });
      after.connection.restoreAttachments(before.connection.snapshotAttachments());
      await after.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "preferences", prompt: [{ type: "text", text: "test" }] });
      expect(after.getEnqueued()?.payload).toMatchObject({ claudePreferences });
      expect(after.request.mock.calls.filter(([message]) => message.op === "cloudCommands.request" && ((message.params as WireRecord).request as WireRecord).kind !== "snapshot")
        .every(([message]) => (message.params as WireRecord).claudePreferencesVersion === 1)).toBe(true);
    } finally { before.connection.dispose(); after.connection.dispose(); }
  });

  it("defaults to native auto memory On and idle compaction Off when a legacy env omits them", async () => {
    const f = fixture();
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: chat, env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } });
      await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "legacy-preferences", prompt: [{ type: "text", text: "test" }] });
      expect(f.getEnqueued()?.payload).toMatchObject({ claudePreferences: { autoMemoryEnabled: true, idleCompactionEnabled: false } });
    } finally { f.connection.dispose(); }
  });

  it.each([undefined, 0, 2])("preserves the old strict wire contract for a worker without preferences v1 (%s)", async version => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (["cloudCommands.conversation", "cloudCommands.createConversation"].includes(String(message.op)))
        return { ...response, result: { ...response.result as WireRecord, claudePreferencesVersion: version } };
      return response;
    });
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: chat,
        env: { ANTHROPIC_MODEL: "claude-haiku-4-5", ZEROS_CLAUDE_IDLE_COMPACTION: "1" } });
      await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "old-worker", prompt: [{ type: "text", text: "test" }] });
      expect(f.getEnqueued()?.payload).not.toHaveProperty("claudePreferences");
      for (const [message] of f.request.mock.calls) expect(message.params).not.toHaveProperty("claudePreferencesVersion");
    } finally { f.connection.dispose(); }
  });

  it("captures preferences before credential lookup and uses a later change only on the next send", async () => {
    const f = fixture();
    let authorize!: (value: string) => void;
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: chat,
        env: { ANTHROPIC_MODEL: "claude-haiku-4-5", ZEROS_CLAUDE_AUTO_MEMORY: "0", ZEROS_CLAUDE_IDLE_COMPACTION: "0" } });
      f.authorize.mockReturnValueOnce(new Promise(resolve => { authorize = resolve; }));
      const pending = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "captured-preferences", prompt: [] });
      f.connection.send({ type: "AGENT_UPDATE_CONFIG", sessionId: `conversation:${chat}`, env: { ZEROS_CLAUDE_AUTO_MEMORY: "1", ZEROS_CLAUDE_IDLE_COMPACTION: "1" } });
      authorize(grant);
      await pending;
      expect(f.getEnqueued()?.payload).toMatchObject({ claudePreferences: { autoMemoryEnabled: false, idleCompactionEnabled: false } });
      await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "next-preferences", prompt: [] });
      expect(f.getEnqueued()?.payload).toMatchObject({ claudePreferences: { autoMemoryEnabled: true, idleCompactionEnabled: true } });
    } finally { f.connection.dispose(); }
  });

  it.each(["codex", "cursor"])("leaves %s commands free of Claude preferences", async agentId => {
    const f = fixture();
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", agentId, chatId: chat,
        env: { OPENAI_MODEL: "test-model", ZEROS_CLAUDE_AUTO_MEMORY: "0", ZEROS_CLAUDE_IDLE_COMPACTION: "1" } });
      await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "other-provider", prompt: [] });
      expect(f.getEnqueued()?.payload).not.toHaveProperty("claudePreferences");
    } finally { f.connection.dispose(); }
  });
});

describe("cloud snapshot and replay installation", () => {
  it("holds a succeeded receipt for snapshot recovery and drops buffered transcript duplicates", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    const streamId = "33333333-3333-4333-8333-333333333333";
    const handlers = new Map<string, (frame: BridgeMessage) => void>();
    let finish!: (value: unknown) => void;
    const request = vi.fn(async (message: WireRecord) => {
      if (message.op === "cloudEvents.request") {
        if ((message.params as any).request.kind === "replay") return { type: "WORKSPACE_RESPONSE", result: {
          streamId, firstRetained: 1, head: 10, cursor: 10, events: [],
        } };
        return new Promise(resolve => { finish = resolve; });
      }
      return original(message);
    });
    const client = { request, status: "connected", on: (type: string, listener: (frame: BridgeMessage) => void) => {
      handlers.set(type, listener); return () => handlers.delete(type);
    }, onStatusChange: () => () => {} } as unknown as RuntimeClient;
    const reader = new CloudEventReader(client), connection = new CloudAgentConnection(client, "local-main", f.authorize, reader);
    const updates = vi.fn(), changed = vi.fn();
    reader.on("AGENT_SESSION_UPDATE", updates); connection.on("DB_CHANGED", changed);
    const chunk = (sequence: number) => ({ type: "AGENT_SESSION_UPDATE", id: `event-${sequence}`, source: "engine", timestamp: 1,
      chatId: chat, sessionId: "execution", executionId: "execution", agentId: "codex", cloudStream: { streamId, sequence },
      notification: { sessionId: "execution", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved answer" } } } }) as BridgeMessage;
    try {
      await connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
      handlers.get("AGENT_SESSION_UPDATE")!(chunk(1)); updates.mockClear();
      const flight = connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "receipt-race", prompt: [] });
      let completed = false; void flight.then(() => { completed = true; });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(completed).toBe(false);
      handlers.get("AGENT_SESSION_UPDATE")!(chunk(2));
      finish({ type: "WORKSPACE_RESPONSE", result: { cursor: { streamId, sequence: 10 },
        snapshot: { conversationId: chat, executionId: "execution", activeTurn: null, messages: [] } } });
      await expect(flight).resolves.toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["messages"], chatIds: [chat] }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(updates).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([message]) => message.op === "cloudCommands.request" && (message.params as any).request.kind === "mutate")).toHaveLength(1);
    } finally { reader.dispose(); connection.dispose(); f.connection.dispose(); }
  });
  it.each(["cloud_provider_start_verification_required", "cloud_provider_prompt_cloud_credential_error"])("restores structured %s from a receipt after terminal-event loss", async code => {
    const f = fixture(); f.setState("failed");
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (message.op === "cloudCommands.request" && (message.params as any).request.kind === "read")
        (response.result as WireRecord).resultCode = code;
      return response;
    });
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: chat, env: { ANTHROPIC_MODEL: "test-model" } });
      await expect(f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "receipt-cause", prompt: [] }))
        .resolves.toMatchObject({ type: "AGENT_PROMPT_FAILED", error: code,
          failure: { kind: code.includes("verification_required") ? "verification-required" : "cloud-credentials-unavailable" } });
      expect(f.request.mock.calls.filter(([message]) => message.op === "cloudCommands.request" && (message.params as any).request.kind === "mutate")).toHaveLength(1);
    } finally { f.connection.dispose(); }
  });
  it.each([false, true])("does not resurrect a completed turn or settled permission from delayed state (retired=%s)", async retired => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    const streamId = "33333333-3333-4333-8333-333333333333";
    const handlers = new Map<string, (frame: BridgeMessage) => void>();
    let finish!: (value: unknown) => void, snapshot: unknown;
    const request = vi.fn(async (message: WireRecord) => {
      if (message.op === "cloudEvents.request") {
        if ((message.params as any).request.kind === "replay") return { type: "WORKSPACE_RESPONSE", result: {
          streamId, firstRetained: 1, head: 12, cursor: 12, events: [],
        } };
        const response = await original(message);
        snapshot = { ...response, result: { ...(response.result as object), cursor: { streamId, sequence: 10 } } };
        return new Promise(resolve => { finish = resolve; });
      }
      return original(message);
    });
    const client = { request, on: (type: string, listener: (frame: BridgeMessage) => void) => {
      handlers.set(type, listener); return () => handlers.delete(type);
    }, onStatusChange: () => () => {} } as unknown as RuntimeClient;
    const reader = new CloudEventReader(client);
    const connection = new CloudAgentConnection(client, "local-main", f.authorize, reader);
    let active = false;
    const permissions = new Set<string>(), received: number[] = [];
    connection.on("AGENT_SESSION_CREATED", frame => { active = (frame as any).promptActive; });
    connection.on("AGENT_PERMISSION_REQUEST", frame => permissions.add((frame as any).permissionId));
    reader.on("AGENT_PERMISSION_SETTLED", frame => { permissions.delete((frame as any).permissionId); received.push(frame.cloudStream!.sequence); });
    reader.on("AGENT_PROMPT_COMPLETE", frame => { connection.incoming(frame as unknown as WireRecord); active = false; received.push(frame.cloudStream!.sequence); });
    const load = connection.request({ type: "AGENT_LOAD_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
    void load.catch(() => {});
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      for (const [sequence, type] of [[11, "AGENT_PERMISSION_SETTLED"], [12, "AGENT_PROMPT_COMPLETE"]] as const)
        handlers.get(type)!({ type, id: `event-${sequence}`, source: "engine", timestamp: 1,
          permissionId: "pending", requestId: "prompt", stopReason: "end_turn", response: { stopReason: "end_turn" },
          chatId: chat, agentId: "codex", sessionId: "reconnected", executionId: "reconnected",
          cloudStream: { streamId, sequence } } as BridgeMessage);
      expect(received).toEqual([]);
      if (retired) { reader.dispose(); connection.dispose(); }
      finish(snapshot);
      if (retired) await expect(load).rejects.toThrow(/closed|changed/);
      else {
        await load;
        await vi.waitFor(() => expect(received).toEqual([11, 12]));
      }
      expect(active).toBe(false); expect(permissions.size).toBe(0);
    } finally { reader.dispose(); connection.dispose(); f.connection.dispose(); }
  });
});

function retainedTaskFixture(){
  const f=fixture(),original=f.request.getMockImplementation()!;
  let background:BackgroundTasksUpdate={sessionUpdate:"background_tasks_update",tasks:[{taskId:"native-child",name:"Retained child",startedAt:1,updatedAt:1}],waiting:true};
  f.request.mockImplementation(async message=>{
    const response=await original(message);
    if(message.op!=="cloudEvents.request")return response;
    const snapshot=(response.result as {snapshot:WireRecord}).snapshot;
    return {...response,result:{snapshot:{...snapshot,activeTurn:null,session:{...snapshot.session as WireRecord,backgroundTasks:background}}}};
  });
  const id=cloudScopedId({organizationId:chat,workspaceId:grant},`conversation:${chat}`);
  let slot:AgentSessionState={...BLANK,agentId:"codex",executionId:id,sessionId:id};
  const metadata=vi.fn((frame:unknown)=>{
    const mapped=f.connection.incoming(frame as WireRecord),session=mapped.session as AgentSessionCreatedMessage["session"];
    const event={...mapped,session:{...session,executionId:id,sessionId:id}} as AgentSessionCreatedMessage;
    slot={...slot,...cloudSessionMetadata(slot,event)};
  });
  f.connection.on("AGENT_SESSION_CREATED",metadata);
  f.connection.on("AGENT_SESSION_UPDATE",frame=>{
    const update=(frame as unknown as {notification:{update:BackgroundTasksUpdate}}).notification.update;
    if(update.sessionUpdate==="background_tasks_update")slot={...slot,...loadedBackgroundTaskState(update)};
  });
  return {...f,metadata,getSlot:()=>slot,setBackground:(update:BackgroundTasksUpdate)=>{background=update;},background,
    load:async()=>{
      const loaded=await f.connection.request({type:"AGENT_LOAD_SESSION",chatId:chat,agentId:"codex",env:{OPENAI_MODEL:"test-model"}});
      slot={...slot,...loadedBackgroundTaskState((loaded!.response as {backgroundTasks?:BackgroundTasksUpdate}).backgroundTasks)};
      return loaded;
    },
    live:(update:BackgroundTasksUpdate,execution="reconnected")=>{
      f.connection.incoming({type:"AGENT_SESSION_UPDATE",chatId:chat,agentId:"codex",notification:{sessionId:execution,update}});
      slot={...slot,...loadedBackgroundTaskState(update)};
    },
  };
}
describe("retained cloud task attachment",()=>{
  it("restores a quiet task atomically on cold reload and through delayed metadata",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();expect(f.getSlot().backgroundTasks).toEqual(f.background.tasks);expect(f.getSlot().waitingForBackgroundTasks).toBe(true);
      await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());expect(f.getSlot().backgroundTasks).toEqual(f.background.tasks);
      expect(f.getSlot().backgroundTasksWaitingSince).toBe(1);
    }finally{f.connection.dispose();}
  });
  it("restores changed task activity on an already attached reconnect",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());f.metadata.mockClear();
      const next={...f.background,tasks:[{...f.background.tasks[0]!,taskId:"next-child"}],activity:{state:"requires_action" as const,startedAt:2}};
      f.setBackground(next);await f.connection.refreshAttachments();await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());
      expect(f.getSlot()).toMatchObject({backgroundTasks:next.tasks,backgroundActivity:next.activity,waitingForBackgroundTasks:true,backgroundTasksWaitingSince:2});
    }finally{f.connection.dispose();}
  });
  it("does not resurrect tasks from delayed metadata after a newer live completion",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();f.live({sessionUpdate:"background_tasks_update",tasks:[],waiting:false,activity:null});
      await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());expect(f.getSlot().backgroundTasks).toEqual([]);expect(f.getSlot().waitingForBackgroundTasks).toBe(false);
    }finally{f.connection.dispose();}
  });
  it("keeps a live completion that arrives while its retained snapshot is in flight",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());f.metadata.mockClear();
      let finish!:(value:Awaited<ReturnType<typeof f.request>>)=>void;
      const original=f.request.getMockImplementation()!;let saved!:Awaited<ReturnType<typeof f.request>>;
      f.request.mockImplementation(async message=>{
        const response=await original(message);if(message.op!=="cloudEvents.request")return response;
        saved=response;return new Promise(resolve=>{finish=resolve;});
      });
      const refreshing=f.connection.refreshAttachments();await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
      f.live({sessionUpdate:"background_tasks_update",tasks:[],waiting:false,activity:null});finish(saved);await refreshing;
      await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());expect(f.getSlot().backgroundTasks).toEqual([]);
    }finally{f.connection.dispose();}
  });
  it("clears visible tasks when reconnect proves their execution has retired",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());
      const original=f.request.getMockImplementation()!;
      f.request.mockImplementation(async message=>{
        const response=await original(message);return message.op==="cloudEvents.request"
          ?{...response,result:{snapshot:{conversationId:chat,executionId:null,activeTurn:null}}}:response;
      });
      await f.connection.refreshAttachments();await vi.waitFor(()=>expect(f.getSlot().backgroundTasks).toEqual([]));
      expect(f.getSlot().waitingForBackgroundTasks).toBe(false);
    }finally{f.connection.dispose();}
  });
  it("does not restore a retired execution when a new execution arrives during refresh",async()=>{
    const f=retainedTaskFixture();try{
      await f.load();await vi.waitFor(()=>expect(f.metadata).toHaveBeenCalled());f.metadata.mockClear();
      let finish!:(value:Awaited<ReturnType<typeof f.request>>)=>void;
      const original=f.request.getMockImplementation()!;let saved!:Awaited<ReturnType<typeof f.request>>;
      f.request.mockImplementation(async message=>{
        const response=await original(message);if(message.op!=="cloudEvents.request")return response;
        saved=response;return new Promise(resolve=>{finish=resolve;});
      });
      const refreshing=f.connection.refreshAttachments();await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
      const next={...f.background,tasks:[{...f.background.tasks[0]!,taskId:"replacement-child"}]};f.live(next,"replacement");finish(saved);await refreshing;
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(f.getSlot().backgroundTasks).toEqual(next.tasks);expect(f.metadata).not.toHaveBeenCalled();
      expect(f.connection.outgoing({type:"AGENT_STOP_BACKGROUND_TASK",sessionId:`conversation:${chat}`})).toMatchObject({sessionId:"replacement"});
    }finally{f.connection.dispose();}
  });
});

describe("cloud agent command adapter", () => {
  it.each(["release", "cancel", "dispose", "owner", "timeout"])("bounds checkpointing retries with one enqueue identity: %s", async outcome => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController(), original = f.request.getMockImplementation()!;
    const writes: WireRecord[] = [], times: number[] = [];
    let blocked = true, settled = false;
    f.request.mockImplementation(async message => {
      const input = (message.params as WireRecord).request as WireRecord | undefined;
      if (input?.kind === "mutate") {
        writes.push(input.mutation as WireRecord); times.push(Date.now());
        if (blocked) return { type: "WORKSPACE_ERROR", code: "CLOUD_WORKSPACE_CHECKPOINTING", message: "Capturing" } as never;
      }
      return original(message);
    });
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
      const sending = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
        userMessageId: "checkpoint-retry", prompt: [{ type: "text", text: "Run once" }] }, { signal: controller.signal })
        .finally(() => { settled = true; });
      void sending.catch(() => {});
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      expect(settled).toBe(false);
      if (outcome === "release") blocked = false;
      if (outcome === "cancel") controller.abort();
      if (outcome === "dispose") f.connection.dispose();
      if (outcome === "owner") await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat,
        agentId: "claude", env: { ANTHROPIC_MODEL: "test-model" } });
      await vi.advanceTimersByTimeAsync(outcome === "timeout" ? 60_000 : 2_000);
      if (outcome === "release") {
        await expect(sending).resolves.toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
        expect(writes).toHaveLength(2);
        expect(f.getEnqueued()).toMatchObject({ kind: "enqueue", payload: { userMessageId: "checkpoint-retry" } });
      } else {
        await expect(sending).rejects.toThrow();
        expect(f.getEnqueued()).toBeUndefined();
        if (outcome === "timeout") {
          expect(writes.length).toBeGreaterThan(2);
          expect(writes.length).toBeLessThan(35);
          expect(times.at(-1)! - times[0]).toBeLessThan(60_000);
          expect(times[1] - times[0]).toBe(250);
          expect(times[2] - times[1]).toBe(500);
        } else expect(writes).toHaveLength(1);
      }
      expect(writes.every(write => JSON.stringify(write) === JSON.stringify(writes[0]))).toBe(true);
      expect(f.authorize).toHaveBeenCalledOnce();
    } finally { f.connection.dispose(); vi.useRealTimers(); }
  });
  it("restores confirmation order when a paused goal utility overtakes an older queued prompt",async()=>{
    const f=fixture(),original=f.request.getMockImplementation()!,update=vi.fn();
    const goal={objective:"Finish",status:"active",tokenBudget:1000,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    const receipt=(position:number,updatedAt:string,value:unknown)=>({commandId:position===1?chat:grant,position,state:"succeeded",payload:null,executionId:`execution-${position}`,generation:1,resultCode:null,createdAt:"2026-09-29T00:00:00Z",updatedAt,result:{version:1,goal:value}});
    f.request.mockImplementation(async message=>{
      const response=await original(message),input=(message.params as WireRecord).request as WireRecord;
      if(message.op==="cloudEvents.request")return {...response,result:{snapshot:{conversationId:chat,activeTurn:null}}};
      if(message.op==="cloudCommands.request"&&input.kind==="snapshot")return {...response,result:{...response.result as WireRecord,receipts:[
        receipt(1,"2026-09-29T00:00:03Z",{...goal,status:"complete",tokensUsed:50,updatedAt:3}),receipt(2,"2026-09-29T00:00:02Z",goal)]}};
      return response;
    });
    f.connection.on("AGENT_SESSION_UPDATE",update);
    try{
      await f.connection.request({type:"AGENT_LOAD_SESSION",chatId:chat,agentId:"codex",env:{OPENAI_MODEL:"test-model"}});
      await vi.waitFor(()=>expect(update).toHaveBeenCalled());
      expect(update.mock.calls.at(-1)?.[0].notification.update.goal.status).toBe("complete");
    }finally{f.connection.dispose();}
  });
  it.each(["codex","claude","cursor"])("durably forks %s and resolves a duplicate request from the same receipt",async agentId=>{
    const f=fixture(),original=f.request.getMockImplementation()!,destination="33333333-3333-4333-8333-333333333333";
    let commandId:string|undefined;
    f.request.mockImplementation(async message=>{
      const params=message.params as WireRecord,input=params.request as WireRecord;
      const response=await original(message);
      const receipt={commandId,position:1,state:"succeeded",payload:null,executionId:"fork-execution",generation:1,resultCode:null,
        createdAt:"2026-09-26T00:00:00Z",updatedAt:"2026-09-26T00:00:00Z"};
      if(message.op==="cloudCommands.conversation")return {...response,result:{...response.result as WireRecord,
        conversationId:params.conversationId,providerBinding:{version:1,providerId:agentId,kind:"native",resumeId:params.conversationId===chat?"source-native":"fork-native"}}};
      if(message.op==="cloudCommands.request"&&input.kind==="snapshot")return {...response,result:{...response.result as WireRecord,conversationId:input.conversationId,receipts:commandId?[receipt]:[]}};
      if(message.op==="cloudCommands.request"&&input.kind==="mutate")commandId=String(((input.mutation as WireRecord).action as WireRecord).commandId);
      if(message.op==="cloudCommands.request"&&input.kind==="read")return {...response,result:{...receipt,commandId:input.commandId,conversationId:destination}};
      return response;
    });
    await f.connection.request({type:"AGENT_NEW_SESSION",chatId:chat,agentId,env:{OPENAI_MODEL:"test-model"}});
    const request={type:"AGENT_FORK_CONVERSATION",agentId,sourceChatId:chat,destinationChatId:destination};
    expect(await f.connection.request(request)).toMatchObject({type:"AGENT_CONVERSATION_FORKED",providerBinding:{resumeId:"fork-native"}});
    expect(await f.connection.request(request)).toMatchObject({type:"AGENT_CONVERSATION_FORKED"});
    expect(f.request.mock.calls.filter(([message])=>message.op==="cloudCommands.request"&&((message.params as WireRecord).request as WireRecord).kind==="mutate")).toHaveLength(1);
    expect(f.getEnqueued()).toMatchObject({kind:"fork",payload:{operation:{kind:"fork",sourceConversationId:chat,strategy:agentId==="codex"?"native":"transcript"}}});
    if (agentId === "claude") expect(f.getEnqueued()?.payload).toMatchObject({ claudePreferences: { autoMemoryEnabled: true, idleCompactionEnabled: false } });
    expect(f.connection.snapshotAttachments().map(row=>row.id)).toEqual([chat,destination]);f.connection.dispose();
  });
  it("restores confirmed goals from durable receipts after the native execution retired",async()=>{
    const f=fixture(),original=f.request.getMockImplementation()!,update=vi.fn();
    const goal={objective:"Keep the goal",status:"paused",tokenBudget:null,tokensUsed:3,timeUsedSeconds:2,createdAt:1,updatedAt:2};
    f.request.mockImplementation(async message=>{
      const response=await original(message),input=(message.params as WireRecord).request as WireRecord;
      if(message.op==="cloudEvents.request")return {...response,result:{snapshot:{conversationId:chat,permissions:[],questions:[]}}};
      if(message.op==="cloudCommands.request"&&input.kind==="snapshot")return {...response,result:{...response.result as WireRecord,
        receipts:[{commandId:grant,position:1,state:"succeeded",payload:null,executionId:"retired",generation:1,resultCode:null,
          createdAt:"2026-09-26T00:00:00Z",updatedAt:"2026-09-26T00:00:00Z",result:{version:1,goal}}]}};
      return response;
    });
    f.connection.on("AGENT_SESSION_UPDATE",update);
    await f.connection.request({type:"AGENT_LOAD_SESSION",chatId:chat,agentId:"codex",env:{OPENAI_MODEL:"test-model"}});
    await vi.waitFor(()=>expect(update).toHaveBeenCalledWith(expect.objectContaining({notification:{sessionId:`conversation:${chat}`,update:{sessionUpdate:"goal_update",goal}}})));
    expect(f.authorize).not.toHaveBeenCalled();f.connection.dispose();
  });
  it("advertises next-message model selection and durably handles an idle goal", async () => {
    const f=fixture({result:{version:1,goal:null}});
    const session=await f.connection.request({type:"AGENT_NEW_SESSION",chatId:chat,agentId:"codex",env:{OPENAI_MODEL:"test-model"}});
    expect(session).toMatchObject({initialize:{_meta:{modelSelectionTiming:"next-message"}}});
    expect(await f.connection.request({type:"AGENT_GOAL_CLEAR",sessionId:`conversation:${chat}`,agentId:"codex",origin:"user"})).toMatchObject({type:"AGENT_GOAL_CHANGED",goal:null});
    expect(f.getEnqueued()).toMatchObject({kind:"enqueue",payload:{operation:{version:1,kind:"goal",action:"clear"},model:"test-model"}});
    expect((f.getEnqueued() as WireRecord).payload).not.toHaveProperty("origin");
    expect(((f.getEnqueued() as WireRecord).payload as WireRecord).operation).not.toHaveProperty("origin");
  });
  it.each([undefined, 0, 2])("rejects unsupported native commands before queue mutation with an actionable typed error (version=%s)", async version => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (message.op === "cloudCommands.conversation" || message.op === "cloudCommands.createConversation")
        return { ...response, result: { ...response.result as WireRecord, nativeCommandsVersion: version } };
      return response;
    });
    try {
      await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
      await expect(f.connection.request({ type: "AGENT_GOAL_CLEAR", sessionId: `conversation:${chat}`, agentId: "codex" }))
        .rejects.toMatchObject({ code: "cloud_runtime_feature_unavailable", action: version === 2 ? "update-desktop" : "update-runtime", feature: "native-commands-v1",
          message: version === 2 ? "Update Zeros to use native conversation operations on this cloud runtime" : "Update the cloud runtime to use native conversation operations" });
      expect(f.getEnqueued()).toBeUndefined();
    } finally { f.connection.dispose(); }
  });
  it.each([
    ["retirement only", 1, "cancelled", true],
    ["another Stop during retirement", 2, "cancelled", false],
    ["engine recovery", 1, "uncertain", false],
    ["a changed execution", 1, "cancelled", false],
  ])("handles a paused queue changing before Resume: %s", async (scenario, delta, state, succeeds) => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    const previous = { commandId: "33333333-3333-4333-8333-333333333333", position: 0,
      state: "dispatching", payload: null, executionId: "previous-execution", generation: 1,
      resultCode: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z" };
    let reads = 0, resumes = 0;
    f.request.mockImplementation(async message => {
      const input = (message.params as WireRecord).request as WireRecord;
      if (message.op === "cloudCommands.request" && input.kind === "snapshot") {
        const retired = reads++ > 0;
        return { type: "WORKSPACE_RESPONSE", op: message.op, result: {
          version: 1, conversationId: chat, revision: retired ? 10 + delta : 10, paused: true,
          pending: retired ? [] : [previous], receipts: retired ? [{ ...previous, state,
            executionId: scenario === "a changed execution" ? "different-execution" : previous.executionId,
            resultCode: "stopped_by_user", updatedAt: "2026-09-26T00:00:01Z" }] : [],
        } };
      }
      if (message.op === "cloudCommands.request" && input.kind === "mutate" &&
        ((input.mutation as WireRecord).action as WireRecord).kind === "resume") {
        if (++resumes === 1) return { type: "WORKSPACE_ERROR", message: "command_conflict" } as never;
        return { type: "WORKSPACE_RESPONSE", op: message.op, result: {
          version: 1, conversationId: chat, revision: 12, paused: false, pending: [], receipts: [],
        } };
      }
      return original(message);
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "test-model" } });
    const prompt = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "immediate-send-after-stop", prompt: [] });
    if (succeeds) await expect(prompt).resolves.toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
    else await expect(prompt).rejects.toThrow("command_conflict");
    const writes = f.request.mock.calls.map(([m]) => (m.params as WireRecord).request as WireRecord)
      .filter(r => r?.kind === "mutate").map(r => r.mutation as WireRecord);
    expect(resumes).toBe(succeeds ? 2 : 1);
    if (succeeds) {
      expect(writes.map(w => w.expectedRevision)).toEqual([10, 11, 12]);
      expect(writes[1]?.operationId).toBe(writes[0]?.operationId);
      expect(f.authorize).toHaveBeenCalledOnce();
    } else expect(writes).toHaveLength(1);
    f.connection.dispose();
  });

  it("retries an enqueue when the previous turn retires after the queue snapshot", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    let snapshots = 0, mutations = 0;
    f.request.mockImplementation(async message => {
      const input = (message.params as WireRecord).request as WireRecord;
      if (message.op === "cloudCommands.request" && input.kind === "mutate" && ++mutations === 1)
        return { type: "WORKSPACE_ERROR", message: "command_conflict" } as never;
      const response = await original(message);
      if (message.op === "cloudCommands.request" && input.kind === "snapshot")
        (response.result as WireRecord).revision = snapshots++;
      return response;
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "test-model", ZEROS_PERMISSION_MODE: "ask" } });
    await expect(f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "immediate-follow-up", prompt: [] })).resolves.toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
    const writes = f.request.mock.calls.map(([m]) => (m.params as WireRecord).request as WireRecord)
      .filter(r => r?.kind === "mutate").map(r => r.mutation as WireRecord);
    expect(writes.map(w => w.expectedRevision)).toEqual([0, 1]);
    expect(writes[1]?.action).toEqual(writes[0]?.action);
    expect(writes[1]?.operationId).toBe(writes[0]?.operationId);
    expect(f.authorize).toHaveBeenCalledOnce();
    f.connection.dispose();
  });

  it("does not resume a concurrent Stop while retrying an enqueue conflict", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    let snapshots = 0;
    f.request.mockImplementation(async message => {
      const input = (message.params as WireRecord).request as WireRecord;
      if (message.op === "cloudCommands.request" && input.kind === "mutate")
        return { type: "WORKSPACE_ERROR", message: "command_conflict" } as never;
      const response = await original(message);
      if (message.op === "cloudCommands.request" && input.kind === "snapshot") {
        (response.result as WireRecord).revision = snapshots;
        (response.result as WireRecord).paused = snapshots++ > 0;
      }
      return response;
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
    await expect(f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "concurrent-stop", prompt: [] })).rejects.toThrow("command_conflict");
    expect(f.request.mock.calls.filter(([m]) => ((m.params as WireRecord).request as WireRecord)?.kind === "mutate")).toHaveLength(1);
    f.connection.dispose();
  });

  it("bounds repeated enqueue conflicts instead of continually retrying a changing queue", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    let revision = 0;
    f.request.mockImplementation(async message => {
      const input = (message.params as WireRecord).request as WireRecord;
      if (message.op === "cloudCommands.request" && input.kind === "mutate")
        return { type: "WORKSPACE_ERROR", message: "command_conflict" } as never;
      const response = await original(message);
      if (message.op === "cloudCommands.request" && input.kind === "snapshot")
        (response.result as WireRecord).revision = revision++;
      return response;
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "test-model" } });
    await expect(f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "changing-queue", prompt: [] })).rejects.toThrow("command_conflict");
    expect(f.request.mock.calls.filter(([m]) => ((m.params as WireRecord).request as WireRecord)?.kind === "mutate")).toHaveLength(3);
    expect(f.authorize).toHaveBeenCalledOnce();
    f.connection.dispose();
  });

  it.each([
    ["codex", "OPENAI_MODEL", "auto-edit"], ["codex", "OPENAI_MODEL", "ask"],
    ["claude", "ANTHROPIC_MODEL", "accept-edits"], ["claude", "ANTHROPIC_MODEL", "plan"],
    ["cursor", "CURSOR_MODEL", "auto"], ["cursor", "CURSOR_MODEL", "plan"],
  ])("carries %s %s mode %s through a replacement connection and command", async (agentId, key, mode) => {
    const before = fixture(), after = fixture();
    await before.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId,
      env: { [key]: "test-model", ZEROS_PERMISSION_MODE: mode } });
    after.connection.restoreAttachments(before.connection.snapshotAttachments());
    before.connection.dispose();
    await after.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "permission-carriage", prompt: [{ type: "text", text: "test" }] });
    expect(after.getEnqueued()?.payload).toMatchObject({ permissionMode: mode });
    after.connection.dispose();
  });

  it("accepts a permission selection before the first cloud execution and applies it to the next send", async () => {
    const f = fixture();
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "test-model", ZEROS_PERMISSION_MODE: "auto-edit" } });
    expect(await f.connection.request({ type: "AGENT_SET_MODE", sessionId: `conversation:${chat}`,
      agentId: "codex", modeId: "ask" })).toMatchObject({ type: "AGENT_MODE_CHANGED", modeId: "ask" });
    await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "ask-first", prompt: [{ type: "text", text: "test" }] });
    expect(f.getEnqueued()?.payload).toMatchObject({ permissionMode: "ask" });
    f.connection.dispose();
  });

  it.each(["succeeded", "cancelled", "failed", "uncertain"])("allows the next mode selection after a %s receipt recovers a lost terminal event", async state => {
    const f = fixture();
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "test-model", ZEROS_PERMISSION_MODE: "auto-edit" } });
    f.connection.incoming({ type: "AGENT_SESSION_CREATED", agentId: "codex", chatId: chat,
      session: { sessionId: "execution" } });
    f.setState(state);
    await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: `recovered-${state}`, prompt: [] });
    f.request.mockClear();
    await expect(f.connection.request({ type: "AGENT_SET_MODE", sessionId: `conversation:${chat}`,
      agentId: "codex", modeId: "ask" })).resolves.toMatchObject({ type: "AGENT_MODE_CHANGED", modeId: "ask" });
    expect(f.request).not.toHaveBeenCalled();
    f.connection.dispose();
  });

  it("does not send a mode selection to the retired execution restored by an idle snapshot", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (message.op === "cloudEvents.request") (response.result as { snapshot: WireRecord }).snapshot.activeTurn = null;
      return response;
    });
    const restored = vi.fn((message) => f.connection.incoming(message));
    f.connection.on("AGENT_SESSION_CREATED", restored);
    await f.connection.request({ type: "AGENT_LOAD_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "test-model", ZEROS_PERMISSION_MODE: "auto-edit" } });
    await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce());
    // The saved next-send choice wins over the retired execution's old Ask
    // snapshot; it must not flicker back when that delayed snapshot arrives.
    expect(restored.mock.calls[0]?.[0]).toMatchObject({ session: { modes: { currentModeId: "auto-edit" } } });
    f.request.mockClear();
    await expect(f.connection.request({ type: "AGENT_SET_MODE", sessionId: `conversation:${chat}`,
      agentId: "codex", modeId: "ask" })).resolves.toMatchObject({ type: "AGENT_MODE_CHANGED", modeId: "ask" });
    expect(f.request).not.toHaveBeenCalled();
    f.connection.dispose();
  });

  it("rejects an unattached prompt without falling through to a native cloud prompt", async () => {
    const f = fixture();
    await expect(f.connection.request({ type: "AGENT_PROMPT", agentId: "codex",
      sessionId: `conversation:${chat}`, userMessageId: "unattached", prompt: [] }))
      .rejects.toThrow(/conversation.*reconnect/i);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("retains only conversation selections, never an old execution or its authority", async () => {
    const before = fixture(), after = fixture();
    await before.connection.request({ type: "AGENT_NEW_SESSION", agentId: "codex", chatId: chat,
      env: { OPENAI_MODEL: "gpt-5.6", ZEROS_ADDITIONAL_DIRS: '["/host-only"]' } });
    before.connection.incoming({ type: "AGENT_SESSION_CREATED", agentId: "codex", chatId: chat,
      session: { sessionId: "old-execution" } });
    const attachments = before.connection.snapshotAttachments();
    before.connection.dispose();
    after.connection.restoreAttachments(attachments);
    expect(() => after.connection.outgoing({ type: "AGENT_PERMISSION_RESPONSE", sessionId: `conversation:${chat}` }))
      .toThrow(/no active execution/i);
    attachments[0]!.localDirectories = false;
    await expect(after.connection.request({ type: "AGENT_PROMPT", agentId: "codex", sessionId: `conversation:${chat}`,
      userMessageId: "local-directory", prompt: [] })).rejects.toThrow(/local folders/i);
    expect(after.authorize).not.toHaveBeenCalled();
  });

  it.each(["dispatching", "failed"].flatMap(state => ["cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized", "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required"].map(code => ({ state, code }))))("recovers the exact upgrade denial from a %s receipt without resending", async ({ state, code }) => {
    const f = fixture(); f.setState(state);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (message.op === "cloudCommands.request" && ((message.params as WireRecord).request as WireRecord).kind === "read")
        (response.result as WireRecord).resultCode = code;
      return response;
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "gpt-5.6" } });
    const flight = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "upgrade-receipt", prompt: [] });
    try {
      await expect(flight).resolves.toMatchObject({ type: "AGENT_PROMPT_FAILED", error: code });
      expect(f.request.mock.calls.filter(([m]) => m.op === "cloudCommands.request" && ((m.params as WireRecord).request as WireRecord).kind === "mutate")).toHaveLength(1);
    } finally { f.setState("succeeded"); f.connection.dispose(); }
  });

  it.each(["cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized", "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required"])("recovers the admission code when an old engine's generic terminal event wins the receipt race", async code => {
    const f = fixture(); f.setState("dispatching");
    const original = f.request.getMockImplementation()!;
    let marker = false;
    f.request.mockImplementation(async message => {
      const response = await original(message);
      if (marker && message.op === "cloudCommands.request" && ((message.params as WireRecord).request as WireRecord).kind === "read")
        (response.result as WireRecord).resultCode = code;
      return response;
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex", env: { OPENAI_MODEL: "gpt-5.6" } });
    const flight = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "old-engine-upgrade", prompt: [] });
    try {
      await vi.waitFor(() => expect(f.getEnqueued()).toBeDefined());
      marker = true;
      f.connection.observePromptResult({ type: "AGENT_PROMPT_FAILED", requestId: f.getEnqueued()!.commandId,
        agentId: "codex", executionId: "execution", error: "Cloud agent execution authority is unavailable" });
      await expect(flight).resolves.toMatchObject({ type: "AGENT_PROMPT_FAILED", error: code });
    } finally { f.setState("succeeded"); f.connection.dispose(); }
  });

  it("accepts the terminal frame while a receipt read is still outstanding", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let finishRead!: (value: Awaited<ReturnType<typeof original>>) => void;
    f.request.mockImplementation(async message => {
      if ((message.params as WireRecord).request &&
        ((message.params as WireRecord).request as WireRecord).kind === "read")
        return new Promise(resolve => { finishRead = resolve; });
      return original(message);
    });
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" } });
    const completed = vi.fn();
    const flight = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "outstanding-receipt", prompt: [{ type: "text", text: "test" }] }).then(completed);
    try {
      await vi.waitFor(() => expect(finishRead).toBeDefined());
      f.connection.observePromptResult({ type: "AGENT_PROMPT_COMPLETE", requestId: f.getEnqueued()!.commandId,
        agentId: "codex", executionId: "native-execution", response: { stopReason: "end_turn" } });
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      expect(completed.mock.calls[0]![0]).toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
      // The old read must not change routing or keep polling after completion.
      finishRead({ type: "WORKSPACE_RESPONSE", op: "cloudCommands.request", result: {} });
      await flight;
      expect(f.connection.outgoing({ type: "AGENT_PERMISSION_RESPONSE", sessionId: `conversation:${chat}` }))
        .toMatchObject({ sessionId: "native-execution" });
    } finally {
      f.connection.dispose();
    }
  });

  it.each(["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"])(
    "settles from ordered %s without waiting for the retirement receipt", async type => {
      const f = fixture();
      f.setState("dispatching");
      await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "claude",
        env: { ANTHROPIC_MODEL: "claude-sonnet" } });
      const completed = vi.fn();
      const flight = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
        userMessageId: "completed-turn", prompt: [{ type: "text", text: "hello" }] }).then(completed);
      try {
        await vi.waitFor(() => expect(f.getEnqueued()).toBeDefined());
        const terminal = { type, requestId: f.getEnqueued()!.commandId, agentId: "claude",
          executionId: "execution", sessionId: "execution", stopReason: "end_turn",
          response: { usage: { inputTokens: 5, outputTokens: 3 } }, error: "Provider failed" };
        for (const mismatch of [
          { requestId: "another-command" }, { chatId: "another-chat" },
          { agentId: "codex" }, { executionId: "another-execution", sessionId: "another-execution" },
        ]) f.connection.observePromptResult({ ...terminal, ...mismatch });
        await Promise.resolve();
        expect(completed).not.toHaveBeenCalled();
        f.connection.observePromptResult(terminal);
        await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
        expect(completed).toHaveBeenCalledWith({ ...terminal, chatId: chat,
          executionId: `conversation:${chat}`, sessionId: `conversation:${chat}` });
      } finally {
        f.setState("succeeded");
        await flight;
        f.connection.dispose();
      }
    },
  );

  it.each([
    { conversationId: "another-conversation" },
    { commandId: "33333333-3333-4333-8333-333333333333" },
  ])("rejects a receipt for another command or conversation: %j", async identity => {
    const f = fixture(identity);
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" } });
    await expect(f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "receipt-owner", prompt: [{ type: "text", text: "test" }] }))
      .rejects.toThrow("Cloud command receipt does not match this conversation");
    expect(() => f.connection.outgoing({ type: "AGENT_PERMISSION_RESPONSE", sessionId: `conversation:${chat}` }))
      .toThrow("This cloud conversation has no active execution");
    f.connection.dispose();
  });

  it.each(["authorized", "denied", "cancelled"])("loads prompt preflight concurrently but never enqueues before %s admission", async outcome => {
    const f = fixture();
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" } });
    f.request.mockClear();
    let authorize!: (value: string) => void, deny!: (error: Error) => void;
    f.authorize.mockReturnValueOnce(new Promise((resolve, reject) => { authorize = resolve; deny = reject; }));
    const controller = new AbortController();
    const pending = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "parallel-preflight", prompt: [] }, { signal: controller.signal })
      .then(result => ({ result, error: null }), error => ({ result: null, error: error as Error }));
    try {
      // The two authenticated reads do not depend on credential minting. A
      // delayed grant must not add another network round trip to prompt startup.
      expect(f.request.mock.calls.map(([message]) => message.op)).toEqual([
        "cloudCommands.conversation", "cloudCommands.request",
      ]);
      expect(f.getEnqueued()).toBeUndefined();
    } finally {
      if (outcome === "cancelled") controller.abort();
      if (outcome === "denied") deny(new Error("credential denied"));
      else authorize(grant);
      const settled = await pending;
      if (outcome === "authorized") {
        expect(settled.result?.type).toBe("AGENT_PROMPT_COMPLETE");
        expect(f.getEnqueued()).toMatchObject({ payload: { agentCredentialGrantId: grant } });
      } else {
        expect(settled.error?.message).toMatch(outcome === "denied" ? /credential denied/ : /cancelled/);
        expect(f.getEnqueued()).toBeUndefined();
      }
      f.connection.dispose();
    }
  });

  it("keeps an in-flight prompt bound to the model and effort that were authorized", async () => {
    const f = fixture();
    let authorize!: (value: string) => void;
    f.authorize.mockReturnValueOnce(new Promise(resolve => { authorize = resolve; }));
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6", ZEROS_THINKING_EFFORT: "high" } });
    const pending = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "captured-model", prompt: [{ type: "text", text: "test" }] });
    f.connection.send({ type: "AGENT_UPDATE_CONFIG", sessionId: `conversation:${chat}`,
      env: { OPENAI_MODEL: "another-model", ZEROS_THINKING_EFFORT: "max", ZEROS_FAST_MODE: "1" } });
    authorize(grant);
    await pending;
    expect(f.getEnqueued()).toMatchObject({ payload: { model: "gpt-5.6", effort: "high", fast: false } });
    f.connection.dispose();
  });
  it.each(["max", "ultracode"])("preserves the existing %s effort choice in cloud commands", async effort => {
    const f = fixture();
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6", ZEROS_THINKING_EFFORT: effort } });
    await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "effort-message",
      prompt: [{ type: "text", text: "test" }] });
    expect(f.getEnqueued()).toMatchObject({ payload: { effort } });
    f.connection.dispose();
  });
  it("attaches without spawning and submits one authorized durable command for duplicate sends", async () => {
    const f = fixture();
    const created = await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" },
    });
    const sessionId = (created!.session as WireRecord).sessionId;
    expect(
      f.request.mock.calls.every(
        ([message]) => message.type === "WORKSPACE_REQUEST",
      ),
    ).toBe(true);
    const prompt = {
      type: "AGENT_PROMPT",
      sessionId,
      agentId: "codex",
      userMessageId: "message-1",
      prompt: [{ type: "text", text: "hello" }],
    };
    const [one, two] = await Promise.all([
      f.connection.request(prompt),
      f.connection.request(prompt),
    ]);
    expect(one).toEqual(two);
    expect(one?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.getEnqueued()).toMatchObject({
      kind: "enqueue",
      payload: {
        agentCredentialGrantId: grant,
        model: "gpt-5.6",
        userMessageId: "message-1",
      },
    });
    f.connection.dispose();
  });

  it("routes live tool notifications and Stop through their conversation", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
    });
    const update = f.connection.incoming({
      type: "AGENT_SESSION_UPDATE",
      chatId: chat,
      executionId: "real-execution",
      notification: {
        sessionId: "real-execution",
        update: { sessionUpdate: "tool_call", toolCallId: "native-tool" },
      },
    });
    expect(update).toMatchObject({
      executionId: `conversation:${chat}`,
      notification: {
        sessionId: `conversation:${chat}`,
        update: { toolCallId: "native-tool" },
      },
    });
    expect(
      f.connection.incoming({
        type: "AGENT_PERMISSION_REQUEST",
        permissionId: "permission",
        request: {
          sessionId: "real-execution",
          toolCall: { toolCallId: "native-tool" },
        },
      }),
    ).toMatchObject({
      chatId: chat,
      request: { sessionId: `conversation:${chat}` },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_CANCEL",
        sessionId: `conversation:${chat}`,
      }),
    ).toMatchObject({
      op: "cloudCommands.request",
      params: { request: { kind: "stop", conversationId: chat } },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_PERMISSION_RESPONSE",
        sessionId: `conversation:${chat}`,
        permissionId: "native-permission",
      }),
    ).toMatchObject({
      sessionId: "real-execution",
      permissionId: "native-permission",
    });
  });

  it("restores an active conversation after reconnect without spawning a replacement", async () => {
    const f = fixture();
    const permissions = vi.fn();
    const metadata = vi.fn();
    f.connection.on("AGENT_PERMISSION_REQUEST", permissions);
    f.connection.on("AGENT_SESSION_CREATED", metadata);
    const response = await f.connection.request({
      type: "AGENT_LOAD_SESSION",
      chatId: chat,
      agentId: "codex",
      providerBinding: { resume: { id: "native" } },
    });
    expect(response).toMatchObject({
      type: "AGENT_SESSION_LOADED",
      promptActive: true,
      activeTurnStartedAt: 100,
      response: { providerBinding: { resume: { id: "native" } } },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_PERMISSION_RESPONSE",
        sessionId: `conversation:${chat}`,
      }),
    ).toMatchObject({ sessionId: "reconnected" });
    expect(
      f.request.mock.calls.some(
        ([message]) => message.type === "AGENT_NEW_SESSION",
      ),
    ).toBe(false);
    expect(
      f.request.mock.calls.some(
        ([message]) => message.op === "cloudCommands.createConversation",
      ),
    ).toBe(false);
    await vi.waitFor(() => expect(permissions).toHaveBeenCalledOnce());
    expect(metadata).toHaveBeenCalledOnce();
    expect(f.connection.incoming(metadata.mock.calls[0][0])).toMatchObject({
      chatId: chat,
      session: {
        executionId: `conversation:${chat}`,
        modes: { currentModeId: "ask" },
      },
      initialize: { agentCapabilities: { steering: true } },
    });
    expect(f.connection.incoming(permissions.mock.calls[0][0])).toMatchObject({
      permissionId: "pending",
      chatId: chat,
      request: {
        sessionId: `conversation:${chat}`,
        toolCall: { toolCallId: "tool" },
      },
    });
    f.connection.dispose();
  });

  it("keeps loaded session metadata on the same attachment route", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
    });
    expect(
      f.connection.incoming({
        type: "AGENT_SESSION_LOADED",
        chatId: chat,
        executionId: "real",
        response: {
          executionId: "real",
          providerBinding: { resumeId: "opaque" },
        },
      }),
    ).toMatchObject({
      executionId: `conversation:${chat}`,
      response: {
        executionId: `conversation:${chat}`,
        providerBinding: { resumeId: "opaque" },
      },
    });
    f.connection.dispose();
  });

  it("does not enqueue when authorization fails or replay an uncertain command", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" },
    });
    f.authorize.mockRejectedValueOnce(new Error("authorization required"));
    const message = {
      type: "AGENT_PROMPT",
      sessionId: `conversation:${chat}`,
      userMessageId: "message-1",
      prompt: [{ type: "text", text: "hello" }],
    };
    await expect(f.connection.request(message)).rejects.toThrow(
      "authorization required",
    );
    expect(f.getEnqueued()).toBeUndefined();
    f.setState("uncertain");
    expect(await f.connection.request(message)).toMatchObject({
      type: "AGENT_PROMPT_FAILED",
      error: expect.stringContaining("unknown"),
    });
  });
});
