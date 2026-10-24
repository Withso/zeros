import { randomUUID } from "node:crypto";
import type { BackgroundTasksUpdate, InitializeResponse, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import { createMessage, type AgentLoadSessionMessage, type AgentNewSessionMessage, type AgentPromptMessage, type AgentSteerMessage, type BridgeMessage, type SteerOutcome } from "@zeros/protocol/messages";
import type { CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import type { Driver } from "./drivers/driver";
import { agentTiming, type TimingObserver, type TimingSpan } from "./agent-timings";
import { recordUser, userMessage, type InboxEntry, type SessionStore, type SteerReceipt } from "./sessions/session-store";
import { WorkspaceError, type WorkerConfig, type WorkspaceScope } from "./workspace/scope";
import { CodexModelAvailability, type ModelDiscoveryOptions } from "./credentials/model-availability";
import { preparePromptFiles } from "./prompt-files";
import type { DriverMcpServers } from "./mcp/gateway";
import { TurnService } from "./workspace/turns";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";

export type DriverFactories = Partial<Record<CloudV2Agent, () => Driver>>;
export interface AppClient { id: string; send(frame: BridgeMessage): Promise<void> }
interface Waiter { client: AppClient; requestId: string; receivedAt: number }
interface Runtime {
  id: string; chatId: string; agentId: CloudV2Agent; model?: string; effort?: string;
  driver?: Driver; unsubscribe?: () => void; login?: string; opening?: Promise<void>;
  preparing?: Promise<void>;
  retiring?: Promise<void>; pendingNative?: string; admitting: number;
  cancelling?: Promise<"succeeded" | "failed" | "cancelled">;
  active?: InboxEntry; nativeRunning?: boolean; background?: BackgroundTasksUpdate;
  pumping?: Promise<void>; events: Promise<void>; stopping: number; closed: boolean;
  settling?: Promise<void>; steers: Map<string, Promise<SteerReceipt>>;
  waiters: Map<string, Waiter[]>;
  turnTiming?: TimingSpan;
  turnFailureNotice?: boolean;
  outboxSteering?: Promise<void>;
  checkpointTurnId?: string;
}

const VERSIONS = { codex: "0.162.1", claude: "0.3.309", cursor: "1.0.37" };
const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor" };
const MODEL_ENV = { codex: "OPENAI_MODEL", claude: "ANTHROPIC_MODEL", cursor: "CURSOR_MODEL" };
const initialized = (agentId: CloudV2Agent): InitializeResponse => ({
  protocolVersion: 1, agentInfo: { name: NAMES[agentId], version: VERSIONS[agentId] },
  authMethods: [], agentCapabilities: { loadSession: true, steering: true, promptCapabilities: { image: true } },
});
const publicError = (error: unknown): string => error instanceof WorkspaceError ? error.message
  : error instanceof Error && /\b401\b|unauthori[sz]ed|authentication/i.test(error.message)
    ? "Agent authentication expired. Reconnect the provider before sending again." : "The agent could not complete this request.";

/** Executions are worker-owned routes; provider resume ids never select a
 * live process. Client disconnects do not change a conversation's lifetime. */
export class Agents {
  readonly turns: TurnService;
  private readonly routes = new Map<string, Runtime>();
  private readonly chats = new Map<string, Runtime>();
  private config: WorkerConfig;
  private readonly models: CodexModelAvailability;
  private outboxDispatch?: (entry: InboxEntry) => Promise<boolean>;
  private outboxStop?: (chatId: string, throughEpoch: string) => Promise<string>;

  constructor(
    private readonly store: SessionStore,
    private readonly scope: WorkspaceScope,
    private readonly factories: DriverFactories,
    config: WorkerConfig,
    private readonly broadcast: (message: BridgeMessage) => Promise<void>,
    private readonly activity: () => void,
    private readonly onTiming?: TimingObserver,
    modelDiscovery?: ModelDiscoveryOptions,
    private readonly mcpProviders?: () => Promise<DriverMcpServers>,
  ) { this.config = config; this.models = new CodexModelAvailability(modelDiscovery); this.models.configure(config); this.turns = new TurnService(store, scope); }

  configure(config: WorkerConfig): void { this.config = config; this.models.configure(config); }
  private initialized(agentId: CloudV2Agent): InitializeResponse {
    return { ...initialized(agentId), _meta: this.models.metadata(agentId === "codex") };
  }
  get busy(): boolean { return [...this.routes.values()].some((route) => !!route.active || this.hasBackground(route)); }

  setOutboxDispatch(dispatch?: (entry: InboxEntry) => Promise<boolean>, stop?: (chatId: string, throughEpoch: string) => Promise<string>): void {
    this.outboxDispatch = dispatch; this.outboxStop = stop;
  }

  async receiveOutbox(item: CloudV2PromptDelivery): Promise<InboxEntry> {
    const { payload, receipt } = item;
    if (receipt.workspaceId !== this.scope.workspace.id || receipt.chatId !== payload.chatId || receipt.userMessageId !== payload.userMessageId)
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This message belongs to another workspace.");
    // Waking preserves the execution the app holds, as well as its native
    // conversation. Re-adopt only the current persisted execution (M069).
    const metadata = this.store.metadata(payload.chatId);
    if (metadata?.executionId) this.readopt(metadata.executionId, payload.agentId, payload.chatId);
    await this.open({ id: "outbox", send: async () => {} }, createMessage({ type: "AGENT_NEW_SESSION", source: "browser",
      chatId: payload.chatId, agentId: payload.agentId, cwd: this.scope.root, workspaceId: this.scope.workspace.id,
      env: { ...(payload.model ? { [MODEL_ENV[payload.agentId]]: payload.model } : {}), ...(payload.effort ? { ZEROS_THINKING_EFFORT: payload.effort } : {}) },
    }), true);
    const route = this.chats.get(payload.chatId)!;
    route.admitting++;
    try { await route.cancelling; this.assertCurrent(route); return await this.store.receiveOutbox(item); }
    finally { route.admitting--; }
  }

  resumeOutbox(chatId: string): void {
    const route = this.chats.get(chatId);
    if (!route || route.closed || route.outboxSteering) return;
    const next = this.store.outboxEntries(chatId).find(({ entry }) => entry.state === "queued" && entry.outbox?.acknowledged)?.entry;
    if (route.active && route.nativeRunning && next?.outbox?.mode === "steer" && !next.outbox.steerDeclined &&
        next.outbox.model === route.model && next.outbox.effort === route.effort) {
      const active = route.active, stopping = route.stopping;
      route.outboxSteering = (async () => {
        const content = await preparePromptFiles(this.scope, next.prompt);
        const entry = await this.store.prepareOutboxDispatch(chatId, next.requestId, true);
        if (!entry) return;
        let outcome: SteerOutcome = "interrupted";
        if (await this.outboxDispatch?.(entry)) {
          if (route.closed || stopping !== route.stopping) outcome = "interrupted";
          else if (route.active !== active || !route.nativeRunning) outcome = "queued";
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
    const interrupt = !!route && (active ? (active.outbox
      ? BigInt(active.outbox.epoch) < BigInt(epoch)
      : active.cancelRequested || freshEpoch) : this.hasBackground(route) && freshEpoch);
    const running = !!route?.nativeRunning;
    if (interrupt && route) { route.stopping++; if (active) active.cancelRequested = true; }
    await this.store.stopOutbox(chatId, epoch);
    if (interrupt && route) {
      if (!active?.outbox) await this.store.stop(chatId);
      await route.driver?.interrupt();
      if (running) await route.pumping;
    }
  }

  async fenceOutbox(): Promise<void> {
    for (const { chatId, entry } of this.store.outboxEntries())
      await this.stopOutbox(chatId, (BigInt(entry.outbox!.epoch) + 1n).toString());
  }

  async handle(client: AppClient, message: BridgeMessage): Promise<void> {
    try {
      switch (message.type) {
        case "AGENT_LIST_AGENTS":
          await client.send(createMessage({ type: "AGENT_AGENTS_LIST", source: "engine", requestId: message.id,
            agents: (Object.keys(VERSIONS) as CloudV2Agent[]).map((id) => ({ id, name: NAMES[id], version: VERSIONS[id], description: `${NAMES[id]} cloud agent`, distribution: {},
              installed: !!this.factories[id], launchKind: this.factories[id] ? "binary" as const : "unavailable" as const, installedVersion: VERSIONS[id], versionCompatible: true, authenticated: !!this.config.agents[id] && !!this.factories[id] })) }));
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
        case "AGENT_SET_MODEL": {
          const route = this.route(message);
          await this.ensureDriver(route);
          this.assertCurrent(route);
          await route.driver!.setModel(message.model);
          this.assertCurrent(route);
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
        case "AGENT_CLOSE_SESSION": {
          const id = message.executionId ?? message.sessionId;
          const route = id ? this.routes.get(id) : message.chatId ? this.chats.get(message.chatId) : undefined;
          if (route && (route.agentId !== message.agentId || (message.chatId && route.chatId !== message.chatId))) throw new WorkspaceError("session-expired", "The execution does not belong to this conversation.");
          // Closing a view is not Stop in a shared headless workspace. The
          // explicit userStop flag also covers Stop before creation replied.
          if (route && message.userStop) await this.closeChat(route.chatId);
          else if (!id && !route && message.chatId && message.userStop && this.store.metadata(message.chatId)?.chat?.agentId === message.agentId) await this.store.stop(message.chatId);
          await client.send(createMessage({ type: "AGENT_SESSION_CLOSED", source: "engine", requestId: message.id, agentId: message.agentId,
            ...(id ? { sessionId: id, executionId: id } : {}), ...(message.chatId ? { chatId: message.chatId } : {}) }));
          return;
        }
        default: throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This agent operation is not available in cloud workspaces yet.");
      }
    } catch (error) {
      await client.send(createMessage({ type: "AGENT_ERROR", source: "engine", requestId: message.id,
        ...("agentId" in message ? { agentId: message.agentId } : {}), code: error instanceof WorkspaceError ? error.code : "AGENT_ERROR", message: publicError(error) }));
    }
  }

  /** Shutdown keeps each chat's execution for the next worker to re-adopt. */
  async closeChat(chatId: string, shutdown = false): Promise<void> {
    const route = this.chats.get(chatId);
    if (!route) return;
    if (!shutdown && this.outboxStop) await this.stop(route);
    await this.retire(route);
    if (!shutdown) await this.store.retireExecution(chatId, route.id);
    if (this.store.metadata(chatId)?.chat) await this.store.stop(chatId, () => this.chats.get(chatId) === route);
    if (this.chats.get(chatId) === route) this.chats.delete(chatId);
    this.activity();
  }

  private retire(route: Runtime): Promise<void> {
    if (route.retiring) return route.retiring;
    route.closed = true; route.stopping++; route.unsubscribe?.();
    this.routes.delete(route.id);
    return route.retiring = (async () => {
      await route.driver?.dispose();
      await route.preparing?.catch(() => {});
      await route.opening?.catch(() => {});
      await route.pumping;
      await route.events;
    })();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.routes.values()].map(async (route) => { await route.events; await route.settling; }));
  }
  async dispose(): Promise<void> { this.models.dispose(); for (const id of [...this.chats.keys()]) await this.closeChat(id, true); }

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
    const metadata = chatId && !this.chats.has(chatId) ? this.store.metadata(chatId) : undefined;
    if (!chatId || !metadata?.chat || metadata.executionId !== id || metadata.chat.agentId !== agentId) return undefined;
    this.scope.folder(metadata.chat.folder);
    const route: Runtime = { id, chatId, agentId: this.agent(agentId), model: metadata.chat.model ?? undefined, effort: metadata.chat.effort || undefined,
      admitting: 0, events: Promise.resolve(), stopping: 0, closed: false, waiters: new Map(), steers: new Map() };
    this.chats.set(chatId, route); this.routes.set(id, route);
    return route;
  }

  private assertCurrent(route: Runtime): void {
    if (route.closed || this.chats.get(route.chatId) !== route) throw new WorkspaceError("session-expired", "This execution has ended. Reopen the conversation to continue.");
  }

  private async open(client: AppClient, message: AgentNewSessionMessage | AgentLoadSessionMessage, deferDriver = false): Promise<void> {
    this.scope.folder(message.cwd, true); this.scope.assertId(message.workspaceId);
    if (message.type === "AGENT_NEW_SESSION" && message.agentRole === "design") throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "Design is not available in cloud workspaces.");
    const agentId = this.agent(message.agentId);
    const requested = message.type === "AGENT_LOAD_SESSION" ? message.executionId ?? message.sessionId : undefined;
    // An adoption probe never starts a native process for a restarted worker.
    const found = requested ? this.routes.get(requested) ?? (message.type === "AGENT_LOAD_SESSION" && !message.adoptOnly ? this.readopt(requested, agentId, message.chatId) : undefined) : undefined;
    const chatId = message.chatId ?? found?.chatId;
    if (!chatId) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "A conversation is required.");
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
        const chat = await this.store.selectAgent({ id: chatId, folder: this.scope.root, agentId, agentName: NAMES[agentId], executionId: selected.id,
          // These existing open couriers carry selections only. Credentials
          // always come from the control plane, never the caller's env.
          model: message.env?.[MODEL_ENV[agentId]] || undefined, effort: message.env?.ZEROS_THINKING_EFFORT || undefined,
        }, () => this.assertCurrent(selected));
        selected.model = chat.model ?? undefined; selected.effort = chat.effort || undefined;
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
    const session = { sessionId: route.id, executionId: route.id, ...(chat.providerBinding ? { providerBinding: chat.providerBinding } : {}), ...(route.background ? { backgroundTasks: route.background } : {}) };
    if (message.type === "AGENT_NEW_SESSION") await client.send(createMessage({ type: "AGENT_SESSION_CREATED", source: "engine", requestId: message.id, agentId, session, initialize: this.initialized(agentId) }));
    else await client.send(createMessage({ type: "AGENT_SESSION_LOADED", source: "engine", requestId: message.id, agentId,
      sessionId: route.id, executionId: route.id, response: session, promptActive: !!route.active,
      ...(route.active ? { activeTurnStartedAt: route.active.startedAt, promptId: route.active.promptId } : {}) }));
    if (route.active) await this.turnState(route, route.active, "running");
  }

  private async ensureDriver(route: Runtime, openingTiming?: TimingSpan): Promise<void> {
    this.assertCurrent(route);
    if (route.opening) return route.opening;
    const login = this.config.agents[route.agentId];
    // Personal MCP sign-in changes readiness without changing the shared
    // server definition. Reopen between turns after that pushed revision.
    const key = JSON.stringify([login, this.config.mcpServers ?? [], this.config.mcpServers?.length ? this.config.loginRevision : undefined]);
    if (route.driver && (route.login === key || route.nativeRunning || this.hasBackground(route))) return;
    if (!login || ("expiresAt" in login && login.expiresAt <= Date.now())) throw new WorkspaceError("auth-required", "Connect this agent before sending a message.");
    const factory = this.factories[route.agentId];
    if (!factory) throw new WorkspaceError("agent-unavailable", "This agent is not installed in the worker.");
    route.opening = (async () => {
      route.unsubscribe?.();
      await route.driver?.dispose();
      this.assertCurrent(route);
      const driver = factory();
      route.driver = driver; route.login = key; route.pendingNative = undefined;
      route.unsubscribe = driver.onEvent((event) => {
        if (route.closed || route.driver !== driver) return;
        const active = route.active;
        if (route.nativeRunning && active?.outbox && !active.outbox.accepted) {
          active.outbox.accepted = true;
          void this.store.acceptOutbox(route.chatId, active.requestId).catch(() => this.stop(route));
        }
        const notification = { ...event, sessionId: route.id };
        const hadBackground = this.hasBackground(route);
        if (active && notification.update.sessionUpdate === "error_notice" && !notification.update.parentToolId &&
            !notification.update.recoverable && notification.update.severity === "error" &&
            (!notification.update.turnFailure || notification.update.turnFailure.turnId === active.userMessageId)) route.turnFailureNotice = true;
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
          await this.store.fold(route.chatId, notification);
          await this.update(route, notification);
          if (backgroundTurnId) {
            const prompt = await this.turns.finish(route.chatId, backgroundTurnId);
            await this.publishRecordedTurn(route, prompt);
          }
        }).catch(async () => { if (!route.closed) await this.stop(route); });
        if (!this.hasBackground(route) && !route.active) this.pump(route);
      });
      try {
        const mcpServers = await this.mcpProviders?.();
        this.assertCurrent(route);
        const native = await driver.open({ sessionId: route.id, cwd: this.scope.root, model: route.model, effort: route.effort,
          ...(mcpServers ? { mcpServers } : {}),
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
      } catch (error) { route.unsubscribe?.(); await driver.dispose(); route.driver = undefined; throw error; }
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
    if (route.pumping || route.closed || route.outboxSteering || this.hasBackground(route)) return;
    route.pumping = (async () => {
      while (!route.closed && !route.cancelling && !this.hasBackground(route)) {
        await route.events;
        if (route.closed || route.cancelling || this.hasBackground(route)) break;
        const stopping = route.stopping;
        let entry = await this.store.claim(route.chatId);
        if (!entry) break;
        route.turnTiming = agentTiming(route.agentId, route.chatId, "turn", this.onTiming, route.waiters.get(entry.requestId)?.[0]?.receivedAt);
        route.active = entry; route.turnFailureNotice = false; this.activity();
        if (!entry.outbox) {
          await this.update(route, { sessionId: route.id, update: { sessionUpdate: "user_message_recorded", message: userMessage(entry) } });
          await this.turnState(route, entry, "running");
        }
        let response: PromptResponse | undefined, error: string | undefined;
        try {
          const content = entry.outbox ? await preparePromptFiles(this.scope, entry.prompt) : entry.prompt;
          if (entry.outbox && (route.model !== entry.outbox.model || route.effort !== entry.outbox.effort)) {
            route.model = entry.outbox.model; route.effort = entry.outbox.effort; route.login = undefined;
            await this.store.update(route.chatId, draft => { draft.chat!.model = route.model ?? null; draft.chat!.effort = route.effort ?? ""; });
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
              else { route.nativeRunning = true; response = await route.driver!.prompt(content); }
            }
          }
        } catch (failure) { error = publicError(failure); }
        finally { route.nativeRunning = false; }
        route.settling = (async () => {
          await route.events;
          await Promise.all([...route.steers.values()]);
          await route.outboxSteering;
          const notice: SessionNotification | undefined = entry.outbox && error && !route.turnFailureNotice
            ? { sessionId: route.id, update: { sessionUpdate: "error_notice", noticeId: `outbox:${entry.userMessageId}`,
                severity: "error", message: error, turnFailure: { turnId: entry.userMessageId, kind: "protocol-error" }, at: Date.now() } }
            : undefined;
          await this.store.finish(route.chatId, entry.requestId, response ? { ...response, userMessageId: entry.userMessageId } : undefined, error, notice);
          const receipt = this.store.receipt(route.chatId, entry.requestId)!;
          const recordedPrompt = await this.turns.finish(route.chatId, entry.userMessageId, {
            status: receipt.state === "cancelled" ? "cancelled" : receipt.state === "failed" ? "failed" : "completed",
            stopReason: receipt.response?.stopReason ?? null,
          });
          await this.publishRecordedTurn(route, recordedPrompt);
          if (notice && receipt.error) await this.update(route, notice);
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
      await route.driver?.dispose().catch(() => {});
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
    if (entry.state === "failed" || entry.state === "interrupted") await waiter.client.send(createMessage({ type: "AGENT_PROMPT_FAILED", ...common, error: entry.error ?? "The turn was interrupted before completion." }));
    else {
      const response = entry.response ?? { stopReason: "cancelled" as const };
      await waiter.client.send(createMessage({ type: "AGENT_PROMPT_COMPLETE", ...common, stopReason: response.stopReason, response }));
    }
  }

  private async cancel(route: Runtime): Promise<"succeeded" | "failed" | "cancelled"> {
    const pumping = route.pumping;
    const running = !!route.nativeRunning || this.hasBackground(route);
    await this.stop(route);
    // Preparation is fenced by stopping/paused; no native turn was admitted.
    // A live turn, however, must retire and persist before its Stop is confirmed.
    if (running) { await pumping; await route.events; }
    const receipt = this.store.latestReceipt(route.chatId);
    return receipt?.state === "completed" ? "succeeded"
      : receipt?.state === "failed" || receipt?.state === "interrupted" ? "failed" : "cancelled";
  }

  private async stop(route: Runtime): Promise<void> {
    route.stopping++;
    await route.preparing;
    this.assertCurrent(route);
    if (this.outboxStop) {
      const epoch = await this.outboxStop(route.chatId, this.store.deliveryEpoch(route.chatId));
      await this.store.stopOutbox(route.chatId, epoch);
    }
    await this.store.stop(route.chatId, () => !route.closed && this.chats.get(route.chatId) === route);
    await route.driver?.interrupt();
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
