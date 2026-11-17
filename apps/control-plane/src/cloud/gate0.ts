// Operator-only probe of the deployed v2 API and its real worker. It creates
// one disposable workspace from an existing Computer, with one stop/wake.
// No database access, Computer builds or model stand-ins. The operator's
// transport probe only inspects this workspace's existing Boat VM.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";
import type { Gate0Timing, Gate0TransportWorkspace } from "./gate0-transport.js";
import { RUNTIME_CANARY_HEADER, RuntimeCanaryClaimsSchema, RuntimeCanaryStatusSchema, type RuntimeCanaryClaims } from "./runtime-canary.js";

export const GATE0_AGENTS = ["codex", "claude", "cursor"] as const;
type Agent = typeof GATE0_AGENTS[number];
export const GATE0_DEFAULT_MODELS: Readonly<Record<Agent, string>> = Object.freeze({
  codex: "gpt-6-luna", claude: "claude-haiku-5-5", cursor: "default",
});
const FrameSchema = z.object({ type: z.string(), requestId: z.string().optional() }).passthrough();
type Frame = z.infer<typeof FrameSchema>;
const WorkspaceSchema = z.object({ id: z.string().uuid(), name: z.string(), repository: z.string(), branch: z.string(), baseBranch: z.string(), state: z.string(), boatSandboxId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  capabilities: z.object({ promptOutbox: z.literal(1).optional() }).passthrough().optional(),
  agentCost: z.object({ totalUsd: z.number().nonnegative(), estimated: z.boolean() }).nullable().optional() });
const PromptReceipt = z.object({ receipt: z.object({ userMessageId: z.string(), epoch: z.string() }).passthrough() });
const PromptStatuses = z.object({ items: z.array(z.object({ receipt: z.object({ userMessageId: z.string() }).passthrough(), state: z.string() }).passthrough()) });
const PROMPT_TERMINAL_STATES = ["completed", "failed", "cancelled", "interrupted"];
const WorkspaceReply = z.object({ workspace: WorkspaceSchema });
const Rows = z.object({ messages: z.array(z.object({ msgId: z.string(), kind: z.string(), payload: z.string() }).passthrough()) });
type MessageRows = z.infer<typeof Rows>["messages"];
const ProviderActivity = z.object({ notification: z.object({ update: z.object({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]),
}) }) });

/** Deliberately excludes response bodies, socket errors, URLs and credentials. `cause` is a closed class
 * (http_503, timeout, schema:workspace.branch, state_failed:<error code>, bridge_closed_1006, reply_<type>). */
export class Gate0Failure extends Error {
  readonly cause?: string;
  constructor(readonly stage: string, cause?: string) {
    const closed = cause === undefined ? undefined : /^[A-Za-z0-9_:.]{1,80}$/.test(cause) ? cause : "other";
    super(`Cloud v2 gate0 failed: ${stage}${closed ? ` (${closed})` : ""}`);
    if (closed) this.cause = closed;
  }
}
function requireCheck(value: unknown, stage: string, cause?: string): asserts value { if (!value) throw new Gate0Failure(stage, cause); }
function parse<T>(schema: z.ZodType<T>, value: unknown, stage: string): T {
  const result = schema.safeParse(value);
  // The failing field's path (schema keys and indexes only), never its value.
  if (!result.success) throw new Gate0Failure(stage, `schema:${result.error.issues[0]?.path.map(String).join(".") ?? ""}`);
  return result.data;
}
async function until<T>(stage: string, timeoutMs: number, pollMs: number, probe: () => Promise<T | false | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) throw new Gate0Failure(stage, "timeout");
    await sleep(pollMs);
  }
}

class BridgeProbe {
  readonly frames: Frame[] = [];
  private failed = false;
  /** Why the bridge stopped being usable: the first of a close (with its code), a socket error or an unusable frame. */
  private failure?: string;
  private fail(cause: string): void { this.failed = true; this.failure ??= cause; }
  private constructor(readonly socket: WebSocket, private readonly timeoutMs: number, private readonly pollMs: number) {
    socket.on("error", () => { this.fail("bridge_error"); });
    socket.on("close", code => { this.fail(`bridge_closed_${code}`); });
    socket.on("message", raw => {
      try {
        const parsed = FrameSchema.safeParse(JSON.parse(String(raw)));
        if (!parsed.success || this.frames.length >= 4096) { this.fail(parsed.success ? "bridge_frames_full" : "bridge_frame_invalid"); return; }
        this.frames.push(parsed.data);
      } catch { this.fail("bridge_frame_invalid"); }
    });
  }
  static async open(ticket: { url: string; protocols: string[] }, timeoutMs: number, pollMs: number): Promise<BridgeProbe> {
    const probe = new BridgeProbe(new WebSocket(ticket.url, ticket.protocols, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: Math.min(timeoutMs, 30_000) }), timeoutMs, pollMs);
    try {
      const ready = await probe.wait(frame => frame.type === "ENGINE_READY", "bridge_handshake");
      const { protocolVersion } = parse(z.object({ protocolVersion: z.number().int() }), ready, "bridge_handshake");
      probe.send("CONNECTED", { protocolVersion, capabilities: [] });
      return probe;
    } catch (error) { probe.close(); throw error; }
  }
  send(type: string, fields: Record<string, unknown> = {}): string {
    const id = randomUUID();
    if (this.socket.readyState !== WebSocket.OPEN) throw new Gate0Failure("bridge_disconnected", this.failure);
    this.socket.send(JSON.stringify({ id, source: "browser", timestamp: Date.now(), type, ...fields }));
    return id;
  }
  wait(predicate: (frame: Frame) => boolean, stage: string): Promise<Frame> {
    return until(stage, this.timeoutMs, this.pollMs, async () => {
      const found = this.frames.find(predicate);
      if (found) return found;
      requireCheck(!this.failed, stage, this.failure);
      return false;
    });
  }
  async request(type: string, fields: Record<string, unknown>, stage: string): Promise<Frame> {
    const id = this.send(type, fields);
    return this.wait(frame => frame.requestId === id, stage);
  }
  async op(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.request("WORKSPACE_REQUEST", { op, params }, op);
    requireCheck(reply.type === "WORKSPACE_RESPONSE", op, `reply_${reply.type}`);
    return reply.result;
  }
  close(): void { this.socket.terminate(); }
}

export type CloudV2Gate0Options = {
  apiOrigin: string;
  organizationId: string;
  repository: string;
  runtimeSha?: string;
  canary?: { token: string; claims: RuntimeCanaryClaims };
  transportProbe?(workspace: Gate0TransportWorkspace): Promise<void>;
  readTimings?(workspace: Gate0TransportWorkspace): Promise<Gate0Timing[]>;
  /** Log incomplete worker timings instead of failing, for a target whose VMs the operator may not read. */
  timingsOptional?: boolean;
  onMetric?(metric: Gate0Metric): void;
  accessToken(): Promise<string>;
  agents?: readonly Agent[];
  models?: Partial<Record<Agent, string>>;
  keep?: boolean;
  fetch?: typeof fetch;
  log?(message: string): void;
  timeoutMs?: number;
  pollMs?: number;
};

/** Wall-clock duration of one probe phase, as the API client observes it. */
export type Gate0Metric = { name: string; ms: number };
export type CloudV2Gate0Result = {
  workspaceId: string; agents: readonly Agent[]; deleted: boolean;
  metrics: Gate0Metric[];
  /** From create request to observed stop, plus wake request to observed deletion. An upper bound on billed VM time. */
  vmRunningMs: number;
  turns: number;
  /** The control plane's provider cost for this workspace, read before deletion. */
  agentCost?: { totalUsd: number; estimated: boolean };
};

export function gate0CanaryStatus(value: unknown, canary: NonNullable<CloudV2Gate0Options["canary"]>, workspaceId?: string) {
  const status = parse(RuntimeCanaryStatusSchema, value, "canary_identity"), c = canary.claims;
  requireCheck(status.grantId === c.jti && status.creatorUserId === c.creatorUserId && status.organizationId === c.organizationId &&
    status.repositoryId === c.repositoryId && status.runId === c.runId && status.runAttempt === c.runAttempt &&
    status.runtimeSha256 === c.runtimeSha256 && status.sourceSha === c.sourceSha && (!workspaceId || status.workspaceId === workspaceId) &&
    status.grantSha256 === createHash("sha256").update(canary.token).digest("hex") &&
    status.createKeySha256 === createHash("sha256").update(c.createKey).digest("hex") && status.deleted === (status.state === "deleted"), "canary_identity");
  return status;
}

function hasAnswer(rows: MessageRows, marker: string): boolean {
  return rows.some(row => {
    try {
      const payload = JSON.parse(row.payload);
      // Models answer the fixed prompt with "OK." or "ok." about as often as "ok".
      return row.kind === "text" && payload.role === "agent" && typeof payload.text === "string" &&
        payload.text.trim().replace(/[.!]+$/, "").toLowerCase() === marker;
    } catch { return false; }
  });
}
function sameRows(left: MessageRows, right: MessageRows): boolean {
  return left.length === right.length && left.every((row, index) => row.msgId === right[index]?.msgId && row.payload === right[index]?.payload);
}

export async function runCloudV2Gate0(options: CloudV2Gate0Options): Promise<CloudV2Gate0Result> {
  const agents = options.agents ?? GATE0_AGENTS;
  const canary = options.canary ? { token: options.canary.token, claims: parse(RuntimeCanaryClaimsSchema, options.canary.claims, "canary_configuration") } : undefined;
  requireCheck(!canary || (!options.keep && agents.length === GATE0_AGENTS.length && options.runtimeSha === canary.claims.runtimeSha256 &&
    options.organizationId.toLowerCase() === canary.claims.organizationId && canary.token.length > 0 && canary.token.length <= 4096), "canary_configuration");
  requireCheck(agents.length > 0 && agents.every(agent => GATE0_AGENTS.includes(agent)) && new Set(agents).size === agents.length, "agent_selection");
  const models = { ...GATE0_DEFAULT_MODELS, ...options.models };
  requireCheck(GATE0_AGENTS.every(agent => typeof models[agent] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/.test(models[agent])), "model_configuration");
  requireCheck(options.runtimeSha === undefined || /^[a-f0-9]{64}$/.test(options.runtimeSha), "runtime_pin");
  const timeoutMs = options.timeoutMs ?? 600_000, pollMs = options.pollMs ?? 1_000;
  const fetchImpl = options.fetch ?? fetch, log = options.log ?? (() => {});
  for (const agent of agents) log(`${agent} model=${models[agent]} effort=low${agent === "cursor" ? " (no native effort control)" : ""}`);
  const runId = canary?.claims.jti ?? randomUUID(), name = `gate0-${runId}`;
  const api = options.apiOrigin.replace(/\/+$/, ""), base = "/v1/cloud-v2/workspaces";
  const request = async (path: string, stage: string, method = "GET", body?: unknown, allowMissing = false): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${api}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
        headers: { authorization: `Bearer ${await options.accessToken()}`, "content-type": "application/json", ...(path === base && method === "POST"
          ? { "idempotency-key": canary?.claims.createKey ?? runId, ...(canary ? { [RUNTIME_CANARY_HEADER]: canary.token } : {}) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Gate0Failure(stage, `http_${response.status}`); }
      return await response.json();
    } catch (error) { throw error instanceof Gate0Failure ? error : new Gate0Failure(stage, "network"); }
  };
  const installed = parse(z.object({ repositories: z.array(z.object({ repository: z.string() })).nullable() }),
    await request(`/v1/cloud-v2/organizations/${options.organizationId}/computer/repositories`, "installed_repositories"), "installed_repositories");
  requireCheck(installed.repositories?.some(repo => repo.repository.toLowerCase() === options.repository.toLowerCase()), "repository_not_installed");

  let workspace: z.infer<typeof WorkspaceSchema> | undefined, bridge: BridgeProbe | undefined;
  let createAttempted = false, failed: unknown, deleted = false, agentCost: CloudV2Gate0Result["agentCost"];
  const canaryStatus = async (workspaceId?: string) => gate0CanaryStatus(
    await request(`/v1/cloud-v2/runtime-canaries/${canary!.claims.jti}`, "canary_identity"), canary!, workspaceId);
  const timedChats: Array<{ agent: Agent; chat: string }> = [];
  const metrics: Gate0Metric[] = [];
  let vmRunningMs = 0, vmSince: number | undefined, turns = 0;
  const now = () => performance.now();
  const measure = (name: string, startedAt: number) => {
    const metric = { name, ms: Math.round(now() - startedAt) };
    metrics.push(metric); options.onMetric?.(metric);
  };
  const vmStopped = () => { if (vmSince !== undefined) vmRunningMs += now() - vmSince; vmSince = undefined; };
  const current = async (stage: string) => parse(WorkspaceReply, await request(`${base}/${workspace!.id}`, stage), stage).workspace;
  const waitState = async (state: string) => until(state, timeoutMs, pollMs, async () => {
    const row = await current(state);
    requireCheck(row.state !== "failed" && row.state !== "deleting", state, row.state === "failed" ? `state_failed:${row.errorCode ?? "none"}` : "state_deleting");
    return row.state === state ? row : false;
  });
  const connect = async () => {
    const ticket = parse(z.object({ url: z.string().url(), protocols: z.array(z.string()).min(2).max(2) }),
      await request(`${base}/${workspace!.id}/connect`, "connect", "POST"), "connect");
    // Tickets belong only in the WebSocket protocol header, never a URL/log.
    const target = new URL(ticket.url), origin = new URL(api);
    requireCheck(["ws:", "wss:"].includes(target.protocol) && !target.username && !target.password && !target.search && !target.hash &&
      (target.protocol === "wss:" || origin.protocol === "http:" && target.host === origin.host) &&
      ticket.protocols[0] === "zeros.cloud.v2" && ticket.protocols[1]?.startsWith("ticket."), "connect_ticket");
    return BridgeProbe.open(ticket, timeoutMs, pollMs);
  };
  // A workspace advertising the outbox refuses bridge sends once execution
  // contexts are active; send and stop over HTTPS as the desktop does.
  let outbox = false;
  const sendPrompt = async (agentId: Agent, chatId: string, prompt: unknown[], stage: string) => parse(PromptReceipt,
    await request(`${base}/${workspace!.id}/prompts`, stage, "POST", { chatId, userMessageId: randomUUID(), agentId, model: models[agentId], effort: "low",
      prompt, startedAt: Date.now() }), stage).receipt;
  const promptState = async (chatId: string, userMessageId: string, stage: string) => parse(PromptStatuses,
    await request(`${base}/${workspace!.id}/prompts?chatId=${encodeURIComponent(chatId)}`, stage), stage)
    .items.find(item => item.receipt.userMessageId === userMessageId)?.state;
  const promptOutcome = (chatId: string, userMessageId: string, stage: string) => until(stage, timeoutMs, pollMs, async () => {
    const state = await promptState(chatId, userMessageId, stage);
    return state && PROMPT_TERMINAL_STATES.includes(state) ? state : false;
  });
  try {
    createAttempted = true;
    let startedAt = vmSince = now();
    workspace = parse(WorkspaceReply, await request(base, "create", "POST", { organizationId: options.organizationId, repository: options.repository, name }), "create").workspace;
    measure("create_request", startedAt);
    if (canary) await canaryStatus(workspace.id);
    startedAt = now(); workspace = await waitState("running"); measure("create_to_running", startedAt); log("create passed");
    outbox = workspace.capabilities?.promptOutbox === 1;
    log(`turns use ${outbox ? "the HTTPS prompt outbox" : "the bridge"}`);
    if (options.transportProbe) { await options.transportProbe(workspace); log("hybrid transport passed"); }
    startedAt = now();
    bridge = await connect();
    const nativeRow = WorkspaceSchema.pick({ id: true, branch: true, baseBranch: true }).extend({ path: z.string().startsWith("/") });
    const list = parse(z.object({ workspaces: z.array(nativeRow) }), await bridge.op("workspace.list", { withChanges: true }), "workspace_list");
    requireCheck(list.workspaces.length === 1 && list.workspaces[0]?.id === workspace.id && list.workspaces[0]?.branch === workspace.branch &&
      list.workspaces[0]?.baseBranch === workspace.baseBranch, "workspace_identity");
    const root = list.workspaces[0]!.path;
    const scope = { workspaceId: workspace.id, cwd: root };
    measure("connect", startedAt); log("connect passed");

    const available = parse(z.object({ agents: z.array(z.object({ id: z.string(), installed: z.boolean(), authenticated: z.boolean() })) }),
      await bridge.request("AGENT_LIST_AGENTS", {}, "agents_list"), "agents_list");
    for (const agent of agents) requireCheck(available.agents.some(row => row.id === agent && row.installed && row.authenticated), `agent_${agent}_login`);

    startedAt = now();
    const terminal = parse(z.object({ type: z.literal("PTY_CREATED"), sessionId: z.string(), cwd: z.string() }),
      await bridge.request("PTY_CREATE", { ...scope, sessionId: `gate0-${runId}`, cols: 120, rows: 30 }, "terminal_create"), "terminal_create");
    requireCheck(terminal.cwd === root, "terminal_cwd");
    const terminalMarker = `zeros-gate0-${runId}:${workspace.branch}`;
    const runtimeCheck = options.runtimeSha ? `test "$(readlink -f /opt/zeros/worker)" = '/opt/zeros/runtime/${options.runtimeSha}' && ` : "";
    bridge.send("PTY_WRITE", { sessionId: terminal.sessionId, data: `${runtimeCheck}printf 'zeros-gate0-%s:%s\\n' '${runId}' "$(git branch --show-current)"\n` });
    await until("terminal_output", timeoutMs, pollMs, async () => bridge!.frames.filter(f => f.type === "PTY_DATA" && f.sessionId === terminal.sessionId)
      .map(f => typeof f.data === "string" ? f.data : "").join("").includes(terminalMarker));
    bridge.send("PTY_KILL", { sessionId: terminal.sessionId }); measure("terminal", startedAt); log("terminal passed");

    startedAt = now();
    const path = `${root}/zeros-gate0-${runId}.txt`, content = `zeros gate0 ${runId}\n`;
    parse(z.object({ kind: z.literal("success") }), await bridge.op("file.write", { ...scope, path, content }), "file_write");
    const file = parse(z.object({ kind: z.literal("text"), content: z.string() }), await bridge.op("file.read", { ...scope, path }), "file_read");
    requireCheck(file.content === content, "file_content");
    const status = parse(z.object({ untracked: z.array(z.string()) }), await bridge.op("git.status", scope), "git_status");
    requireCheck(status.untracked.includes(path.slice(root.length + 1)), "git_untracked");
    await bridge.op("git.stage", { ...scope, paths: [path] });
    const diff = parse(z.object({ patch: z.string() }), await bridge.op("git.diff", { ...scope, mode: "index-vs-head", filePath: path, rawPatch: true }), "git_diff");
    requireCheck(diff.patch.includes(content.trim()), "git_diff_content");
    await bridge.op("git.unstage", { ...scope, paths: [path] }); measure("files_git", startedAt); log("files and git passed");

    const transcripts = new Map<string, MessageRows>();
    for (const agentId of agents) {
      const chatId = `gate0-${agentId}-${runId}`, marker = "ok";
      timedChats.push({ agent: agentId, chat: chatId.slice(-8) });
      await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId, model: models[agentId], effort: "low", title: "Gate0", createdAt: Date.now() } });
      const opened = parse(z.object({ type: z.literal("AGENT_SESSION_CREATED"), session: z.object({ sessionId: z.string() }) }),
        await bridge.request("AGENT_NEW_SESSION", { ...scope, agentId, chatId }, `agent_${agentId}_session`), `agent_${agentId}_session`);
      const sessionId = opened.session.sessionId;
      startedAt = now(); turns++;
      const prompt = [{ type: "text", text: "Reply with exactly: ok. Do not use tools or read files." }];
      if (outbox) {
        const sent = await sendPrompt(agentId, chatId, prompt, `agent_${agentId}_turn`);
        requireCheck(await promptOutcome(chatId, sent.userMessageId, `agent_${agentId}_turn`) === "completed", `agent_${agentId}_turn`);
      } else {
        const done = await bridge.request("AGENT_PROMPT", { agentId, sessionId, userMessageId: randomUUID(), prompt }, `agent_${agentId}_turn`);
        requireCheck(done.type === "AGENT_PROMPT_COMPLETE", `agent_${agentId}_turn`);
      }
      requireCheck(bridge.frames.some(frame => frame.type === "AGENT_SESSION_UPDATE" && frame.chatId === chatId), `agent_${agentId}_stream`);
      const rows = parse(Rows, await bridge.op("messages.window", { chatId }), `agent_${agentId}_history`).messages;
      requireCheck(hasAnswer(rows, marker), `agent_${agentId}_answer`);
      transcripts.set(chatId, rows); measure(`turn_${agentId}`, startedAt); log(`${agentId} turn passed`);
    }

    // A separate chat keeps earlier updates/receipts from satisfying Stop.
    // Wait for native activity, not our own recorded user row or running state.
    const agentId = (["claude", "codex", "cursor"] as const).find(agent => agents.includes(agent))!, chatId = `gate0-stop-${randomUUID()}`;
    timedChats.push({ agent: agentId, chat: chatId.slice(-8) });
    await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId, model: models[agentId], effort: "low", title: "Gate0 Stop", createdAt: Date.now() } });
    const opened = parse(z.object({ type: z.literal("AGENT_SESSION_CREATED"), session: z.object({ sessionId: z.string() }) }),
      await bridge.request("AGENT_NEW_SESSION", { ...scope, agentId, chatId }, "agent_stop_session"), "agent_stop_session");
    const sessionId = opened.session.sessionId;
    startedAt = now(); turns++;
    const stopPrompt = [{ type: "text", text: "Run only `sleep 60`, then reply ok. Do not read or edit files." }];
    const nativeActivity = (frame: Frame) => frame.type === "AGENT_SESSION_UPDATE" && frame.chatId === chatId && ProviderActivity.safeParse(frame).success;
    if (outbox) {
      const sent = await sendPrompt(agentId, chatId, stopPrompt, "agent_stop_live");
      const settled = async () => PROMPT_TERMINAL_STATES.includes(await promptState(chatId, sent.userMessageId, "agent_stop_live") ?? "");
      await until("agent_stop_live", timeoutMs, pollMs, async () => {
        if (bridge!.frames.some(nativeActivity)) return true;
        requireCheck(!await settled(), "agent_stop_live");
        return false;
      });
      requireCheck(!await settled(), "agent_stop_live");
      parse(z.object({ chatId: z.literal(chatId), epoch: z.string() }),
        await request(`${base}/${workspace.id}/prompts/stop`, "agent_stop_ack", "POST", { chatId, throughEpoch: sent.epoch }), "agent_stop_ack");
      requireCheck(await promptOutcome(chatId, sent.userMessageId, "agent_stop_complete") === "cancelled", "agent_stop_complete");
    } else {
      const promptId = bridge.send("AGENT_PROMPT", { agentId, sessionId, userMessageId: randomUUID(), prompt: stopPrompt });
      const terminalReply = (frame: Frame) => frame.requestId === promptId && ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "AGENT_ERROR"].includes(frame.type);
      const live = await bridge.wait(frame => terminalReply(frame) || nativeActivity(frame), "agent_stop_live");
      requireCheck(nativeActivity(live) && !bridge.frames.some(terminalReply), "agent_stop_live");
      const stopped = parse(z.object({ type: z.literal("WORKSPACE_RESPONSE"), op: z.literal("AGENT_CANCEL"),
        result: z.object({ conversationId: z.string(), state: z.literal("cancelled") }) }),
      await bridge.request("AGENT_CANCEL", { agentId, sessionId, chatId }, "agent_stop_ack"), "agent_stop_ack");
      // Both the WebSocket and HTTP probe speak native ids. The Mac wire maps
      // this conversationId back to the scoped renderer id.
      requireCheck(stopped.result.conversationId === chatId, "agent_stop_ack");
      const cancelled = await bridge.wait(terminalReply, "agent_stop_complete");
      requireCheck(cancelled.type === "AGENT_PROMPT_COMPLETE" && cancelled.stopReason === "cancelled", "agent_stop_complete");
    }
    transcripts.set(chatId, parse(Rows, await bridge.op("messages.window", { chatId }), "agent_stop_history").messages);
    measure("stop_turn", startedAt); log("live turn Stop passed");

    let incompleteTimings = false;
    if (options.readTimings) {
      const timings = await options.readTimings(workspace);
      for (const chat of timedChats) {
        const records = timings.filter(row => row.agent === chat.agent && row.chat === chat.chat);
        for (const row of records) log(`worker timing ${row.agent} ${row.chat} ${row.phase} ${row.stage} ${row.elapsedMs}ms`);
        for (const [phase, stages] of [
          ["open", ["open_received", "driver_ready"]],
          ["turn", ["turn_received", "driver_ready", "turn_sent", "first_provider_event", "turn_done"]],
        ] as const) {
          const complete = stages.every(stage => records.some(row => row.phase === phase && row.stage === stage));
          if (!complete && options.timingsOptional) incompleteTimings = true;
          else requireCheck(complete, "worker_timings");
        }
      }
      if (incompleteTimings) log("worker timings incomplete; not required for this target");
    }

    // Wait for every final row to reach the mirror before a deliberate stop.
    startedAt = now();
    // Compare with the VM's current rows each time: a stopped turn's last row can still settle after the snapshot above.
    for (const [chatId, rows] of transcripts) await until("history_mirror", timeoutMs, pollMs, async () => {
      const current = parse(Rows, await bridge!.op("messages.window", { chatId }), "history_mirror").messages;
      requireCheck(current.length >= rows.length, "history_mirror");
      const mirrored = parse(z.object({ result: Rows }), await request(`${base}/${workspace!.id}/history`, "history_mirror", "POST", { op: "messages.window", params: { chatId } }), "history_mirror");
      if (!sameRows(current, mirrored.result.messages)) return false;
      // Later offline and wake checks compare with these settled rows.
      transcripts.set(chatId, current); return true;
    });
    measure("history_mirror", startedAt);
    bridge.close(); bridge = undefined;
    startedAt = now(); await request(`${base}/${workspace.id}/stop`, "stop", "POST"); measure("stop_request", startedAt);
    startedAt = now(); await waitState("stopped"); measure("stop_to_stopped", startedAt); vmStopped();
    startedAt = now();
    const offline = parse(z.object({ result: z.object({ chats: z.array(z.object({ id: z.string() })) }) }),
      await request(`${base}/${workspace.id}/history`, "offline_chats", "POST", { op: "chats.list" }), "offline_chats");
    requireCheck([...transcripts.keys()].every(id => offline.result.chats.some(chat => chat.id === id)), "offline_chats");
    for (const [chatId, rows] of transcripts) {
      const mirrored = parse(z.object({ result: Rows }), await request(`${base}/${workspace.id}/history`, "offline_messages", "POST", { op: "messages.window", params: { chatId } }), "offline_messages");
      requireCheck(sameRows(rows, mirrored.result.messages), "offline_messages");
      const beforeMsgId = rows.at(-1)?.msgId, limit = 2;
      requireCheck(beforeMsgId, "offline_messages_older");
      const older = parse(z.object({ result: Rows }), await request(`${base}/${workspace.id}/history`, "offline_messages_older", "POST",
        { op: "messages.windowOlder", params: { chatId, beforeMsgId, limit } }), "offline_messages_older");
      requireCheck(sameRows(rows.slice(Math.max(0, rows.length - 1 - limit), -1), older.result.messages), "offline_messages_older");
    }
    requireCheck((await current("offline_stays_stopped")).state === "stopped", "offline_stays_stopped");
    measure("offline_history", startedAt); log("stop and offline history passed");
    startedAt = vmSince = now(); await request(`${base}/${workspace.id}/start`, "wake", "POST"); measure("wake_request", startedAt);
    startedAt = now(); workspace = await waitState("running"); measure("wake_to_running", startedAt);
    if (options.transportProbe) { await options.transportProbe(workspace); log("hybrid wake transport passed"); }
    startedAt = now(); bridge = await connect(); measure("wake_connect", startedAt);
    startedAt = now();
    if (canary) {
      const terminal = parse(z.object({ type: z.literal("PTY_CREATED"), sessionId: z.string() }),
        await bridge.request("PTY_CREATE", { ...scope, sessionId: `gate0-wake-${runId}`, cols: 120, rows: 30 }, "wake_runtime"), "wake_runtime");
      bridge.send("PTY_WRITE", { sessionId: terminal.sessionId, data: `test "$(readlink -f /opt/zeros/worker)" = '/opt/zeros/runtime/${options.runtimeSha}' && printf 'zeros-gate0-%s:%s\\n' '${runId}' "$(git branch --show-current)"\n` });
      await until("wake_runtime", timeoutMs, pollMs, async () => bridge!.frames.filter(f => f.type === "PTY_DATA" && f.sessionId === terminal.sessionId)
        .map(f => typeof f.data === "string" ? f.data : "").join("").includes(terminalMarker));
      bridge.send("PTY_KILL", { sessionId: terminal.sessionId });
    }
    for (const [chatId, rows] of transcripts) requireCheck(sameRows(rows, parse(Rows, await bridge.op("messages.window", { chatId }), "wake_history").messages), "wake_history");
    requireCheck(parse(z.object({ content: z.string() }), await bridge.op("file.read", { ...scope, path }), "wake_file").content === content, "wake_file");
    measure("wake_checks", startedAt); log("wake and persisted data passed");
  } catch (error) { failed = error instanceof Gate0Failure ? error : new Gate0Failure("unexpected_failure"); }
  finally {
    bridge?.close();
    if (!options.keep && createAttempted) {
      try {
        // A lost POST response is ambiguous; cleanup needs this run's grant
        // identity (or its unique name for the ordinary operator probe).
        let cleanupId = workspace?.id;
        if (!cleanupId && canary) cleanupId = (await canaryStatus()).workspaceId;
        if (!cleanupId) {
          const listed = parse(z.object({ workspaces: z.array(WorkspaceSchema) }), await request(`${base}?organizationId=${options.organizationId}`, "cleanup_lookup"), "cleanup_lookup");
          const matches = listed.workspaces.filter(row => row.name === name && row.repository.toLowerCase() === options.repository.toLowerCase());
          requireCheck(matches.length <= 1, "cleanup_identity"); workspace = matches[0];
          cleanupId = workspace?.id;
        }
        if (cleanupId) {
          // Best effort: the cost read must never block cleanup.
          try { agentCost = parse(WorkspaceReply, await request(`${base}/${cleanupId}`, "agent_cost"), "agent_cost").workspace.agentCost ?? undefined; } catch { /* reported as absent */ }
          const startedAt = now();
          await request(`${base}/${cleanupId}`, "delete", "DELETE", undefined, !!canary);
          await until("delete", timeoutMs, pollMs, async () => {
            if (canary) return (await canaryStatus(cleanupId)).deleted;
            const reply = await request(`${base}/${cleanupId}`, "delete", "GET", undefined, true);
            return reply === null || parse(WorkspaceReply, reply, "delete").workspace.state === "deleted";
          });
          measure("delete_to_deleted", startedAt); vmStopped(); deleted = true; log("delete passed");
        }
      } catch { log("cleanup incomplete; inspect this gate0 workspace before rerunning"); failed ??= new Gate0Failure("cleanup"); }
    }
  }
  if (failed) throw failed;
  requireCheck(workspace, "workspace_missing");
  return { workspaceId: workspace.id, agents, deleted, metrics, vmRunningMs: Math.round(vmRunningMs), turns, ...(agentCost ? { agentCost } : {}) };
}
