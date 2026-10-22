import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runCloudV2Gate0 } from "./gate0.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Faults = { cancelAck?: "missing" | "request" | "chat" | "state"; completedBeforeStop?: boolean; older?: "anchor" | "wrong" };
async function fixture(failAgent?: string, protocolVersion = 21, faults: Faults = {}) {
  const id = randomUUID(), organizationId = randomUUID();
  const repository = "example/project", root = `/home/user/${repository}`, branch = "zeros/gate0";
  const calls: { method: string; path: string; body: any }[] = [];
  const frames: any[] = [], chats = new Map<string, any[]>(), files = new Map<string, string>();
  const sessions = new Map<string, string>(), tickets = new Set<string>(), activePrompts = new Map<string, any>();
  const logs: string[] = [];
  let state = "absent", name = "", staged = false, connections = 0;
  const workspace = () => ({ id, organizationId, repository, branch, baseBranch: "master", name, state, boatSandboxId: "bx_23456789" });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = request.url!, method = request.method!;
    calls.push({ method, path, body });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer synthetic-gate0-access") return json({}, 401);
    if (path.endsWith("/computer/repositories")) return json({ repositories: [{ repository, defaultBranch: "master" }] });
    if (method === "POST" && path === "/v1/cloud-v2/workspaces") {
      expect(request.headers["idempotency-key"]).toBeTypeOf("string");
      name = body.name; state = "running"; return json({ workspace: workspace() }, 201);
    }
    if (method === "GET" && path.startsWith("/v1/cloud-v2/workspaces?")) return json({ workspaces: state === "absent" ? [] : [workspace()] });
    if (method === "GET" && path === `/v1/cloud-v2/workspaces/${id}`) return state === "deleted" ? json({}, 404) : json({ workspace: workspace() });
    if (path.endsWith("/connect")) {
      const ticket = `ticket.${randomUUID()}`; tickets.add(ticket);
      return json({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/bridge`, protocols: ["zeros.cloud.v2", ticket] });
    }
    if (path.endsWith("/stop")) { state = "stopped"; return json({ workspace: workspace() }, 202); }
    if (path.endsWith("/start")) { state = "running"; return json({ workspace: workspace() }, 202); }
    if (path.endsWith("/history")) {
      if (body.op === "chats.list") return json({ result: { chats: [...chats.keys()].map(id => ({ id })), chatDeletions: [] } });
      const rows = chats.get(body.params.chatId) ?? [];
      if (body.op === "messages.windowOlder") {
        const anchor = rows.findIndex(row => row.msgId === body.params.beforeMsgId);
        const end = anchor + (faults.older === "anchor" ? 1 : 0);
        const messages = faults.older === "wrong" ? [] : rows.slice(Math.max(0, end - body.params.limit), end);
        return json({ result: { messages } });
      }
      return json({ result: { messages: rows } });
    }
    if (method === "DELETE" && path === `/v1/cloud-v2/workspaces/${id}`) { state = "deleted"; return json({ workspace: workspace() }, 202); }
    return json({}, 404);
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => "zeros.cloud.v2" });
  server.on("upgrade", (request, socket, head) => {
    const offered = request.headers["sec-websocket-protocol"]?.split(",").map(v => v.trim()) ?? [];
    const ticket = offered.find(v => tickets.has(v));
    expect(offered[0]).toBe("zeros.cloud.v2");
    if (!ticket) { socket.destroy(); return; }
    tickets.delete(ticket); connections++;
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
  });
  wss.on("connection", ws => {
    const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify({ id: randomUUID(), source: "engine", timestamp: Date.now(), ...frame }));
    send({ type: "ENGINE_READY", protocolVersion, minProtocolVersion: 2 });
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      const reply = (type: string, fields: object = {}) => send({ type, requestId: frame.id, ...fields });
      if (frame.type === "WORKSPACE_REQUEST") {
        const p = frame.params;
        const result = (() => {
          switch (frame.op) {
            // Native Local/worker row, not the HTTP workspace document.
            case "workspace.list": return { workspaces: [{ id, path: root, repoRoot: root, repoSlug: repository,
              branch, baseBranch: "master", status: "in-progress", kind: "code", placement: "cloud", organizationId }] };
            case "file.write": files.set(p.path, p.content); return { kind: "success" };
            case "file.read": return { kind: "text", content: files.get(p.path) };
            case "git.status": return { untracked: staged ? [] : [...files.keys()].map(path => path.slice(root.length + 1)) };
            case "git.stage": staged = true; return { ok: true };
            case "git.unstage": staged = false; return { ok: true };
            case "git.diff": return { patch: `+${[...files.values()].join("")}`, hunks: [{}] };
            case "chats.upsert": chats.set(p.chat.id, []); return {};
            case "messages.window": return { messages: chats.get(p.chatId) ?? [] };
          }
          throw new Error(`Unexpected fake op ${frame.op}`);
        })();
        return reply("WORKSPACE_RESPONSE", { result });
      }
      if (frame.type === "PTY_CREATE") return reply("PTY_CREATED", { sessionId: frame.sessionId, cwd: root });
      if (frame.type === "PTY_WRITE") {
        const marker = /'([a-f0-9-]{36})'/.exec(frame.data)?.[1];
        return send({ type: "PTY_DATA", sessionId: frame.sessionId, data: `zeros-gate0-${marker}:${branch}\r\n` });
      }
      if (frame.type === "AGENT_LIST_AGENTS") return reply("AGENT_AGENTS_LIST", {
        agents: ["codex", "claude", "cursor"].map(id => ({ id, installed: true, authenticated: true })),
      });
      if (frame.type === "AGENT_NEW_SESSION") {
        const sessionId = randomUUID(); sessions.set(sessionId, frame.chatId);
        return reply("AGENT_SESSION_CREATED", { session: { sessionId } });
      }
      if (frame.type === "AGENT_PROMPT") {
        const chatId = sessions.get(frame.sessionId)!;
        if (frame.agentId === failAgent) return reply("AGENT_PROMPT_FAILED", { message: "provider-secret-must-not-appear" });
        if (chatId.startsWith("gate0-stop-")) {
          activePrompts.set(frame.sessionId, frame);
          chats.set(chatId, [
            { msgId: frame.userMessageId, kind: "text", payload: JSON.stringify({ role: "user", text: frame.prompt[0].text }), createdAt: 1 },
            { msgId: randomUUID(), kind: "text", payload: JSON.stringify({ role: "agent", text: "Waiting" }), createdAt: 2 },
          ]);
          send({ type: "AGENT_SESSION_UPDATE", chatId, notification: { sessionId: frame.sessionId, update: { sessionUpdate: "turn_state", state: "running" } } });
          send({ type: "AGENT_SESSION_UPDATE", chatId, notification: { sessionId: frame.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Waiting" } } } });
          if (faults.completedBeforeStop) { activePrompts.delete(frame.sessionId); reply("AGENT_PROMPT_COMPLETE", { stopReason: "end_turn" }); }
          return;
        }
        const marker = /zeros-gate0-[a-f0-9-]+/.exec(frame.prompt[0].text)![0];
        chats.set(chatId, [
          { msgId: frame.userMessageId, kind: "text", payload: JSON.stringify({ role: "user", text: frame.prompt[0].text }), createdAt: 1 },
          { msgId: randomUUID(), kind: "text", payload: JSON.stringify({ role: "agent", text: marker }), createdAt: 2 },
        ]);
        send({ type: "AGENT_SESSION_UPDATE", chatId, notification: { sessionId: frame.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: marker } } } });
        return reply("AGENT_PROMPT_COMPLETE");
      }
      if (frame.type === "AGENT_CANCEL") {
        const prompt = activePrompts.get(frame.sessionId);
        expect(prompt).toBeDefined(); activePrompts.delete(frame.sessionId);
        const chatId = sessions.get(frame.sessionId)!;
        expect(frame.chatId).toBe(chatId);
        const rows = chats.get(chatId)!;
        rows[1].payload = JSON.stringify({ role: "agent", text: "Stopped" });
        send({ type: "AGENT_PROMPT_COMPLETE", requestId: prompt.id, stopReason: "cancelled" });
        if (faults.cancelAck !== "missing") reply("WORKSPACE_RESPONSE", {
          op: "AGENT_CANCEL", requestId: faults.cancelAck === "request" ? prompt.id : frame.id,
          result: { conversationId: faults.cancelAck === "chat" ? "foreign-chat" : chatId, state: faults.cancelAck === "state" ? "succeeded" : "cancelled" },
        });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const options = { apiOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, organizationId, repository,
    accessToken: async () => "synthetic-gate0-access", log: (line: string) => logs.push(line), pollMs: 1, timeoutMs: 2_000 };
  return { options, calls, frames, logs, connections: () => connections, state: () => state };
}

describe("cloud v2 gate0 through a fake HTTP control plane and relay", () => {
  it("checks the existing VM's hybrid route on create and wake, within the one-workspace budget", async () => {
    const f = await fixture(), transportProbe = vi.fn(async (_workspace: unknown) => {});
    const result = await runCloudV2Gate0({ ...f.options, transportProbe });
    expect(transportProbe).toHaveBeenCalledTimes(2);
    for (const call of transportProbe.mock.calls) expect(call[0]).toMatchObject({ id: result.workspaceId, boatSandboxId: "bx_23456789", state: "running" });
    expect(f.calls.filter(call => call.method === "POST" && call.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
    expect(f.calls.filter(call => call.path.endsWith("/start"))).toHaveLength(1);
  });
  it.each([20, 21])("uses protocol %s, checks all three turns and native file/git/PTY frames, then stops, reads history, wakes and deletes one workspace", async protocolVersion => {
    const f = await fixture(undefined, protocolVersion);
    await expect(runCloudV2Gate0(f.options)).resolves.toMatchObject({ agents: ["codex", "claude", "cursor"], deleted: true });
    expect(f.calls.filter(c => c.method === "POST" && c.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
    expect(f.calls.find(c => c.path === "/v1/cloud-v2/workspaces")?.body).not.toHaveProperty("baseBranch");
    expect(f.calls.filter(c => c.path.endsWith("/stop"))).toHaveLength(1);
    expect(f.calls.filter(c => c.path.endsWith("/start"))).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
    expect(f.connections()).toBe(2);
    const handshakes = f.frames.filter(frame => frame.type === "CONNECTED");
    expect(handshakes).toHaveLength(2);
    for (const frame of handshakes) expect(frame).toMatchObject({ source: "browser", protocolVersion, capabilities: [] });
    expect(f.frames.filter(f => f.type === "AGENT_PROMPT").map(f => f.agentId)).toEqual(["codex", "claude", "cursor", "codex"]);
    const cancel = f.frames.filter(frame => frame.type === "AGENT_CANCEL");
    expect(cancel).toHaveLength(1);
    expect(cancel[0]).toMatchObject({ agentId: "codex", chatId: expect.stringMatching(/^gate0-stop-/) });
    expect(f.calls.filter(c => c.path.endsWith("/history") && c.body.op === "messages.windowOlder")).toHaveLength(4);
    expect(f.frames.filter(f => f.type === "WORKSPACE_REQUEST").map(f => f.op)).toEqual(expect.arrayContaining(["file.write", "file.read", "git.status", "git.stage", "git.diff", "git.unstage"]));
    expect(f.calls.some(c => c.path.includes("/builds"))).toBe(false);
    expect(f.state()).toBe("deleted");
    expect(f.logs.join("\n")).not.toContain("synthetic-gate0-access");
  });

  it.each(["missing", "request", "chat", "state"] as const)("fails and cleans up a %s Stop acknowledgement even when the prompt completes", async cancelAck => {
    const f = await fixture(undefined, 21, { cancelAck });
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_stop_ack");
    expect(f.state()).toBe("deleted");
    expect(f.calls.some(c => c.path.endsWith("/stop"))).toBe(false);
  });

  it("requires a live turn for the Stop probe", async () => {
    const f = await fixture(undefined, 21, { completedBeforeStop: true });
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_stop_live");
    expect(f.frames.some(frame => frame.type === "AGENT_CANCEL")).toBe(false);
    expect(f.state()).toBe("deleted");
  });

  it.each(["anchor", "wrong"] as const)("rejects offline paging with %s rows before waking", async older => {
    const f = await fixture(undefined, 21, { older });
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("offline_messages_older");
    expect(f.calls.some(c => c.path.endsWith("/start"))).toBe(false);
    expect(f.state()).toBe("deleted");
  });

  it("uses the first selected provider for Stop without another workspace or wake", async () => {
    const f = await fixture();
    await runCloudV2Gate0({ ...f.options, agents: ["claude"] });
    expect(f.frames.filter(frame => frame.type === "AGENT_PROMPT").map(frame => frame.agentId)).toEqual(["claude", "claude"]);
    expect(f.frames.find(frame => frame.type === "AGENT_CANCEL")).toMatchObject({ agentId: "claude" });
    expect(f.calls.filter(c => c.method === "POST" && c.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
    expect(f.calls.filter(c => c.path.endsWith("/start"))).toHaveLength(1);
  });

  it("deletes the workspace on a failed provider turn and never surfaces the provider's error body", async () => {
    const f = await fixture("cursor");
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_cursor_turn");
    expect(f.state()).toBe("deleted");
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
    expect(f.calls.some(c => c.path.endsWith("/start"))).toBe(false);
    expect(f.logs.join("\n")).not.toContain("provider-secret");
  });

  it("recovers an ambiguous create response by its unique name for cleanup without retrying create", async () => {
    const f = await fixture();
    const lostResponse: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/cloud-v2/workspaces") {
        await response.body?.cancel(); throw new Error("request body with secret");
      }
      return response;
    };
    await expect(runCloudV2Gate0({ ...f.options, fetch: lostResponse })).rejects.toThrow("create");
    expect(f.state()).toBe("deleted");
    expect(f.calls.filter(c => c.method === "POST" && c.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
  });

  it("keeps the resource only when explicitly requested", async () => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, keep: true })).resolves.toMatchObject({ deleted: false });
    expect(f.state()).toBe("running");
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });
});
