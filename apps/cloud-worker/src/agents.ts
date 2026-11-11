import { AgentInteractions } from "./interactions";
import { INPUT_CANCELLED, INPUT_STOPPED, INPUT_TIMEOUT } from "./sessions/interaction-history";
import { randomUUID } from "node:crypto";
import { cloudModeId, cloudPermissionMode, cloudSessionModes, type CloudPermissionMode, type BackgroundTasksUpdate, type InitializeResponse, type PromptResponse, type SessionNotification } from "@zeros/protocol/agent-events";
import { createMessage, type AgentLoadSessionMessage, type AgentNewSessionMessage, type AgentPromptMessage, type AgentSteerMessage, type BridgeAgentFailure, type BridgeMessage, type SteerOutcome } from "@zeros/protocol/messages";
import { cloudFailureMessage, type CloudMcpFailure, type CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import type { Driver } from "./drivers/driver";
import { agentTiming, type TimingObserver, type TimingSpan } from "./agent-timings";
import { recordUser, userMessage, type InboxEntry, type SessionStore, type SteerReceipt } from "./sessions/session-store";
import { WorkspaceError, type WorkerConfig, type WorkspaceScope } from "./workspace/scope";
import { CodexModelAvailability, type ModelDiscoveryOptions } from "./credentials/model-availability";
import { preparePromptFiles } from "./prompt-files";
import type { DriverMcpServers } from "./mcp/gateway";
import type { WorkspaceToolFactory, WorkspaceToolGrant } from "./mcp/workspace-tools";
import { TurnService } from "./workspace/turns";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import { providerAvailability, providerFailure } from "./provider-failure";
import type { ApplicationEnvironment } from "./credentials/application-environment";
import type { WorkspaceApiEnvironment } from "./credentials/workspace-api";

export type DriverFactories = Partial<Record<CloudV2Agent, () => Driver>>;
export interface AppClient { id: string; send(frame: BridgeMessage): Promise<void> }
interface Waiter { client: AppClient; requestId: string; receivedAt: number }
interface Runtime {
  id: string; chatId: string; agentId: CloudV2Agent; model?: string; effort?: string; fast?: boolean;
  driver?: Driver; unsubscribe?: () => void; login?: string; opening?: Promise<void>;
  configRevision?: number;
  stopInFlight?: number; idleInputStop?: boolean; blockedInputTools?: Set<string>;
  permissionMode?: CloudPermissionMode; activePermissionMode?: CloudPermissionMode; modeRevision?: number;
  modeChanges?: Promise<void>;
  interactions?: AgentInteractions; tools?: Map<string, { nativeId?: string; parentId?: string; active: boolean }>;
  preparing?: Promise<void>;
  retiring?: Promise<void>; pendingNative?: string; admitting: number;
  cancelling?: Promise<"succeeded" | "failed" | "cancelled">;
  active?: InboxEntry; nativeRunning?: boolean; background?: BackgroundTasksUpdate;
  pumping?: Promise<void>; events: Promise<void>; stopping: number; closed: boolean;
  settling?: Promise<void>; steers: Map<string, Promise<SteerReceipt>>;
  waiters: Map<string, Waiter[]>;
  turnTiming?: TimingSpan;
  turnFailureNotice?: BridgeAgentFailure;
  outboxSteering?: Promise<void>;
  checkpointTurnId?: string;
  mcpExecutionId?: string;
  mcpFailures?: Set<string>;
  workspaceTools?: WorkspaceToolGrant;
}

const VERSIONS = { codex: "0.166.0", claude: "0.3.311", cursor: "1.2.0" };
const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
const MODEL_ENV = { codex: "OPENAI_MODEL", claude: "ANTHROPIC_MODEL", cursor: "CURSOR_MODEL" };
const initialized = (agentId: CloudV2Agent): InitializeResponse => ({
  protocolVersion: 1, agentInfo: { name: NAMES[agentId], version: VERSIONS[agentId] },
  authMethods: [], agentCapabilities: { loadSession: true, steering: true, promptCapabilities: { image: true } },
});

/** Executions are worker-owned routes; provider resume ids never select a
 * live process. Client disconnects do not change a conversation's lifetime. */
export class Agents {
  readonly turns: TurnService;
  private readonly routes = new Map<string, Runtime>();
  private readonly chats = new Map<string, Runtime>();
  private config: WorkerConfig;
  private reviewConfig: WorkerConfig["codeReview"];
  private reviewConfiguration = 0;
  private readonly models: CodexModelAvailability;
  private outboxDispatch?: (entry: InboxEntry) => Promise<boolean>;
  private outboxStop?: (chatId: string, throughEpoch: string) => Promise<string>;
  private readonly chatMutations = new Map<string, Promise<unknown>>();
  private readonly mutationEpochs = new Map<string, number>();
  private readonly outboxOpenings = new Map<string, Promise<void>>();
  private readonly waitingOpens = new Map<string, Set<{ cancelled: boolean }>>();
  private readonly lifetime = new AbortController();
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly store: SessionStore,
    private readonly scope: WorkspaceScope,
    private readonly factories: DriverFactories,
    config: WorkerConfig,
    private readonly broadcast: (message: BridgeMessage) => Promise<void>,
    private readonly activity: () => void,
    private readonly onTiming?: TimingObserver,
    modelDiscovery?: ModelDiscoveryOptions,
    private readonly mcpProviders?: (executionId: string) => Promise<DriverMcpServers>,
    private readonly workspaceToolFactory?: WorkspaceToolFactory,
    private readonly application?: ApplicationEnvironment,
    private readonly resumeIdleExecutions = false,
    private readonly zeros?: WorkspaceApiEnvironment,
  ) { this.config = config; this.reviewConfig = config.codeReview; this.models = new CodexModelAvailability(modelDiscovery); this.models.configure(config); this.turns = new TurnService(store, scope); }

  fenceReviewConfiguration(review: WorkerConfig["codeReview"]): boolean {
    if (JSON.stringify(this.reviewConfig) === JSON.stringify(review)) return false;
    this.reviewConfig = review;
    this.reviewConfiguration++;
    for (const route of this.routes.values()) void this.retireWorkspaceTools(route);
    return true;
  }
  configure(config: WorkerConfig): void {
    this.fenceReviewConfiguration(config.codeReview);
    this.config = config; this.models.configure(config);
  }
  /** The chat a native execution (route) belongs to, if it is still open. */
  chatForExecution(executionId: string): string | undefined {
    const route = this.routes.get(executionId);
    return route && !route.closed ? route.chatId : undefined;
  }
  mcpFailure(executionId: string, cloud: CloudMcpFailure): void {
    const route = [...this.routes.values()].find(value => value.mcpExecutionId === executionId);
    if (!route || route.closed || this.chats.get(route.chatId) !== route) return;
    const ownsFailure = () => !route.closed && route.mcpExecutionId === executionId && this.chats.get(route.chatId) === route;
    const key = `${cloud.serverId}:${cloud.reason}`;
    route.mcpFailures ??= new Set();
    if (route.mcpFailures.has(key)) return;
    route.mcpFailures.add(key);
    const notification: SessionNotification = { sessionId: route.id, update: { sessionUpdate: "error_notice", noticeId: `mcp:${randomUUID()}`,
      severity: "warning", recoverable: true, message: cloudFailureMessage(cloud), cloud, at: Date.now() } };
    route.events = route.events.then(async () => {
      if (!ownsFailure()) return;
      await this.store.fold(route.chatId, notification, ownsFailure);
      if (ownsFailure()) await this.update(route, notification);
    }).catch(() => { if (ownsFailure()) this.cancelForInput(route, INPUT_CANCELLED); });
  }
  /** The memory watchdog stopped a process this chat's agent started. */
  processStopped(chatId: string, message: string): void {
    const route = this.chats.get(chatId);
    if (!route || route.closed) return;
    const owns = () => !route.closed && this.chats.get(chatId) === route;
    const notification: SessionNotification = { sessionId: route.id, update: { sessionUpdate: "error_notice", noticeId: `memory:${randomUUID()}`,
      severity: "warning", recoverable: true, message, at: Date.now() } };
    route.events = route.events.then(async () => {
      if (!owns()) return;
      await this.store.fold(route.chatId, notification, owns);
      if (owns()) await this.update(route, notification);
    }).catch(() => { if (owns()) this.cancelForInput(route, INPUT_CANCELLED); });
  }
  private initialized(agentId: CloudV2Agent): InitializeResponse {
    return { ...initialized(agentId), _meta: this.models.metadata(agentId === "codex") };
  }
  get busy(): boolean { return [...this.routes.values()].some(route => (this.waitingForInput(route) ? this.hasIndependentWork(route) : !!route.active || this.hasBackground(route))); }
  get runtimeBusy(): boolean {
    return this.disposed || this.chatMutations.size > 0 || this.outboxOpenings.size > 0 || this.waitingOpens.size > 0 ||
      [...this.chats.values()].some(route => Boolean(route.admitting || route.opening || route.preparing || route.retiring || route.active ||
        route.nativeRunning || route.pumping || route.settling || route.cancelling || route.outboxSteering || route.steers.size ||
        route.interactions?.runtimeBusy || this.hasBackground(route) || [...(route.tools?.values() ?? [])].some(tool => tool.active)));
  }

  setOutboxDispatch(dispatch?: (entry: InboxEntry) => Promise<boolean>, stop?: (chatId: string, throughEpoch: string) => Promise<string>): void {
    this.outboxDispatch = dispatch; this.outboxStop = stop;
  }

  private assertAdmission(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.");
  }

  private async afterMutation(chatId: string, cancelled?: AbortSignal): Promise<void> {
    const signal = cancelled ? AbortSignal.any([this.lifetime.signal, cancelled]) : this.lifetime.signal;
    this.assertAdmission(signal);
    while (this.chatMutations.has(chatId)) {
      const pending = this.chatMutations.get(chatId)!;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.")); };
        const settled = () => { signal.removeEventListener("abort", abort); resolve(); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        void pending.then(settled, settled);
      });
      this.assertAdmission(signal);
    }
  }

  private async waitToOpen(chatId: string, signal?: AbortSignal): Promise<void> {
    const waiting = this.waitingOpens.get(chatId) ?? new Set<{ cancelled: boolean }>();
    const admission = { cancelled: false };
    waiting.add(admission); this.waitingOpens.set(chatId, waiting);
    try {
      await this.afterMutation(chatId, signal);
      if (admission.cancelled) throw new WorkspaceError("session-expired", "This session was stopped before it could open.");
    } finally {
      waiting.delete(admission);
      if (!waiting.size) this.waitingOpens.delete(chatId);
    }
  }

  private cancelWaitingOpens(chatId: string): void {
    for (const admission of this.waitingOpens.get(chatId) ?? []) admission.cancelled = true;
  }

  mutateChat<T>(chatId: string, _resetContext: boolean, action: () => Promise<T>): Promise<T> {
    if (this.disposed || !this.store.metadata(chatId)?.chat)
      return Promise.reject(new WorkspaceError("WORKSPACE_NOT_FOUND", "This conversation is unavailable."));
    const previous = this.chatMutations.get(chatId), route = this.chats.get(chatId);
    this.mutationEpochs.set(chatId, (this.mutationEpochs.get(chatId) ?? 0) + 1);
    // Retire synchronously, before a held HTTP Stop or receipt can allow
    // another provider action. New sends wait outside the entire mutation.
    const retiring = route ? this.retire(route) : Promise.resolve();
    void retiring.catch(() => {});
    const operation = (async () => {
      await previous?.catch(() => {});
      try {
        await this.store.stop(chatId);
        if (this.outboxStop) {
          const epoch = await this.outboxStop(chatId, this.store.deliveryEpoch(chatId));
          await this.store.stopOutbox(chatId, epoch);
        }
      } finally {
        await retiring;
        if (this.chats.get(chatId) === route) this.chats.delete(chatId);
      }
      await this.store.update(chatId, draft => {
        for (const entry of draft.inbox) if (!entry.outbox && entry.state === "queued") { entry.state = "cancelled"; entry.cancelRequested = true; }
      });
      if (this.disposed) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.");
      return action();
    })();
    this.chatMutations.set(chatId, operation);
    void operation.finally(() => { if (this.chatMutations.get(chatId) === operation) this.chatMutations.delete(chatId); }).catch(() => {});
    return operation;
  }

  async receiveOutbox(item: CloudV2PromptDelivery, signal?: AbortSignal): Promise<InboxEntry> {
    const { payload, receipt } = item;
    if (receipt.workspaceId !== this.scope.workspace.id || receipt.chatId !== payload.chatId || receipt.userMessageId !== payload.userMessageId)
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This message belongs to another workspace.");
    for (;;) {
      await this.afterMutation(payload.chatId, signal);
      const epoch = this.mutationEpochs.get(payload.chatId) ?? 0;
      try { this.assertAdmission(signal); return await this.admitOutbox(item, signal); }
      catch (error) {
        if (epoch === (this.mutationEpochs.get(payload.chatId) ?? 0)) throw error;
      }
    }
  }

  private async admitOutbox(item: CloudV2PromptDelivery, signal?: AbortSignal): Promise<InboxEntry> {
    const { payload } = item;
    // Waking preserves the execution the app holds, as well as its native
    // conversation. Re-adopt only the current persisted execution (M069).
    const metadata = this.store.metadata(payload.chatId);
    if (metadata?.executionId) this.readopt(metadata.executionId, payload.agentId, payload.chatId);
    await this.open({ id: "outbox", send: async () => {} }, createMessage({ type: "AGENT_NEW_SESSION", source: "browser",
      chatId: payload.chatId, agentId: payload.agentId, cwd: this.scope.root, workspaceId: this.scope.workspace.id,
      env: { ...(payload.model ? { [MODEL_ENV[payload.agentId]]: payload.model } : {}), ...(payload.effort ? { ZEROS_THINKING_EFFORT: payload.effort } : {}) },
    }), true, signal, { ...(item.sessionName?.trim() ? { title: item.sessionName.trim() } : {}) });
    const route = this.chats.get(payload.chatId)!;
    route.admitting++;
    const ownsAdmission = () => { this.assertAdmission(signal); this.assertCurrent(route); };
    try { await route.cancelling; ownsAdmission(); return await this.store.receiveOutbox(item, ownsAdmission); }
    finally { route.admitting--; }
  }

  resumeOutbox(chatId: string): void {
    if (this.disposed) return;
    const route = this.chats.get(chatId);
    if ((!route || route.closed || this.chatMutations.has(chatId)) && !this.outboxOpenings.has(chatId) &&
        this.store.outboxEntries(chatId).some(({ entry }) => entry.state === "queued" && entry.outbox?.acknowledged)) {
      const opening = this.afterMutation(chatId).then(async () => {
        const chat = this.store.metadata(chatId)?.chat;
        if (!chat?.agentId) return;
        await this.open({ id: "outbox", send: async () => {} }, createMessage({ type: "AGENT_NEW_SESSION", source: "browser",
          chatId, agentId: chat.agentId, cwd: this.scope.root, workspaceId: this.scope.workspace.id }), true);
      });
      this.outboxOpenings.set(chatId, opening);
      void opening.then(() => { this.outboxOpenings.delete(chatId); this.resumeOutbox(chatId); }, () => { this.outboxOpenings.delete(chatId); });
      return;
    }
    if (!route || route.closed || route.cancelling || route.stopInFlight || route.outboxSteering) return;
    const next = this.store.outboxEntries(chatId).find(({ entry }) => entry.state === "queued" && entry.outbox?.acknowledged)?.entry;
    const matchesActiveMode = () => next?.outbox?.permissionMode === undefined || next.outbox.permissionMode === route.activePermissionMode;
    if (route.active && route.nativeRunning && next?.outbox?.mode === "steer" && !next.outbox.steerDeclined &&
        next.outbox.model === route.model && next.outbox.effort === route.effort &&
        matchesActiveMode() && !route.interactions?.blocking) {
      const active = route.active, stopping = route.stopping;
      route.outboxSteering = (async () => {
        const content = await preparePromptFiles(this.scope, next.prompt);
        const entry = await this.store.prepareOutboxDispatch(chatId, next.requestId, true);
        if (!entry) return;
        let outcome: SteerOutcome = "interrupted";
        if (await this.outboxDispatch?.(entry)) {
          if (route.closed || stopping !== route.stopping) outcome = "interrupted";
          else if (route.active !== active || !route.nativeRunning || !matchesActiveMode() || route.interactions?.blocking) outcome = "queued";
          else outcome = await route.driver!.steer(content);
        }
        await this.store.finishOutboxSteer(chatId, entry.requestId, outcome, active.userMessageId);
        if (outcome === "delivered") await this.update(route, { sessionId: route.id,
          update: { sessionUpdate: "user_message_recorded", message: userMessage(entry, active.userMessageId) } });
      })().catch(async () => {
        await this.store.finishOutboxSteer(chatId, next.requestId, "interrupted", active.userMessageId);
      }).finally(() => { route.outboxSteering = undefined; this.resumeOutbox(chatId); });
    } else this.pump(route);
  }

  async stopOutbox(chatId: string, epoch: string): Promise<void> {
    const route = this.chats.get(chatId), active = route?.active;
    const freshEpoch = BigInt(this.store.deliveryEpoch(chatId)) < BigInt(epoch);
    if (freshEpoch) this.cancelWaitingOpens(chatId);
    const interrupt = !!route && (active ? (active.outbox
      ? BigInt(active.outbox.epoch) < BigInt(epoch)
      : active.cancelRequested || freshEpoch) : this.hasBackground(route) && freshEpoch);
    const running = !!route?.nativeRunning;
    if (!interrupt || !route) {
      let tools: Promise<void> | undefined;
      if (route && freshEpoch && !active && this.workspaceToolFactory) {
        route.stopping++;
        tools = this.stopWorkspaceTools(route);
      }
      await this.store.stopOutbox(chatId, epoch);
      await tools;
      return;
    }
    route.stopping++; route.stopInFlight = (route.stopInFlight ?? 0) + 1;
    if (active) active.cancelRequested = true;
    const tools = this.stopWorkspaceTools(route);
    const stopped = Promise.all([route.interactions?.dismiss(INPUT_CANCELLED), route.driver?.interrupt(), tools]);
    void stopped.catch(() => {});
    try {
      await this.store.stopOutbox(chatId, epoch);
      if (!active?.outbox) await this.store.stop(chatId);
      await stopped;
      if (running) await route.pumping;
    } finally { route.stopInFlight--; }
    this.resumeOutbox(chatId);
  }

  async fenceOutbox(): Promise<void> {
    const epochs = new Map<string, bigint>();
    for (const { chatId, entry } of this.store.outboxEntries()) {
      const epoch = BigInt(entry.outbox!.epoch) + 1n;
      if (epoch > (epochs.get(chatId) ?? -1n)) epochs.set(chatId, epoch);
    }
    await Promise.all([...epochs].map(([chatId, epoch]) => this.stopOutbox(chatId, epoch.toString())));
  }

  async handle(client: AppClient, message: BridgeMessage): Promise<void> {
    try {
      switch (message.type) {
        case "AGENT_LIST_AGENTS":
          await client.send(createMessage({ type: "AGENT_AGENTS_LIST", source: "engine", requestId: message.id,
            agents: (Object.keys(VERSIONS) as CloudV2Agent[]).map((id) => {
              const cloud = providerAvailability(id, this.config, !!this.factories[id]);
              return { id, name: NAMES[id], version: VERSIONS[id], description: `${NAMES[id]} cloud agent`, distribution: {},
                installed: !!this.factories[id], launchKind: this.factories[id] ? "binary" as const : "unavailable" as const,
                installedVersion: VERSIONS[id], versionCompatible: true, authenticated: !cloud, ...(cloud ? { cloud } : {}) };
            }) }));
          return;
        case "AGENT_INIT_AGENT":
          await this.models.refresh();
          await client.send(createMessage({ type: "AGENT_AGENT_INITIALIZED", source: "engine", requestId: message.id, agentId: message.agentId, initialize: this.initialized(this.agent(message.agentId)) }));
          return;
        case "AGENT_NEW_SESSION": case "AGENT_LOAD_SESSION": return await this.open(client, message);
        case "AGENT_PROMPT": return await this.prompt(client, message);
        case "AGENT_STEER": return await this.steer(client, message);
        case "AGENT_CANCEL": {
          const route = this.route(message);
          route.cancelling ??= this.cancel(route);
          try {
            const state = await route.cancelling;
            await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: message.id,
              op: "AGENT_CANCEL", result: { conversationId: message.chatId ?? route.chatId, state } }));
          } finally { route.cancelling = undefined; }
          return;
        }
        case "AGENT_QUESTION_RESPONSE": case "AGENT_PERMISSION_RESPONSE": {
          const route = message.executionId ? this.routes.get(message.executionId) : undefined;
          if (!route || route.closed || !message.chatId || route.chatId !== message.chatId || this.chats.get(message.chatId) !== route)
            throw new WorkspaceError("session-expired", "This question belongs to an expired execution.");
          if (message.type === "AGENT_QUESTION_RESPONSE") await route.interactions?.reply("question", message.questionId, message.response, message.nativeRequestId);
          else await route.interactions?.reply("permission", message.permissionId, message.response);
          return;
        }
        case "AGENT_SET_MODE": {
          const route = this.route(message);
          if (this.config.agentInteractions !== 1) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This cloud worker does not support Plan mode yet.");
          const mode = cloudPermissionMode(route.agentId, message.modeId);
          if (!mode) throw new WorkspaceError("invalid-params", "Choose Plan or Full access for a cloud workspace.");
          // Some providers apply modes on the next turn. A changed selection
          // invalidates the running turn's match instead of relabelling it.
          if (route.activePermissionMode !== mode) route.activePermissionMode = undefined;
          const revision = route.modeRevision = (route.modeRevision ?? 0) + 1;
          return this.withModeChange(route, async () => {
            await this.ensureDriver(route); this.assertCurrent(route);
            if (route.modeRevision !== revision) return;
            if (!route.driver!.setMode) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This agent cannot change mode.");
            await route.driver!.setMode(message.modeId); this.assertCurrent(route);
            if (route.modeRevision !== revision) return;
            await this.saveMode(route, mode);
            if (mode === "bypass") await route.interactions?.allowPending();
            await this.update(route, { sessionId: route.id, update: { sessionUpdate: "current_mode_update", currentModeId: message.modeId } });
            await client.send(createMessage({ type: "AGENT_MODE_CHANGED", source: "engine", requestId: message.id, agentId: route.agentId,
              sessionId: route.id, executionId: route.id, modeId: message.modeId }));
          });
        }
        case "AGENT_SET_MODEL": {
          const route = this.route(message);
          const revision = route.configRevision = (route.configRevision ?? 0) + 1;
          await this.ensureDriver(route);
          this.assertCurrent(route);
          if (route.configRevision !== revision) return;
          await route.driver!.setModel(message.model);
          this.assertCurrent(route);
          // The renderer sends model selection and complete config without
          // awaiting either. An older native ACK cannot erase newer knobs.
          if (route.configRevision !== revision) return;
          if (route.model !== message.model) {
            route.model = message.model; route.effort = undefined;
            // Keep a credential refresh or VM restart from restoring the old
            // model's effort. The native driver clears its live override too.
            await this.store.update(route.chatId, draft => {
              this.assertCurrent(route);
              draft.chat!.model = message.model; draft.chat!.effort = "";
            });
          }
          return;
        }
        case "AGENT_UPDATE_CONFIG": {
          const route = this.route(message);
          const model = message.env[MODEL_ENV[route.agentId]]?.trim() || undefined;
          if (model && (model.length > 200 || /\s/.test(model))) throw new WorkspaceError("invalid-params", "Invalid agent model.");
          const revision = route.configRevision = (route.configRevision ?? 0) + 1;
          await route.preparing;
          this.assertCurrent(route);
          if (route.configRevision !== revision) return;
          const effort = message.env.ZEROS_THINKING_EFFORT || undefined;
          const fast = message.env.ZEROS_FAST_MODE === "1";
          if (model) route.model = model;
          route.effort = effort; route.fast = fast;
          await this.store.update(route.chatId, draft => {
            this.assertCurrent(route);
            if (model) draft.chat!.model = model;
            draft.chat!.effort = effort ?? ""; draft.chat!.fast = fast;
          });
          while (route.opening) await route.opening;
          this.assertCurrent(route);
          if (route.configRevision !== revision) return;
          // Apply the latest snapshot after any opening driver is ready.
          // Only typed selections cross; credentials and arbitrary caller
          // environment never replace worker configuration. Each driver owns
          // its provider's live-versus-next-prompt application boundary.
          await route.driver?.updateConfig?.({ ...(route.model ? { model: route.model } : {}), effort: route.effort, fast: route.fast === true });
          return;
        }
        case "AGENT_CLOSE_SESSION": {
          const id = message.executionId ?? message.sessionId;
          const route = id ? this.routes.get(id) : message.chatId ? this.chats.get(message.chatId) : undefined;
          if (route && (route.agentId !== message.agentId || (message.chatId && route.chatId !== message.chatId))) throw new WorkspaceError("session-expired", "The execution does not belong to this conversation.");
          // Closing a view is not Stop in a shared headless workspace. The
          // explicit userStop flag also covers Stop before creation replied.
          if (route && message.userStop) await this.closeChat(route.chatId);
          else if (!id && !route && message.chatId && message.userStop && this.store.metadata(message.chatId)?.chat?.agentId === message.agentId) {
            this.cancelWaitingOpens(message.chatId);
            await this.store.stop(message.chatId);
          }
          await client.send(createMessage({ type: "AGENT_SESSION_CLOSED", source: "engine", requestId: message.id, agentId: message.agentId,
            ...(id ? { sessionId: id, executionId: id } : {}), ...(message.chatId ? { chatId: message.chatId } : {}) }));
          return;
        }
        default: throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This agent operation is not available in cloud workspaces yet.");
      }
    } catch (error) {
      const agentId = "agentId" in message && (message.agentId === "claude" || message.agentId === "codex" || message.agentId === "cursor") ? message.agentId : undefined;
      const stage = message.type === "AGENT_NEW_SESSION" ? "newSession" : message.type === "AGENT_LOAD_SESSION" ? "loadSession"
        : message.type === "AGENT_PROMPT" ? "prompt" : message.type === "AGENT_INIT_AGENT" ? "initialize" : undefined;
      const failure = agentId ? providerFailure(agentId, error, stage) : undefined;
      await client.send(createMessage({ type: "AGENT_ERROR", source: "engine", requestId: message.id,
        ...("agentId" in message ? { agentId: message.agentId } : {}), code: error instanceof WorkspaceError ? error.code : "AGENT_ERROR",
        message: error instanceof WorkspaceError && !failure?.cloud ? error.message : failure?.message ?? "The agent could not complete this request.", ...(failure ? { failure } : {}) }));
    }
  }

  /** Shutdown keeps each chat's execution for the next worker to re-adopt. */
  async closeChat(chatId: string, shutdown = false): Promise<void> {
    this.cancelWaitingOpens(chatId);
    const route = this.chats.get(chatId);
    if (!route) return;
    const tools = this.retireWorkspaceTools(route);
    if (!shutdown && this.outboxStop) await this.stop(route);
    await this.retire(route, shutdown ? INPUT_STOPPED : INPUT_CANCELLED);
    if (!shutdown) await this.store.retireExecution(chatId, route.id);
    if (this.store.metadata(chatId)?.chat) await this.store.stop(chatId, () => this.chats.get(chatId) === route);
    if (this.chats.get(chatId) === route) this.chats.delete(chatId);
    await tools;
    this.activity();
  }

  /** Stop fences review writes by retiring their grant (the next turn reopens
   * the driver). Read-only terminal and diff tools stay with their execution. */
  private stopWorkspaceTools(route: Runtime): Promise<void> {
    if (route.workspaceTools?.review === false) { route.workspaceTools.cancel(); return Promise.resolve(); }
    return this.retireWorkspaceTools(route);
  }

  private retireWorkspaceTools(route: Runtime): Promise<void> {
    const tools = route.workspaceTools;
    route.workspaceTools = undefined;
    if (tools) route.login = undefined;
    tools?.revoke();
    return tools?.dispose() ?? Promise.resolve();
  }

  private retire(route: Runtime, reason = INPUT_CANCELLED): Promise<void> {
    if (route.retiring) return route.retiring;
    route.closed = true; route.stopping++; route.unsubscribe?.();
    const tools = this.retireWorkspaceTools(route);
    this.routes.delete(route.id);
    return route.retiring = (async () => {
      // Native abort cannot wait for a held input receipt to become durable.
      await Promise.all([route.interactions?.dismiss(reason), route.driver?.dispose()]);
      await route.preparing?.catch(() => {});
      await route.opening?.catch(() => {});
      await route.pumping;
      await route.events;
      await tools;
    })();
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.chatMutations.values(), ...this.outboxOpenings.values()]);
    await Promise.all([...this.routes.values()].map(async (route) => { await route.events; await route.settling; }));
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.lifetime.abort(); this.models.dispose();
    const tools = [...this.chats.values()].map(route => this.retireWorkspaceTools(route));
    return this.disposal = (async () => {
      await Promise.all([...this.chats.keys()].map(id => this.closeChat(id, true)));
      await Promise.all(tools);
      await Promise.allSettled([...this.chatMutations.values(), ...this.outboxOpenings.values()]);
    })();
  }

  private agent(id: string): CloudV2Agent {
    if (id !== "codex" && id !== "claude" && id !== "cursor") throw new WorkspaceError("agent-not-found", "Unknown cloud agent.");
    return id;
  }

  private route(message: { agentId: string; sessionId: string; executionId?: string; chatId?: string }): Runtime {
    const id = message.executionId ?? message.sessionId;
    const route = this.routes.get(id) ?? this.readopt(id, message.agentId, message.chatId);
    if (!route || route.closed || route.agentId !== message.agentId || (message.chatId && route.chatId !== message.chatId))
      throw new WorkspaceError("session-expired", "This execution has ended. Reopen the conversation to continue.");
    if (message.executionId && message.sessionId !== message.executionId) throw new WorkspaceError("session-expired", "Conflicting execution routes.");
    return route;
  }

  /** A worker restart ends its routes, not the app's executions. Only a
   * chat's persisted execution comes back; replaced or closed ones stay fenced. */
  private readopt(id: string, agentId: string, requestedChat?: string): Runtime | undefined {
    const chatId = requestedChat ?? this.store.chatForExecution(id);
    if (this.disposed || chatId && this.chatMutations.has(chatId)) return undefined;
    const metadata = chatId && !this.chats.has(chatId) ? this.store.metadata(chatId) : undefined;
    if (!chatId || !metadata?.chat || metadata.executionId !== id || metadata.chat.agentId !== agentId) return undefined;
    this.scope.folder(metadata.chat.folder);
    const route: Runtime = { id, chatId, agentId: this.agent(agentId), model: metadata.chat.model ?? undefined, effort: metadata.chat.effort || undefined, fast: metadata.chat.fast,
      admitting: 0, events: Promise.resolve(), stopping: 0, closed: false, waiters: new Map(), steers: new Map() };
    route.permissionMode = metadata.chat.permissionMode === "plan" ? "plan" : "bypass";
    this.chats.set(chatId, route); this.routes.set(id, route);
    return route;
  }

  private assertCurrent(route: Runtime): void {
    if (this.chatMutations.has(route.chatId)) throw new WorkspaceError("CONVERSATION_MUTATING", "This conversation is being reset. Retry after it completes.");
    if (route.closed || this.chats.get(route.chatId) !== route) throw new WorkspaceError("session-expired", "This execution has ended. Reopen the conversation to continue.");
  }

  private async open(client: AppClient, message: AgentNewSessionMessage | AgentLoadSessionMessage, deferDriver = false, signal?: AbortSignal,
    /** Applies only if this open creates the chat; an existing chat keeps its title. */
    creation: { title?: string } = {}): Promise<void> {
    this.scope.folder(message.cwd, true); this.scope.assertId(message.workspaceId);
    if (message.type === "AGENT_NEW_SESSION" && message.agentRole === "design") throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "Design is not available in cloud workspaces.");
    const agentId = this.agent(message.agentId);
    const requested = message.type === "AGENT_LOAD_SESSION" ? message.executionId ?? message.sessionId : undefined;
    // A quiet runtime handoff preserves exact persisted executions. Ordinary
    // restart probes still require an explicit reopen after interrupted work.
    const persisted = this.resumeIdleExecutions && message.chatId ? this.store.metadata(message.chatId)?.executionId : undefined;
    const target = requested ?? persisted;
    const found = target ? this.routes.get(target) ?? (message.type === "AGENT_LOAD_SESSION" && (!message.adoptOnly || this.resumeIdleExecutions)
      ? this.readopt(target, agentId, message.chatId) : undefined) : undefined;
    const chatId = message.chatId ?? found?.chatId;
    if (!chatId) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "A conversation is required.");
    if (this.chatMutations.has(chatId)) await this.waitToOpen(chatId, signal);
    this.assertAdmission(signal);
    const timing = agentTiming(agentId, chatId, "open", this.onTiming);
    if (found && found.chatId !== chatId) throw new WorkspaceError("session-expired", "The execution belongs to a different conversation.");
    let route = this.chats.get(chatId);
    if (message.type === "AGENT_LOAD_SESSION" && message.adoptOnly &&
        (!route || route.closed || route.agentId !== agentId || (requested && route.id !== requested)))
      throw new WorkspaceError("session-expired", "No live execution for this conversation.");
    const metadata = this.store.metadata(chatId);
    // A first-tab/reconnect probe can beat the renderer's chats.upsert. With
    // no durable locator this is an ordinary adoption miss: the renderer may
    // issue NEW_SESSION for the same chat. Deleted chats and explicit missing
    // bindings remain refusals, and an in-flight creation is adopted below.
    if (!metadata && !route && message.type === "AGENT_LOAD_SESSION" && !requested && !message.providerBinding) {
      const failure = { kind: "session-expired" as const, stage: "loadSession" as const, agentId,
        message: "No live execution for this conversation." };
      await client.send(createMessage({ type: "AGENT_ERROR", source: "engine", requestId: message.id,
        agentId, code: failure.kind, message: failure.message, failure }));
      return;
    }
    if (metadata?.chat === null || (!metadata && message.type !== "AGENT_NEW_SESSION" && !route?.preparing))
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Cloud conversation is unavailable.");
    if (metadata?.chat) {
      this.scope.folder(metadata.chat.folder);
    }
    if ((metadata?.chat?.agentId && metadata.chat.agentId !== agentId) || (route && route.agentId !== agentId)) {
      if (!this.store.canRebind(chatId) || (route && (route.admitting || route.active || route.nativeRunning || route.steers.size || route.cancelling || this.hasBackground(route))))
        throw new WorkspaceError("session-expired", "This conversation belongs to another agent.");
    }
    if (!route || route.closed || route.agentId !== agentId) {
      const retiring = route ? this.retire(route) : undefined;
      // Publish the route before any durable write yields. Stop by chatId
      // must find a creation even before its initial metadata is on disk.
      route = { id: randomUUID(), chatId, agentId, admitting: 0,
        events: Promise.resolve(), stopping: 0, closed: false, waiters: new Map(), steers: new Map() };
      this.chats.set(chatId, route); this.routes.set(route.id, route);
      const selected = route;
      selected.preparing = (async () => {
        await retiring;
        const chat = await this.store.selectAgent({ id: chatId, folder: this.scope.root, agentId, agentName: NAMES[agentId], executionId: selected.id, ...creation,
          // These existing open couriers carry selections only. Credentials
          // always come from the control plane, never the caller's env.
          model: message.env?.[MODEL_ENV[agentId]] || undefined, effort: message.env?.ZEROS_THINKING_EFFORT || undefined,
          ...(message.env?.ZEROS_FAST_MODE !== undefined ? { fast: message.env.ZEROS_FAST_MODE === "1" } : {}),
        }, () => this.assertCurrent(selected));
        selected.model = chat.model ?? undefined; selected.effort = chat.effort || undefined; selected.fast = chat.fast;
        selected.permissionMode = (message.env?.ZEROS_PERMISSION_MODE ?? chat.permissionMode) === "plan" ? "plan" : "bypass";
      })();
    }
    try { await route.preparing; }
    catch (error) {
      await this.retire(route);
      if (this.chats.get(chatId) === route) this.chats.delete(chatId);
      throw error;
    }
    route.preparing = undefined;
    if (deferDriver) return;
    await this.ensureDriver(route, timing);
    this.assertCurrent(route);
    timing.mark("driver_ready");
    const chat = this.store.metadata(chatId)!.chat!;
    const session = { sessionId: route.id, executionId: route.id, ...(this.config.agentInteractions === 1 ? { modes: cloudSessionModes(agentId, route.permissionMode ?? "bypass") } : {}), ...(chat.providerBinding ? { providerBinding: chat.providerBinding } : {}), ...(route.background ? { backgroundTasks: route.background } : {}) };
    if (message.type === "AGENT_NEW_SESSION") await client.send(createMessage({ type: "AGENT_SESSION_CREATED", source: "engine", requestId: message.id, agentId, session, initialize: this.initialized(agentId) }));
    else await client.send(createMessage({ type: "AGENT_SESSION_LOADED", source: "engine", requestId: message.id, agentId,
      sessionId: route.id, executionId: route.id, response: session, promptActive: !!route.active,
      ...(route.active ? { activeTurnStartedAt: route.active.startedAt, promptId: route.active.promptId } : {}) }));
    await route.interactions?.replay(frame => client.send(frame));
    if (route.active) await this.turnState(route, route.active, "running");
  }

  private async ensureDriver(route: Runtime, openingTiming?: TimingSpan): Promise<void> {
    this.assertCurrent(route);
    if (route.permissionMode === "plan" && this.config.agentInteractions !== 1)
      throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This cloud worker does not support Plan mode yet. Update it before sending this Plan request.");
    if (route.driver && (route.nativeRunning || this.hasBackground(route))) return;
    const unavailable = providerAvailability(route.agentId, this.config, !!this.factories[route.agentId]);
    if (unavailable) throw Object.assign(new Error(cloudFailureMessage(unavailable)), { cloud: unavailable });
    if (route.opening) return route.opening;
    const login = this.config.agents[route.agentId];
    // Personal MCP sign-in changes readiness without changing the shared
    // server definition. Reopen between turns after that pushed revision.
    const key = JSON.stringify([login, this.config.mcpServers ?? [], this.config.mcpServers?.length ? this.config.loginRevision : undefined, this.config.agentInteractions, this.config.codeReview]);
    if (route.driver && route.login === key) return;
    if (!login) throw new WorkspaceError("auth-required", "Connect this agent before sending a message.");
    const factory = this.factories[route.agentId];
    if (!factory) throw new WorkspaceError("agent-unavailable", "This agent is not installed in the worker.");
    route.opening = (async () => {
      const openingStop = route.stopping;
      const openingReview = this.reviewConfiguration;
      const tools = this.retireWorkspaceTools(route);
      await route.interactions?.dismiss(INPUT_CANCELLED);
      await tools;
      route.unsubscribe?.();
      route.mcpExecutionId = undefined;
      await route.driver?.dispose();
      this.assertCurrent(route);
      const driver = factory();
      route.driver = driver; route.login = key; route.pendingNative = undefined;
      route.tools = new Map();
      route.interactions = this.config.agentInteractions === 1 ? new AgentInteractions(this.store, {
        chatId: route.chatId, executionId: route.id, agentId: route.agentId,
        current: () => !route.closed && this.chats.get(route.chatId) === route && route.driver === driver,
        enqueue: work => {
          const task = route.events.then(work);
          route.events = task.catch(() => { this.cancelForInput(route, INPUT_CANCELLED); });
          return task;
        },
        publish: frame => this.broadcast(frame), update: event => this.update(route, event), activity: () => this.activity(),
        timeout: reason => this.cancelForInput(route, reason),
      }) : undefined;
      route.mcpExecutionId = randomUUID(); route.mcpFailures = new Set();
      route.unsubscribe = driver.onEvent((event) => {
        if (route.closed || route.driver !== driver) return;
        if (event.update.sessionUpdate === "current_mode_update" &&
            cloudPermissionMode(route.agentId, event.update.currentModeId) !== route.activePermissionMode) route.activePermissionMode = undefined;
        const active = route.active;
        // Controls and automatic wake-ups can arrive after a user prompt
        // starts. Neither proves that prompt was accepted; native size hints
        // and the existing provider events still do.
        const advisory = event.update.sessionUpdate === "wakeup_notice" ||
          (route.agentId === "claude" && event.update.sessionUpdate === "usage_update" && event.update.categories !== undefined);
        if (!advisory && route.nativeRunning && active?.outbox && !active.outbox.accepted) {
          active.outbox.accepted = true;
          void this.store.acceptOutbox(route.chatId, active.requestId).catch(() => this.stop(route));
        }
        const notification = { ...(this.application?.value(event) ?? event), sessionId: route.id };
        if (notification.update.sessionUpdate === "error_notice" && notification.update.severity === "error" && !notification.update.recoverable) {
          const update = notification.update;
          const failure = providerFailure(route.agentId, { code: update.code, message: update.message, cloud: update.cloud }, "prompt", update.turnFailure?.kind ?? update.failureKind);
          const code = update.code === "claude-background-failed" || update.code === "claude-background-transport-closed" ? update.code : failure.kind;
          notification.update = { ...update, message: failure.message, code, failureKind: failure.kind,
            ...(failure.cloud ? { cloud: failure.cloud } : {}),
            ...(active && !update.parentToolId && !update.turnFailure ? { turnFailure: { turnId: active.userMessageId, kind: failure.kind } } : {}) };
        }
        if (notification.update.sessionUpdate === "tool_call" || notification.update.sessionUpdate === "tool_call_update") {
          const tool = notification.update, prior = route.tools?.get(tool.toolCallId);
          route.tools?.set(tool.toolCallId, { nativeId: tool.nativeToolCallId ?? prior?.nativeId, parentId: ("parentToolId" in tool ? tool.parentToolId : undefined) ?? prior?.parentId,
            active: tool.status ? tool.status === "pending" || tool.status === "in_progress" : prior?.active ?? true });
          this.activity();
        }
        const hadBackground = this.hasBackground(route);
        if (active && notification.update.sessionUpdate === "error_notice" && !notification.update.parentToolId &&
            !notification.update.recoverable && notification.update.severity === "error" &&
            (!notification.update.turnFailure || notification.update.turnFailure.turnId === active.userMessageId)) route.turnFailureNotice = providerFailure(route.agentId,
              { cloud: notification.update.cloud }, "prompt", notification.update.failureKind);
        if (notification.update.sessionUpdate === "background_tasks_update") {
          route.background = notification.update; this.activity();
        }
        const backgroundTurnId = hadBackground && notification.update.sessionUpdate === "background_tasks_update" &&
          !this.hasBackground(route) && !route.nativeRunning ? route.checkpointTurnId : undefined;
        route.events = route.events.then(async () => {
          // A replacement must not inherit queued events from the old agent.
          // Stop of this same execution still saves everything already received.
          if (this.chats.get(route.chatId) !== route) return;
          if (notification.update.sessionUpdate === "provider_binding_update") {
            const binding = notification.update.providerBinding;
            if (binding.providerId !== route.agentId || binding.kind !== "native") throw new Error("Invalid native provider binding.");
            if (this.store.canRebind(route.chatId)) { route.pendingNative = binding.resumeId; return; }
            await this.store.bind(route.chatId, route.agentId, binding.resumeId);
          }
          if (notification.update.sessionUpdate === "current_mode_update") {
            const mode = cloudPermissionMode(route.agentId, notification.update.currentModeId);
            if (mode) await this.saveMode(route, mode);
          }
          await this.store.fold(route.chatId, notification);
          await this.update(route, notification);
          if (backgroundTurnId) {
            const prompt = await this.turns.finish(route.chatId, backgroundTurnId);
            await this.publishRecordedTurn(route, prompt);
          }
        }).catch(() => { if (!route.closed) this.cancelForInput(route, INPUT_CANCELLED); });
        if (!this.hasBackground(route) && !route.active) this.pump(route);
      });
      try {
        const mcpServers = await this.mcpProviders?.(route.mcpExecutionId);
        const executionId = route.mcpExecutionId;
        const assertExecutionCurrent = () => {
          this.assertCurrent(route);
          if (route.driver !== driver || route.mcpExecutionId !== executionId) throw new WorkspaceError("session-expired", "This execution's tools have been retired.");
        };
        const assertToolsCurrent = () => {
          assertExecutionCurrent();
          if (route.stopping !== openingStop || this.reviewConfiguration !== openingReview)
            throw new WorkspaceError("session-expired", "This execution's tools have been retired.");
        };
        route.workspaceTools = await this.workspaceToolFactory?.({ agentId: route.agentId, conversationId: route.chatId, executionId,
          assertCurrent: assertToolsCurrent, assertExecutionCurrent });
        assertToolsCurrent();
        this.assertCurrent(route);
        const interactions = route.interactions;
        const native = await driver.open({ sessionId: route.id, cwd: this.scope.root, model: route.model, effort: route.effort, fast: route.fast,
          ...(this.application ? { application: this.application } : {}),
          ...(this.zeros ? { zerosEnvironment: this.zeros.variables(route.chatId) } : {}),
          ...(mcpServers || route.workspaceTools ? { mcpServers: { ...mcpServers, ...route.workspaceTools?.servers } } : {}),
          ...(this.config.agentInteractions === 1 ? { modeId: cloudModeId(route.agentId, route.permissionMode ?? "bypass"),
            onQuestion: (request, signal) => interactions!.question(request, signal),
            onPermission: (request, signal) => interactions!.permission(request, signal) } : {}),
          onTiming: stage => {
            if (!route.closed && this.chats.get(route.chatId) === route && route.driver === driver)
              (route.turnTiming ?? openingTiming)?.mark(stage);
          },
          nativeSessionId: this.store.metadata(route.chatId)?.nativeSessionId ?? this.store.metadata(route.chatId)?.chat?.providerBinding?.resumeId,
          ...("oauthToken" in login ? { oauthToken: login.oauthToken } : "apiKey" in login
            ? { apiKey: login.apiKey } : { proxy: { baseUrl: login.baseUrl, token: login.token } }) });
        if (route.closed) { await driver.dispose(); throw new WorkspaceError("session-expired", "This execution has ended."); }
        // Codex and Cursor can reserve a native session during open. Until a
        // user turn exists it must not pin an otherwise empty chat to an agent.
        if (!native.provisional) {
          if (this.store.canRebind(route.chatId)) route.pendingNative = native.nativeSessionId;
          else await this.store.bind(route.chatId, route.agentId, native.nativeSessionId);
        }
      } catch (error) { const tools = this.retireWorkspaceTools(route); route.mcpExecutionId = undefined; route.unsubscribe?.(); await driver.dispose(); await tools; route.driver = undefined; throw error; }
    })();
    try { await route.opening; } finally { route.opening = undefined; }
  }

  private async prompt(client: AppClient, message: AgentPromptMessage): Promise<void> {
    const receivedAt = performance.now();
    const route = this.route(message);
    // A new Send resumes the paused inbox only after the pending Stop has a
    // terminal receipt; it must not prolong or be interrupted by that Stop.
    route.admitting++;
    try {
      await route.cancelling;
      const { entry } = await this.store.enqueue(route.chatId, {
        requestId: message.id, userMessageId: message.userMessageId ?? message.id, prompt: message.prompt, bubble: message.bubble,
        startedAt: message.startedAt ?? Date.now(), promptId: message.promptId,
      }, () => {
        this.assertCurrent(route);
        if (this.store.metadata(route.chatId)?.chat?.agentId !== route.agentId)
          throw new WorkspaceError("session-expired", "Reopen the conversation with its selected agent before sending.");
      });
      this.assertCurrent(route);
      const waiter = { client, requestId: message.id, receivedAt };
      if (entry.state !== "queued" && entry.state !== "running") return this.receipt(route, entry, waiter);
      const waiters = route.waiters.get(entry.requestId) ?? [];
      if (!waiters.some((value) => value.client === client && value.requestId === message.id)) waiters.push(waiter);
      route.waiters.set(entry.requestId, waiters);
      this.pump(route);
    } finally { route.admitting--; }
  }

  private pump(route: Runtime): void {
    if (route.pumping || route.closed || route.cancelling || route.stopInFlight || route.outboxSteering || this.hasBackground(route)) return;
    route.pumping = (async () => {
      while (!route.closed && !route.cancelling && !route.stopInFlight && !this.hasBackground(route)) {
        await route.events;
        if (route.closed || route.cancelling || route.stopInFlight || this.hasBackground(route)) break;
        const stopping = route.stopping;
        let entry = await this.store.claim(route.chatId);
        if (!entry) break;
        route.turnTiming = agentTiming(route.agentId, route.chatId, "turn", this.onTiming, route.waiters.get(entry.requestId)?.[0]?.receivedAt);
        route.idleInputStop = false; route.blockedInputTools = undefined;
        route.active = entry; route.turnFailureNotice = undefined; this.activity();
        if (!entry.outbox) {
          await this.update(route, { sessionId: route.id, update: { sessionUpdate: "user_message_recorded", message: userMessage(entry) } });
          await this.turnState(route, entry, "running");
        }
        let response: PromptResponse | undefined, failure: BridgeAgentFailure | undefined;
        try {
          const content = entry.outbox ? await preparePromptFiles(this.scope, entry.prompt) : entry.prompt;
          if (entry.outbox && (route.model !== entry.outbox.model || route.effort !== entry.outbox.effort)) {
            route.model = entry.outbox.model; route.effort = entry.outbox.effort; route.login = undefined;
            await this.store.update(route.chatId, draft => { draft.chat!.model = route.model ?? null; draft.chat!.effort = route.effort ?? ""; });
          }
          if (entry.outbox?.permissionMode !== undefined) {
            const mode = entry.outbox.permissionMode;
            if (mode === "plan" && this.config.agentInteractions !== 1) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This cloud worker does not support Plan mode yet. Update it before sending this Plan request.");
            await this.withModeChange(route, async () => { if (mode !== route.permissionMode) await this.saveMode(route, mode); });
          }
          await this.ensureDriver(route);
          route.turnTiming.mark("driver_ready");
          if (route.closed || stopping !== route.stopping) response = { stopReason: "cancelled" };
          else {
            if (entry.outbox) {
              const prepared = await this.store.prepareOutboxDispatch(route.chatId, entry.requestId);
              if (!prepared) response = { stopReason: "cancelled" };
              else {
                entry = prepared; route.active = entry;
                if (!await this.outboxDispatch?.(entry)) response = { stopReason: "cancelled" };
                if (!response && !route.closed && stopping === route.stopping) {
                  await this.update(route, { sessionId: route.id, update: { sessionUpdate: "user_message_recorded", message: userMessage(entry) } });
                  await this.turnState(route, entry, "running");
                }
              }
            }
            if (route.pendingNative) {
              await this.store.bind(route.chatId, route.agentId, route.pendingNative);
              route.pendingNative = undefined;
              await this.update(route, { sessionId: route.id, update: { sessionUpdate: "provider_binding_update", providerBinding: this.store.metadata(route.chatId)!.chat!.providerBinding! } });
            }
            if (route.closed || stopping !== route.stopping) response = { stopReason: "cancelled" };
            else if (!response) {
              await this.turns.begin(route.chatId, entry, route.agentId);
              route.checkpointTurnId = entry.userMessageId;
              // Stop can arrive while the pre-turn snapshot is being captured.
              if (route.closed || stopping !== route.stopping) response = { stopReason: "cancelled" };
              else {
                const mode = entry.outbox?.permissionMode;
                const admission = await this.withModeChange(route, async () => {
                  if (!route.closed && stopping === route.stopping && mode !== undefined) {
                    if (mode === "plan" && this.config.agentInteractions !== 1) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This cloud worker does not support Plan mode yet.");
                    if (!route.driver!.setMode) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This agent cannot change mode.");
                    await route.driver!.setMode(cloudModeId(route.agentId, mode));
                    this.assertCurrent(route);
                    await this.saveMode(route, mode);
                  }
                  if (route.closed || stopping !== route.stopping) return { completion: Promise.resolve<PromptResponse>({ stopReason: "cancelled" }) };
                  route.nativeRunning = true; route.activePermissionMode = route.permissionMode ?? "bypass";
                  const completion = route.driver!.prompt(content); void completion.catch(() => {});
                  // Release mode admission immediately; a live turn still accepts mode controls.
                  return { completion };
                });
                response = await admission.completion;
              }
            }
          }
        } catch (error) { failure = providerFailure(route.agentId, error, "prompt"); }
        finally { route.nativeRunning = false; }
        route.settling = (async () => {
          if (route.interactions?.blocking) await route.interactions.dismiss(INPUT_CANCELLED);
          await route.events;
          await Promise.all([...route.steers.values()]);
          await route.outboxSteering;
          failure = route.turnFailureNotice ?? failure;
          const error = failure?.message;
          const notice: SessionNotification | undefined = failure && !route.turnFailureNotice && !entry.cancelRequested && response?.stopReason !== "cancelled"
            ? { sessionId: route.id, update: { sessionUpdate: "error_notice", noticeId: `failure:${entry.userMessageId}`,
                severity: "error", message: failure.message, ...(failure.cloud ? { cloud: failure.cloud } : {}),
                turnFailure: { turnId: entry.userMessageId, kind: failure.kind }, at: Date.now() } }
            : undefined;
          await this.store.finish(route.chatId, entry.requestId, response ? { ...response, userMessageId: entry.userMessageId } : undefined, error, notice, failure);
          const receipt = this.store.receipt(route.chatId, entry.requestId)!;
          const recordedPrompt = await this.turns.finish(route.chatId, entry.userMessageId, {
            status: receipt.state === "cancelled" ? "cancelled" : receipt.state === "failed" ? "failed" : "completed",
            stopReason: receipt.response?.stopReason ?? null,
            // Rides turnSummary on the mirrored prompt row; the control plane totals it per workspace.
            ...(receipt.response?.usage ? { usage: receipt.response.usage } : {}),
          });
          await this.publishRecordedTurn(route, recordedPrompt);
          if (notice && receipt.state === "failed") await this.update(route, notice);
          route.turnTiming?.mark("turn_done"); route.turnTiming = undefined;
          await this.turnState(route, entry, receipt.state === "cancelled" ? "cancelled" : receipt.state === "failed" ? "failed" : "completed", receipt.response?.stopReason);
          for (const waiter of route.waiters.get(entry.requestId) ?? []) await this.receipt(route, receipt, waiter);
          route.waiters.delete(entry.requestId); route.active = undefined; this.activity();
        })();
        await route.settling; route.settling = undefined;
      }
    })().catch(async () => {
      route.turnTiming?.mark("turn_done"); route.turnTiming = undefined;
      // A failed durable write must stop dispatch; never continue a queue that
      // cannot establish whether the provider consumed the last input.
      route.unsubscribe?.();
      const tools = this.retireWorkspaceTools(route);
      await route.driver?.dispose().catch(() => {});
      await tools;
      if (route.active) await this.turnState(route, route.active, "failed");
      for (const waiters of route.waiters.values()) for (const waiter of waiters) {
        await waiter.client.send(createMessage({ type: "AGENT_PROMPT_FAILED", source: "engine", requestId: waiter.requestId,
          agentId: route.agentId, sessionId: route.id, executionId: route.id, error: "The turn could not be saved. Its last confirmed history has been retained." }));
      }
      route.waiters.clear();
      route.active = undefined; route.closed = true; this.activity();
    }).finally(() => {
      route.pumping = undefined;
      if (this.store.hasQueued(route.chatId)) this.pump(route);
    });
  }

  private async receipt(route: Runtime, entry: InboxEntry, waiter: Waiter): Promise<void> {
    const common = { source: "engine" as const, requestId: waiter.requestId, agentId: route.agentId, sessionId: route.id, executionId: route.id };
    if (entry.state === "failed" || entry.state === "interrupted") await waiter.client.send(createMessage({ type: "AGENT_PROMPT_FAILED", ...common, error: entry.error ?? "The turn was interrupted before completion.", ...(entry.failure ? { failure: entry.failure } : {}) }));
    else {
      const response = entry.response ?? { stopReason: "cancelled" as const };
      await waiter.client.send(createMessage({ type: "AGENT_PROMPT_COMPLETE", ...common, stopReason: response.stopReason, response }));
    }
  }

  private async cancel(route: Runtime, reason = INPUT_CANCELLED): Promise<"succeeded" | "failed" | "cancelled"> {
    const pumping = route.pumping;
    const running = !!route.nativeRunning || this.hasBackground(route);
    await this.stop(route, reason);
    // Preparation is fenced by stopping/paused; no native turn was admitted.
    // A live turn, however, must retire and persist before its Stop is confirmed.
    if (running) { await pumping; await route.events; }
    const receipt = this.store.latestReceipt(route.chatId);
    return receipt?.state === "completed" ? "succeeded"
      : receipt?.state === "failed" || receipt?.state === "interrupted" ? "failed" : "cancelled";
  }

  private async stop(route: Runtime, reason = INPUT_CANCELLED): Promise<void> {
    this.cancelWaitingOpens(route.chatId);
    route.stopping++; route.stopInFlight = (route.stopInFlight ?? 0) + 1;
    if (route.active) route.active.cancelRequested = true;
    const tools = this.stopWorkspaceTools(route);
    // Claim the dismissal first, then interrupt before any provider callback
    // can continue while the control-plane Stop receipt is in flight.
    const dismissed = route.interactions?.dismiss(reason);
    const interrupted = route.driver?.interrupt();
    void interrupted?.catch(() => {});
    try {
      await dismissed;
      await route.preparing; this.assertCurrent(route);
      await this.store.stop(route.chatId, () => !route.closed && this.chats.get(route.chatId) === route);
      if (this.outboxStop) {
        const epoch = await this.outboxStop(route.chatId, this.store.deliveryEpoch(route.chatId));
        await this.store.stopOutbox(route.chatId, epoch);
      }
      await interrupted;
      await tools;
    } finally { route.stopInFlight--; }
  }

  private async steer(client: AppClient, message: AgentSteerMessage): Promise<void> {
    const route = this.routes.get(message.executionId ?? message.sessionId);
    const attemptId = message.attemptId ?? message.userMessageId ?? message.id;
    let receipt: Pick<SteerReceipt, "outcome" | "turnId"> = { outcome: "interrupted" };
    if (route && !route.closed && route.agentId === message.agentId && (!message.executionId || message.executionId === message.sessionId)) {
      const saved = this.store.steerReceipt(route.chatId, route.id, attemptId);
      if (saved && (JSON.stringify(saved.prompt) !== JSON.stringify(message.prompt) || JSON.stringify(saved.bubble) !== JSON.stringify(message.bubble)))
        throw new WorkspaceError("VALIDATION_FAILED", "This steering attempt has different content.");
      let pending = route.steers.get(attemptId);
      if (saved && saved.outcome !== "pending") receipt = saved;
      else {
        if (!pending) {
          const accepting = route.active, stopping = route.stopping;
          pending = (async () => {
            const result: SteerReceipt = { requestId: message.id, attemptId, executionId: route.id,
              userMessageId: message.userMessageId ?? attemptId, prompt: message.prompt, bubble: message.bubble,
              createdAt: Date.now(), turnId: accepting?.userMessageId, outcome: "pending" };
            await this.store.update(route.chatId, (draft) => { this.assertCurrent(route); draft.steers.push(result); });
            let outcome: SteerOutcome = "queued";
            if (route.closed) outcome = "interrupted";
            else if (accepting && route.active === accepting && route.stopping === stopping && route.driver) {
              try { outcome = await route.driver.steer(message.prompt); } catch { outcome = "interrupted"; }
            }
            await this.store.update(route.chatId, (draft) => {
              draft.steers.find((value) => value.executionId === route.id && value.attemptId === attemptId)!.outcome = outcome;
              if (outcome !== "queued") recordUser(draft, { ...result, startedAt: result.createdAt }, result.turnId);
            });
            if (outcome !== "queued") await this.update(route, { sessionId: route.id, update: { sessionUpdate: "user_message_recorded", message: userMessage({ ...result, startedAt: result.createdAt }, result.turnId) } });
            return { ...result, outcome };
          })();
          route.steers.set(attemptId, pending);
          void pending.catch(() => {}).finally(() => { route.steers.delete(attemptId); });
        }
        const completed = await pending;
        if (JSON.stringify(completed.prompt) !== JSON.stringify(message.prompt) || JSON.stringify(completed.bubble) !== JSON.stringify(message.bubble))
          throw new WorkspaceError("VALIDATION_FAILED", "This steering attempt has different content.");
        receipt = completed;
      }
    }
    if (!message.attemptId && receipt.outcome !== "delivered") throw new WorkspaceError("STEER_NOT_DELIVERED", receipt.outcome === "queued" ? "This instruction was not delivered and remains queued." : "Delivery could not be confirmed. Review the turn before sending again.");
    await client.send(createMessage({ type: "AGENT_STEERED", source: "engine", requestId: message.id, agentId: message.agentId,
      sessionId: message.sessionId, executionId: message.executionId ?? message.sessionId, outcome: receipt.outcome as SteerOutcome,
      ...(receipt.turnId ? { turnId: receipt.turnId } : {}) }));
  }

  private withModeChange<T>(route: Runtime, work: () => Promise<T>): Promise<T> {
    const pending = (route.modeChanges ?? Promise.resolve()).then(work);
    route.modeChanges = pending.then(() => {}, () => {});
    return pending;
  }

  private async saveMode(route: Runtime, mode: CloudPermissionMode): Promise<void> {
    route.permissionMode = mode;
    await this.store.update(route.chatId, draft => {
      this.assertCurrent(route);
      draft.chat!.permissionMode = mode === "plan" ? "plan" : "danger";
      draft.chat!.lastModeId = cloudModeId(route.agentId, mode);
    });
  }

  private cancelForInput(route: Runtime, reason: string): void {
    if (route.closed || route.cancelling) return;
    // Publish the Stop fence before releasing callbacks: a completed native
    // question must not admit a queued HTTP successor in the same microtask.
    if (reason === INPUT_TIMEOUT) { route.idleInputStop = true; route.blockedInputTools = route.interactions?.toolIds; }
    route.cancelling = this.cancel(route, reason);
    const pending = route.cancelling;
    void pending.finally(() => { if (route.cancelling === pending) route.cancelling = undefined; }).catch(() => {});
  }

  private waitingForInput(route: Runtime): boolean { return !!route.interactions?.blocking || !!route.idleInputStop && !!route.active; }
  private hasIndependentWork(route: Runtime): boolean {
    if (route.background?.tasks.length) return true;
    const blocked = new Set([...(route.interactions?.toolIds ?? []), ...(route.blockedInputTools ?? [])]);
    const tools = route.tools ?? new Map();
    // Ancestor agent tools wait for their child too. Sibling tools and native
    // background tasks continue to count as activity.
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, tool] of tools) if ((blocked.has(id) || !!tool.nativeId && blocked.has(tool.nativeId)) && tool.parentId && !blocked.has(tool.parentId)) {
        blocked.add(tool.parentId); changed = true;
      }
    }
    return [...tools].some(([id, tool]) => tool.active && !blocked.has(id) && (!tool.nativeId || !blocked.has(tool.nativeId)));
  }

  private hasBackground(route: Runtime): boolean { return !!route.background && (route.background.tasks.length > 0 || (!!route.background.activity && route.background.activity.state !== "idle")); }
  private update(route: Runtime, notification: SessionNotification): Promise<void> {
    return this.broadcast(createMessage({ type: "AGENT_SESSION_UPDATE", source: "engine", agentId: route.agentId, executionId: route.id, chatId: route.chatId, notification }));
  }
  private async publishRecordedTurn(route: Runtime, prompt: AgentTextMessage | undefined): Promise<void> {
    if (!prompt) return;
    await this.update(route, { sessionId: route.id, update: { sessionUpdate: "user_message_recorded", message: prompt } });
    // The file watcher can fire before this record is ready. Every device,
    // including one without the chat open, needs the completed history now.
    await this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["workspaces"], workspaceIds: [this.scope.workspace.id] }));
  }
  private turnState(route: Runtime, entry: InboxEntry, state: "running" | "completed" | "failed" | "cancelled", stopReason?: PromptResponse["stopReason"]): Promise<void> {
    return this.update(route, { sessionId: route.id, update: { sessionUpdate: "turn_state", turnId: entry.userMessageId, state, startedAt: entry.startedAt, ...(stopReason ? { stopReason } : {}) } });
  }
}
