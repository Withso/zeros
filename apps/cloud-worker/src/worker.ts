import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudV2ControlFrameSchema, CLOUD_V2_RELAY_PROTOCOL, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptPullReplySchema } from "@zeros/protocol/cloud-v2-prompts";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { safeParseClientBridgeMessage } from "@zeros/protocol/schemas";
import { MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION } from "@zeros/protocol/version";
import { Agents, type AppClient, type DriverFactories } from "./agents";
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
import { GithubBroker, GithubTokens, githubEnvironment } from "./credentials/github";
import { commandRunner } from "./workspace/commands";
import { Terminals } from "./terminals/service";
import type { ModelDiscoveryOptions } from "./credentials/model-availability";
import { PromptInbox } from "./prompt-inbox";
import { McpGateway } from "./mcp/gateway";
import { measureStartup, recordStartupTiming, type StartupTimingObserver } from "./startup-timings";

interface WorkerOptions {
  directory: string;
  workspaceId?: string;
  transport: Transport;
  drivers?: DriverFactories;
  prepareCheckout?: (workspace: WorkerConfig["workspace"], gitEnvironment: NodeJS.ProcessEnv, timing?: StartupTimingObserver) => Promise<CheckoutResult | void>;
  setupRunner?: SetupRunner;
  gitAskpassPath?: string;
  workspaceServices?: WorkspaceServiceOptions;
  onError?: (code: "configuration" | "storage" | "transport") => void;
  onTiming?: TimingObserver;
  modelDiscovery?: ModelDiscoveryOptions;
}
interface Client extends AppClient { rejected: boolean }

/** One VM, one checkout, many app sockets. The relay is a carrier for ordinary
 * bridge frames; this process owns validation, agent work and durable history. */
export class CloudWorker {
  /** Changes with every process, so the app can tell a restart (its shells are gone) from a reconnect. */
  private readonly instanceId = randomUUID();
  private readonly clients = new Map<string, Client>();
  private scope?: WorkspaceScope;
  private store?: SessionStore;
  private agents?: Agents;
  private mcp?: McpGateway;
  private chats?: ChatService;
  private history?: HistoryMirror;
  private promptInbox?: PromptInbox;
  private workspace?: WorkspaceService;
  private terminals?: Terminals;
  private setup?: WorkspaceSetup;
  private checkoutRefresh?: CheckoutRefresh;
  private readonly tokens: GithubTokens;
  private readonly github: GithubBroker;
  private readonly gitEnvironment: NodeJS.ProcessEnv;
  private configuring: Promise<void> = Promise.resolve();
  private online = false;
  private disposed = false;
  private started = false;
  private stopping?: Promise<void>;
  private configurationRevision?: bigint;
  private idle?: boolean;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly options: WorkerOptions) {
    this.tokens = new GithubTokens(frame => this.send(frame));
    this.github = new GithubBroker(join(options.directory, "github.sock"), () => this.tokens.get(), () => this.workspace?.githubChanged());
    this.gitEnvironment = githubEnvironment(this.github.socketPath, options.gitAskpassPath ?? fileURLToPath(new URL("../bin/git-askpass", import.meta.url)));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.heartbeat = setInterval(() => { void this.reportIdle(Boolean(this.agents?.busy || this.terminals?.busy || this.setup?.busy || this.workspace?.uploading)); }, 55_000);
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
        this.online = false;
        for (const client of this.clients.values()) this.terminals?.detach(client);
        this.clients.clear(); this.history?.disconnect(); this.tokens.disconnect();
      },
    });
  }

  async flush(): Promise<void> {
    await this.configuring;
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
    this.disposed = true; clearInterval(this.heartbeat); this.tokens.disconnect();
    await this.configuring.catch(() => {});
    await this.stopCheckout();
    await this.promptInbox?.dispose();
    await this.terminals?.dispose();
    await this.workspace?.dispose();
    await this.agents?.dispose();
    await this.mcp?.dispose();
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
      // The VM can stop only after the native turn's final rows reach the HTTP
      // mirror. Keep the transport alive until this correlated ack is sent.
      this.stopping ??= this.prepareStop();
      await this.stopping;
      // A lost HTTPS response may need a retry after quiescing. Do not cache a
      // mirror failure in the promise that prevents new work from starting.
      await this.flush();
      if (this.history && !await this.history.flush()) throw new Error("History mirror is unavailable.");
      await this.send({ t: "stop-ack", id: message.id });
      return;
    }
    if (message.t === "close") {
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
      if (!this.scope || !this.online || this.clients.get(client.id) !== client) return;
      await client.send(createMessage({ type: "ENGINE_READY", source: "engine", version: "0.0.0", root: "", framework: "cloud", port: 0,
        protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL, instanceId: this.instanceId }));
      return;
    }
    const client = this.clients.get(message.clientId);
    if (!client || client.rejected) return;
    await this.configuring;
    if (!this.scope || !this.online || this.clients.get(client.id) !== client) return;
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
      try {
        // Target changes write metadata without going through the Git runner.
        if (frame.op === "file.write" || frame.op === "git.changeTarget" || frame.op === "attachment.write") await this.touchCheckout();
        const service = /^(chats|messages|turns)\./.test(frame.op) ? this.chats! : this.workspace!;
        const result = await service.handle(frame.op, frame.params ?? {});
        if (frame.op === "attachment.write") await this.reportIdle();
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result }));
      } catch (error) {
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op,
          code: error instanceof WorkspaceError ? error.code : "WORKSPACE_ERROR", message: error instanceof WorkspaceError ? error.message : "The workspace request could not be completed." }));
      }
    }
  }

  private async configure(config: WorkerConfig): Promise<void> {
    const started = performance.now(), initial = !this.scope;
    const timing = this.options.transport.reportTiming?.bind(this.options.transport);
    const revision = BigInt(config.loginRevision);
    if (this.configurationRevision !== undefined && revision < this.configurationRevision) return;
    if (this.options.workspaceId && config.workspace.id !== this.options.workspaceId) throw new Error("Workspace identity changed.");
    const scope = new WorkspaceScope(config.workspace);
    if (this.scope && (this.scope.key !== scope.key || this.scope.root !== scope.root || this.scope.workspace.repository !== scope.workspace.repository)) throw new Error("Workspace identity changed.");
    if (!this.scope) {
      await this.github.start(); this.tokens.invalidate();
      const checkout = await measureStartup("worker_checkout", () => (this.options.prepareCheckout ?? prepareCheckout)(config.workspace, this.gitEnvironment, timing), timing);
      this.checkoutRefresh = checkout?.refresh;
      const restoreMarker = join(this.options.directory, "restored-from-checkpoint");
      const restored = await access(restoreMarker).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      const store = await measureStartup("worker_session_store", () => SessionStore.open(join(this.options.directory, "sessions"), scope.key), timing);
      const servicesStarted = performance.now();
      // Earlier worker snapshots stored a cloud key in chat metadata. Native
      // bridge rows must round-trip through the renderer's existing mapper.
      for (const chat of store.list().chats) if (chat.folder !== scope.folder(chat.folder)) await store.upsert({ ...chat, folder: scope.root });
      const run = this.options.workspaceServices?.run ?? commandRunner(scope.root, this.gitEnvironment);
      this.workspace = await WorkspaceService.open(scope, this.options.directory, {
        historyDiff: params => this.agents!.turns.historyDiff(params),
        ...this.options.workspaceServices,
        run: async (program, args, options) => {
          if (options?.readOnly !== true) await this.touchCheckout();
          return run(program, args, options);
        },
        publish: (frame) => { void this.broadcast(frame); },
      });
      this.scope = scope; this.store = store;
      this.mcp = new McpGateway({ workspaceRoot: scope.root, authorization: this.options.transport.mcpAuthorization?.bind(this.options.transport) });
      await this.mcp.configure(config.mcpServers ?? [], config.loginRevision);
      this.agents = new Agents(store, scope, this.options.drivers ?? {
        codex: () => new CodexDriver({ gitEnvironment: this.gitEnvironment }), claude: () => new ClaudeDriver({ gitEnvironment: this.gitEnvironment }),
        cursor: () => new CursorDriver({ gitEnvironment: this.gitEnvironment }),
      }, config,
        (frame) => this.broadcast(frame), () => { void this.reportIdle(); }, this.options.onTiming, this.options.modelDiscovery, () => this.mcp!.providers());
      this.terminals = new Terminals(scope, { gitEnvironment: this.gitEnvironment, broadcast: frame => this.broadcast(frame), activity: () => { void this.reportIdle(); } });
      this.chats = new ChatService(store, scope, (chatId) => this.agents!.closeChat(chatId), this.agents.turns);
      this.history = new HistoryMirror(store, this.options.transport);
      this.unsubscribers.push(store.onChange((change) => {
        if (!change.chat && !change.deleted && !change.rows.length) return;
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: [...(change.chat || change.deleted ? ["chats"] : []), ...(change.rows.length ? ["messages"] : []), ...(change.deleted ? ["workspaces"] : [])],
          ...(change.deleted ? { workspaceIds: [scope.workspace.id] } : {}),
          ...(change.rows.length ? { chatIds: [change.chatId] } : {}) }));
      }), store.onError((chatId) => {
        this.options.onError?.("storage"); void this.agents!.closeChat(chatId).catch(() => {});
      }));
      recordStartupTiming("worker_services", servicesStarted, timing);
      const refresh = this.checkoutRefresh, refreshing = refresh?.start();
      this.setup = new WorkspaceSetup({ directory: this.options.directory, workspace: config.workspace, gitEnvironment: this.gitEnvironment,
        runner: this.options.setupRunner, activity: () => { void this.reportIdle(); }, onStorageError: () => this.options.onError?.("storage"),
        beforeRun: async () => {
          if (refresh?.mayFastForward) await refreshing;
          await refresh?.touch();
        },
        onAdmitted: () => rm(restoreMarker, { force: true }).catch(() => {}),
      });
      this.setup.start(checkout?.createdBranch === true || restored);
    } else { this.tokens.invalidate(); await this.workspace!.configure(config.workspace); await this.mcp!.configure(config.mcpServers ?? [], config.loginRevision); this.agents!.configure(config); }
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
    await this.reportIdle(true);
    if (initial) recordStartupTiming("worker_configure", started, timing);
  }

  private broadcast(frame: BridgeMessage): Promise<void> { return this.send({ t: "frame", clientId: "*", frame }).then(() => {}); }
  private async touchCheckout(): Promise<void> {
    await this.checkoutRefresh?.touch();
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
    await this.configuring;
    await this.stopCheckout();
    await this.workspace?.stopAttachmentTransfers();
    await this.promptInbox?.dispose();
    await this.agents?.dispose();
    await this.terminals?.dispose();
    await this.mcp?.dispose();
  }
  private async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (!this.online) return false;
    try { return await this.options.transport.send(frame); }
    catch { this.options.onError?.("transport"); return false; }
  }
  private async reportIdle(force = false): Promise<void> {
    if (!this.online || !this.agents) return;
    const idle = !this.agents.busy && !this.terminals?.busy && !this.setup?.busy && !this.workspace?.uploading;
    if (force || this.idle !== idle) {
      if (idle) {
        try { await this.store?.flush(); await this.history?.flush(); }
        catch { this.options.onError?.("storage"); return; }
        // A new prompt may have arrived while persistence was draining.
        if (!this.online || this.agents.busy || this.terminals?.busy || this.setup?.busy || this.workspace?.uploading) return;
      }
      this.idle = idle; await this.send({ t: "idle", idle });
    }
  }
}
