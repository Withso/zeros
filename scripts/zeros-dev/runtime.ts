import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { CloudWorkspaceAccessClient, CloudWorkspaceAccessClientError,
  type CloudWorkspaceAdmissionOptions } from "../../apps/desktop/electron/cloud-workspace-access-client";
import { CloudWorkspaceAccessBroker } from "../../apps/desktop/electron/cloud-workspace-access-broker";
import { CloudReplicaDeviceSigner } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RuntimeClient, type ConnectionRejection, type RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import { CloudRuntimeAccessError } from "../../apps/desktop/src/renderer/platform/bridge/cloud-runtime-access-error";
import { CloudAgentConnection } from "../../apps/desktop/src/renderer/platform/bridge/cloud-agent-connection";
import { CloudEventReader } from "../../apps/desktop/src/renderer/platform/bridge/cloud-event-reader";
import { cloudOutgoing, record, type CloudRuntimeScope } from "../../apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire";
import { cloudWorkspaceKey, cloudScopedId } from "../../apps/desktop/src/renderer/platform/bridge/cloud-workspace-key";
import { bridgePtyCreate, bridgePtyKill, bridgePtyWrite, subscribeBridgePtyData, subscribeBridgePtyExit } from "../../apps/desktop/src/renderer/platform/bridge/pty-bridge";
import type { BridgeMessage } from "../../apps/desktop/src/renderer/platform/bridge/messages";
import type { ZerosDevSession } from "./session";
import type { Agent, ProductApi } from "./product";
import type { Run, RunHandle } from "./receipts";
import { ALPHA_ORIGIN } from "./config";
import { beforeDeadline } from "./transport";
import { ZerosDevError } from "./errors";
import type { RuntimeObservation } from "./runtime-observation";
import { AdmissionObservationSchema, type AdmissionObservation } from "./admission-observation";
import { RuntimeTelemetry } from "./runtime-telemetry";
import type { TransportObservation } from "./gate0-contract";

type SessionPort = Pick<ZerosDevSession, "fixture" | "device" | "accessToken" | "accountSessionKey">;
type Options = { signal?: AbortSignal; environment?: RuntimeClientEnvironment; fetch?: typeof fetch;
  onAdmissionEvent?: (event: AdmissionObservation) => void };
const listSchema = z.object({ workspaces: z.array(z.object({ id: z.string().min(1), path: z.string().min(1).max(4096) })).max(1000) });
const messagesSchema = z.object({ messages: z.array(z.object({ msgId: z.string().min(1).max(128), kind: z.string().max(64), payload: z.string().max(512 * 1024), createdAt: z.number().finite() })).max(200) });
const promptSchema = z.object({ id: z.string().uuid(), agent: z.enum(["claude", "codex", "cursor"]), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/), text: z.string().min(1).max(64 * 1024), continueFrom: z.string().uuid().optional(), permissionMode: z.enum(["tool-approval", "auto"]).optional() }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bounded = (signal: AbortSignal | undefined, ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

function connectFailure(error: unknown, phase: RuntimeObservation["phase"], aborted: boolean,
  rejection: ConnectionRejection | null | undefined, channel: string | undefined, admission?: AdmissionObservation,
  transport?: TransportObservation): ZerosDevError {
  const known = error instanceof ZerosDevError || error instanceof CloudWorkspaceAccessClientError || error instanceof CloudRuntimeAccessError;
  const code = known ? error.code : undefined, status = known ? error.status : undefined;
  let inner: RuntimeObservation["class"] = "unknown";
  if (rejection) {
    if (["auth-required", "auth-invalid", "auth-wrong-account", "desktop-unbound", "cloud-revoked"].includes(rejection.reason)) inner = "authority_rejected";
    else if (rejection.reason === "cloud-superseded") inner = "identity_changed";
    else if (rejection.reason === "cloud-transient") inner = channel === "control-plane-websocket" ? "relay_unavailable" : "unknown";
    else inner = "handshake_rejected";
  } else if (code === "bad_response") inner = "bad_response";
  else if (code === "runtime_changed" || code === "identity_changed" || code === "cloud_workspace_access_superseded") inner = "identity_changed";
  else if (code === "workspace_not_running") inner = "workspace_not_running";
  else if (status === 401 || status === 403 || ["auth_denied", "forbidden", "login_required", "signed_out", "device_proof_required"].includes(code ?? "")) inner = "authority_rejected";
  else if (aborted || code === "deadline" || code === "request_timeout" || status === 408) inner = "request_timeout";
  else if (phase === "admission" && (code === "control_plane_unavailable" || (status ?? 0) >= 500)) inner = "admission_unavailable";
  else if (phase === "admission" && (status ?? 0) >= 400) inner = "admission_refused";
  else if (code === "cloud_actor_runtime_unavailable" && channel === "control-plane-websocket") inner = "relay_unavailable";
  else if (error instanceof Error) {
    // The shared client has not yet typed these request failures. Match only
    // its exact literals; never forward even a substring of an error message.
    if (["Request timeout: WORKSPACE_REQUEST", "Request timeout: WORKSPACE_REQUEST (reconnecting)"].includes(error.message) ||
      ("code" in error && error.code === "REQUEST_ABORTED")) inner = "request_timeout";
    else if (error.message === "Request timeout: engine disconnected" && channel === "control-plane-websocket") inner = "relay_unavailable";
    else if ("code" in error && error.code === "ECONNREFUSED") inner = "connect_refused";
  }
  const runtime: RuntimeObservation = { phase, class: inner,
    ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? { status } : {}) };
  return error instanceof ZerosDevError
    ? new ZerosDevError(error.code, error.status, error.retryAfterMs, error.setup, runtime, error.admission ?? admission, transport)
    : new ZerosDevError(aborted || code === "request_timeout" ? "deadline" : "runtime_unavailable", undefined, undefined, undefined, runtime, admission, transport);
}

function environment(): RuntimeClientEnvironment {
  return {
    controlPlaneOrigin: ALPHA_ORIGIN, allowHttpLoopback: false,
    createWebSocket: (url, protocols) => new WebSocket(url, protocols, { maxPayload: 4 * 1024 * 1024, followRedirects: false }) as never,
    resolveEnginePort: async () => { throw new ZerosDevError("runtime_unavailable"); },
    resolveEngineToken: async () => { throw new ZerosDevError("runtime_unavailable"); },
    invalidateEnginePort() {}, invalidateEngineToken() {},
    getAuthAccessToken: () => { throw new ZerosDevError("runtime_unavailable"); },
    // The transport may log network destinations. CLI evidence is closed.
    logger: { warn() {}, error() {} },
  };
}

/** One admitted product connection, with the desktop's framing, boot fence,
 * direct/relay selection, command receipts and ordered replay unchanged. */
export class ZerosDevRuntime {
  private readonly agents: CloudAgentConnection;
  private readonly events: CloudEventReader;
  private readonly off: Array<() => void> = [];
  private disposed = false;
  private transportDetached = false;
  private constructor(readonly client: RuntimeClient, readonly scope: CloudRuntimeScope,
    private readonly broker: CloudWorkspaceAccessBroker, private readonly admissionId: string,
    private readonly api: ProductApi, private readonly run: Run, readonly channel: string, private readonly telemetry: RuntimeTelemetry,
    readonly admission?: AdmissionObservation) {
    this.events = new CloudEventReader(client, id => { void this.agents.refreshAttachments(id); });
    this.agents = new CloudAgentConnection(client, scope.engineWorkspaceId, (agent, model) => api.grant(run, agent as Agent, model), this.events);
    for (const type of ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"])
      this.off.push(this.events.on(type, message => {
        this.agents.incoming(message as unknown as Record<string, unknown>);
        this.agents.observePromptResult(message as unknown as Record<string, unknown>);
      }));
    for (const type of ["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED", "AGENT_SESSION_UPDATE"])
      this.off.push(this.events.on(type, message => { this.agents.incoming(message as unknown as Record<string, unknown>); }));
    this.off.push(client.onStatusChange(status => { if (status === "connected") void this.agents.refreshAttachments(); }));
  }

  static async connect(session: SessionPort, api: ProductApi, run: Run, options: Options = {}): Promise<ZerosDevRuntime> {
    const signal = bounded(options.signal, 30_000);
    let phase: RuntimeObservation["phase"] = "workspace_read", channel: string | undefined;
    let client: RuntimeClient | undefined, broker: CloudWorkspaceAccessBroker | undefined;
    let runtime: ZerosDevRuntime | undefined;
    let firstAdmission: AdmissionObservation | undefined, sequence = 0;
    const telemetry = new RuntimeTelemetry();
    const admissionOptions = (bound?: AbortSignal): CloudWorkspaceAdmissionOptions => {
      const currentSequence = ++sequence;
      let observation: AdmissionObservation | undefined;
      const publish = () => {
        const snapshot = AdmissionObservationSchema.parse(observation);
        if (!firstAdmission || firstAdmission.sequence === currentSequence) firstAdmission = snapshot;
        // The client isolates diagnostic callbacks. Validate/copy before the
        // public writer sees anything, and never pass a raw server error.
        options.onAdmissionEvent?.(AdmissionObservationSchema.parse(snapshot));
      };
      return { signal: bound, onAdmissionFailure: failure => {
        if (observation) return;
        observation = { connectionId: telemetry.snapshot().connectionId, sequence: currentSequence, firstFailure: failure, retryCount: 0, retries: [] }; publish();
      }, onAdmissionRetry: retry => {
        if (!observation) return;
        observation.retries.push(retry); observation.retryCount = observation.retries.length; publish();
      } };
    };
    try {
      const row = await beforeDeadline(api.workspace(run, signal), signal);
      if (!["ready", "busy"].includes(row.status)) throw new ZerosDevError("workspace_not_running");
      phase = "identity";
      const fixture = await beforeDeadline(session.fixture(), signal), credential = await beforeDeadline(session.device(), signal);
      const env = telemetry.wrap(options.environment ?? environment()); // Test port only; never an argv/env origin override.
      const access = new CloudWorkspaceAccessClient({ baseUrl: env.controlPlaneOrigin, allowInsecureLoopback: env.allowHttpLoopback,
        fetch: options.fetch ?? api.transport.fetchImpl,
        signEngineAdmission: async (_token, target) => {
          const current = await session.device();
          if (current.deviceId !== credential.deviceId || current.publicKey !== credential.publicKey || current.keyVersion !== credential.keyVersion)
            throw new ZerosDevError("identity_changed");
          return new CloudReplicaDeviceSigner(current).proof("engine.connect", target);
        },
      });
      const admitted = new CloudWorkspaceAccessBroker({ api: access, getAccessToken: () => session.accessToken(),
        getAccountSessionKey: () => session.accountSessionKey(), getDeviceId: async () => credential.deviceId!,
        onRuntimeRetired: () => client?.dispose(),
      });
      broker = admitted; phase = "admission";
      const pending = admitted.openRuntime({ organizationId: fixture.organizationId, workspaceId: row.id }, admissionOptions(signal));
      // If the caller times out, dispose still owns and retires a late grant.
      void pending.then(target => { if (signal.aborted) return admitted.closeRuntime(target.runtimeId); }, () => {}).catch(() => {});
      const target = await beforeDeadline(pending, signal);
      if (target.generation !== row.generation.number || target.organizationId !== fixture.organizationId || target.workspaceId !== row.id)
        throw new ZerosDevError("runtime_changed");
      channel = target.channel; phase = "handshake";
      telemetry.target(channel);
      client = new RuntimeClient(target, { environment: env,
        refreshCloudConnectionTarget: async previous => {
          const refreshed = await admitted.refreshRuntime(previous, admissionOptions(runtime ? options.signal : signal));
          telemetry.target(refreshed.channel); return refreshed;
        } });
      client.onStatusChange(status => telemetry.status(status));
      await beforeDeadline(client.connect(), signal); await client.waitUntilReady({ signal });
      phase = "workspace_read";
      const current = await beforeDeadline(api.workspace(run, signal), signal);
      if (!["ready", "busy"].includes(current.status)) throw new ZerosDevError("workspace_not_running");
      phase = "workspace_list";
      const response = await client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} }, { timeoutMs: 10_000, signal });
      const parsed = listSchema.safeParse(record(response).result);
      if (response.type !== "WORKSPACE_RESPONSE" || !parsed.success) throw new ZerosDevError("bad_response");
      const rows = parsed.data.workspaces;
      const exact = rows.filter(item => item.id === row.id), fallback = rows.filter(item => item.id === "local-main");
      if (exact.length > 1 || fallback.length > 1) throw new ZerosDevError("runtime_changed");
      const selected = exact[0] ?? fallback[0];
      if (!selected || !selected.path.startsWith("/") || selected.path === "/" || selected.path.includes("\0") || path.posix.normalize(selected.path) !== selected.path)
        throw new ZerosDevError("runtime_changed");
      runtime = new ZerosDevRuntime(client, { organizationId: fixture.organizationId, workspaceId: row.id,
        engineWorkspaceId: selected.id, root: selected.path }, admitted, target.runtimeId, api, run, target.channel, telemetry, firstAdmission);
      if (options.signal) {
        const close = () => { void runtime!.dispose(); };
        options.signal.addEventListener("abort", close, { once: true });
        runtime.off.push(() => options.signal!.removeEventListener("abort", close));
      }
      return runtime;
    } catch (error) {
      // Capture before disposal clears lastRejection, and before any retirement
      // failure can replace the first cause. Only the shared client retries.
      const failure = connectFailure(error, phase, signal.aborted, client?.lastRejection, channel, firstAdmission, telemetry.snapshot());
      telemetry.expectDisconnect();
      client?.dispose();
      if (broker) await beforeDeadline(broker.dispose(), AbortSignal.timeout(3000)).catch(() => {});
      throw failure;
    }
  }

  transport(): TransportObservation { return this.telemetry.snapshot(); }

  private async current(signal?: AbortSignal): Promise<void> {
    if (this.disposed || this.transportDetached) throw new ZerosDevError("runtime_unavailable");
    const row = await this.api.workspace(this.run, signal);
    if (!["ready", "busy"].includes(row.status)) throw new ZerosDevError("workspace_not_running");
    const peer = this.client.executionIdentity;
    if (peer.kind !== "cloud" || peer.organizationId !== this.scope.organizationId || peer.workspaceId !== this.scope.workspaceId || peer.generation !== row.generation.number)
      throw new ZerosDevError("runtime_changed");
  }

  async prompt(handle: RunHandle, input: { id?: string; agent: Agent; model: string; text: string; continueFrom?: string; permissionMode?: "tool-approval" | "auto" }, external?: AbortSignal): Promise<Run["prompts"][number]> {
    return (await this.startPrompt(handle, input, external)).completion;
  }

  /** Submission and observation stay separate for the laptop-close rehearsal.
   * A caller must prove the durable dispatch before disconnecting. Returning
   * this handle alone is neither acceptance nor successful provider execution. */
  async startPrompt(handle: RunHandle, input: { id?: string; agent: Agent; model: string; text: string; continueFrom?: string; permissionMode?: "tool-approval" | "auto" }, external?: AbortSignal) {
    const value = promptSchema.safeParse({ ...input, id: input.id ?? randomUUID() });
    if (!value.success || handle.run !== this.run) throw new ZerosDevError("invalid_request");
    const { id, agent, model, text, continueFrom, permissionMode } = value.data;
    const sha256 = hash(JSON.stringify({ agent, model, text, continueFrom, ...(permissionMode ? { permissionMode } : {}) }));
    const previous = continueFrom ? handle.run.prompts.find(row => row.id === continueFrom) : undefined;
    if (continueFrom && !previous) throw new ZerosDevError("receipt_missing");
    if (previous && (previous.state !== "succeeded" || previous.agent !== agent || previous.model !== model)) throw new ZerosDevError("operation_conflict");
    let receipt = handle.run.prompts.find(row => row.id === id);
    if (receipt && (receipt.sha256 !== sha256 || receipt.agent !== agent || receipt.model !== model)) throw new ZerosDevError("operation_conflict");
    if (receipt?.state === "succeeded") return { receipt, completion: Promise.resolve(receipt) };
    if (receipt?.state === "failed") throw new ZerosDevError("agent_failed");
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, bounded(external, 300_000)]);
    await this.current(signal);
    if (!receipt) {
      receipt = { id, conversationId: previous?.conversationId ?? randomUUID(), agent, model, sha256, state: "pending" };
      handle.run.prompts.push(receipt); await handle.save();
    }
    const saved = receipt;
    let permission = false;
    const stopForControl = () => { permission = true; controller.abort(); };
    // Auto is the normal product permission mode, explicitly chosen only by
    // the bounded rehearsal. Neither path fabricates a permission response.
    const off = [this.events.on("AGENT_PERMISSION_REQUEST", stopForControl), this.events.on("AGENT_QUESTION_REQUEST", stopForControl),
      this.agents.on("AGENT_PERMISSION_REQUEST", stopForControl), this.agents.on("AGENT_QUESTION_REQUEST", stopForControl)];
    const release = () => { controller.abort(); for (const stop of off) stop(); };
    const fail = async (error: unknown): Promise<never> => {
      if (saved.state !== "failed") saved.state = "uncertain";
      await handle.save();
      if (permission) throw new ZerosDevError("permission_required");
      if (error instanceof ZerosDevError && error.code === "agent_failed") throw error;
      throw new ZerosDevError("command_uncertain");
    };
    try {
      await beforeDeadline(this.agents.request({ type: "AGENT_NEW_SESSION", chatId: saved.conversationId, agentId: agent, model,
        env: { ZEROS_PERMISSION_MODE: permissionMode ?? "tool-approval" } }, { signal }), signal);
    } catch (error) { try { return await fail(error); } finally { release(); } }
    const completion = (async () => {
      try {
        const result = await beforeDeadline(this.agents.request({ type: "AGENT_PROMPT", chatId: saved.conversationId, agentId: agent,
          sessionId: `conversation:${saved.conversationId}`, userMessageId: id, prompt: [{ type: "text", text }] }, { signal }), signal);
        if (result?.type !== "AGENT_PROMPT_COMPLETE" || result.stopReason === "cancelled") {
          saved.state = "failed"; throw new ZerosDevError("agent_failed");
        }
        saved.state = "succeeded"; await handle.save(); return saved;
      } catch (error) { return fail(error); }
      finally { release(); }
    })();
    // The detached caller owns this result even while it is checking durable
    // dispatch. Prevent an early rejection becoming an unhandled rejection.
    void completion.catch(() => {});
    return { receipt: saved, completion };
  }

  async tail(promptId: string, signal?: AbortSignal) {
    const prompt = this.run.prompts.find(row => row.id === promptId);
    if (!prompt) throw new ZerosDevError("receipt_missing");
    await this.current(signal);
    const message = cloudOutgoing(this.scope, { type: "WORKSPACE_REQUEST", op: "messages.window",
      params: { chatId: cloudScopedId(this.scope, prompt.conversationId), limit: 100 } });
    const response = await this.client.request(message as Partial<BridgeMessage> & { type: string }, { timeoutMs: 15_000, signal });
    const parsed = messagesSchema.safeParse(record(response).result);
    if (response.type !== "WORKSPACE_RESPONSE" || !parsed.success) throw new ZerosDevError("bad_response");
    return parsed.data.messages;
  }

  async terminal(handle: RunHandle, input: { id?: string; script: string }, external?: AbortSignal): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    if (handle.run !== this.run || !input.script || Buffer.byteLength(input.script) > 2048 || input.script.includes("\0")) throw new ZerosDevError("invalid_request");
    const id = input.id ?? randomUUID();
    if (!z.string().uuid().safeParse(id).success) throw new ZerosDevError("invalid_request");
    // PTYs have no durable command receipt. Never repeat an uncertain script.
    if (handle.run.terminals?.some(row => row.id === id)) throw new ZerosDevError("operation_conflict");
    const signal = bounded(external, 60_000); await this.current(signal);
    const receipt = { id, sha256: hash(input.script), state: "uncertain" as "uncertain" | "succeeded" | "failed", exitCode: null as number | null };
    (handle.run.terminals ??= []).push(receipt); await handle.save();
    const sessionId = `zd-${id}`, parts: string[] = []; let bytes = 0, truncated = false;
    let resolveExit!: (code: number | null) => void;
    const ended = new Promise<number | null>(resolve => { resolveExit = resolve; });
    const off = [subscribeBridgePtyData(this.client, event => {
      if (event.sessionId !== sessionId || typeof event.data !== "string") return;
      const remaining = Math.max(0, 64 * 1024 - bytes), chunk = Buffer.from(event.data);
      if (chunk.byteLength > remaining) truncated = true;
      if (remaining) parts.push(chunk.subarray(0, remaining).toString("utf8")); bytes += Math.min(remaining, chunk.byteLength);
    }), subscribeBridgePtyExit(this.client, event => { if (event.sessionId === sessionId) resolveExit(event.exitCode); })];
    try {
      const mapped = cloudOutgoing(this.scope, { type: "PTY_CREATE", cwd: cloudWorkspaceKey(this.scope) });
      const created = await beforeDeadline(bridgePtyCreate(this.client, { sessionId, cwd: String(mapped.cwd), cols: 120, rows: 30, ephemeral: true }), signal);
      if (!created || created.reattached || created.cwd !== this.scope.root) throw new ZerosDevError("terminal_failed");
      const encoded = Buffer.from(input.script).toString("base64");
      bridgePtyWrite(this.client, { sessionId, data: `stty -echo; printf '%s' '${encoded}' | base64 -d | bash; exit $?\n` });
      const exitCode = await beforeDeadline(ended, signal);
      if (!Number.isInteger(exitCode) || exitCode === null || exitCode < 0 || exitCode > 255) throw new ZerosDevError("command_uncertain");
      receipt.exitCode = exitCode; receipt.state = exitCode === 0 ? "succeeded" : "failed"; await handle.save();
      return { exitCode, output: parts.join(""), truncated };
    } catch (error) {
      await handle.save(); throw error instanceof ZerosDevError ? error : new ZerosDevError("command_uncertain");
    } finally { for (const release of off) release(); bridgePtyKill(this.client, { sessionId }); }
  }

  /** Device sleep releases sockets, not the actor's execution authority. The
   * caller must later dispose (or log out) to retire the retained admission. */
  detachTransport(): void {
    if (this.transportDetached) return;
    this.transportDetached = true; this.telemetry.expectDisconnect();
    for (const release of this.off) release();
    this.events.dispose(); this.agents.dispose(); this.client.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.detachTransport();
    await beforeDeadline(this.broker.closeRuntime(this.admissionId), AbortSignal.timeout(3000)).catch(() => {});
    await beforeDeadline(this.broker.dispose(), AbortSignal.timeout(3000)).catch(() => {});
  }
}
