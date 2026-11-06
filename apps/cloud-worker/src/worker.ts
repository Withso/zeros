import { createHash, randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CloudV2ControlFrameSchema, CLOUD_V2_RELAY_PROTOCOL, type CloudV2ControlFrame, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptPullReplySchema } from "@zeros/protocol/cloud-v2-prompts";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { safeParseClientBridgeMessage } from "@zeros/protocol/schemas";
import { CodeReviewError } from "@zeros/protocol/code-review";
import { MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION } from "@zeros/protocol/version";
import { Agents, type AppClient, type DriverFactories } from "./agents";
import { RECENT_ACTIVITY_MS } from "./activity";
import type { TimingObserver } from "./agent-timings";
import { CodexDriver } from "./drivers/codex/driver";
import { ClaudeDriver } from "./drivers/claude/driver";
import { CursorDriver } from "./drivers/cursor/driver";
import { SessionStore } from "./sessions/session-store";
import { HistoryMirror } from "./sessions/history-mirror";
import type { Transport } from "./transport";
import { ChatService } from "./workspace/chat-service";
import { prepareCheckout, type CheckoutRefresh, type CheckoutResult } from "./workspace/checkout";
import { WorkspaceSetup, type SetupRunner } from "./workspace/setup";
import { WorkspaceError, WorkspaceScope, type WorkerConfig } from "./workspace/scope";
import { WorkspaceService, type WorkspaceServiceOptions } from "./workspace/service";
import { isGitMutation } from "./workspace/git";
import { GithubBroker, GithubTokens, githubEnvironment } from "./credentials/github";
import { GithubCredentialRecovery } from "./credentials/github-recovery";
import { configureGitIdentity } from "./credentials/git-identity";
import { commandRunner } from "./workspace/commands";
import { Terminals } from "./terminals/service";
import type { ModelDiscoveryOptions } from "./credentials/model-availability";
import { PromptInbox } from "./prompt-inbox";
import { McpGateway } from "./mcp/gateway";
import { WorkspaceToolsMcp } from "./mcp/workspace-tools";
import { WorkerCodeReview } from "./workspace/code-review";
import { measureStartup, recordStartupTiming, type StartupTimingObserver } from "./startup-timings";
import { EnvironmentSeedError, seedEnvironment } from "./workspace/environment-seed";
import { ApplicationEnvironment } from "./credentials/application-environment";
import { RuntimeQuiescence, type RuntimeCensus } from "./runtime-quiescence";
import { RuntimeUpdate } from "./runtime-update";
import type { RuntimePermit } from "./runtime-permit";

interface WorkerOptions {
  directory: string;
  homeDirectory?: string;
  workspaceId?: string;
  runtimeResume?: { instanceId: string; ready?(): void };
  runtimePermit?: RuntimePermit;
  runtimeClock?: () => number;
  transport: Transport;
  drivers?: DriverFactories;
  prepareCheckout?: (workspace: WorkerConfig["workspace"], gitEnvironment: NodeJS.ProcessEnv, timing?: StartupTimingObserver) => Promise<CheckoutResult | void>;
  setupRunner?: SetupRunner;
  gitAskpassPath?: string;
  githubFetch?: typeof fetch;
  workspaceServices?: WorkspaceServiceOptions;
  onError?: (code: "configuration" | "storage" | "transport") => void;
  onTiming?: TimingObserver;
  modelDiscovery?: ModelDiscoveryOptions;
}
interface Client extends AppClient { rejected: boolean }

const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
/** The control plane mints a new Codex proxy token for every configuration it
 * builds, so the relay's copy of the hello configuration differs only there. */
function configurationIdentity(config: WorkerConfig): string {
  const { agents: { codex, ...agents }, ...rest } = config;
  return createHash("sha256").update(stableJson({ ...rest, agents: { ...agents, ...(codex ? { codex: { baseUrl: codex.baseUrl } } : {}) } })).digest("hex");
}

/** One VM, one checkout, many app sockets. The relay is a carrier for ordinary
 * bridge frames; this process owns validation, agent work and durable history. */
export class CloudWorker {
  /** Only a quiescent handoff preserves identity; ordinary restarts lose PTYs. */
  private readonly instanceId: string;
  private readonly clients = new Map<string, Client>();
  private readonly pendingClients = new Map<string, object>();
  private readonly runtimeGate = new RuntimeQuiescence(() => this.runtimeCensus, () => this.options.runtimeClock?.() ?? Date.now());
  private runtimeUpdater?: RuntimeUpdate;
  private runtimePublished = false;
  private configurations = 0;
  private scope?: WorkspaceScope;
  private store?: SessionStore;
  private agents?: Agents;
  private mcp?: McpGateway;
  private readonly workspaceMcp = new WorkspaceToolsMcp(async () => this.runtimeGate.admit());
  private reviews?: WorkerCodeReview;
  private chats?: ChatService;
  private history?: HistoryMirror;
  private promptInbox?: PromptInbox;
  private workspace?: WorkspaceService;
  private terminals?: Terminals;
  private setup?: WorkspaceSetup;
  private checkoutRefresh?: CheckoutRefresh;
  private initialSetupNeeded = false;
  private checkoutSequence = 0;
  private readonly tokens: GithubTokens;
  private readonly githubCredentials: GithubCredentialRecovery;
  private githubUserTokensEnabled = false;
  private historyReplacementEnabled = false;
  private readonly github: GithubBroker;
  private readonly gitEnvironment: NodeJS.ProcessEnv;
  private configuring: Promise<void> = Promise.resolve();
  private appliedConfiguration?: string;
  private disconnects = 0;
  private online = false;
  private disposed = false;
  private started = false;
  private stopping?: Promise<void>;
  private acceptedConfigurationRevision?: bigint;
  private configurationRevision?: bigint;
  private configuredReviewAvailable = false;
  private environmentVersion?: string;
  private readonly environmentLifetime = new AbortController();
  private idle?: boolean;
  private activeMutations = 0;
  private lastMutationAt = -Infinity;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly options: WorkerOptions) {
    this.instanceId = options.runtimeResume?.instanceId ?? randomUUID();
    this.tokens = new GithubTokens((frame, timeoutMs) => this.send(frame, timeoutMs));
    this.githubCredentials = new GithubCredentialRecovery(this.tokens, { fetch: options.githubFetch, supportsRecovery: () => this.githubUserTokensEnabled });
    this.github = new GithubBroker(`/tmp/zeros-github-${this.instanceId}/github.sock`, (purpose, failed) => this.githubCredentials.get(purpose, failed), () => this.workspace?.githubChanged());
    this.gitEnvironment = githubEnvironment(this.github.socketPath, options.gitAskpassPath ?? fileURLToPath(new URL("../bin/git-askpass", import.meta.url)));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.heartbeat = setInterval(() => { void this.reportIdle(this.busy); }, 55_000);
    this.heartbeat.unref?.();
    this.options.transport.start({
      open: async () => {
        if (this.disposed) return;
        this.online = true; this.idle = undefined; this.tokens.connect();
        await this.send({ t: "hello", protocol: CLOUD_V2_RELAY_PROTOCOL, workerVersion: "0.0.0",
          capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"], mcp: 1 } });
      },
      frame: (raw) => this.receive(raw),
      close: () => {
        this.online = false; this.appliedConfiguration = undefined; this.disconnects++;
        for (const client of this.clients.values()) this.terminals?.detach(client);
        this.clients.clear(); this.history?.disconnect(); this.tokens.disconnect(); this.githubCredentials.disconnect();
      },
    });
  }

  async flush(): Promise<void> {
    await this.configuring;
    await this.flushServices();
  }

  private async flushServices(): Promise<void> {
    // Let resolved native promises enter their durable turn-end section.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.agents?.flush();
    await this.store?.flush();
    await this.history?.flush();
    await this.workspace?.flush();
    await this.terminals?.flush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.runtimeUpdater?.stop(); clearInterval(this.heartbeat); this.tokens.dispose(); this.githubCredentials.invalidate();
    const workspaceTools = this.workspaceMcp.dispose();
    const agentsClosing = this.agents?.dispose();
    this.environmentLifetime.abort();
    void agentsClosing?.catch(() => {});
    await this.configuring.catch(() => {});
    await this.stopCheckout();
    await this.promptInbox?.dispose();
    await this.terminals?.dispose();
    await this.workspace?.dispose();
    await agentsClosing;
    await this.mcp?.dispose();
    await workspaceTools;
    this.reviews?.close();
    await this.store?.flush();
    await this.history?.flush();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.history?.dispose();
    await this.github.dispose();
    await this.options.transport.dispose();
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const parsed = CloudV2ControlFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (["stop", "close", "prompts"].includes(message.t)) this.runtimeGate.activity();
    if (["stop", "close", "prompts", "reply", "refusal"].includes(message.t)) return this.control(message);
    const opening = {};
    if (message.t === "open") this.pendingClients.set(message.clientId, opening);
    const admission = this.runtimeGate.admit();
    const leave = typeof admission === "function" ? admission : await admission;
    if (message.t === "config") this.configurations++;
    try {
      if (message.t !== "open" || this.pendingClients.get(message.clientId) === opening) await this.control(message);
    } finally {
      if (message.t === "open" && this.pendingClients.get(message.clientId) === opening) this.pendingClients.delete(message.clientId);
      if (message.t === "config") this.configurations--; leave();
    }
  }

  private async control(message: CloudV2ControlFrame): Promise<void> {
    if (this.disposed) return;
    if (message.t === "config") {
      this.configuring = this.configuring.catch(() => {}).then(() => this.configure(message));
      await this.configuring.catch(error => { this.options.onError?.("configuration"); throw error; });
      return;
    }
    // Checkout preparation can be waiting for this reply. Never queue control
    // replies behind configuration or behind ordinary app work.
    if (message.t === "reply" || message.t === "refusal") { this.tokens.receive(message); return; }
    if (message.t === "prompts") { this.promptInbox?.hint(); return; }
    if (message.t === "stop") {
      this.runtimeUpdater?.stop();
      // The VM can stop only after the native turn's final rows reach the HTTP
      // mirror. Keep the transport alive until this correlated ack is sent.
      this.stopping ??= this.prepareStop();
      await this.stopping;
      // A lost HTTPS response may need a retry after quiescing. Do not cache a
      // mirror failure in the promise that prevents new work from starting.
      await this.flushServices();
      if (this.history && !await this.history.flush()) throw new Error("History mirror is unavailable.");
      await this.send({ t: "stop-ack", id: message.id });
      return;
    }
    if (message.t === "close") {
      this.pendingClients.delete(message.clientId);
      const client = this.clients.get(message.clientId); if (client) this.terminals?.detach(client);
      this.clients.delete(message.clientId); return;
    }
    if (this.stopping) return;
    if (message.t === "open") {
      const previous = this.clients.get(message.clientId); if (previous) this.terminals?.detach(previous);
      const client: Client = { id: message.clientId, rejected: false, send: async (frame) => {
        if (this.clients.get(client.id) === client && !client.rejected) await this.send({ t: "frame", clientId: client.id, frame });
      } };
      this.clients.set(client.id, client);
      await this.configuring;
      if (!this.scope || !this.online || this.disposed || this.stopping || this.clients.get(client.id) !== client) return;
      await client.send(this.readyFrame());
      return;
    }
    const client = this.clients.get(message.clientId);
    if (!client || client.rejected) return;
    await this.configuring;
    if (!this.scope || !this.online || this.disposed || this.stopping || this.clients.get(client.id) !== client) return;
    const frame = safeParseClientBridgeMessage(message.frame);
    if (!frame) return;
    if (frame.type === "CONNECTED") {
      const version = frame.protocolVersion ?? PROTOCOL_VERSION;
      if (version < MIN_SUPPORTED_PROTOCOL || version > PROTOCOL_VERSION) {
        await client.send(createMessage({ type: "CONNECTION_REJECTED", source: "engine", reason: version < MIN_SUPPORTED_PROTOCOL ? "protocol-too-old" : "protocol-too-new",
          message: "The app and worker use different protocol versions. Update Zeros to reconnect.", engineProtocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL }));
        client.rejected = true;
      }
      return;
    }
    if (frame.type === "HEARTBEAT") return;
    if (frame.type.startsWith("AGENT_")) {
      if (frame.type !== "AGENT_LIST_AGENTS" && frame.type !== "AGENT_INIT_AGENT") await this.touchCheckout();
      return this.agents!.handle(client, frame);
    }
    if (frame.type.startsWith("PTY_")) {
      if (frame.type !== "PTY_LIST") await this.touchCheckout();
      return this.terminals!.handle(client, frame);
    }
    if (frame.type === "WORKSPACE_REQUEST") {
      const mutation = frame.op === "file.write" || frame.op === "workspace.prepareGithub" ||
        ["codeReview.create", "codeReview.reply", "codeReview.setResolved", "turns.reset", "turns.undoReset", "messages.truncateFrom"].includes(frame.op) || isGitMutation(frame.op, frame.params ?? {});
      let activeMutation = false;
      try {
        if (mutation || frame.op === "attachment.write") await this.touchCheckout();
        if (mutation) {
          this.activeMutations++;
          activeMutation = true;
          this.lastMutationAt = Date.now();
          await this.reportIdle();
        }
        const service = /^(chats|messages|turns)\./.test(frame.op) ? this.chats! : this.workspace!;
        const result = await service.handle(frame.op, frame.params ?? {});
        if (frame.op === "attachment.write") await this.reportIdle();
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result }));
      } catch (error) {
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op,
          code: error instanceof WorkspaceError || error instanceof CodeReviewError ? error.code : "WORKSPACE_ERROR",
          message: error instanceof WorkspaceError || error instanceof CodeReviewError ? error.message : "The workspace request could not be completed." }));
      } finally {
        if (activeMutation) {
          this.activeMutations--;
          this.lastMutationAt = Date.now();
        }
      }
    }
  }

  private async configure(config: WorkerConfig): Promise<void> {
    if (this.disposed || (!this.scope && this.stopping)) return;
    const started = performance.now(), initial = !this.scope;
    const reviewAvailable = this.configuredReviewAvailable;
    const timing = this.options.transport.reportTiming?.bind(this.options.transport);
    const revision = BigInt(config.loginRevision);
    if (this.acceptedConfigurationRevision !== undefined && revision < this.acceptedConfigurationRevision) return;
    const identity = configurationIdentity(config), disconnects = this.disconnects;
    // Repeating checkout, MCP and review setup would hold every waiting open.
    if (this.scope && !this.stopping && identity === this.appliedConfiguration) { this.agents!.configure(config); return; }
    this.appliedConfiguration = undefined;
    this.githubUserTokensEnabled = config.githubUserTokens === 1;
    if (this.options.workspaceId && config.workspace.id !== this.options.workspaceId) throw new Error("Workspace identity changed.");
    const scope = new WorkspaceScope(config.workspace);
    if (this.scope && (this.scope.key !== scope.key || this.scope.root !== scope.root || this.scope.workspace.repository !== scope.workspace.repository)) throw new Error("Workspace identity changed.");
    if (this.scope && this.environmentVersion !== config.environment?.versionId) throw new EnvironmentSeedError("cloud_environment_pin_changed");
    if (this.reviews && !this.stopping) this.reviews.validateConfiguration(config.codeReview);
    this.acceptedConfigurationRevision = revision;
    if (this.reviews && !this.stopping && this.agents!.fenceReviewConfiguration(config.codeReview)) {
      this.reviews.suspend();
      this.workspaceMcp.revoke();
    }
    this.historyReplacementEnabled = config.historyReplacement === 1;
    if (this.configurationRevision !== revision) { this.tokens.invalidate(); this.githubCredentials.invalidate(); }
    await configureGitIdentity(this.options.homeDirectory ?? homedir(), config.gitIdentity);
    if (!this.scope) {
      if (!await this.initialize(scope, config, timing)) return;
    } else {
      await measureStartup("worker_reconfigure_workspace", () => this.workspace!.configure(config.workspace), timing);
      await measureStartup("worker_reconfigure_mcp", () => this.mcp!.configure(config.mcpServers ?? [], config.loginRevision), timing);
      if (!this.stopping) await this.reviews!.configure(config.codeReview);
      if (!this.reviews!.enabled) this.workspaceMcp.revoke();
      this.agents!.configure(config);
    }
    if (this.disposed) return;
    if (this.stopping) {
      // Stop can need refreshed credentials to finish its final mirror receipt.
      this.history!.connect();
      this.configurationRevision = revision;
      return;
    }
    await measureStartup("worker_reconfigure_ready", async () => { await this.options.transport.readyRuntime?.(); }, initial ? undefined : timing);
    if (this.disposed || this.stopping) return;
    this.options.runtimeResume?.ready?.();
    this.runtimePublished = true;
    this.history!.connect();
    if (config.promptOutbox === 1 && this.options.transport.promptRequest) {
      this.promptInbox ??= new PromptInbox(this.store!, this.agents!, async (op, body, signal) => {
        const reply = await this.options.transport.promptRequest!(op, body, signal);
        // The HTTP inbox bypasses app bridge dispatch. Fence it before the
        // inbox can materialize attachments or open a native driver.
        if (op === "pull") {
          const batch = CloudV2PromptPullReplySchema.safeParse(reply);
          if (batch.success && batch.data.prompts.length) await this.touchCheckout();
        }
        return reply;
      });
      this.promptInbox.start();
    } else if (this.promptInbox) { await this.promptInbox.dispose(); this.promptInbox = undefined; }
    this.configurationRevision = revision;
    if (config.runtimeUpdate === 1 && this.options.transport.runtimeUpdate && this.options.runtimePermit && !this.runtimeUpdater) {
      this.runtimeUpdater = new RuntimeUpdate({ gate: this.runtimeGate, permit: this.options.runtimePermit, instanceId: this.instanceId,
        revision: () => this.configurationRevision?.toString(), request: this.options.transport.runtimeUpdate.bind(this.options.transport),
        flush: async () => {
          await this.flushServices();
          if (!await this.history!.flush()) throw new Error("History mirror is unavailable.");
        } });
      this.runtimeUpdater.start();
    }
    if (!initial && reviewAvailable !== this.reviews?.enabled) await this.broadcast(this.readyFrame());
    this.configuredReviewAvailable = this.reviews?.enabled === true;
    if (disconnects === this.disconnects) this.appliedConfiguration = identity;
    await this.reportIdle(true);
    if (initial) recordStartupTiming("worker_configure", started, timing);
    else recordStartupTiming("worker_reconfigure", started, timing);
  }

  private async initialize(scope: WorkspaceScope, config: WorkerConfig, timing?: StartupTimingObserver): Promise<boolean> {
    if (this.disposed || this.stopping) return false;
    let refresh: CheckoutRefresh | undefined, store: SessionStore | undefined, workspace: WorkspaceService | undefined;
    let mcp: McpGateway | undefined, agents: Agents | undefined, terminals: Terminals | undefined, history: HistoryMirror | undefined, setup: WorkspaceSetup | undefined;
    let reviews: WorkerCodeReview | undefined;
    const unsubscribers: Array<() => void> = [];
    let published = false;
    try {
      await this.github.start();
      if (this.disposed || this.stopping) return false;
      const checkout = await measureStartup("worker_checkout", () => this.options.runtimeResume ? Promise.resolve(undefined)
        : (this.options.prepareCheckout ?? prepareCheckout)(config.workspace, this.gitEnvironment, timing), timing)
        .catch(async error => {
          await this.options.transport.reportCheckoutFailure?.().catch(() => {});
          throw error;
        });
      refresh = checkout?.refresh;
      this.initialSetupNeeded ||= checkout?.createdBranch === true;
      if (this.disposed || this.stopping) return false;
      if (config.environment && !this.options.transport.reportEnvironment) throw new EnvironmentSeedError("cloud_environment_runtime_required");
      try { await seedEnvironment(scope, this.options.directory, config.environment, this.environmentLifetime.signal); }
      catch (error) {
        if (error instanceof EnvironmentSeedError && config.environment && !this.environmentLifetime.signal.aborted)
          await this.options.transport.reportEnvironment?.({ versionId: config.environment.versionId, sequence: 1, state: "failed", errorCode: error.code }, this.environmentLifetime.signal);
        throw error;
      }
      if (this.disposed || this.stopping) return false;
      const application = new ApplicationEnvironment(config.environment && { variables: config.environment.variables, files: config.environment.files });
      const restoreMarker = join(this.options.directory, "restored-from-checkpoint");
      const restored = await access(restoreMarker).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      store = await measureStartup("worker_session_store", () => SessionStore.open(join(this.options.directory, "sessions"), scope.key), timing);
      const servicesStarted = performance.now();
      // Earlier worker snapshots stored a cloud key in chat metadata. Native
      // bridge rows must round-trip through the renderer's existing mapper.
      for (const chat of store.list().chats) if (chat.folder !== scope.folder(chat.folder)) await store.upsert({ ...chat, folder: scope.root });
      if (this.disposed || this.stopping) return false;
      const run = this.options.workspaceServices?.run ?? commandRunner(scope.root, this.gitEnvironment);
      reviews = new WorkerCodeReview(scope, this.options.directory, () => {
        if (this.reviews !== reviews) return;
        this.lastMutationAt = Date.now(); void this.reportIdle();
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["codeReview"], workspaceIds: [scope.workspace.id] }));
      });
      await measureStartup("worker_services_review", () => reviews!.configure(config.codeReview), timing);
      if (this.disposed || this.stopping) return false;
      workspace = await measureStartup("worker_services_workspace", () => WorkspaceService.open(scope, this.options.directory, {
        historyDiff: params => agents!.turns.historyDiff(params),
        ...this.options.workspaceServices,
        codeReview: reviews,
        pollingAllowed: () => this.runtimeGate.open && (!this.options.runtimeResume || this.runtimePublished),
        activity: () => this.runtimeGate.activity(),
        ...(config.githubPullRequests === 1 && this.options.transport.reportGithubCheckout
          ? { reportGithubCheckout: this.options.transport.reportGithubCheckout.bind(this.options.transport) } : {}),
        nextCheckoutSequence: () => ++this.checkoutSequence,
        run: async (program, args, options) => {
          if (options?.readOnly !== true) { await refresh?.touch(); this.assertCheckoutActive(); }
          return run(program, args, options);
        },
        publish: (frame) => { if (workspace && this.workspace === workspace) void this.broadcast(frame); },
      }), timing);
      if (this.disposed || this.stopping) return false;
      mcp = new McpGateway({ workspaceRoot: scope.root, authorization: this.options.transport.mcpAuthorization?.bind(this.options.transport), admit: async () => this.runtimeGate.admit(),
        onFailure: (executionId, failure) => agents?.mcpFailure(executionId, failure) });
      await measureStartup("worker_services_mcp", () => mcp!.configure(config.mcpServers ?? [], config.loginRevision), timing);
      if (this.disposed || this.stopping) return false;
      agents = new Agents(store, scope, this.options.drivers ?? {
        codex: () => new CodexDriver({ gitEnvironment: this.gitEnvironment }), claude: () => new ClaudeDriver({ gitEnvironment: this.gitEnvironment }),
        cursor: () => new CursorDriver({ gitEnvironment: this.gitEnvironment }),
      }, config,
        (frame) => this.broadcast(frame), () => { this.runtimeGate.activity(); void this.reportIdle(); }, this.options.onTiming, this.options.modelDiscovery, executionId => mcp!.providers(executionId),
        async input => reviews!.enabled ? this.workspaceMcp.admit(input.executionId, reviews!.tools(input)) : undefined, application, !!this.options.runtimeResume);
      terminals = new Terminals(scope, { gitEnvironment: this.gitEnvironment, applicationEnvironment: application.variables,
        broadcast: frame => this.broadcast(frame), activity: () => { this.runtimeGate.activity(); void this.reportIdle(); } });
      const chats = new ChatService(store, scope, (chatId) => agents!.closeChat(chatId), agents.turns, {
        historyReplacement: () => this.historyReplacementEnabled,
        mutate: agents.mutateChat.bind(agents),
        files: action => workspace!.git.mutate(action),
      });
      history = new HistoryMirror(store, this.options.transport, () => this.historyReplacementEnabled, value => application.value(value));
      unsubscribers.push(store.onChange((change) => {
        this.runtimeGate.activity();
        if (!change.chat && !change.deleted && !change.rows.length && !change.replace) return;
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: [...(change.chat || change.deleted ? ["chats"] : []), ...(change.rows.length || change.replace ? ["messages"] : []), ...(change.replace ? ["conversationContext"] : []), ...(change.deleted ? ["workspaces"] : [])],
          ...(change.deleted ? { workspaceIds: [scope.workspace.id] } : {}),
          ...(change.rows.length || change.replace ? { chatIds: [change.chatId] } : {}) }));
      }), store.onError((chatId) => {
        this.options.onError?.("storage"); void agents!.closeChat(chatId).catch(() => {});
      }));
      setup = new WorkspaceSetup({ directory: this.options.directory, workspace: config.workspace, gitEnvironment: this.gitEnvironment, application,
        signal: this.environmentLifetime.signal,
        runner: this.options.setupRunner, activity: () => { void this.reportIdle(); }, onStorageError: () => this.options.onError?.("storage"),
        beforeRun: async () => {
          if (refresh?.mayFastForward) await refreshing;
          await refresh?.touch();
        },
        onAdmitted: async () => { this.initialSetupNeeded = false; await rm(restoreMarker, { force: true }).catch(() => {}); },
      });
      if (config.environment) await this.options.transport.reportEnvironment!({ versionId: config.environment.versionId, sequence: 1, state: "ready" }, this.environmentLifetime.signal);
      if (this.disposed || this.stopping) return false;
      this.environmentVersion = config.environment?.versionId;
      this.store = store; this.workspace = workspace; this.mcp = mcp; this.agents = agents; this.reviews = reviews;
      this.terminals = terminals; this.chats = chats; this.history = history; this.setup = setup; this.checkoutRefresh = refresh;
      this.unsubscribers.push(...unsubscribers); this.scope = scope; published = true;
      recordStartupTiming("worker_services", servicesStarted, timing);
      const refreshing = refresh?.start();
      if (!this.options.runtimeResume) setup.start(this.initialSetupNeeded || restored);
      return true;
    } finally {
      if (!published) {
        for (const unsubscribe of unsubscribers) unsubscribe();
        const closed = await Promise.allSettled([setup?.dispose(), refresh?.dispose(), terminals?.dispose(), workspace?.dispose(),
          agents?.dispose(), mcp?.dispose(), store?.flush(), history?.dispose(), Promise.resolve().then(() => reviews?.close())]);
        if (closed.some(result => result.status === "rejected")) this.options.onError?.("storage");
      }
    }
  }

  private broadcast(frame: BridgeMessage): Promise<void> { return this.send({ t: "frame", clientId: "*", frame }).then(() => {}); }
  private readyFrame(): BridgeMessage {
    return createMessage({ type: "ENGINE_READY", source: "engine", version: "0.0.0", root: "", framework: "cloud", port: 0,
      protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL, instanceId: this.instanceId,
      ...(this.reviews?.enabled ? { capabilities: ["code-review-v1"] } : {}) });
  }
  private async touchCheckout(): Promise<void> {
    await this.checkoutRefresh?.touch();
    this.assertCheckoutActive();
  }
  private assertCheckoutActive(): void {
    if (this.disposed || this.stopping) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.");
  }
  private async stopCheckout(): Promise<void> {
    // Abort setup before releasing its refresh wait; otherwise it could launch
    // as refresh cancellation finishes, while Stop is already checkpointing.
    const setup = this.setup?.dispose();
    await this.checkoutRefresh?.dispose();
    await setup;
  }
  private async prepareStop(): Promise<void> {
    clearInterval(this.heartbeat);
    const workspaceTools = this.workspaceMcp.dispose();
    // A delivery waiting behind a mutation can hold inbox/configuration drain.
    // Retire native inputs before either wait permits a late approval.
    const agentsClosing = this.agents?.dispose();
    this.environmentLifetime.abort();
    void agentsClosing?.catch(() => {});
    await this.configuring.catch(() => {});
    await this.stopCheckout();
    await this.workspace?.stopAttachmentTransfers();
    await this.promptInbox?.dispose();
    await agentsClosing;
    await this.terminals?.dispose();
    await this.mcp?.dispose();
    await workspaceTools;
    this.reviews?.close();
  }
  private async send(frame: CloudV2WorkerFrame, timeoutMs?: number): Promise<boolean> {
    if (!this.online) return false;
    try { return await this.options.transport.send(frame, timeoutMs === undefined ? undefined : { timeoutMs }); }
    catch { this.options.onError?.("transport"); return false; }
  }
  private get busy(): boolean {
    return Boolean(this.agents?.busy || this.terminals?.busy || this.setup?.busy || this.workspace?.uploading ||
      this.activeMutations || Date.now() - this.lastMutationAt < RECENT_ACTIVITY_MS);
  }
  get runtimeCensus(): RuntimeCensus {
    return {
      clients: this.clients.size > 0,
      requests: this.activeMutations > 0,
      agents: this.agents?.runtimeBusy ?? null,
      terminals: this.terminals?.runtimeBusy ?? null,
      setup: this.setup?.busy ?? null,
      checkout: this.checkoutRefresh ? this.checkoutRefresh.runtimeBusy ?? null : false,
      configuration: !this.scope || !this.online || this.configurations > 0 || this.disposed || !!this.stopping ||
        this.acceptedConfigurationRevision !== this.configurationRevision,
      prompts: this.promptInbox?.runtimeBusy ?? false,
      attachments: this.workspace?.uploading ?? null,
      storage: this.store && this.history ? this.store.runtimeBusy || this.history.runtimeBusy : null,
      tools: this.mcp ? this.mcp.runtimeBusy || this.workspaceMcp.runtimeBusy : null,
    };
  }
  private async reportIdle(force = false): Promise<void> {
    if (!this.online || !this.agents) return;
    const idle = !this.busy;
    if (force || this.idle !== idle) {
      if (idle) {
        try { await this.store?.flush(); await this.history?.flush(); }
        catch { this.options.onError?.("storage"); return; }
        // New work may have arrived while persistence was draining.
        if (!this.online || this.busy) return;
      }
      this.idle = idle; await this.send({ t: "idle", idle });
    }
  }
}
