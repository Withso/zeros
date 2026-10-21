// Operator-only probe of the deployed v2 API and its real worker. It creates
// one disposable workspace from an existing Computer, with one stop/wake.
// No database access, Computer builds, direct Boat calls or model stand-ins.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";

export const GATE0_AGENTS = ["codex", "claude", "cursor"] as const;
type Agent = typeof GATE0_AGENTS[number];
const FrameSchema = z.object({ type: z.string(), requestId: z.string().optional() }).passthrough();
type Frame = z.infer<typeof FrameSchema>;
const WorkspaceSchema = z.object({ id: z.string().uuid(), name: z.string(), repository: z.string(), branch: z.string(), baseBranch: z.string(), state: z.string() });
const WorkspaceReply = z.object({ workspace: WorkspaceSchema });
const Rows = z.object({ messages: z.array(z.object({ msgId: z.string(), kind: z.string(), payload: z.string() }).passthrough()) });
type MessageRows = z.infer<typeof Rows>["messages"];

/** Deliberately excludes response bodies, socket errors, URLs and credentials. */
export class Gate0Failure extends Error {
  constructor(readonly stage: string) { super(`Cloud v2 gate0 failed: ${stage}`); }
}
function requireCheck(value: unknown, stage: string): asserts value { if (!value) throw new Gate0Failure(stage); }
function parse<T>(schema: z.ZodType<T>, value: unknown, stage: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Gate0Failure(stage);
  return result.data;
}
async function until<T>(stage: string, timeoutMs: number, pollMs: number, probe: () => Promise<T | false | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) throw new Gate0Failure(stage);
    await sleep(pollMs);
  }
}

class BridgeProbe {
  readonly frames: Frame[] = [];
  private failed = false;
  private constructor(readonly socket: WebSocket, private readonly timeoutMs: number, private readonly pollMs: number) {
    socket.on("error", () => { this.failed = true; });
    socket.on("close", () => { this.failed = true; });
    socket.on("message", raw => {
      try {
        const parsed = FrameSchema.safeParse(JSON.parse(String(raw)));
        if (!parsed.success || this.frames.length >= 4096) { this.failed = true; return; }
        this.frames.push(parsed.data);
      } catch { this.failed = true; }
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
    if (this.socket.readyState !== WebSocket.OPEN) throw new Gate0Failure("bridge_disconnected");
    this.socket.send(JSON.stringify({ id, source: "browser", timestamp: Date.now(), type, ...fields }));
    return id;
  }
  wait(predicate: (frame: Frame) => boolean, stage: string): Promise<Frame> {
    return until(stage, this.timeoutMs, this.pollMs, async () => {
      const found = this.frames.find(predicate);
      if (found) return found;
      requireCheck(!this.failed, stage);
      return false;
    });
  }
  async request(type: string, fields: Record<string, unknown>, stage: string): Promise<Frame> {
    const id = this.send(type, fields);
    return this.wait(frame => frame.requestId === id, stage);
  }
  async op(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.request("WORKSPACE_REQUEST", { op, params }, op);
    requireCheck(reply.type === "WORKSPACE_RESPONSE", op);
    return reply.result;
  }
  close(): void { this.socket.terminate(); }
}

export type CloudV2Gate0Options = {
  apiOrigin: string;
  organizationId: string;
  repository: string;
  runtimeSha?: string;
  accessToken(): Promise<string>;
  agents?: readonly Agent[];
  keep?: boolean;
  fetch?: typeof fetch;
  log?(message: string): void;
  timeoutMs?: number;
  pollMs?: number;
};

function hasAnswer(rows: MessageRows, marker: string): boolean {
  return rows.some(row => {
    try {
      const payload = JSON.parse(row.payload);
      return row.kind === "text" && payload.role === "agent" && typeof payload.text === "string" && payload.text.includes(marker);
    } catch { return false; }
  });
}
function sameRows(left: MessageRows, right: MessageRows): boolean {
  return left.length === right.length && left.every((row, index) => row.msgId === right[index]?.msgId && row.payload === right[index]?.payload);
}

export async function runCloudV2Gate0(options: CloudV2Gate0Options): Promise<{ workspaceId: string; agents: readonly Agent[]; deleted: boolean }> {
  const agents = options.agents ?? GATE0_AGENTS;
  requireCheck(agents.length > 0 && agents.every(agent => GATE0_AGENTS.includes(agent)) && new Set(agents).size === agents.length, "agent_selection");
  requireCheck(options.runtimeSha === undefined || /^[a-f0-9]{64}$/.test(options.runtimeSha), "runtime_pin");
  const timeoutMs = options.timeoutMs ?? 600_000, pollMs = options.pollMs ?? 1_000;
  const fetchImpl = options.fetch ?? fetch, log = options.log ?? (() => {});
  const runId = randomUUID(), name = `gate0-${runId}`;
  const api = options.apiOrigin.replace(/\/+$/, ""), base = "/v1/cloud-v2/workspaces";
  const request = async (path: string, stage: string, method = "GET", body?: unknown, allowMissing = false): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${api}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
        headers: { authorization: `Bearer ${await options.accessToken()}`, "content-type": "application/json", ...(path === base && method === "POST" ? { "idempotency-key": runId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Gate0Failure(stage); }
      return await response.json();
    } catch { throw new Gate0Failure(stage); }
  };
  const installed = parse(z.object({ repositories: z.array(z.object({ repository: z.string() })).nullable() }),
    await request(`/v1/cloud-v2/organizations/${options.organizationId}/computer/repositories`, "installed_repositories"), "installed_repositories");
  requireCheck(installed.repositories?.some(repo => repo.repository.toLowerCase() === options.repository.toLowerCase()), "repository_not_installed");

  let workspace: z.infer<typeof WorkspaceSchema> | undefined, bridge: BridgeProbe | undefined;
  let createAttempted = false, failed: unknown, deleted = false;
  const current = async (stage: string) => parse(WorkspaceReply, await request(`${base}/${workspace!.id}`, stage), stage).workspace;
  const waitState = async (state: string) => until(state, timeoutMs, pollMs, async () => {
    const row = await current(state);
    requireCheck(row.state !== "failed" && row.state !== "deleting", state);
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
  try {
    createAttempted = true;
    workspace = parse(WorkspaceReply, await request(base, "create", "POST", { organizationId: options.organizationId, repository: options.repository, name }), "create").workspace;
    await waitState("running"); log("create passed");
    bridge = await connect();
    const nativeRow = WorkspaceSchema.pick({ id: true, branch: true, baseBranch: true }).extend({ path: z.string().startsWith("/") });
    const list = parse(z.object({ workspaces: z.array(nativeRow) }), await bridge.op("workspace.list", { withChanges: true }), "workspace_list");
    requireCheck(list.workspaces.length === 1 && list.workspaces[0]?.id === workspace.id && list.workspaces[0]?.branch === workspace.branch &&
      list.workspaces[0]?.baseBranch === workspace.baseBranch, "workspace_identity");
    const root = list.workspaces[0]!.path;
    const scope = { workspaceId: workspace.id, cwd: root };
    log("connect passed");

    const available = parse(z.object({ agents: z.array(z.object({ id: z.string(), installed: z.boolean(), authenticated: z.boolean() })) }),
      await bridge.request("AGENT_LIST_AGENTS", {}, "agents_list"), "agents_list");
    for (const agent of agents) requireCheck(available.agents.some(row => row.id === agent && row.installed && row.authenticated), `agent_${agent}_login`);

    const terminal = parse(z.object({ type: z.literal("PTY_CREATED"), sessionId: z.string(), cwd: z.string() }),
      await bridge.request("PTY_CREATE", { ...scope, sessionId: `gate0-${runId}`, cols: 120, rows: 30 }, "terminal_create"), "terminal_create");
    requireCheck(terminal.cwd === root, "terminal_cwd");
    const terminalMarker = `zeros-gate0-${runId}:${workspace.branch}`;
    const runtimeCheck = options.runtimeSha ? `test "$(readlink -f /opt/zeros/worker)" = '/opt/zeros/runtime/${options.runtimeSha}' && ` : "";
    bridge.send("PTY_WRITE", { sessionId: terminal.sessionId, data: `${runtimeCheck}printf 'zeros-gate0-%s:%s\\n' '${runId}' "$(git branch --show-current)"\n` });
    await until("terminal_output", timeoutMs, pollMs, async () => bridge!.frames.filter(f => f.type === "PTY_DATA" && f.sessionId === terminal.sessionId)
      .map(f => typeof f.data === "string" ? f.data : "").join("").includes(terminalMarker));
    bridge.send("PTY_KILL", { sessionId: terminal.sessionId }); log("terminal passed");

    const path = `${root}/zeros-gate0-${runId}.txt`, content = `zeros gate0 ${runId}\n`;
    parse(z.object({ kind: z.literal("success") }), await bridge.op("file.write", { ...scope, path, content }), "file_write");
    const file = parse(z.object({ kind: z.literal("text"), content: z.string() }), await bridge.op("file.read", { ...scope, path }), "file_read");
    requireCheck(file.content === content, "file_content");
    const status = parse(z.object({ untracked: z.array(z.string()) }), await bridge.op("git.status", scope), "git_status");
    requireCheck(status.untracked.includes(path.slice(root.length + 1)), "git_untracked");
    await bridge.op("git.stage", { ...scope, paths: [path] });
    const diff = parse(z.object({ patch: z.string() }), await bridge.op("git.diff", { ...scope, mode: "index-vs-head", filePath: path, rawPatch: true }), "git_diff");
    requireCheck(diff.patch.includes(content.trim()), "git_diff_content");
    await bridge.op("git.unstage", { ...scope, paths: [path] }); log("files and git passed");

    const transcripts = new Map<string, MessageRows>();
    for (const agentId of agents) {
      const chatId = `gate0-${agentId}-${runId}`, marker = `zeros-gate0-${randomUUID()}`;
      await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId, title: "Gate0", createdAt: Date.now() } });
      const opened = parse(z.object({ type: z.literal("AGENT_SESSION_CREATED"), session: z.object({ sessionId: z.string() }) }),
        await bridge.request("AGENT_NEW_SESSION", { ...scope, agentId, chatId }, `agent_${agentId}_session`), `agent_${agentId}_session`);
      const sessionId = opened.session.sessionId;
      const done = await bridge.request("AGENT_PROMPT", { agentId, sessionId, userMessageId: randomUUID(),
        prompt: [{ type: "text", text: `Reply with exactly ${marker}. Do not use tools or change files.` }] }, `agent_${agentId}_turn`);
      requireCheck(done.type === "AGENT_PROMPT_COMPLETE", `agent_${agentId}_turn`);
      requireCheck(bridge.frames.some(frame => frame.type === "AGENT_SESSION_UPDATE" && frame.chatId === chatId), `agent_${agentId}_stream`);
      const rows = parse(Rows, await bridge.op("messages.window", { chatId }), `agent_${agentId}_history`).messages;
      requireCheck(hasAnswer(rows, marker), `agent_${agentId}_answer`);
      transcripts.set(chatId, rows); log(`${agentId} turn passed`);
    }

    // Wait for every final row to reach the mirror before a deliberate stop.
    for (const [chatId, rows] of transcripts) await until("history_mirror", timeoutMs, pollMs, async () => {
      const mirrored = parse(z.object({ result: Rows }), await request(`${base}/${workspace!.id}/history`, "history_mirror", "POST", { op: "messages.window", params: { chatId } }), "history_mirror");
      return sameRows(rows, mirrored.result.messages);
    });
    bridge.close(); bridge = undefined;
    await request(`${base}/${workspace.id}/stop`, "stop", "POST"); await waitState("stopped");
    const offline = parse(z.object({ result: z.object({ chats: z.array(z.object({ id: z.string() })) }) }),
      await request(`${base}/${workspace.id}/history`, "offline_chats", "POST", { op: "chats.list" }), "offline_chats");
    requireCheck([...transcripts.keys()].every(id => offline.result.chats.some(chat => chat.id === id)), "offline_chats");
    for (const [chatId, rows] of transcripts) {
      const mirrored = parse(z.object({ result: Rows }), await request(`${base}/${workspace.id}/history`, "offline_messages", "POST", { op: "messages.window", params: { chatId } }), "offline_messages");
      requireCheck(sameRows(rows, mirrored.result.messages), "offline_messages");
    }
    requireCheck((await current("offline_stays_stopped")).state === "stopped", "offline_stays_stopped"); log("stop and offline history passed");
    await request(`${base}/${workspace.id}/start`, "wake", "POST"); await waitState("running");
    bridge = await connect();
    for (const [chatId, rows] of transcripts) requireCheck(sameRows(rows, parse(Rows, await bridge.op("messages.window", { chatId }), "wake_history").messages), "wake_history");
    requireCheck(parse(z.object({ content: z.string() }), await bridge.op("file.read", { ...scope, path }), "wake_file").content === content, "wake_file");
    log("wake and persisted data passed");
  } catch (error) { failed = error instanceof Gate0Failure ? error : new Gate0Failure("unexpected_failure"); }
  finally {
    bridge?.close();
    if (!options.keep && createAttempted) {
      try {
        // A lost POST response is ambiguous. Find only this run's unique name;
        // never retry creation or delete another run's workspace.
        if (!workspace) {
          const listed = parse(z.object({ workspaces: z.array(WorkspaceSchema) }), await request(`${base}?organizationId=${options.organizationId}`, "cleanup_lookup"), "cleanup_lookup");
          const matches = listed.workspaces.filter(row => row.name === name && row.repository.toLowerCase() === options.repository.toLowerCase());
          requireCheck(matches.length <= 1, "cleanup_identity"); workspace = matches[0];
        }
        if (workspace) {
          await request(`${base}/${workspace.id}`, "delete", "DELETE");
          await until("delete", timeoutMs, pollMs, async () => {
            const reply = await request(`${base}/${workspace!.id}`, "delete", "GET", undefined, true);
            return reply === null || parse(WorkspaceReply, reply, "delete").workspace.state === "deleted";
          });
          deleted = true; log("delete passed");
        }
      } catch { log("cleanup incomplete; inspect this gate0 workspace before rerunning"); failed ??= new Gate0Failure("cleanup"); }
    }
  }
  if (failed) throw failed;
  requireCheck(workspace, "workspace_missing");
  return { workspaceId: workspace.id, agents, deleted };
}
