import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import {
  CloudCommandSnapshotSchema,
  CloudCommandEntrySchema,
  CloudBootCommandSnapshotSchema,
  CloudBootCommandEntrySchema,
  CLOUD_AGENT_PERMISSION_MODES,
  cloudPermissionMode,
  type CloudCommandSnapshot,
  type CloudClaudePreferences,
  type CloudNativeOperation,
  CloudNativeOperationSchema,
  CloudNativeResultSchema,
  cloudCommandFailureFromCode,
} from "@zeros/protocol/cloud-commands";
import type { RuntimeClient } from "./ws-client";
import { CloudAgentBootConversationSchema, type CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import type { BackgroundTasksUpdate } from "@zeros/protocol/agent-events";
import type { BridgeMessage } from "./messages";
import { record, type WireRecord } from "./cloud-runtime-wire";
import type { CloudEventReader, CloudSnapshotInstallation } from "./cloud-event-reader";

type Options = Exclude<
  Parameters<RuntimeClient["request"]>[1],
  number | undefined
>;
type Conversation = {
  id: string;
  agentId: string;
  model: string;
  effort?: string;
  fast: boolean;
  claudePreferences?: CloudClaudePreferences;
  execution?: string;
  turnId?: string;
  intentRevision?: number;
  modeRevision: number;
  localDirectories?: boolean;
  permissionMode?: string;
  promptActive?: boolean;
  permissionRevision?: number;
  nativeCommandsVersion?: number;
  goalRevision?: number;
  nativeResult?: ReturnType<typeof CloudNativeResultSchema.parse>;
  snapshotRevision?: number;
  backgroundRevision?: number;
  backgroundTasks?: BackgroundTasksUpdate;
};
type NativeSnapshot = {
  owner: Conversation;
  snapshot: WireRecord;
  revision: number;
  execution?: string;
  backgroundRevision: number;
  cursor?: unknown;
  restoration?: CloudSnapshotInstallation;
};
/** Device selection only. A replacement transport obtains fresh execution and
 * credential authority; neither can be transferred with an attachment. */
export type CloudConversationAttachment = Omit<Conversation, "execution" | "turnId" | "intentRevision" | "promptActive" | "permissionRevision" | "snapshotRevision" | "backgroundRevision" | "backgroundTasks">;
const routeId = (id: string) => `conversation:${id}`;
// Individual command reads include their conversation owner; entries inside a
// queue snapshot inherit that identity from the snapshot instead.
const commandReceiptSchema = CloudCommandEntrySchema.extend({
  conversationId: CloudCommandSnapshotSchema.shape.conversationId,
});

/** A capability refusal occurs before a durable command is submitted. */
export class CloudRuntimeCompatibilityError extends Error {
  readonly code = "cloud_runtime_feature_unavailable";
  readonly action: "update-runtime" | "update-desktop";
  readonly feature = "native-commands-v1";
  constructor(runtimeVersion: unknown) {
    const newer = typeof runtimeVersion === "number" && Number.isInteger(runtimeVersion) && runtimeVersion > 1;
    super(newer ? "Update Zeros to use native conversation operations on this cloud runtime"
      : "Update the cloud runtime to use native conversation operations");
    this.action = newer ? "update-desktop" : "update-runtime";
    this.name = "CloudRuntimeCompatibilityError";
  }
}

/** Each settled command advances the queue revision exactly once. Require all
 * intervening revisions to be explained by those exact dispatching commands:
 * another Stop advances it again even when the queue is already paused. */
function onlyCommandRetirements(before: CloudCommandSnapshot, after: CloudCommandSnapshot): boolean {
  if (before.conversationId !== after.conversationId || !before.paused || !after.paused) return false;
  const pending = new Map(after.pending.map(row => [row.commandId, row]));
  const receipts = new Map(after.receipts.map(row => [row.commandId, row]));
  if (pending.size !== after.pending.length || receipts.size !== after.receipts.length) return false;
  let retired = 0;
  for (const row of before.pending) {
    const retained = pending.get(row.commandId);
    if (retained) {
      if (JSON.stringify(retained) !== JSON.stringify(row)) return false;
      pending.delete(row.commandId);
      continue;
    }
    const receipt = receipts.get(row.commandId);
    if (row.state !== "dispatching" || !receipt ||
      !["succeeded", "failed", "cancelled"].includes(receipt.state) ||
      receipt.executionId !== row.executionId || receipt.generation !== row.generation ||
      receipt.position !== row.position || receipt.createdAt !== row.createdAt) return false;
    receipts.delete(row.commandId);
    retired++;
  }
  return pending.size === 0 && retired > 0 && after.revision === before.revision + retired;
}

/** Adapts a durable cloud conversation to the existing session UI contract.
 * The route is a conversation attachment, never a provider resume identity.
 * Commands own real executions; closing the UI does not cancel their work. */
export class CloudAgentConnection {
  private readonly conversations = new Map<string, Conversation>();
  private readonly executionOwners = new Map<string, string>();
  private readonly commandOwners = new Map<string, string>();
  private readonly retiredExecutions = new Map<string, string>();
  private readonly pending = new Map<string, Promise<WireRecord>>();
  private readonly promptResults = new Map<string, {
    owner: Conversation;
    execution?: string;
    resolve: (message: WireRecord) => void;
  }>();
  private closed = false;
  private nativeCommandsVersion=0;
  private claudePreferencesVersion=0;
  private cloudTurnProtocolVersion=0;
  private localCommandsBinding?: CloudAgentBootConversation;
  private readonly attaching = new Map<string, number>();
  private listeners = new Map<string, Set<(message: BridgeMessage) => void>>();

  constructor(
    private readonly client: RuntimeClient,
    private readonly workspaceId: string,
    private readonly grant: (agentId: string, model: string) => Promise<string>,
    private readonly events?: CloudEventReader,
  ) {}

  private localCommandsRefusal(): Error {
    return Object.assign(new Error("Update Zeros to use this cloud runtime"), { code: "cloud_workspace_client_update_required" });
  }

  private confirmLocalCommands(value: unknown): void {
    const capable = this.client.supportsEngineCapability?.("cloud.localCommands.v1") === true;
    if (value === undefined && !capable && !this.localCommandsBinding) return;
    const parsed = CloudAgentBootConversationSchema.safeParse(value), peer = this.client.executionIdentity;
    if (!capable || !parsed.success || peer?.kind !== "cloud" ||
        ["organizationId", "workspaceId", "generation", "engineInstanceId", "authorityEpoch"].some(key =>
          parsed.data[key as keyof CloudAgentBootConversation] !== peer[key as keyof typeof peer]) ||
        this.localCommandsBinding && ["bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"].some(key =>
          parsed.data[key as keyof CloudAgentBootConversation] !== this.localCommandsBinding![key as keyof CloudAgentBootConversation]))
      throw this.localCommandsRefusal();
    this.localCommandsBinding = parsed.data;
  }

  private parseQueue(value: unknown): CloudCommandSnapshot {
    return (this.localCommandsBinding ? CloudBootCommandSnapshotSchema : CloudCommandSnapshotSchema).parse(value);
  }

  private parseReceipt(value: unknown) {
    return (this.localCommandsBinding ? CloudBootCommandEntrySchema.extend({
      conversationId: CloudCommandSnapshotSchema.shape.conversationId,
    }) : commandReceiptSchema).parse(value);
  }

  on(type: string, listener: (message: BridgeMessage) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  snapshotAttachments(): CloudConversationAttachment[] {
    return [...this.conversations.values()].map(owner => ({
      id: owner.id, agentId: owner.agentId, model: owner.model,
      effort: owner.effort, fast: owner.fast, modeRevision: owner.modeRevision,
      localDirectories: owner.localDirectories, permissionMode: owner.permissionMode,
      ...(owner.claudePreferences ? { claudePreferences: { ...owner.claudePreferences } } : {}),
    }));
  }

  hasCurrentExecution(conversationId: string, executionId: string): boolean {
    const native = this.conversations.get(conversationId)?.execution;
    // The renderer receives the stable conversation alias. Prove it through
    // the original native mapping; an unbound alias is not a live execution.
    return !this.closed && native !== undefined && this.executionOwners.get(native) === conversationId &&
      (executionId === native || executionId === routeId(conversationId));
  }

  restoreAttachments(attachments: readonly CloudConversationAttachment[]): void {
    if (this.closed || this.conversations.size || attachments.length > 256)
      throw new Error("Cloud conversation attachments cannot be restored");
    for (const owner of attachments) this.conversations.set(owner.id, {
      id: owner.id, agentId: owner.agentId, model: owner.model,
      effort: owner.effort, fast: owner.fast, modeRevision: owner.modeRevision,
      localDirectories: owner.localDirectories, permissionMode: owner.permissionMode,
      ...(owner.claudePreferences ? { claudePreferences: { ...owner.claudePreferences } } : {}),
    });
  }

  /** Only the ordered event reader may acknowledge a native turn here. The
   * durable receipt additionally proves retirement; it remains the fallback
   * after a lost terminal frame, not a reason to keep a completed turn busy. */
  observePromptResult(message: WireRecord): void {
    if (this.closed || !["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(String(message.type))) return;
    const result = this.promptResults.get(String(message.requestId));
    if (!result || message.agentId !== result.owner.agentId ||
      (message.chatId !== undefined && message.chatId !== result.owner.id)) return;
    const execution = message.executionId ?? message.sessionId;
    if (typeof execution !== "string" ||
      (message.executionId !== undefined && message.sessionId !== undefined && message.executionId !== message.sessionId) ||
      (result.execution !== undefined && result.execution !== execution)) return;
    const mapped = this.incoming(message);
    if (mapped) result.resolve(mapped);
  }

  private currentSnapshot(state: NativeSnapshot): boolean {
    return !this.closed && (!state.restoration || state.restoration.current()) &&
      this.conversations.get(state.owner.id) === state.owner &&
      state.owner.snapshotRevision === state.revision &&
      (state.owner.execution === state.execution || state.owner.execution === state.snapshot.executionId);
  }

  private attachSnapshot(state: NativeSnapshot): WireRecord {
    if (!this.currentSnapshot(state)) { state.restoration?.finish(); throw new Error("Cloud execution changed during restore"); }
    const { owner, snapshot } = state;
    const execution = typeof snapshot.executionId === "string" ? snapshot.executionId : undefined;
    const previousBackground = owner.backgroundTasks;
    this.bindExecution(owner, execution);
    state.execution = execution;
    for (const [id, chat] of this.executionOwners)
      if (chat === owner.id && id !== execution) this.executionOwners.delete(id);
    if (execution) this.executionOwners.set(execution, owner.id);
    // Live full replacements received during the read outrank its snapshot.
    if ((owner.backgroundRevision ?? 0) === state.backgroundRevision) {
      owner.backgroundTasks = execution
        ? record(snapshot.session).backgroundTasks as BackgroundTasksUpdate | undefined
        : previousBackground ? { sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: null } : undefined;
    }
    snapshot.session = { ...record(snapshot.session), backgroundTasks: owner.backgroundTasks };
    state.backgroundRevision = owner.backgroundRevision ?? 0;
    const activeTurnId = record(snapshot.activeTurn).turnId;
    this.bindTurn(owner, typeof activeTurnId === "string" ? activeTurnId : undefined);
    owner.promptActive = !!snapshot.activeTurn;
    const publish = () => {
      if (!Array.isArray(snapshot.messages)) return; // Older runtime metadata.
      const controls = (field: string) => (Array.isArray(snapshot[field]) ? snapshot[field] as unknown[] : []).map(item => {
        const row = record(item), request = record(row.request);
        return { ...row, request: { ...request, sessionId: routeId(owner.id), executionId: request.executionId ?? request.sessionId } };
      });
      const frame = { type: "AGENT_SESSION_CREATED", chatId: owner.id, agentId: owner.agentId,
        session: { ...record(snapshot.session), sessionId: routeId(owner.id), executionId: routeId(owner.id) },
        initialize: snapshot.initialize ?? { protocolVersion: 1, agentCapabilities: {} },
        cloudSnapshot: { ...snapshot, permissions: controls("permissions"), questions: controls("questions") } };
      for (const listener of this.listeners.get(frame.type) ?? []) listener(frame as unknown as BridgeMessage);
    };
    try {
      if (state.restoration) state.restoration.install(state.cursor, { conversationId: owner.id, executionId: execution }, publish);
      else publish();
    } catch (error) { state.restoration?.finish(); throw error; }
    return snapshot;
  }

  private publishControls(state: NativeSnapshot): void {
    // Let the caller bind the returned session before delivering its restored
    // controls. This is one event-loop task, not a delayed readiness heuristic.
    setTimeout(() => {
      try {
      if (this.closed || !this.currentSnapshot(state)) return;
      const { snapshot } = state;
      const attached=this.conversations.get(String(snapshot.conversationId));
      if(attached?.nativeResult && "goal" in attached.nativeResult && (!snapshot.activeTurn||attached.goalRevision!==undefined)) {
        const frame={type:"AGENT_SESSION_UPDATE",agentId:attached.agentId,chatId:attached.id,
          notification:{sessionId:routeId(attached.id),update:{sessionUpdate:"goal_update",goal:attached.nativeResult.goal}}};
        for(const listener of this.listeners.get(frame.type)??[])listener(frame as unknown as BridgeMessage);
      }
      if (snapshot.executionId && snapshot.initialize && snapshot.session) {
        const owner = this.conversations.get(String(snapshot.conversationId));
        if (owner?.execution !== snapshot.executionId) return;
        const session = { ...record(snapshot.session) };
        // The native stream can finish a task after restore but before this
        // deferred metadata event. Never let it resurrect that task.
        if ((owner.backgroundRevision ?? 0) !== state.backgroundRevision) delete session.backgroundTasks;
        const modes = record(session.modes);
        const frame = {
          type: "AGENT_SESSION_CREATED",
          chatId: snapshot.conversationId,
          promptActive: !!snapshot.activeTurn,
          agentId:
            snapshot.agentId ??
            this.conversations.get(String(snapshot.conversationId))?.agentId,
          session: {
            ...session,
            // An idle execution describes the previous command. The saved
            // next-send choice is authoritative until a new command starts.
            ...(!snapshot.activeTurn && owner.permissionMode && session.modes
              ? { modes: { ...modes, currentModeId: owner.permissionMode } }
              : {}),
            executionId: snapshot.executionId,
            sessionId: snapshot.executionId,
          },
          initialize: snapshot.initialize,
        };
        for (const listener of this.listeners.get(frame.type) ?? [])
          listener(frame as unknown as BridgeMessage);
      } else if (attached?.backgroundTasks && (attached.backgroundRevision ?? 0) === state.backgroundRevision) {
        const frame = { type: "AGENT_SESSION_UPDATE", agentId: attached.agentId, chatId: attached.id,
          notification: { sessionId: routeId(attached.id), update: attached.backgroundTasks } };
        for (const listener of this.listeners.get(frame.type) ?? []) listener(frame as unknown as BridgeMessage);
      }
      for (const [field, type] of [
        ["permissions", "AGENT_PERMISSION_REQUEST"],
        ["questions", "AGENT_QUESTION_REQUEST"],
      ]) {
        for (const item of Array.isArray(snapshot[field])
          ? (snapshot[field] as unknown[])
          : []) {
          const frame = {
            ...record(item),
            type,
            chatId: snapshot.conversationId,
          };
          for (const listener of this.listeners.get(type) ?? [])
            listener(frame as unknown as BridgeMessage);
        }
      }
      } finally { state.restoration?.finish(); }
    }, 0);
  }

  async refreshAttachments(conversationId?: string): Promise<void> {
    await Promise.allSettled(
      [...this.conversations.values()].filter(owner => !conversationId || owner.id === conversationId).map(async (owner) => {
        const state = await this.restoreNativeState(owner);
        this.attachSnapshot(state);
        this.publishControls(state);
      }),
    );
  }

  private async restoreNativeState(owner:Conversation):Promise<NativeSnapshot> {
    const restoration = this.events?.beginSnapshot({ conversationId: owner.id, executionId: owner.execution });
    try {
    const revision = owner.snapshotRevision = (owner.snapshotRevision ?? 0) + 1;
    const execution = owner.execution, backgroundRevision = owner.backgroundRevision ?? 0;
    if(owner.nativeCommandsVersion===undefined) {
      const conversation=await this.op("cloudCommands.conversation",{conversationId:owner.id});
      owner.nativeCommandsVersion=Number(conversation.nativeCommandsVersion??0);
    }
    const [events,commands]=await Promise.all([this.op("cloudEvents.request",{request:{kind:"snapshot",conversationId:owner.id}}),
      this.op("cloudCommands.request",{request:{kind:"snapshot",conversationId:owner.id}})]);
    const queue=this.parseQueue(commands);
    if(queue.conversationId!==owner.id)throw new Error("Cloud state belongs to another conversation");
    const state = { owner, snapshot: record(events.snapshot), cursor: events.cursor, restoration, revision, execution, backgroundRevision };
    if (state.snapshot.conversationId !== owner.id) throw new Error("Cloud state belongs to another conversation");
    if (!this.currentSnapshot(state)) throw new Error("Cloud execution changed during restore");
    const receipts=[...queue.receipts].sort((left,right)=>Date.parse(right.updatedAt)-Date.parse(left.updatedAt));
    const confirmed=receipts.find(row=>row.result?.capabilities && row.result.model===owner.model)?.result;
    let goal=receipts.find(row=>row.result && "goal" in row.result)?.result;
    if(queue.nativeGoal){
      if(queue.nativeGoal.conversationId!==owner.id||queue.nativeGoal.revision>queue.revision)throw new Error("Cloud goal state belongs to another conversation revision");
      if((owner.goalRevision??-1)<=queue.nativeGoal.revision){
        owner.goalRevision=queue.nativeGoal.revision;goal={version:1,goal:queue.nativeGoal.goal};
      }else goal=owner.nativeResult;
    }else if(owner.goalRevision!==undefined)goal=owner.nativeResult;
    owner.nativeResult={version:1,...(confirmed??{}),...(goal&&"goal" in goal?{goal:goal.goal}:{})};
    return state;
    } catch (error) { restoration?.finish(); throw error; }
  }

  private async op(op: string, params: WireRecord, submission?: {
    owner: Conversation; signal?: AbortSignal; deadline: number; intentCurrent?: () => boolean;
  }): Promise<WireRecord> {
    const assertCurrent = (checkIntent = true) => {
      if (this.closed) throw new Error("Cloud workspace connection closed");
      submission?.signal?.throwIfAborted();
      if (submission && this.conversations.get(submission.owner.id) !== submission.owner)
        throw new Error("Cloud conversation changed before submission");
      if (checkIntent && submission?.intentCurrent && !submission.intentCurrent())
        throw new Error("Cloud turn changed before submission");
    };
    let backoff = 250;
    for (;;) {
      assertCurrent();
      const remaining = submission ? submission.deadline - Date.now() : 30_000;
      if (remaining <= 0) throw new Error("The cloud workspace is still checkpointing. Try sending again when it is ready.");
      const response = await this.client.request(
        { type: "WORKSPACE_REQUEST", op, params:op==="cloudCommands.request"?{...params,
          ...(this.nativeCommandsVersion===1?{nativeCommandsVersion:1}:{}),
          ...(this.cloudTurnProtocolVersion===1?{cloudTurnProtocolVersion:1}:{}),
          ...(this.claudePreferencesVersion===1?{claudePreferencesVersion:1}:{}),
          ...(this.localCommandsBinding ? { cloudLocalCommandsVersion: 1,
            bootId: this.localCommandsBinding.bootId, writerEpoch: this.localCommandsBinding.writerEpoch } : {}),
        }:params },
        submission ? { timeoutMs: Math.min(30_000, remaining), signal: submission.signal } : 30_000,
      );
      // An applied acknowledgement can arrive after a newer turn starts. Its
      // caller fences state updates; an error may retry only the original intent.
      assertCurrent(response.type === "WORKSPACE_ERROR");
      if (response.type === "WORKSPACE_ERROR") {
        // Server cancellation can precede the engine releasing its capture
        // fence. Only this explicit pre-dispatch rejection is safe to retry;
        // keep the exact mutation identity, payload and expected revision.
        if (submission && response.code === "CLOUD_WORKSPACE_CHECKPOINTING") {
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); submission.signal?.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, Math.max(0, Math.min(backoff, submission.deadline - Date.now())));
            submission.signal?.addEventListener("abort", done, { once: true });
            if (submission.signal?.aborted) done();
          });
          backoff = Math.min(backoff * 2, 2_000);
          continue;
        }
        throw new Error(response.message || "Cloud request failed");
      }
      const result=record((response as unknown as WireRecord).result);
      if(op==="cloudCommands.conversation"||op==="cloudCommands.createConversation") {
        this.confirmLocalCommands(result.cloudLocalCommands);
        this.nativeCommandsVersion=Number(result.nativeCommandsVersion??0);
        this.cloudTurnProtocolVersion=Number(result.cloudTurnProtocolVersion??0);
        this.claudePreferencesVersion=Number(result.claudePreferencesVersion??0);
      }
      return result;
    }
  }

  private owner(message: WireRecord): Conversation | undefined {
    if (typeof message.chatId === "string")
      return this.conversations.get(message.chatId);
    const id =
      message.executionId ??
      message.sessionId ??
      record(message.request).sessionId ??
      record(message.notification).sessionId;
    if (typeof id !== "string") return undefined;
    return this.conversations.get(
      id.startsWith("conversation:")
        ? id.slice(13)
        : (this.executionOwners.get(id) ?? ""),
    );
  }

  private bindExecution(owner: Conversation, execution?: string): void {
    if (owner.execution === execution) return;
    if (owner.execution) {
      this.retiredExecutions.set(owner.execution, owner.id);
      while (this.retiredExecutions.size > 512) this.retiredExecutions.delete(this.retiredExecutions.keys().next().value!);
    }
    owner.backgroundTasks = undefined;
    owner.execution = execution;
    for (const [id, chat] of this.executionOwners) if (chat === owner.id) this.executionOwners.delete(id);
    if (execution) this.executionOwners.set(execution, owner.id);
  }

  private bindTurn(owner: Conversation, turnId?: string): void {
    if (owner.turnId === turnId) return;
    owner.turnId = turnId;
    owner.intentRevision = (owner.intentRevision ?? 0) + 1;
  }

  private detach(owner: Conversation): void {
    this.conversations.delete(owner.id);
    this.events?.forgetAttachment(owner.id);
    for (const [execution, chat] of this.executionOwners) if (chat === owner.id) this.executionOwners.delete(execution);
    for (const [command, chat] of this.commandOwners) if (chat === owner.id) {
      this.commandOwners.delete(command); this.promptResults.delete(command);
    }
    for (const [execution, chat] of this.retiredExecutions) if (chat === owner.id) this.retiredExecutions.delete(execution);
  }

  /** Called before the normal namespacing boundary. Only protocol identities
   * are rewritten; tool records and provider bindings remain opaque. */
  incoming(message: WireRecord): WireRecord | null {
    const chatId =
      typeof message.chatId === "string"
        ? message.chatId
        : this.commandOwners.get(String(message.requestId));
    const session = record(message.session);
    const execution =
      message.executionId ??
      message.sessionId ??
      session.executionId ??
      session.sessionId ??
      record(message.notification).sessionId ??
      record(message.request).sessionId;
    const owner = chatId
      ? this.conversations.get(chatId)
      : this.conversations.get(
          this.executionOwners.get(String(execution)) ?? "",
        );
    if (typeof execution === "string" && this.retiredExecutions.has(execution)) return null;
    if (!owner) return message;
    if (
      typeof execution === "string" &&
      !execution.startsWith("conversation:")
    ) {
      this.bindExecution(owner, execution);
    }
    const update = record(record(message.notification).update);
    if (message.type === "AGENT_SESSION_UPDATE" && update.sessionUpdate === "turn_state" && update.state === "running" && typeof update.turnId === "string") {
      this.bindTurn(owner, update.turnId);
      owner.promptActive = true;
    }
    if (message.type === "AGENT_SESSION_UPDATE" && update.sessionUpdate === "background_tasks_update") {
      owner.backgroundRevision = (owner.backgroundRevision ?? 0) + 1;
      owner.backgroundTasks = update as unknown as BackgroundTasksUpdate;
    }
    if (["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED"].includes(String(message.type))) owner.promptActive = message.promptActive !== false;
    if (["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(String(message.type))) owner.promptActive = false;
    const map = (value: WireRecord) => ({
      ...value,
      ...(typeof value.sessionId === "string"
        ? { sessionId: routeId(owner.id) }
        : {}),
      ...(typeof value.executionId === "string"
        ? { executionId: routeId(owner.id) }
        : {}),
    });
    return {
      ...map(message),
      chatId: owner.id,
      ...(message.notification
        ? { notification: map(record(message.notification)) }
        : {}),
      ...(message.request ? { request: { ...map(record(message.request)),
        ...(typeof execution === "string" ? { executionId: execution } : {}) } } : {}),
      ...(message.session ? { session: map(session) } : {}),
      ...(message.response ? { response: map(record(message.response)) } : {}),
    };
  }

  private configure(owner: Conversation, message: WireRecord): void {
    const env = record(message.env);
    if (message.env)
      owner.localDirectories =
        typeof env.ZEROS_ADDITIONAL_DIRS === "string" &&
        env.ZEROS_ADDITIONAL_DIRS !== "[]";
    const model =
      message.model ??
      env.ANTHROPIC_MODEL ??
      env.OPENAI_MODEL ??
      env.CODEX_MODEL ??
      env.CURSOR_MODEL;
    if (typeof model === "string" && model) owner.model = model;
    if (message.env)
      owner.effort =
        typeof env.ZEROS_THINKING_EFFORT === "string"
          ? env.ZEROS_THINKING_EFFORT
          : undefined;
    if (message.env) {
      owner.fast = env.ZEROS_FAST_MODE === "1";
      owner.permissionMode = cloudPermissionMode(owner.agentId, env.ZEROS_PERMISSION_MODE ?? "auto");
      if (owner.agentId === "claude") owner.claudePreferences = {
        autoMemoryEnabled: env.ZEROS_CLAUDE_AUTO_MEMORY !== "0",
        idleCompactionEnabled: env.ZEROS_CLAUDE_IDLE_COMPACTION === "1",
      };
    }
  }

  async request(
    message: WireRecord,
    options?: number | Options,
  ): Promise<WireRecord | null> {
    if(message.type==="AGENT_FORK_CONVERSATION") {
      const source=this.conversations.get(String(message.sourceChatId));
      if(!source || typeof message.destinationChatId!=="string")throw new Error("Reopen the source chat before forking");
      if(message.agentId!==source.agentId || message.destinationChatId===source.id)throw new Error("Fork conversation ownership changed");
      const owner:Conversation={...source,id:message.destinationChatId,execution:undefined,turnId:undefined,intentRevision:undefined,promptActive:false};
      const release = this.reserveAttachment(owner.id);
      try {
        await this.op("cloudCommands.createConversation",{conversationId:owner.id,workspaceId:this.workspaceId,agentId:owner.agentId,
          model:owner.model,sourceConversationId:source.id});
        if (this.closed) throw new Error("Cloud connection closed during attachment");
        this.conversations.set(owner.id,owner);
      } finally { release(); }
      const commandId=await this.operationIdentity(`fork:${source.id}:${owner.id}`);
      await this.nativeOperation(owner,{version:1,kind:"fork",sourceConversationId:source.id,
        strategy:message.forkStrategy==="transcript"?"transcript":owner.agentId==="codex"?"native":"transcript"},commandId,typeof options==="object"?options.signal:undefined);
      const conversation=await this.op("cloudCommands.conversation",{conversationId:owner.id});
      return {type:"AGENT_CONVERSATION_FORKED",agentId:owner.agentId,sourceChatId:source.id,destinationChatId:owner.id,
        ...(conversation.providerBinding?{providerBinding:conversation.providerBinding}:{})};
    }
    if (
      message.type === "AGENT_NEW_SESSION" ||
      message.type === "AGENT_LOAD_SESSION"
    ) {
      if (
        typeof message.chatId !== "string" ||
        typeof message.agentId !== "string"
      )
        throw new Error("Cloud conversations require their saved identity");
      const release = this.reserveAttachment(message.chatId);
      const previous = this.conversations.get(message.chatId);
      const owner = (previous?.agentId === message.agentId
        ? previous
        : undefined) ?? {
        id: message.chatId,
        agentId: message.agentId,
        model: "",
        fast: false,
        modeRevision: 0,
      };
      this.configure(owner, message);
      try {
      const conversation =
        message.type === "AGENT_LOAD_SESSION"
          ? await this.op("cloudCommands.conversation", {
              conversationId: owner.id,
            })
          : await this.op("cloudCommands.createConversation", {
              conversationId: owner.id,
              workspaceId: this.workspaceId,
              agentId: owner.agentId,
              ...(owner.model ? { model: owner.model } : {}),
            });
      owner.modeRevision = Number(conversation.modeRevision);
      owner.nativeCommandsVersion=Number(conversation.nativeCommandsVersion??0);
      if (this.closed) throw new Error("Cloud connection closed during attachment");
      this.conversations.set(owner.id, owner);
      } finally { release(); }
      const response = {
        executionId: routeId(owner.id),
        sessionId: routeId(owner.id),
        modes: { currentModeId: owner.permissionMode ?? cloudPermissionMode(owner.agentId),
          availableModes: CLOUD_AGENT_PERMISSION_MODES[owner.agentId as keyof typeof CLOUD_AGENT_PERMISSION_MODES].map(id => ({id, name:id})) },
      };
      if (message.type === "AGENT_NEW_SESSION")
        return {
          type: "AGENT_SESSION_CREATED",
          agentId: owner.agentId,
          session: response,
          initialize: { protocolVersion: 1, _meta:{modelSelectionTiming:"next-message",cloudNativeCommandsVersion:owner.nativeCommandsVersion} },
        };
      // Normalized messages are read by the same history path as local chats.
      // Snapshot the active execution to recover its pending controls as well.
      const state = await this.restoreNativeState(owner);
      const snapshot = this.attachSnapshot(state);
      this.publishControls(state);
      return {
        type: "AGENT_SESSION_LOADED",
        agentId: owner.agentId,
        ...response,
        response: {
          ...response,
          ...(owner.backgroundTasks ? { backgroundTasks: owner.backgroundTasks } : {}),
          ...(owner.nativeResult?.capabilities?{nativeCapabilities:owner.nativeResult.capabilities}:{}),
          ...(message.providerBinding
            ? { providerBinding: message.providerBinding }
            : {}),
        },
        promptActive: !!snapshot.activeTurn,
        ...(snapshot.activeTurn
          ? { activeTurnStartedAt: record(snapshot.activeTurn).startedAt }
          : {}),
      };
    }
    const owner = this.owner(message);
    if (!owner && message.type === "AGENT_PROMPT")
      throw new Error("This cloud conversation needs to reconnect before sending. Reopen the chat and retry.");
    if (!owner) return null;
    if (message.type === "AGENT_CANCEL") {
      const execution = owner.execution;
      const intentRevision = owner.intentRevision ?? 0;
      const intentCurrent = () => owner.execution === execution && (owner.intentRevision ?? 0) === intentRevision;
      const operationId = typeof message.id === "string" && /^[0-9a-f-]{36}$/i.test(message.id) ? message.id : crypto.randomUUID();
      const submission = { owner, deadline: Date.now() + 60_000, intentCurrent };
      for (let attempt = 0; ; attempt++) {
        try {
          const result = this.parseQueue(await this.op("cloudCommands.request", {
            request: { kind: "stop", conversationId: owner.id, operationId },
          }, submission));
          if (result.conversationId !== owner.id || !result.paused) throw new Error("Cloud Stop acknowledgement does not match this conversation");
          if (this.conversations.get(owner.id) === owner && intentCurrent()) owner.promptActive = false;
          return { type: "WORKSPACE_RESPONSE", op: "cloudCommands.request", requestId: message.id, result };
        } catch (error) {
          if (!intentCurrent()) throw new Error("Cloud turn changed before Stop acknowledgement");
          if (attempt >= 2 || this.closed || this.conversations.get(owner.id) !== owner ||
              !(error instanceof Error) || !/timeout|disconnected|swapping|network/i.test(error.message)) throw error;
        }
      }
    }
    if(message.type==="AGENT_GOAL_SET"||message.type==="AGENT_GOAL_CLEAR") {
      // Live changes use the existing actor/execution-scoped action check.
      if(owner.execution&&owner.promptActive)return null;
      const operation=CloudNativeOperationSchema.parse({version:1,kind:"goal",
        action:message.type==="AGENT_GOAL_SET"?"set":"clear",...(message.type==="AGENT_GOAL_SET"?{update:message.update}:{})});
      const entry=await this.nativeOperation(owner,operation,crypto.randomUUID(),typeof options==="object"?options.signal:undefined);
      if(!entry.result||!("goal" in entry.result))throw new Error("Cloud goal result is unavailable");
      return {type:"AGENT_GOAL_CHANGED",agentId:owner.agentId,sessionId:routeId(owner.id),executionId:routeId(owner.id),goal:entry.result.goal};
    }
    if (message.type === "AGENT_PROMPT") {
      const key = `${owner.id}:${String(message.userMessageId)}`;
      const existing = this.pending.get(key);
      if (existing) return existing;
      // Fence an older Stop before credential lookup or any other await. A
      // queued local send changes intent even before its execution is admitted.
      owner.turnId = typeof message.userMessageId === "string" ? message.userMessageId : undefined;
      owner.intentRevision = (owner.intentRevision ?? 0) + 1;
      const flight = this.prompt(
        owner,
        message,
        typeof options === "object" ? options.signal : undefined,
      ).finally(() => {
        if (this.pending.get(key) === flight) this.pending.delete(key);
      });
      this.pending.set(key, flight);
      return flight;
    }
    if (message.type === "AGENT_SET_MODE") {
      const mode = cloudPermissionMode(owner.agentId, message.modeId);
      const revision = owner.permissionRevision = (owner.permissionRevision ?? 0) + 1;
      const previous = owner.permissionMode;
      owner.permissionMode = mode;
      // Between commands this changes the attachment's next-send selection.
      // During a turn the real provider must acknowledge it before success.
      try {
        if (owner.execution && owner.promptActive) {
          const response = await this.client.request(this.outgoing(message) as unknown as BridgeMessage, options);
          if (response.type === "AGENT_ERROR") throw new Error(String((response as unknown as WireRecord).message ?? "Permission change failed"));
          return this.incoming(response as unknown as WireRecord);
        }
        return {type:"AGENT_MODE_CHANGED",agentId:owner.agentId,sessionId:routeId(owner.id),executionId:routeId(owner.id),modeId:mode};
      } catch (error) {
        if (owner.permissionRevision === revision) owner.permissionMode = previous;
        throw error;
      }
    }
    if (message.type === "AGENT_CLOSE_SESSION") {
      this.detach(owner);
      return {
        type: "AGENT_SESSION_CLOSED",
        agentId: owner.agentId,
        sessionId: routeId(owner.id),
        executionId: routeId(owner.id),
      };
    }
    return null;
  }

  private async operationIdentity(value:string):Promise<string> {
    const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`zeros-native-command:${value}`))).slice(0,16);
    bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  private async nativeOperation(owner:Conversation,operation:CloudNativeOperation,commandId:string,signal?:AbortSignal) {
    const {agentId,model,effort,fast,claudePreferences}=owner;
    const permissionMode=owner.permissionMode??cloudPermissionMode(agentId);
    if(!model)throw new Error("Choose a model before using this cloud operation");
    const [grant,conversation,snapshot]=await Promise.all([this.localCommandsBinding ? Promise.resolve(undefined) : this.grant(agentId,model),
      this.op("cloudCommands.conversation",{conversationId:owner.id}),
      this.op("cloudCommands.request",{request:{kind:"snapshot",conversationId:owner.id}})]);
    if(conversation.nativeCommandsVersion!==1)throw new CloudRuntimeCompatibilityError(conversation.nativeCommandsVersion);
    signal?.throwIfAborted();
    const queue=this.parseQueue(snapshot);
    if(![...queue.pending,...queue.receipts].some(row=>row.commandId===commandId)) {
      if(queue.paused && operation.kind!=="goal")throw new Error("Resume this conversation before changing its native state");
      await this.op("cloudCommands.request",{request:{kind:"mutate",mutation:{conversationId:owner.id,operationId:commandId,
        expectedRevision:queue.revision,action:{kind:operation.kind==="fork"?"fork":"enqueue",commandId,payload:{agentId,model,
          ...(grant ? { agentCredentialGrantId:grant } : {}),userMessageId:commandId,modeRevision:Number(conversation.modeRevision),permissionMode,
          ...(effort?{effort}:{}),fast,
          ...(agentId === "claude" && conversation.claudePreferencesVersion === 1
            ? { claudePreferences: claudePreferences ?? { autoMemoryEnabled: true, idleCompactionEnabled: false } } : {}),
          prompt:[{type:"text",text:""}],operation}}}}});
    }
    // Read the same receipt after reconnect/unknown acknowledgement. An
    // uncertain native mutation is never automatically dispatched again.
    const deadline=Date.now()+120_000;
    while(!this.closed && Date.now()<deadline) {
      signal?.throwIfAborted();
      const entry=this.parseReceipt(await this.op("cloudCommands.request",{request:{kind:"read",commandId}}));
      if(entry.conversationId!==owner.id || entry.commandId!==commandId)throw new Error("Cloud command receipt belongs to another conversation");
      if(entry.state==="succeeded")return entry;
      if(["failed","cancelled","uncertain"].includes(entry.state))throw new Error(`Cloud operation ${entry.state}. Reopen the conversation to inspect its saved state.`);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error("Cloud operation is still pending. Reopen the conversation to inspect its saved state.");
  }

  private async prompt(
    owner: Conversation,
    message: WireRecord,
    signal?: AbortSignal,
  ): Promise<WireRecord> {
    // Composer changes apply to the next send. This command must retain the
    // model/effort that its credential lookup authorizes across every await.
    const { agentId, model, effort, fast, localDirectories, claudePreferences } = owner;
    const permissionMode = owner.permissionMode ?? cloudPermissionMode(agentId);
    if (!model)
      throw new Error("Choose a model before sending to the cloud workspace");
    if (localDirectories)
      throw new Error(
        "Additional local folders cannot be used in a cloud workspace",
      );
    if (
      effort &&
      !["low", "medium", "high", "xhigh", "max", "ultracode"].includes(effort)
    )
      throw new Error(
        "Choose a supported effort level before sending to the cloud workspace.",
      );
    // These independently authenticated reads do not depend on the credential
    // grant. Await all three before any queue mutation or execution admission.
    const [grant, conversation, snapshot] = await Promise.all([
      this.localCommandsBinding ? Promise.resolve(undefined) : this.grant(agentId, model),
      this.op("cloudCommands.conversation", { conversationId: owner.id }),
      this.op("cloudCommands.request", {
        request: { kind: "snapshot", conversationId: owner.id },
      }),
    ]);
    owner.modeRevision = Number(conversation.modeRevision);
    let queue = this.parseQueue(snapshot);
    if (signal?.aborted)
      throw new Error("Cloud prompt was cancelled before submission");
    // The optimistic user-message identity survives retry/reload. Hash it into
    // a stable UUID so an unknown acknowledgement cannot send the prompt twice.
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `zeros-cloud-command:${owner.id}:${String(message.userMessageId)}`,
        ),
      ),
    ).slice(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    this.commandOwners.set(commandId, owner.id);
    // Mutated by the finally below while observeReceipt may still be awaiting.
    const observation = { live: true };
    let terminal: WireRecord | undefined;
    let wakeReceiptWait: (() => void) | undefined;
    const completed = new Promise<WireRecord>(resolve => {
      this.promptResults.set(commandId, { owner, resolve: message => {
        terminal ??= message;
        resolve(terminal);
      } });
    });
    try {
      const submission = { owner, signal, deadline: Date.now() + 60_000 };
      const observeReceipt = async (): Promise<WireRecord> => {
        const prior = [...queue.pending, ...queue.receipts].find(
          (row) => row.commandId === commandId,
        );
        if (!prior) {
          if (queue.paused) {
            const operationId = crypto.randomUUID();
            for (let attempt = 0; ; attempt++) {
              try {
                queue = this.parseQueue(await this.op("cloudCommands.request", {
                  request: {
                    kind: "mutate",
                    mutation: {
                      conversationId: owner.id,
                      operationId,
                      expectedRevision: queue.revision,
                      action: { kind: "resume" },
                    },
                  },
                }, submission));
                break;
              } catch (error) {
                if (!(error instanceof Error) || error.message !== "command_conflict" || attempt >= 2 || signal?.aborted)
                  throw error;
                const current = this.parseQueue(await this.op("cloudCommands.request", {
                  request: { kind: "snapshot", conversationId: owner.id },
                }));
                if (!observation.live) return terminal!;
                // Resume may race the stopped turn's durable retirement. A
                // changed pause/queue intent must still reject this stale send.
                if (signal?.aborted || !onlyCommandRetirements(queue, current)) throw error;
                queue = current;
              }
            }
          }
          if (!observation.live) return terminal!;
          const enqueue = () => this.op("cloudCommands.request", {
            request: {
              kind: "mutate",
              mutation: {
                conversationId: owner.id,
                operationId: commandId,
                expectedRevision: queue.revision,
                action: {
                  kind: "enqueue",
                  commandId,
                  payload: {
                    agentId,
                    userMessageId: message.userMessageId,
                    prompt: message.prompt,
                    ...(message.bubble ? { bubble: message.bubble } : {}),
                    modeRevision: Number(conversation.modeRevision),
                    ...(grant ? { agentCredentialGrantId: grant } : {}),
                    model,
                    ...(["low", "medium", "high", "xhigh", "max", "ultracode"].includes(
                      effort ?? "",
                    )
                      ? { effort }
                      : {}),
                    fast,
                    // Older pinned workers accept only their original strict
                    // payload. Preferences are additive and capability-gated.
                    ...(agentId === "claude" && conversation.claudePreferencesVersion === 1
                      ? { claudePreferences: claudePreferences ?? { autoMemoryEnabled: true, idleCompactionEnabled: false } } : {}),
                    ...(conversation.permissionModeVersion === 1 ? { permissionMode } : {}),
                  },
                },
              },
            },
          }, submission);
          // Native completion can arrive before the preceding command's
          // retirement advances the durable queue revision. Keep this send's
          // identity, grant and payload while rebasing only that revision.
          for (let attempt = 0; ; attempt++) {
            try { await enqueue(); break; }
            catch (error) {
              if (!(error instanceof Error) || error.message !== "command_conflict" || attempt >= 2 || signal?.aborted)
                throw error;
              const current = this.parseQueue(await this.op("cloudCommands.request", {
                request: { kind: "snapshot", conversationId: owner.id },
              }));
              if (!observation.live) return terminal!;
              if ([...current.pending, ...current.receipts].some(row => row.commandId === commandId)) break;
              // A concurrent Stop or unchanged revision is a real conflict,
              // not permission to resume or rewrite someone else's command.
              if (signal?.aborted || current.paused || current.revision === queue.revision) throw error;
              queue = current;
            }
          }
        }
        // Receipts recover completion after reconnect or lost terminal frames.
        // The server still serializes subsequent execution behind retirement.
        for (;;) {
          if (!observation.live) return terminal!;
          if (signal?.aborted || this.closed || this.conversations.get(owner.id) !== owner)
            throw new Error(
              "Cloud prompt observation ended; reconnect to view its result",
            );
          let entry;
          try {
            entry = this.parseReceipt(
              await this.op("cloudCommands.request", {
                request: { kind: "read", commandId },
              }),
            );
          } catch (error) {
            if (!observation.live) return terminal!;
            if (this.client.status === "connected") throw error;
          }
          if (!observation.live) return terminal!;
          if (entry && (entry.commandId !== commandId || entry.conversationId !== owner.id))
            throw new Error("Cloud command receipt does not match this conversation");
          const outcome = this.cloudTurnProtocolVersion === 1 ? entry?.result?.terminal : undefined;
          if (entry && outcome && (outcome.commandId !== commandId || outcome.conversationId !== owner.id || outcome.executionId !== entry.executionId ||
              outcome.turnId !== message.userMessageId || outcome.agentId !== owner.agentId || entry.payload && entry.payload.userMessageId !== outcome.turnId ||
              entry.state === "succeeded" && outcome.status !== "completed" || entry.state === "cancelled" && outcome.status !== "cancelled" ||
              entry.state === "failed" && outcome.status !== "failed"))
            throw new Error("Cloud terminal receipt does not match this turn");
          if (entry?.executionId) {
            const result = this.promptResults.get(commandId);
            if (result) result.execution = entry.executionId;
            if (!this.retiredExecutions.has(entry.executionId)) this.bindExecution(owner, entry.executionId);
          }
          if (entry?.state === "succeeded") {
            // Receipt persistence proves dispatch completion, not consumption
            // of the ordered transcript. Install its existing snapshot floor
            // before the renderer reads history, so delayed chunks cannot be
            // appended a second time to that normalized tail.
            const state = await this.restoreNativeState(owner);
            if (!observation.live) { state.restoration?.finish(); return terminal!; }
            try {
              this.attachSnapshot(state);
              const changed = { type: "DB_CHANGED", kinds: ["messages"], chatIds: [owner.id] };
              for (const listener of this.listeners.get("DB_CHANGED") ?? []) listener(changed as unknown as BridgeMessage);
              this.publishControls(state);
            } catch (error) { state.restoration?.finish(); throw error; }
          }
          if (entry && ["succeeded", "cancelled"].includes(entry.state))
            return {
              type: "AGENT_PROMPT_COMPLETE",
              agentId: owner.agentId,
              sessionId: routeId(owner.id),
              executionId: routeId(owner.id),
              stopReason: outcome?.stopReason ?? (entry.state === "cancelled" ? "cancelled" : "end_turn"),
              response: outcome?.response ?? {},
              requestId: commandId, chatId: owner.id,
            };
          if (entry && (["failed", "uncertain"].includes(entry.state) || isCloudAgentAdmissionCode(entry.resultCode)))
            return {
              type: "AGENT_PROMPT_FAILED",
              agentId: owner.agentId,
              sessionId: routeId(owner.id),
              executionId: routeId(owner.id),
              error: outcome?.error ?? (
                isCloudAgentAdmissionCode(entry.resultCode) || cloudCommandFailureFromCode(entry.resultCode)
                  ? entry.resultCode
                  : entry.state === "uncertain"
                  ? "The cloud command outcome is unknown. Review the transcript before retrying."
                  : "command_dispatch_rejected"),
              ...(outcome?.failure ? { failure: outcome.failure } : entry.state === "failed" && cloudCommandFailureFromCode(entry.resultCode, owner.agentId)
                ? { failure: cloudCommandFailureFromCode(entry.resultCode, owner.agentId) } : {}),
              requestId: commandId,
              chatId: owner.id,
            };
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { wakeReceiptWait = undefined; resolve(); }, 1000);
            wakeReceiptWait = () => { clearTimeout(timer); wakeReceiptWait = undefined; resolve(); };
          });
        }
      };
      let result = await Promise.race([completed, observeReceipt()]);
      if (result.type === "AGENT_PROMPT_FAILED" && !isCloudAgentAdmissionCode(result.error)) {
        // Deployed engines may discard the HTTP error code. Admission records
        // its denial before responding, so even an early generic terminal event
        // can recover this exact command's code without retrying the prompt.
        try {
          const receipt = this.parseReceipt(await this.op("cloudCommands.request", {
            request: { kind: "read", commandId },
          }));
          if (receipt.commandId === commandId && receipt.conversationId === owner.id &&
              isCloudAgentAdmissionCode(receipt.resultCode))
            result = { ...result, error: receipt.resultCode };
          else if (receipt.commandId === commandId && receipt.conversationId === owner.id && !result.failure &&
              cloudCommandFailureFromCode(receipt.resultCode, owner.agentId))
            result = { ...result, error: receipt.resultCode, failure: cloudCommandFailureFromCode(receipt.resultCode, owner.agentId) };
        } catch { /* An unavailable receipt cannot prove a pre-provider denial. */ }
      }
      // A terminal receipt also ends the execution's interactive controls when
      // its terminal event was lost. An interrupted observer proves nothing.
      owner.promptActive = false;
      return result;
    } finally {
      observation.live = false;
      wakeReceiptWait?.();
      this.promptResults.delete(commandId);
      this.commandOwners.delete(commandId);
    }
  }

  send(message: WireRecord): boolean {
    const owner = this.owner(message);
    if (!owner) return false;
    if (
      message.type === "AGENT_SET_MODEL" ||
      message.type === "AGENT_UPDATE_CONFIG"
    ) {
      this.configure(owner, message);
      return true;
    }
    if (message.type === "AGENT_CLOSE_SESSION") { this.detach(owner); return true; }
    return false;
  }

  outgoing(message: WireRecord): WireRecord {
    const owner = this.owner(message);
    if (!owner) return message;
    if (message.type === "AGENT_PERMISSION_RESPONSE" || message.type === "AGENT_QUESTION_RESPONSE") {
      if (!owner.execution) throw new Error("This cloud conversation has no active execution");
      if (message.chatId !== owner.id || !message.executionId || message.executionId !== owner.execution)
        throw new Error("Cloud resolver execution changed before reply");
      if (this.cloudTurnProtocolVersion !== 1) {
        const { chatId: _chatId, executionId: _executionId, ...legacy } = message;
        return legacy;
      }
      return message;
    }
    // Stop names the durable conversation even before an execution is admitted.
    if (message.type === "AGENT_CANCEL")
      return {
        type: "WORKSPACE_REQUEST",
        op: "cloudCommands.request",
        params: {
          request: {
            kind: "stop",
            conversationId: owner.id,
            operationId: crypto.randomUUID(),
          },
        },
      };
    if (!owner.execution)
      throw new Error("This cloud conversation has no active execution");
    return {
      ...message,
      ...(message.sessionId ? { sessionId: owner.execution } : {}),
      ...(message.executionId ? { executionId: owner.execution } : {}),
    };
  }

  dispose(): void {
    this.closed = true;
    this.conversations.clear();
    this.attaching.clear();
    this.executionOwners.clear();
    this.commandOwners.clear();
    this.retiredExecutions.clear();
    this.promptResults.clear();
    this.listeners.clear();
  }

  private reserveAttachment(id: string): () => void {
    if (this.closed) throw new Error("Cloud connection is closed");
    if (!this.conversations.has(id) && !this.attaching.has(id) && new Set([...this.conversations.keys(), ...this.attaching.keys()]).size >= 256)
      throw new Error("Cloud conversation attachment limit reached");
    this.attaching.set(id, (this.attaching.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.attaching.get(id) ?? 1) - 1;
      if (remaining) this.attaching.set(id, remaining); else this.attaching.delete(id);
    };
  }
}
