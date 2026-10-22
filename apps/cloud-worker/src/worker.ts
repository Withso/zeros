import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudV2ControlFrameSchema, CLOUD_V2_RELAY_PROTOCOL, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
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
import { prepareCheckout } from "./workspace/checkout";
import { WorkspaceError, WorkspaceScope, type WorkerConfig } from "./workspace/scope";
import { WorkspaceService, type WorkspaceServiceOptions } from "./workspace/service";
import { GithubBroker, GithubTokens, githubEnvironment } from "./credentials/github";
import { commandRunner } from "./workspace/commands";
import { Terminals } from "./terminals/service";
import type { ModelDiscoveryOptions } from "./credentials/model-availability";

interface WorkerOptions {
  directory: string;
  workspaceId?: string;
  transport: Transport;
  drivers?: DriverFactories;
  prepareCheckout?: (workspace: WorkerConfig["workspace"], gitEnvironment: NodeJS.ProcessEnv) => Promise<void>;
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
  private readonly clients = new Map<string, Client>();
  private scope?: WorkspaceScope;
  private store?: SessionStore;
  private agents?: Agents;
  private chats?: ChatService;
  private history?: HistoryMirror;
  private workspace?: WorkspaceService;
  private terminals?: Terminals;
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
    this.heartbeat = setInterval(() => { void this.reportIdle(Boolean(this.agents?.busy || this.terminals?.busy)); }, 55_000);
    this.heartbeat.unref?.();
    this.options.transport.start({
      open: async () => {
        if (this.disposed) return;
        this.online = true; this.idle = undefined; this.tokens.connect();
        await this.send({ t: "hello", protocol: CLOUD_V2_RELAY_PROTOCOL, workerVersion: "0.0.0",
          capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] } });
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
    await this.terminals?.dispose();
    await this.workspace?.dispose();
    await this.agents?.dispose();
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
        protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL }));
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
    if (frame.type.startsWith("AGENT_")) return this.agents!.handle(client, frame);
    if (frame.type.startsWith("PTY_")) return this.terminals!.handle(client, frame);
    if (frame.type === "WORKSPACE_REQUEST") {
      try {
        const service = /^(chats|messages|turns)\./.test(frame.op) ? this.chats! : this.workspace!;
        const result = await service.handle(frame.op, frame.params ?? {});
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result }));
      } catch (error) {
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op,
          code: error instanceof WorkspaceError ? error.code : "WORKSPACE_ERROR", message: error instanceof WorkspaceError ? error.message : "The workspace request could not be completed." }));
      }
    }
  }

  private async configure(config: WorkerConfig): Promise<void> {
    const revision = BigInt(config.loginRevision);
    if (this.configurationRevision !== undefined && revision < this.configurationRevision) return;
    if (this.options.workspaceId && config.workspace.id !== this.options.workspaceId) throw new Error("Workspace identity changed.");
    const scope = new WorkspaceScope(config.workspace);
    if (this.scope && (this.scope.key !== scope.key || this.scope.root !== scope.root || this.scope.workspace.repository !== scope.workspace.repository)) throw new Error("Workspace identity changed.");
    if (!this.scope) {
      await this.github.start(); this.tokens.invalidate();
      await (this.options.prepareCheckout ?? prepareCheckout)(config.workspace, this.gitEnvironment);
      const store = await SessionStore.open(join(this.options.directory, "sessions"), scope.key);
      // Earlier worker snapshots stored a cloud key in chat metadata. Native
      // bridge rows must round-trip through the renderer's existing mapper.
      for (const chat of store.list().chats) if (chat.folder !== scope.folder(chat.folder)) await store.upsert({ ...chat, folder: scope.root });
      this.workspace = await WorkspaceService.open(scope, this.options.directory, {
        run: commandRunner(scope.root, this.gitEnvironment), ...this.options.workspaceServices, publish: (frame) => { void this.broadcast(frame); },
      });
      this.scope = scope; this.store = store;
      this.agents = new Agents(store, scope, this.options.drivers ?? {
        codex: () => new CodexDriver({ gitEnvironment: this.gitEnvironment }), claude: () => new ClaudeDriver({ gitEnvironment: this.gitEnvironment }),
        cursor: () => new CursorDriver({ gitEnvironment: this.gitEnvironment }),
      }, config,
        (frame) => this.broadcast(frame), () => { void this.reportIdle(); }, this.options.onTiming, this.options.modelDiscovery);
      this.terminals = new Terminals(scope, { gitEnvironment: this.gitEnvironment, broadcast: frame => this.broadcast(frame), activity: () => { void this.reportIdle(); } });
      this.chats = new ChatService(store, scope, (chatId) => this.agents!.closeChat(chatId));
      this.history = new HistoryMirror(store, this.options.transport);
      this.unsubscribers.push(store.onChange((change) => {
        if (!change.chat && !change.deleted && !change.rows.length) return;
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: [...(change.chat || change.deleted ? ["chats"] : []), ...(change.rows.length ? ["messages"] : [])],
          ...(change.rows.length ? { chatIds: [change.chatId] } : {}) }));
      }), store.onError((chatId) => {
        this.options.onError?.("storage"); void this.agents!.closeChat(chatId).catch(() => {});
      }));
    } else { this.tokens.invalidate(); await this.workspace!.configure(config.workspace); this.agents!.configure(config); }
    this.history!.connect();
    this.configurationRevision = revision;
    await this.reportIdle(true);
  }

  private broadcast(frame: BridgeMessage): Promise<void> { return this.send({ t: "frame", clientId: "*", frame }).then(() => {}); }
  private async prepareStop(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.configuring;
    await this.agents?.dispose();
    await this.terminals?.dispose();
  }
  private async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (!this.online) return false;
    try { return await this.options.transport.send(frame); }
    catch { this.options.onError?.("transport"); return false; }
  }
  private async reportIdle(force = false): Promise<void> {
    if (!this.online || !this.agents) return;
    const idle = !this.agents.busy && !this.terminals?.busy;
    if (force || this.idle !== idle) {
      if (idle) {
        try { await this.store?.flush(); await this.history?.flush(); }
        catch { this.options.onError?.("storage"); return; }
        // A new prompt may have arrived while persistence was draining.
        if (!this.online || this.agents.busy || this.terminals?.busy) return;
      }
      this.idle = idle; await this.send({ t: "idle", idle });
    }
  }
}
