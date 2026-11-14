import { createHash, randomUUID } from "node:crypto";
import { access, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CloudV2ClientOperationSchema, CloudV2ControlFrameSchema, type CloudV2BootCleanRefusal, type CloudV2ClientLease, CLOUD_V2_RELAY_PROTOCOL, CLOUD_WORKSPACE_RESOURCES_CAPABILITY, CLOUD_WORKSPACE_RESOURCES_PUSH_MS, CLOUD_WORKSPACE_RESOURCES_WATCH_CAPABILITY, PUSH_SIGNALS_REPORT_MS, type CloudV2ControlFrame, type CloudV2SetupStatus, type CloudV2WorkerFrame, type RuntimeMcpServer } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptPullReplySchema } from "@zeros/protocol/cloud-v2-prompts";
import { createMessage, type BridgeMessage, type ClientOperationFailure } from "@zeros/protocol/messages";
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
import { WorkspaceSetup, readSetupOutput, type SetupRunner } from "./workspace/setup";
import { NotifyUserService } from "./notify-user/service";
import { SyncService } from "./workspace/sync-service";
import { SyncTransferActivity } from "./workspace/sync-activity";
import { SYNC_CAPABILITY, SYNC_HINT_KIND, SYNC_BATCH_CAPABILITY, SYNC_HAVE_V2_CAPABILITY, SYNC_TRANSFER_OPS } from "@zeros/protocol/workspace-sync";
import { WorkspaceError, WorkspaceScope, type WorkerConfig } from "./workspace/scope";
import { WorkspaceService, type WorkspaceServiceOptions } from "./workspace/service";
import { isGitMutation } from "./workspace/git";
import { GithubBroker, GithubTokens, githubEnvironment, type GithubToken } from "./credentials/github";
import { githubAuthenticationError } from "./credentials/github-failure";
import { GithubCredentialRecovery } from "./credentials/github-recovery";
import { configureGitIdentity } from "./credentials/git-identity";
import { commandRunner } from "./workspace/commands";
import { Terminals, type TerminalPeople } from "./terminals/service";
import { ClosedFailure, classOf, closedFailure, errorCode, failureLine, tagged } from "./sharing/closed-failure";
import { ContextCommitIdentities, reviewRequesterName } from "./sharing/identity";
import { PersonalEnvironments, unexportedLine } from "./sharing/personal-env";
import { GitCommandError } from "./workspace/commands";
import type { SweepSummary } from "./sharing/boot-clean";
import { operationEnvironment } from "./sharing/operation-environment";
import { retireContext } from "./sharing/retire";
import { removeLegacyMaterial } from "./sharing/legacy-material";
import type { ModelDiscoveryOptions } from "./credentials/model-availability";
import { PromptInbox } from "./prompt-inbox";
import { McpGateway } from "./mcp/gateway";
import { WorkspaceToolsMcp } from "./mcp/workspace-tools";
import { WorkspaceAgentTools } from "./mcp/agent-tools";
import { MemoryWatchdog, type KillReport } from "./resources/watchdog";
import { WorkerCodeReview } from "./workspace/code-review";
import { measureStartup, recordStartupTiming, type StartupTimingObserver } from "./startup-timings";
import { EnvironmentSeedError, seedEnvironment } from "./workspace/environment-seed";
import { ApplicationEnvironment } from "./credentials/application-environment";
import { WorkspaceApiEnvironment } from "./credentials/workspace-api";
import { RuntimeQuiescence, type RuntimeCensus } from "./runtime-quiescence";
import { RuntimeUpdate } from "./runtime-update";
import type { RuntimePermit } from "./runtime-permit";
import { ExecutionContexts } from "./sharing/execution-contexts";

interface WorkerOptions {
  directory: string;
  homeDirectory?: string;
  /** Team sharing §7a: this boot's pre-boot process sweep, returning what it could not end or prove. Only the
   * production entry supplies the real /proc sweep; without one an activated boot is unproven and acts for no one. */
  bootClean?: (note?: (refusal: CloudV2BootCleanRefusal) => void, summary?: (summary: SweepSummary) => void) => Promise<number>;
  /** One worker journal line per notable step (boot-clean's outcome); closed words and counts only. */
  log?(line: string): void;
  /** Where a legacy restore leaves its token directory (tests); /dev/shm otherwise. */
  sharedMemory?: string;
  /** Context renewal cadence override (tests); 10 s otherwise. */
  contextRenewMs?: number;
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
  /** R1: how often a watching client gets a pushed resources sample (tests shorten it). */
  resourcesPushMs?: number;
  onError?: (code: "configuration" | "storage" | "transport") => void;
  onTiming?: TimingObserver;
  /** Closed configuration paths only; never values or user-defined keys. */
  onReconfigure?: (changed: readonly string[]) => void;
  modelDiscovery?: ModelDiscoveryOptions;
  /** Production only: the directories the shipped runtime runs from. */
  memoryWatchdog?: { runtimeRoots: readonly string[] };
  /** Closed codes only. */
  onMemory?: (event: "memory_stopped" | "memory_pressure") => void;
  /** Worker journal lines for Sync to Mac: counts, sizes and durations; never a path. */
  onSync?: (line: string) => void;
}
/** passive (Order 3): a syncing Mac; never activity, never in the census, sync reads only. */
interface Client extends AppClient { rejected: boolean; passive?: boolean; device?: string; served?: number;
  /** Activated acting-user-v1: the control plane's person and client context for this connection. */
  userId?: string; contextId?: string;
  /** The control plane's own id for this client (inbound bridge): what its terminal and client leases name; id is the carrier's local routing id. */
  authorityId?: string }

const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
/** Digests per closed schema path. The control plane mints a new Codex proxy
 * token for every configuration it builds, so that token is not compared. */
function configurationSections(config: WorkerConfig): Map<string, string> {
  const { agents: { codex, ...agents }, workspace, ...rest } = config;
  const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
  const sections = new Map<string, string>();
  for (const [key, value] of Object.entries(rest)) sections.set(key, digest(value));
  for (const [key, value] of Object.entries(workspace)) sections.set(`workspace.${key}`, digest(value));
  for (const [key, value] of Object.entries(agents)) sections.set(`agents.${key}`, digest(value));
  if (codex) sections.set("agents.codex", digest({ baseUrl: codex.baseUrl }));
  return sections;
}
const changedSections = (previous: Map<string, string>, next: Map<string, string>): string[] =>
  [...new Set([...previous.keys(), ...next.keys()])].filter(key => previous.get(key) !== next.get(key)).sort();

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
  private sync?: SyncService;
  private readonly syncTransfers = new SyncTransferActivity();
  private terminals?: Terminals;
  private application?: ApplicationEnvironment;
  private watchdog?: MemoryWatchdog;
  private workspaceApi?: WorkspaceApiEnvironment;
  private setup?: WorkspaceSetup;
  private checkoutRefresh?: CheckoutRefresh;
  private initialSetupNeeded = false;
  private checkoutSequence = 0;
  private readonly tokens: GithubTokens;
  private readonly githubCredentials: GithubCredentialRecovery;
  private githubUserTokensEnabled = false;
  private historyReplacementEnabled = false;
  /** Read when a native execution's tools are admitted. */
  private localCommandsEnabled = false;
  private localCommandReason = false;
  private notifyUserEnabled = false;
  private notifyUserService?: NotifyUserService;
  private readonly github: GithubBroker;
  private readonly gitEnvironment: NodeJS.ProcessEnv;
  /** Team sharing slice B: the leased people this boot runs work as (in memory only). */
  private readonly contexts?: ExecutionContexts;
  private acting = false;
  private readonly personal: PersonalEnvironments;
  /** creator-commit-identity-v1: each context's Git include, following the current Creator rule. */
  private readonly commitIdentities: ContextCommitIdentities;
  private readonly identityEnds = new Set<string>();
  /** One GitHub credential flight per live context; it ends with its context. */
  private readonly contextGithub = new Map<string, { tokens: GithubTokens; recovery: GithubCredentialRecovery }>();
  /** A context's own MCP servers, behind its own gateway; closed when the context ends. */
  private readonly contextMcp = new Map<string, Promise<McpGateway>>();
  private configuring: Promise<void> = Promise.resolve();
  private appliedSections?: Map<string, string>;
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
    this.github = new GithubBroker(`/tmp/zeros-github-${this.instanceId}/github.sock`, (purpose, failed, contextId) => this.githubToken(purpose, failed, contextId), () => this.workspace?.githubChanged());
    this.gitEnvironment = githubEnvironment(this.github.socketPath, options.gitAskpassPath ?? fileURLToPath(new URL("../bin/git-askpass", import.meta.url)));
    this.personal = new PersonalEnvironments(options.homeDirectory ?? homedir());
    this.commitIdentities = new ContextCommitIdentities(options.homeDirectory ?? homedir());
    const transport = options.transport;
    if (transport.contextRequest) this.contexts = new ExecutionContexts({ post: (path, body) => transport.contextRequest!(path, body),
      ...(options.contextRenewMs ? { renewMs: options.contextRenewMs } : {}) });
    const contexts = this.contexts;
    // sync-context-v1: an activated workspace's sync socket reads only while its person's handle lives.
    if (contexts) transport.setSyncContexts?.({ required: () => this.acting, admit: (contextId, userId) => contexts.admitHandle(contextId, userId),
      ended: (contextId, listener) => contexts.onEnd(contextId, listener), release: contextId => contexts.release(contextId), live: contextId => contexts.live(contextId) });
  }

  private contextGateway(context: { contextId: string; servers: readonly RuntimeMcpServer[] }, workspaceRoot: string, agents: Agents): Promise<McpGateway> {
    const { contextId } = context;
    if (!this.contexts?.live(contextId)) return Promise.reject(new Error("This context has ended."));
    let gateway = this.contextMcp.get(contextId);
    if (!gateway) {
      const transport = this.options.transport;
      const created = new McpGateway({ workspaceRoot, admit: async () => this.runtimeGate.admit(),
        ...(transport.mcpAuthorization ? { authorization: (id: string, force?: boolean, signal?: AbortSignal) => transport.mcpAuthorization!(id, force, signal, contextId) } : {}),
        onFailure: (executionId, failure) => agents.mcpFailure(executionId, failure) });
      gateway = created.configure(context.servers, contextId).then(() => created, async error => { await created.dispose(); throw error; });
      this.contextMcp.set(contextId, gateway);
      this.contexts.onEnd(contextId, () => {
        const ending = this.contextMcp.get(contextId); this.contextMcp.delete(contextId);
        void ending?.then(value => value.dispose()).catch(() => {});
      });
    }
    return gateway;
  }

  /** Activated: a client's mutation runs as the connection's person, from an operation lease retired when the request ends. */
  private async asClient<T>(client: Client, requestId: string, op: string, params: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
    const operation = CloudV2ClientOperationSchema.safeParse(op);
    if (!this.acting || !operation.success || (op === "git.repoBranchCatalog" && params.fetch !== true)) return work();
    if (!this.contexts || !client.userId) throw tagged(new WorkspaceError("CLOUD_V2_UNSUPPORTED", "Reconnect to the workspace to make changes as yourself."), "no_person");
    let lease: CloudV2ClientLease;
    try { lease = await this.contexts.clientLease({ clientId: client.authorityId ?? client.id, requestId, operation: operation.data }); }
    catch (error) { throw tagged(error, "lease_refused"); }
    try {
      if (lease.userId !== client.userId) throw tagged(new WorkspaceError("CLOUD_V2_UNSUPPORTED", "Reconnect to the workspace to make changes as yourself."), "lease_person_mismatch");
      const userName = reviewRequesterName(lease, this.commitIdentities.identitySource);
      return await operationEnvironment.run({ git: this.contextGit(lease.contextId, lease.gitIdentity), zeros: { ZEROS_EXECUTION_CONTEXT: lease.contextId },
        // A code review mutation is authored by this person (never the Creator, whose identity authors commits).
        requester: { userId: lease.userId, ...(userName ? { userName } : {}) } }, work);
    } finally {
      await retireContext(this.contexts, lease.contextId, "operation_done");
    }
  }

  /** Activated: a shell runs from its opener's terminal lease (identity, context, API and own variables). */
  private terminalPeople(contexts: ExecutionContexts, application: ApplicationEnvironment): TerminalPeople {
    return {
      of: client => (client as Client).userId,
      lease: async (client, terminalId, requestId) => {
        const lease = await contexts.terminalLease({ clientId: (client as Client).authorityId ?? client.id, terminalId, requestId });
        let env: Awaited<ReturnType<PersonalEnvironments["materialize"]>> | undefined;
        try { env = lease.environment ? await this.personal.materialize(lease.contextId, lease.environment) : undefined; }
        catch (error) {
          // Granted but unusable: retired now (its files erased), not left to lapse.
          void retireContext(contexts, lease.contextId, "terminal_closed", { personal: this.personal }).catch(() => {});
          throw closedFailure("personal_env_failed", error);
        }
        const skipped = env && unexportedLine(env.unexported);
        if (skipped) this.options.log?.(skipped);
        const variables = env?.variables ?? {};
        application.protect([...Object.values(variables), ...(lease.environment?.files.map(file => file.content) ?? []), ...(lease.api ? [lease.api.token] : [])]);
        return { contextId: lease.contextId, userId: lease.userId, git: this.contextGit(lease.contextId, lease.gitIdentity),
          zeros: { ZEROS_EXECUTION_CONTEXT: lease.contextId, ...(lease.api ? { ZEROS_API_URL: lease.api.url, ZEROS_API_TOKEN: lease.api.token } : {}),
            ...(env ? { ZEROS_PERSONAL_ENV_DIR: env.directory } : {}) },
          application: variables };
      },
      ended: (contextId, listener) => contexts.onEnd(contextId, listener),
      retire: contextId => retireContext(contexts, contextId, "terminal_closed", { personal: this.personal }),
    };
  }

  /** An activated workspace never gives a credential outside a live context: no Creator fallback. */
  private githubToken(purpose: "git" | "gh", failed: string | undefined, contextId: string | undefined): Promise<GithubToken> {
    if (!this.acting) return this.githubCredentials.get(purpose, failed);
    if (!contextId || !this.contexts?.live(contextId)) return Promise.reject(githubAuthenticationError("connection-changed"));
    let flight = this.contextGithub.get(contextId);
    if (!flight) {
      const tokens = new GithubTokens((frame, timeoutMs) => this.send(frame, timeoutMs), { contextId });
      if (this.online) tokens.connect();
      flight = { tokens, recovery: new GithubCredentialRecovery(tokens, { fetch: this.options.githubFetch, supportsRecovery: () => this.githubUserTokensEnabled }) };
      this.contextGithub.set(contextId, flight);
      this.contexts.onEnd(contextId, () => { tokens.dispose(); flight!.recovery.invalidate(); this.contextGithub.delete(contextId); });
    }
    return flight.recovery.get(purpose, failed);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.armIdleHeartbeat();
    this.options.transport.start({
      open: async () => {
        if (this.disposed) return;
        this.online = true; this.idle = undefined; this.tokens.connect();
        for (const { tokens } of this.contextGithub.values()) tokens.connect();
        await this.send({ t: "hello", protocol: CLOUD_V2_RELAY_PROTOCOL, workerVersion: "0.0.0",
          capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"], mcp: 1 } });
        // setup-status-v1: once after each hello; a first hello has no workspace yet and configuration reports it.
        void this.setup?.reportCurrent();
      },
      frame: (raw) => this.receive(raw),
      runtimeUpdate: () => { this.runtimeUpdater?.hint(); void this.runtimeUpdater?.tick(); },
      close: () => {
        this.online = false; this.appliedSections = undefined; this.disconnects++;
        for (const client of this.clients.values()) this.terminals?.detach(client);
        for (const client of this.clients.values()) if (client.contextId) this.contexts?.release(client.contextId);
        this.clients.clear(); this.history?.disconnect(); this.tokens.disconnect(); this.githubCredentials.disconnect();
        for (const { tokens, recovery } of this.contextGithub.values()) { tokens.disconnect(); recovery.disconnect(); }
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
    for (const timer of this.resourceWatchers.values()) clearInterval(timer);
    this.resourceWatchers.clear();
    if (this.disposed) return;
    this.disposed = true; this.runtimeUpdater?.stop(); this.watchdog?.stop(); clearInterval(this.heartbeat); this.tokens.dispose(); this.githubCredentials.invalidate();
    const workspaceTools = this.workspaceMcp.dispose();
    const agentsClosing = this.agents?.dispose();
    this.environmentLifetime.abort();
    void agentsClosing?.catch(() => {});
    await this.configuring.catch(() => {});
    await this.stopCheckout();
    await this.promptInbox?.dispose();
    await this.terminals?.dispose();
    this.sync?.dispose();
    await this.workspace?.dispose();
    await agentsClosing;
    await this.mcp?.dispose();
    await workspaceTools;
    this.reviews?.close();
    await this.store?.flush();
    await this.history?.flush();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.history?.dispose();
    this.contexts?.dispose();
    await this.github.dispose();
    await this.options.transport.dispose();
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const parsed = CloudV2ControlFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    // A syncing Mac never admits work, holds a runtime update, or counts as activity.
    const passive = message.t === "open" ? message.passive === true
      : (message.t === "frame" || message.t === "close") && this.clients.get(message.clientId)?.passive === true;
    if (passive) return this.control(message);
    if (["stop", "close", "prompts"].includes(message.t)) this.runtimeGate.activity();
    if (["stop", "close", "prompts", "reply", "refusal", "revoke-context"].includes(message.t)) return this.control(message);
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
      await this.configuring.catch(error => {
        this.options.onError?.("configuration");
        // One closed line per failed start: which step refused, and its closed code (never an id, path or value).
        this.options.log?.(failureLine("startup", classOf(error) ??
          new ClosedFailure(error instanceof EnvironmentSeedError ? "environment_seed_failed" : "configuration_failed", errorCode(error))));
        throw error;
      });
      return;
    }
    // Checkout preparation can be waiting for this reply. Never queue control
    // replies behind configuration or behind ordinary app work.
    // Activated: the control plane ended this context (a lost push is caught by renewal or expiry).
    if (message.t === "revoke-context") { this.contexts?.revoke(message.contextId, message.reason); return; }
    if (message.t === "reply" || message.t === "refusal") {
      this.tokens.receive(message);
      for (const { tokens } of this.contextGithub.values()) tokens.receive(message);
      return;
    }
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
      if (client?.passive) this.options.onSync?.(`sync served client=${client.id.slice(0, 8)} reads=${client.served ?? 0}`);
      if (client?.contextId) this.contexts?.release(client.contextId);
      clearInterval(this.resourceWatchers.get(message.clientId)); this.resourceWatchers.delete(message.clientId);
      this.clients.delete(message.clientId); return;
    }
    if (this.stopping) return;
    if (message.t === "open") {
      const previous = this.clients.get(message.clientId); if (previous) this.terminals?.detach(previous);
      if (previous?.contextId && previous.contextId !== message.contextId) this.contexts?.release(previous.contextId);
      // The connection's client handle lives as long as the connection: adopted now, renewed in every batch.
      if (message.userId && message.contextId) {
        this.contexts?.adopt(message.contextId, message.userId);
        // Phase 3: that person lost access. The control plane closes the leg; here the client is dropped at once.
        this.contexts?.onEnd(message.contextId, () => {
          const current = this.clients.get(message.clientId);
          if (!current || current.contextId !== message.contextId) return;
          current.rejected = true;
          this.terminals?.detach(current);
          this.clients.delete(message.clientId);
        });
      }
      const client: Client = { id: message.clientId, rejected: false, ...(message.passive ? { passive: true } : {}),
        ...(message.passive && message.device ? { device: message.device } : {}),
        ...(message.userId && message.contextId ? { userId: message.userId, contextId: message.contextId } : {}),
        ...(message.authorityClientId ? { authorityId: message.authorityClientId } : {}), send: async (frame) => {
        if (this.clients.get(client.id) === client && !client.rejected) await this.send({ t: "frame", clientId: client.id, frame });
      } };
      this.clients.set(client.id, client);
      await this.configuring;
      if (!this.scope || !this.online || this.disposed || this.stopping || this.clients.get(client.id) !== client) return;
      await client.send(this.readyFrame());
      return;
    }
    if (message.t !== "frame") return;
    const client = this.clients.get(message.clientId);
    if (!client || client.rejected) return;
    await this.configuring;
    if (!this.scope || !this.online || this.disposed || this.stopping || this.clients.get(client.id) !== client) return;
    const frame = safeParseClientBridgeMessage(message.frame);
    if (!frame) return;
    if (client.passive && (frame.type !== "WORKSPACE_REQUEST" || !SyncService.ops.has(frame.op))) {
      // Passivity is self-declared: a passive client may ONLY call sync.snapshot and sync.read.
      if (frame.type === "WORKSPACE_REQUEST")
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op, code: "PASSIVE_CLIENT", message: "A syncing Mac may only read sync data." }));
      return;
    }
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
    if (frame.type === "WORKSPACE_REQUEST" && SyncService.ops.has(frame.op)) {
      try {
        if (!this.sync) throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "Sync is not available.");
        const result = await this.sync.handle(frame.op, frame.params ?? {});
        // A Mac moving bytes keeps the VM awake (bounded); an in-sync mirror's snapshots never do.
        // Per Mac (device), across its sockets: a reconnect loop cannot restart the 30-minute allowance.
        if (client.passive && SYNC_TRANSFER_OPS.has(frame.op)) {
          this.syncTransfers.transferred(client.device ?? client.id, Date.now());
          client.served = (client.served ?? 0) + 1;
        }
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result }));
      } catch (error) {
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op,
          code: error instanceof WorkspaceError ? error.code : "WORKSPACE_ERROR",
          message: error instanceof WorkspaceError ? error.message : "The sync request could not be completed." }));
      }
      return;
    }
    if (frame.type.startsWith("AGENT_")) {
      if (frame.type !== "AGENT_LIST_AGENTS" && frame.type !== "AGENT_INIT_AGENT") await this.touchCheckout();
      if ((frame.type === "AGENT_PROMPT" || frame.type === "AGENT_STEER") && this.localCommandsEnabled) await this.retireLocalCommandSender(frame.sessionId);
      return this.agents!.handle(client, frame);
    }
    if (frame.type.startsWith("PTY_")) {
      if (frame.type !== "PTY_LIST") await this.touchCheckout();
      return this.terminals!.handle(client, frame);
    }
    if (frame.type === "WORKSPACE_REQUEST" && frame.op === "workspace.resources" && typeof (frame.params as { watch?: unknown } | undefined)?.watch === "boolean") {
      this.watchResources(client, (frame.params as { watch: boolean }).watch);
      if (!(frame.params as { watch: boolean }).watch) {
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result: { watching: false } }));
        return;
      }
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
        const result = await this.asClient(client, frame.id, frame.op, frame.params ?? {}, () => service.handle(frame.op, frame.params ?? {}));
        if (frame.op === "attachment.write") await this.reportIdle();
        await client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: frame.id, op: frame.op, result }));
      } catch (error) {
        // Activated: one journal line names the refusing step (closed class and code, never a path or value).
        const failure = classOf(error) as ClosedFailure<ClientOperationFailure> | undefined;
        // A failed Git command adds its closed detail (credential_missing, permission_denied, …), never its stderr.
        const detail = error instanceof GitCommandError ? error.detail : undefined;
        if (this.acting) this.options.log?.(failureLine(`workspace-request op=${/^[A-Za-z]{1,32}(?:\.[A-Za-z]{1,32}){0,2}$/.test(frame.op) ? frame.op : "other"}`,
          failure ?? new ClosedFailure("operation_failed", errorCode(error))) + (detail ? ` detail=${detail}` : ""));
        await client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: frame.id, op: frame.op,
          code: error instanceof WorkspaceError || error instanceof CodeReviewError ? error.code : "WORKSPACE_ERROR",
          message: error instanceof WorkspaceError || error instanceof CodeReviewError ? error.message : "The workspace request could not be completed.",
          ...(this.acting && failure ? { failure: failure.failure } : {}), ...(detail ? { detail } : {}) }));
      } finally {
        if (activeMutation) {
          this.activeMutations--;
          this.lastMutationAt = Date.now();
        }
      }
    }
  }

  private async configure(received: WorkerConfig): Promise<void> {
    // Activated: a global personal environment never applies (each lease brings its person's); one is ignored, not seeded.
    const config: WorkerConfig = received.actingUser === 1 && received.environment ? (({ environment: _ignored, ...rest }) => rest)(received) : received;
    if (this.disposed || (!this.scope && this.stopping)) return;
    const started = performance.now(), initial = !this.scope;
    const reviewAvailable = this.configuredReviewAvailable;
    const timing = this.options.transport.reportTiming?.bind(this.options.transport);
    const revision = BigInt(config.loginRevision);
    if (this.acceptedConfigurationRevision !== undefined && revision < this.acceptedConfigurationRevision) return;
    this.acting = config.actingUser === 1;
    if (this.acting && this.contexts) {
      const sweep = this.options.bootClean, workspaceRoot = config.workspace.checkoutPath;
      // Slice D (Q-D2): after the sweep (nothing old can rewrite it), the phase-1 Creator material goes, with proof.
      // Only a boot with a real sweep cleans; without one it is unproven anyway.
      void this.contexts.clean(async () => {
        // Each refused class goes with the attestation and into one journal line (no paths or values).
        const refusals = new Set<CloudV2BootCleanRefusal>(), note = (refusal: CloudV2BootCleanRefusal) => { refusals.add(refusal); };
        // No real sweep (not a production boot): unproven, and it says so.
        if (!sweep) note("proc_unreadable");
        // One closed line about what the sweep met: counts by class, command names only from a fixed allowlist.
        const summarize = (value: SweepSummary) => this.options.log?.(`boot-clean sweep targets=${value.targets} zombies=${value.zombies} zombie_leaders_with_threads=${value.zombieLeadersWithThreads} unreadable=${value.unreadable} ` +
          Object.entries(value.survivors).map(([kind, count]) => `${kind}=${count}`).join(" ") +
          ` comms=${Object.entries(value.comms).sort().map(([comm, count]) => `${comm}:${count}`).join(",") || "none"}`);
        const processes = sweep ? await sweep(note, summarize) : 1;
        const legacyMaterial = sweep ? await removeLegacyMaterial({ root: workspaceRoot, state: this.options.directory, home: this.options.homeDirectory ?? homedir(),
          ...(this.options.sharedMemory ? { shm: this.options.sharedMemory } : {}) }, note) : "refused" as const;
        const classes = [...refusals].sort();
        this.options.log?.(`boot-clean processes=${processes} legacy=${legacyMaterial} refusals=${classes.join(",") || "none"}`);
        return { processes, legacyMaterial, refusals: classes };
      });
    }
    const sections = configurationSections(config), disconnects = this.disconnects;
    // Only a configuration applied in full on this connection is a baseline.
    const changed = this.scope && !this.stopping && this.appliedSections ? changedSections(this.appliedSections, sections) : undefined;
    // Repeating checkout, MCP and review setup would hold every waiting open.
    if (changed?.length === 0) { this.agents!.configure(config); return; }
    if (changed) this.options.onReconfigure?.(changed);
    this.appliedSections = undefined;
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
    this.localCommandsEnabled = config.localCommands === 1;
    this.localCommandReason = config.localCommandReason === 1;
    this.notifyUserEnabled = config.notifyUser === 1;
    if (this.configurationRevision !== revision) { this.tokens.invalidate(); this.githubCredentials.invalidate(); }
    if (!changed || changed.includes("gitIdentity") || changed.includes("gitIdentitySource")) {
      // Activated with a Creator: the VM-wide managed identity is the Creator's; open contexts follow (identity.ts).
      await configureGitIdentity(this.options.homeDirectory ?? homedir(), config.gitIdentity, { managed: config.gitIdentitySource === "creator" });
      this.commitIdentities.configure(config.gitIdentitySource, config.gitIdentity ?? null);
    }
    if (!this.scope) {
      if (!await this.initialize(scope, config, timing)) return;
    } else {
      if (!changed || changed.includes("api")) { this.application!.protect([config.api?.token]); this.workspaceApi!.configure(config.api); }
      if (!changed || changed.some(key => key.startsWith("workspace.")))
        await measureStartup("worker_reconfigure_workspace", () => this.workspace!.configure(config.workspace), timing);
      await measureStartup("worker_reconfigure_mcp", () => this.mcp!.configure(config.mcpServers ?? [], config.loginRevision), timing);
      if (!this.stopping) await (config.actingUser === 1 ? this.reviews!.configurePerRequester() : this.reviews!.configure(config.codeReview));
      if (!this.reviews!.enabled) this.workspaceMcp.revokeReview();
      this.agents!.configure(config);
      // The agents and their model lists follow the login revision (and, activated, the Creator's logins and models):
      // every client re-reads them now instead of polling.
      if (changed?.some(key => key === "loginRevision" || key === "agentLogins" || key === "agentModels"))
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["agents"], workspaceIds: [scope.workspace.id] }));
    }
    if (this.disposed) return;
    this.applyPushSignals(config.pushSignals === 1);
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
      }, (chatId, version) => this.history?.acknowledgeChatEdit(chatId, version));
      // The negotiated cadence applies from the inbox's first poll, not from the next configuration.
      this.promptInbox.pushSignals = this.pushSignals;
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
      this.runtimeUpdater.setPushSignals(this.pushSignals);
      this.runtimeUpdater.start();
    }
    if (!initial && reviewAvailable !== this.reviews?.enabled) await this.broadcast(this.readyFrame());
    this.configuredReviewAvailable = this.reviews?.enabled === true;
    if (disconnects === this.disconnects) this.appliedSections = sections;
    // Readiness never waits for the history backfill: a cold wake's first client gets ENGINE_READY as soon as the
    // services are configured, while the idle report flushes sessions and history in the background (reportIdle reports
    // idle only after both flushes, so idle-stop still sees persisted work).
    void this.reportIdle(true).catch(() => this.options.onError?.("storage"));
    if (initial) recordStartupTiming("worker_configure", started, timing);
    else recordStartupTiming("worker_reconfigure", started, timing);
  }

  private async initialize(scope: WorkspaceScope, config: WorkerConfig, timing?: StartupTimingObserver): Promise<boolean> {
    if (this.disposed || this.stopping) return false;
    let refresh: CheckoutRefresh | undefined, store: SessionStore | undefined, workspace: WorkspaceService | undefined;
    let mcp: McpGateway | undefined, agents: Agents | undefined, terminals: Terminals | undefined, history: HistoryMirror | undefined, setup: WorkspaceSetup | undefined;
    let reviews: WorkerCodeReview | undefined;
    // Opened beside the checkout; cleanup below waits for them on any failure.
    let storeOpening: Promise<SessionStore> | undefined, reviewConfiguring: Promise<void> | undefined;
    const unsubscribers: Array<() => void> = [];
    let published = false;
    try {
      await this.github.start();
      if (this.disposed || this.stopping) return false;
      // Activated: checkout and setup run as the persisted starter, from the bootstrap lease; no Creator fallback.
      // Activated with no bootstrap context: only an existing checkout may start (a later process on a boot whose
      // setup completed, or an earlier boot's checkout). A fresh one is never cloned or set up as nobody.
      if (this.acting && !config.bootstrapContextId && !this.options.runtimeResume && !await lstat(join(config.workspace.checkoutPath, ".git")).then(() => true, () => false))
        throw tagged(new WorkspaceError("WORKSPACE_UNAVAILABLE", "This workspace is still being prepared. Try again shortly."), "bootstrap_required");
      const bootstrap = this.acting && config.bootstrapContextId && this.contexts && !this.options.runtimeResume
        ? await this.contexts.bootstrapLease(config.bootstrapContextId).catch(error => { throw tagged(error, "bootstrap_lease_refused"); }) : undefined;
      const bootstrapEnvironment = bootstrap && { git: this.contextGit(bootstrap.contextId, bootstrap.gitIdentity), zeros: { ZEROS_EXECUTION_CONTEXT: bootstrap.contextId } };
      const asStarter = <T>(work: () => T): T => bootstrapEnvironment ? operationEnvironment.run(bootstrapEnvironment, work) : work();
      const checking = measureStartup("worker_checkout", () => this.options.runtimeResume ? Promise.resolve(undefined)
        : asStarter(() => (this.options.prepareCheckout ?? prepareCheckout)(config.workspace, this.gitEnvironment, timing)), timing)
        .catch(async error => {
          await this.options.transport.reportCheckoutFailure?.().catch(() => {});
          throw tagged(error, "checkout_failed");
        });
      // The session store and review database live in the worker's state
      // directory, not the checkout. Git switches branches in a child process,
      // so they open meanwhile (0.97 s and 0.63 s one after another on Alpha).
      storeOpening = measureStartup("worker_session_store", () => SessionStore.open(join(this.options.directory, "sessions"), scope.key), timing);
      storeOpening.catch(() => {});
      reviews = new WorkerCodeReview(scope, this.options.directory, () => {
        if (this.reviews !== reviews) return;
        this.lastMutationAt = Date.now(); void this.reportIdle();
        void this.broadcast(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["codeReview"], workspaceIds: [scope.workspace.id] }));
      });
      // Activated: each review mutation is its requester's; no workspace-wide reviewer (config.codeReview is ignored).
      reviewConfiguring = measureStartup("worker_services_review", () => config.actingUser === 1 ? reviews!.configurePerRequester() : reviews!.configure(config.codeReview), timing);
      reviewConfiguring.catch(() => {});
      const checkout = await checking;
      refresh = checkout?.refresh;
      this.initialSetupNeeded ||= checkout?.createdBranch === true;
      if (this.disposed || this.stopping) return false;
      if (config.environment && !this.options.transport.reportEnvironment) throw new EnvironmentSeedError("cloud_environment_runtime_required");
      // Activated: the legacy seed journal belongs to boot-clean's removal, never to seeding.
      try { if (config.actingUser !== 1) await seedEnvironment(scope, this.options.directory, config.environment, this.environmentLifetime.signal); }
      catch (error) {
        if (error instanceof EnvironmentSeedError && config.environment && !this.environmentLifetime.signal.aborted)
          await this.options.transport.reportEnvironment?.({ versionId: config.environment.versionId, sequence: 1, state: "failed", errorCode: error.code }, this.environmentLifetime.signal);
        throw error;
      }
      if (this.disposed || this.stopping) return false;
      const application = new ApplicationEnvironment(config.environment && { variables: config.environment.variables, files: config.environment.files });
      application.protect([config.api?.token]);
      const workspaceApi = new WorkspaceApiEnvironment(scope.workspace.id);
      workspaceApi.configure(config.api);
      const restoreMarker = join(this.options.directory, "restored-from-checkpoint");
      const restored = await access(restoreMarker).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      store = await storeOpening;
      const servicesStarted = performance.now();
      // Earlier worker snapshots stored a cloud key in chat metadata. Native
      // bridge rows must round-trip through the renderer's existing mapper.
      for (const chat of store.list().chats) if (chat.folder !== scope.folder(chat.folder)) await store.upsert({ ...chat, folder: scope.root });
      if (this.disposed || this.stopping) return false;
      const run = this.options.workspaceServices?.run ?? commandRunner(scope.root, this.gitEnvironment);
      await reviewConfiguring;
      if (this.disposed || this.stopping) return false;
      const sync = new SyncService(scope, (program, args, options) => run(program, args, options), () => this.syncHint(sync),
        { bundleDirectory: join(this.options.directory, "sync-bundles"), baseBranch: config.workspace.baseBranch, onActive: () => workspace?.refreshWatch(),
          ...(this.options.onSync ? { log: this.options.onSync } : {}) });
      workspace = await measureStartup("worker_services_workspace", () => WorkspaceService.open(scope, this.options.directory, {
        onContentChange: () => sync.changed(), onWatchLossy: () => sync.lossy(), watchContext: () => sync.active,
        historyDiff: params => agents!.turns.historyDiff(params),
        ...this.options.workspaceServices,
        codeReview: reviews,
        onStartupTiming: timing,
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
        (frame) => this.broadcast(frame), () => { this.runtimeGate.activity(); void this.reportIdle(); }, this.options.onTiming, this.options.modelDiscovery,
        (executionId, context) => context ? this.contextGateway(context, scope.root, agents!).then(gateway => gateway.providers(executionId)) : mcp!.providers(executionId),
        async input => this.workspaceMcp.admit(input.executionId, new WorkspaceAgentTools({ assertCurrent: () => input.assertExecutionCurrent(),
          terminalOutput: async ({ source, ...request }) => {
            if (source !== "setup") {
              const contextId = config.actingUser === 1 ? agents!.activeTurn(input.nativeExecutionId)?.contextId : undefined;
              const userId = contextId ? this.contexts?.userOf(contextId) : undefined;
              return terminals!.output({ ...request, ...(source === "auto" ? {} : { kind: source }), ...(userId ? { userId } : {}) });
            }
            const setupOutput = await readSetupOutput(this.options.directory, scope.workspace.id, request.maxLines);
            return setupOutput && { terminalId: "setup", truncated: setupOutput.truncated, lines: setupOutput.lines.map(line => application.text(line)) };
          }, diff: request => workspace!.git.agentDiff(request),
          ...(this.localCommandsEnabled && this.options.transport.localCommand ? { localCommands: { checkout: scope.root, reason: this.localCommandReason,
            run: (command, signal) => {
              // Activated: the active turn's context names whose Mac this may reach.
              const contextId = agents!.activeTurn(input.nativeExecutionId)?.contextId;
              return this.options.transport.localCommand!({ chatId: input.conversationId, executionId: input.nativeExecutionId, input: command, ...(contextId ? { contextId } : {}) }, signal);
            } } } : {}),
          ...(this.notifyUserEnabled && this.notifyUserService ? { notifyUser: { notify: (request, signal) => this.notifyUserService!.notify(input.executionId, request, signal) } } : {}),
          ...(reviews!.enabled ? { review: reviews!.tools(input) } : {}) })), application, !!this.options.runtimeResume, workspaceApi);
      this.notifyUserService = new NotifyUserService({ activeTurn: executionId => agents!.activeTurn(executionId),
        publish: (executionId, update) => agents!.attention(executionId, update),
        ...(this.options.transport.notifyUser ? { deliver: (request, signal) => this.options.transport.notifyUser!(request, signal) } : {}) });
      terminals = new Terminals(scope, { gitEnvironment: this.gitEnvironment, applicationEnvironment: application.variables,
        zerosEnvironment: () => workspaceApi.variables(), redact: text => application.text(text),
        ...(config.actingUser === 1 && this.contexts ? { people: this.terminalPeople(this.contexts, application) } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
        records: join(this.options.directory, "terminals"), broadcast: frame => this.broadcast(frame), activity: () => { this.runtimeGate.activity(); void this.reportIdle(); } });
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
        ...(this.options.transport.reportSetup ? { report: (status: CloudV2SetupStatus) => this.options.transport.reportSetup!(status) } : {}),
        beforeRun: async () => {
          if (refresh?.mayFastForward) await refreshing;
          await refresh?.touch();
        },
        onAdmitted: async () => { this.initialSetupNeeded = false; await rm(restoreMarker, { force: true }).catch(() => {}); },
      });
      if (config.environment) await this.options.transport.reportEnvironment!({ versionId: config.environment.versionId, sequence: 1, state: "ready" }, this.environmentLifetime.signal);
      if (this.disposed || this.stopping) return false;
      this.environmentVersion = config.environment?.versionId;
      this.sync?.dispose(); this.sync = sync;
      this.store = store; this.workspace = workspace; this.mcp = mcp; this.agents = agents; agents.setExecutionContexts(this.contexts, this.personal, this.options.log);
      agents.commitIdentity = (contextId, identity) => this.contextGit(contextId, identity); this.reviews = reviews;
      this.terminals = terminals; this.application = application; this.workspaceApi = workspaceApi; this.chats = chats; this.history = history; this.setup = setup; this.checkoutRefresh = refresh;
      this.unsubscribers.push(...unsubscribers); this.scope = scope; published = true;
      recordStartupTiming("worker_services", servicesStarted, timing);
      if (this.options.memoryWatchdog && process.platform === "linux" && process.getuid) this.startWatchdog(this.options.memoryWatchdog.runtimeRoots, process.getuid());
      const refreshing = refresh?.start();
      // Before start: a file a hard stop left running reads as interrupted, never as this run.
      void setup.reportCurrent();
      if (!this.options.runtimeResume) asStarter(() => setup!.start(this.initialSetupNeeded || restored));
      if (bootstrap) void setup.done().then(() => retireContext(this.contexts!, bootstrap.contextId, "setup_done")).catch(() => {});
      return true;
    } finally {
      if (!published) {
        for (const unsubscribe of unsubscribers) unsubscribe();
        // A failure before they were awaited still owns what they opened.
        store ??= await storeOpening?.catch(() => undefined);
        await reviewConfiguring?.catch(() => undefined);
        const closed = await Promise.allSettled([setup?.dispose(), refresh?.dispose(), terminals?.dispose(), workspace?.dispose(),
          agents?.dispose(), mcp?.dispose(), store?.flush(), history?.dispose(), Promise.resolve().then(() => reviews?.close())]);
        if (closed.some(result => result.status === "rejected")) this.options.onError?.("storage");
      }
    }
  }

  private startWatchdog(runtimeRoots: readonly string[], uid: number): void {
    const watchdog = this.watchdog = new MemoryWatchdog({ self: process.pid, uid, runtimeRoots, loginShells: () => new Set(this.terminals?.shellPids().keys()),
      onPressure: () => this.options.onMemory?.("memory_pressure"),
      onKilled: report => { this.options.onMemory?.("memory_stopped"); void this.reportStopped(report).catch(() => {}); } });
    watchdog.start();
  }
  private async reportStopped(report: KillReport): Promise<void> {
    const name = report.name.replace(/[^\x20-\x7e]/g, "?").slice(0, 32) || "a process";
    const size = report.rssBytes >= 2 ** 30 ? `${(report.rssBytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(report.rssBytes / 2 ** 20)} MB`;
    const message = `Zeros stopped ${name} (PID ${report.pid}, ${size}) because the workspace was almost out of memory.`;
    if (report.owner.kind === "chat") this.agents?.processStopped(report.owner.chatId, message);
    else if (report.owner.kind === "terminal") {
      const sessionId = this.terminals?.shellPids().get(report.owner.shellPid);
      if (sessionId) await this.terminals!.notice(sessionId, `\r\n\x1b[33m${message}\x1b[0m\r\n`);
    }
  }
  /** A legacy relay prompt changes who the chat's latest sender is. The control
   * plane fences that before forwarding; this narrow second fence is best
   * effort and can never restore an authority. */
  private async retireLocalCommandSender(executionId: string): Promise<void> {
    const chatId = this.agents?.chatForExecution(executionId);
    if (!chatId || !this.options.transport.retireLocalCommandSender) return;
    await Promise.race([this.options.transport.retireLocalCommandSender({ chatId, executionId }).catch(() => {}),
      new Promise<void>(resolve => { setTimeout(resolve, 5_000).unref(); })]);
  }
  /** After a recorded batch: only syncing Macs need it, and they pull. */
  private syncHint(sync: SyncService): void {
    if (this.sync !== sync || !this.scope) return;
    const hint = createMessage({ type: "DB_CHANGED", source: "engine", kinds: [SYNC_HINT_KIND], workspaceIds: [this.scope.workspace.id] });
    for (const client of this.clients.values()) if (client.passive) void client.send(hint).catch(() => {});
  }
  /** R1 push-not-poll: one pushed sample stream per watching client (bounded), stopped by watch:false, close or dispose. */
  private readonly resourceWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private watchResources(client: Client, watch: boolean): void {
    clearInterval(this.resourceWatchers.get(client.id)); this.resourceWatchers.delete(client.id);
    if (!watch || this.resourceWatchers.size >= 32) return;
    let sampling = false;
    const timer = setInterval(() => {
      if (sampling) return;
      if (this.clients.get(client.id) !== client || client.rejected || this.disposed || this.stopping) {
        clearInterval(timer); if (this.resourceWatchers.get(client.id) === timer) this.resourceWatchers.delete(client.id); return;
      }
      sampling = true;
      void this.workspace!.handle("workspace.resources", {})
        .then(result => client.send(createMessage({ type: "WORKSPACE_RESOURCES", source: "engine", result })))
        .catch(() => {}).finally(() => { sampling = false; });
    }, this.options.resourcesPushMs ?? CLOUD_WORKSPACE_RESOURCES_PUSH_MS);
    timer.unref?.();
    this.resourceWatchers.set(client.id, timer);
  }
  /** R1 push-signals-v1: once the control plane accepts the cadences, the forced idle report runs every 5 min (it is
   * still sent on every busy/idle change), the transport pulse every 5 min, the prompt long poll 60 s and the runtime
   * update check falls back to 15 min. Without it, today's timers stay. */
  private pushSignals = false;
  private applyPushSignals(on: boolean): void {
    if (this.promptInbox) this.promptInbox.pushSignals = on;
    this.runtimeUpdater?.setPushSignals(on);
    if (on === this.pushSignals) return;
    this.pushSignals = on;
    this.options.transport.setPushSignals?.(on);
    this.armIdleHeartbeat();
  }
  private armIdleHeartbeat(): void {
    clearInterval(this.heartbeat);
    if (!this.started || this.disposed) return;
    this.heartbeat = setInterval(() => { void this.reportIdle(this.busy); }, this.pushSignals ? PUSH_SIGNALS_REPORT_MS : 55_000);
    this.heartbeat.unref?.();
  }

  /** A context's Git author env; its include file is removed when the context ends. */
  private contextGit(contextId: string, identity: Parameters<ContextCommitIdentities["environment"]>[1]): Record<string, string> {
    const env = this.commitIdentities.environment(contextId, identity);
    if (this.commitIdentities.identitySource && this.contexts && !this.identityEnds.has(contextId)) {
      this.identityEnds.add(contextId);
      this.contexts.onEnd(contextId, () => { this.identityEnds.delete(contextId); this.commitIdentities.forget(contextId); });
    }
    return env;
  }

  private broadcast(frame: BridgeMessage): Promise<void> { return this.send({ t: "frame", clientId: "*", frame }).then(() => {}); }
  private readyFrame(): BridgeMessage {
    return createMessage({ type: "ENGINE_READY", source: "engine", version: "0.0.0", root: "", framework: "cloud", port: 0,
      protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_SUPPORTED_PROTOCOL, instanceId: this.instanceId,
      capabilities: [...(this.reviews?.enabled ? ["code-review-v1"] : []), CLOUD_WORKSPACE_RESOURCES_CAPABILITY, CLOUD_WORKSPACE_RESOURCES_WATCH_CAPABILITY, SYNC_CAPABILITY, SYNC_BATCH_CAPABILITY, SYNC_HAVE_V2_CAPABILITY] });
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
    clearInterval(this.heartbeat); this.watchdog?.stop();
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
      this.activeMutations || (this.options.transport.localCommandsPending ?? 0) > 0 || Date.now() - this.lastMutationAt < RECENT_ACTIVITY_MS ||
      this.syncTransfers.active(Date.now()));
  }
  get runtimeCensus(): RuntimeCensus {
    return {
      clients: [...this.clients.values()].some(client => !client.passive),
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
      tools: this.mcp ? this.mcp.runtimeBusy || this.workspaceMcp.runtimeBusy || (this.options.transport.localCommandsPending ?? 0) > 0 : null,
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
