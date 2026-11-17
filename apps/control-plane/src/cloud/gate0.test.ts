import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runCloudV2Gate0 } from "./gate0.js";
import type { Gate0Timing } from "./gate0-transport.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Faults = { cancelAck?: "missing" | "request" | "chat" | "state"; completedBeforeStop?: boolean; older?: "anchor" | "wrong"; answer?: string;
  canaryStatus?: "missing" | "wrong" | "inaccessible" | "not-deleted"; wakeRuntime?: false; lostCreate?: true;
  outbox?: true; outboxStop?: "ignored" | "settled";
  /** The stopped chat's last row settles after the probe's snapshot (seen on Alpha). */
  stopRowSettlesLater?: true };
async function fixture(failAgent?: string, protocolVersion = 21, faults: Faults = {}) {
  const id = randomUUID(), organizationId = randomUUID();
  const repository = "example/project", root = `/home/user/${repository}`, branch = "zeros/gate0";
  const calls: { method: string; path: string; body: any }[] = [];
  const frames: any[] = [], chats = new Map<string, any[]>(), files = new Map<string, string>();
  const sessions = new Map<string, string>(), tickets = new Set<string>(), activePrompts = new Map<string, any>();
  const logs: string[] = [];
  let state = "absent", name = "", staged = false, connections = 0, stopReads = 0;
  const canary = { token: "synthetic-runtime-grant", claims: { version: 1 as const, iss: "zeros-runtime-release" as const, aud: "zeros-cloud-runtime-canary" as const,
    channel: "alpha" as const, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
    runId: "456", runAttempt: 1, creatorUserId: randomUUID(), organizationId, repositoryId: "42", createKey: randomUUID(),
    runtimeSha256: "a".repeat(64), sourceSha: "b".repeat(40) } };
  const canaryHeaders: { path: string; token: string | undefined; key: string | undefined }[] = [];
  const workspace = () => ({ id, organizationId, repository, branch, baseBranch: "master", name, state, boatSandboxId: "bx_23456789",
    agentCost: faults.outbox ? { totalUsd: 0.0042, estimated: false } : null, ...(faults.outbox ? { capabilities: { promptOutbox: 1 } } : {}) });
  const prompts: { chatId: string; userMessageId: string; agentId: string; epoch: string; state: string }[] = [];
  let liveSend: ((frame: Record<string, unknown>) => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = request.url!, method = request.method!;
    calls.push({ method, path, body });
    canaryHeaders.push({ path, token: request.headers["x-zeros-runtime-canary"] as string | undefined, key: request.headers["idempotency-key"] as string | undefined });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer synthetic-gate0-access") return json({}, 401);
    if (path === `/v1/cloud-v2/runtime-canaries/${canary.claims.jti}`) {
      if (state === "absent" || faults.canaryStatus === "missing" || (faults.canaryStatus === "inaccessible" && state === "deleted")) return json({}, 404);
      return json({ version: 1, grantId: canary.claims.jti, workspaceId: id, creatorUserId: canary.claims.creatorUserId, organizationId,
        repositoryId: "42", runId: faults.canaryStatus === "wrong" ? "999" : "456", runAttempt: 1,
        runtimeSha256: canary.claims.runtimeSha256, sourceSha: canary.claims.sourceSha,
        grantSha256: createHash("sha256").update(canary.token).digest("hex"), createKeySha256: createHash("sha256").update(canary.claims.createKey).digest("hex"),
        state: faults.canaryStatus === "not-deleted" ? "running" : state, deleted: faults.canaryStatus !== "not-deleted" && state === "deleted" });
    }
    if (path.endsWith("/computer/repositories")) return json({ repositories: [{ repository, defaultBranch: "master" }] });
    if (method === "POST" && path === "/v1/cloud-v2/workspaces") {
      expect(request.headers["idempotency-key"]).toBeTypeOf("string");
      name = body.name; state = "running";
      if (faults.lostCreate) { request.socket.destroy(); return; }
      return json({ workspace: workspace() }, 201);
    }
    if (method === "GET" && path.startsWith("/v1/cloud-v2/workspaces?")) return json({ workspaces: state === "absent" ? [] : [workspace()] });
    if (method === "GET" && path === `/v1/cloud-v2/workspaces/${id}`) return state === "deleted" ? json({}, 404) : json({ workspace: workspace() });
    if (path.endsWith("/connect")) {
      const ticket = `ticket.${randomUUID()}`; tickets.add(ticket);
      return json({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/bridge`, protocols: ["zeros.cloud.v2", ticket] });
    }
    if (faults.outbox && method === "POST" && path === `/v1/cloud-v2/workspaces/${id}/prompts`) {
      const row = { chatId: body.chatId, userMessageId: body.userMessageId, agentId: body.agentId, epoch: "1", state: "accepted" };
      prompts.push(row);
      const update = (sessionUpdate: string, text: string) => liveSend!({ type: "AGENT_SESSION_UPDATE", chatId: body.chatId,
        notification: { sessionId: body.chatId, update: { sessionUpdate, content: { type: "text", text } } } });
      if (body.chatId.startsWith("gate0-stop-")) {
        chats.set(body.chatId, [{ msgId: body.userMessageId, kind: "text", payload: JSON.stringify({ role: "user", text: body.prompt[0].text }), createdAt: 1 }]);
        if (faults.outboxStop === "settled") row.state = "completed"; else update("agent_thought_chunk", "Waiting");
      } else {
        const marker = /^Reply with exactly:? ([^.\n]+)/.exec(body.prompt[0].text)![1]!;
        chats.set(body.chatId, [
          { msgId: body.userMessageId, kind: "text", payload: JSON.stringify({ role: "user", text: body.prompt[0].text }), createdAt: 1 },
          { msgId: randomUUID(), kind: "text", payload: JSON.stringify({ role: "agent", text: marker }), createdAt: 2 },
        ]);
        update("agent_message_chunk", marker);
        row.state = body.agentId === failAgent ? "failed" : "completed";
      }
      return json({ receipt: { workspaceId: id, chatId: body.chatId, userMessageId: body.userMessageId, sequence: String(prompts.length), epoch: row.epoch,
        acceptedAt: new Date().toISOString(), workspaceState: state } }, 201);
    }
    if (faults.outbox && method === "GET" && path.startsWith(`/v1/cloud-v2/workspaces/${id}/prompts?`)) {
      const chatId = new URL(path, "http://fake").searchParams.get("chatId");
      return json({ epoch: "1", nextAfter: null, items: prompts.filter(row => row.chatId === chatId).map(row => ({
        receipt: { userMessageId: row.userMessageId, chatId: row.chatId, epoch: row.epoch }, state: row.state, payload: null, cancelRequested: false })) });
    }
    if (faults.outbox && method === "POST" && path === `/v1/cloud-v2/workspaces/${id}/prompts/stop`) {
      if (faults.outboxStop !== "ignored") for (const row of prompts) if (row.chatId === body.chatId && Number(row.epoch) <= Number(body.throughEpoch)) row.state = "cancelled";
      return json({ chatId: body.chatId, epoch: "2" });
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
    send({ type: "ENGINE_READY", protocolVersion, minProtocolVersion: 2 }); liveSend = send;
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
            case "messages.window": {
              const rows = chats.get(p.chatId) ?? [];
              if (faults.stopRowSettlesLater && p.chatId.startsWith("gate0-stop-") && ++stopReads === 2 && rows[1])
                rows[1] = { ...rows[1], payload: JSON.stringify({ role: "agent", text: "Stopped (settled after the snapshot)" }) };
              return { messages: rows };
            }
          }
          throw new Error(`Unexpected fake op ${frame.op}`);
        })();
        return reply("WORKSPACE_RESPONSE", { result });
      }
      if (frame.type === "PTY_CREATE") return reply("PTY_CREATED", { sessionId: frame.sessionId, cwd: root });
      if (frame.type === "PTY_WRITE") {
        if (faults.wakeRuntime === false && connections > 1) return;
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
      // An active execution context refuses bridge sends; the outbox is the only path.
      if (frame.type === "AGENT_PROMPT" && faults.outbox) return reply("AGENT_ERROR", { code: "client_update_required", message: "Update the desktop" });
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
        const marker = faults.answer ?? /^Reply with exactly:? ([^.\n]+)/.exec(frame.prompt[0].text)![1];
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
  return { options, calls, frames, logs, sessions, canary, prompts, canaryHeaders, connections: () => connections, state: () => state };
}

describe("cloud v2 gate0 through a fake HTTP control plane and relay", () => {
  it("waits for the mirror to match the VM's current rows when a stopped turn's last row settles after the snapshot", async () => {
    const f = await fixture(undefined, 21, { stopRowSettlesLater: true });
    const result = await runCloudV2Gate0({ ...f.options, timeoutMs: 5_000 });
    expect(result.deleted).toBe(true);
  });

  it("uses one grant-bound create, proves the candidate on create and wake, and requires bound deletion", async () => {
    const f = await fixture();
    const result = await runCloudV2Gate0({ ...f.options, runtimeSha: f.canary.claims.runtimeSha256, canary: f.canary });
    expect(result.deleted).toBe(true);
    expect(f.canaryHeaders.filter(row => row.token !== undefined)).toEqual([{ path: "/v1/cloud-v2/workspaces", token: f.canary.token, key: f.canary.claims.createKey }]);
    expect(f.calls.find(row => row.method === "POST" && row.path === "/v1/cloud-v2/workspaces")?.body.name).toBe(`gate0-${f.canary.claims.jti}`);
    expect(f.frames.filter(frame => frame.type === "PTY_WRITE" && frame.data.includes(`/opt/zeros/runtime/${f.canary.claims.runtimeSha256}`))).toHaveLength(2);
    expect(f.calls.filter(row => row.path.startsWith("/v1/cloud-v2/runtime-canaries/"))).toHaveLength(2);
    expect(f.logs.join("\n")).not.toContain(f.canary.token);
  });

  it.each(["missing", "wrong", "inaccessible", "not-deleted"] as const)("refuses %s canary proof, including a misleading workspace 404", async canaryStatus => {
    const f = await fixture(undefined, 21, { canaryStatus });
    await expect(runCloudV2Gate0({ ...f.options, timeoutMs: 100, runtimeSha: f.canary.claims.runtimeSha256, canary: f.canary })).rejects.toThrow();
    expect(f.state()).toBe("deleted");
  });

  it("refuses a different runtime after wake and still deletes the candidate", async () => {
    const f = await fixture(undefined, 21, { wakeRuntime: false });
    await expect(runCloudV2Gate0({ ...f.options, timeoutMs: 100, runtimeSha: f.canary.claims.runtimeSha256, canary: f.canary })).rejects.toThrow("wake_runtime");
    expect(f.state()).toBe("deleted");
  });

  it("recovers an ambiguous create by grant identity without replaying creation", async () => {
    const f = await fixture(undefined, 21, { lostCreate: true });
    await expect(runCloudV2Gate0({ ...f.options, runtimeSha: f.canary.claims.runtimeSha256, canary: f.canary })).rejects.toThrow("create");
    expect(f.state()).toBe("deleted");
    expect(f.calls.filter(row => row.method === "POST" && row.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
    expect(f.calls.some(row => row.path.startsWith("/v1/cloud-v2/workspaces?"))).toBe(false);
  });

  it.each([{ keep: true }, { agents: ["codex"] as const }, { runtimeSha: undefined }])("refuses a partial or retained canary before creating anything (%j)", async patch => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, runtimeSha: f.canary.claims.runtimeSha256, canary: f.canary, ...patch })).rejects.toThrow("canary_configuration");
    expect(f.calls).toHaveLength(0);
  });

  it("prints each chat's stage durations, including Stop, before stopping the same VM", async () => {
    const f = await fixture();
    const readTimings = vi.fn(async (): Promise<Gate0Timing[]> => {
      expect(f.state()).toBe("running");
      return f.frames.filter(frame => frame.type === "AGENT_NEW_SESSION").flatMap(frame => [
        ...(["open_received", "driver_ready"] as const).map((stage, i) => ({ agent: frame.agentId, chat: frame.chatId.slice(-8), phase: "open" as const, stage, elapsedMs: i * 10 })),
        ...(["turn_received", "driver_ready", "turn_sent", "first_provider_event", "turn_done"] as const).map((stage, i) => ({ agent: frame.agentId, chat: frame.chatId.slice(-8), phase: "turn" as const, stage, elapsedMs: i * 10 })),
      ]);
    });
    await runCloudV2Gate0({ ...f.options, readTimings });
    expect(readTimings).toHaveBeenCalledTimes(1);
    const timings = f.logs.filter(line => line.startsWith("worker timing "));
    expect(timings).toHaveLength(28);
    const chats = f.frames.filter(frame => frame.type === "AGENT_NEW_SESSION");
    expect(new Set(chats.map(chat => `${chat.agentId}:${chat.chatId.slice(-8)}`)).size).toBe(4);
    for (const chat of chats) {
      expect(timings).toContain(`worker timing ${chat.agentId} ${chat.chatId.slice(-8)} open driver_ready 10ms`);
      expect(timings).toContain(`worker timing ${chat.agentId} ${chat.chatId.slice(-8)} turn first_provider_event 30ms`);
      expect(timings).toContain(`worker timing ${chat.agentId} ${chat.chatId.slice(-8)} turn turn_done 40ms`);
      expect(timings.join("\n")).not.toContain(chat.chatId);
    }
    expect(f.calls.filter(call => call.method === "POST" && call.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
  });

  it("rejects missing required timing stages and still deletes its workspace", async () => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, readTimings: async () => [] })).rejects.toThrow("worker_timings");
    expect(f.state()).toBe("deleted");
  });

  it.each([undefined, { codex: "fixture-codex", claude: "fixture-claude", cursor: "fixture-cursor" }])(
    "pins every created and prompted chat to a model and low effort, including Stop (%j)", async models => {
      const f = await fixture();
      await runCloudV2Gate0({ ...f.options, models });
      const expected = models ?? { codex: "gpt-6-luna", claude: "claude-haiku-5-5", cursor: "default" };
      const chats = f.frames.filter(frame => frame.type === "WORKSPACE_REQUEST" && frame.op === "chats.upsert").map(frame => frame.params.chat);
      expect(chats).toHaveLength(4);
      for (const chat of chats) expect(chat).toMatchObject({ model: expected[chat.agentId as keyof typeof expected], effort: "low" });
      const prompts = f.frames.filter(frame => frame.type === "AGENT_PROMPT");
      expect(prompts).toHaveLength(4);
      for (const prompt of prompts) {
        const chat = chats.find(chat => chat.id === f.sessions.get(prompt.sessionId));
        expect(chat).toMatchObject({ model: expected[prompt.agentId as keyof typeof expected], effort: "low" });
        if (!chat.id.startsWith("gate0-stop-")) expect(prompt.prompt).toEqual([{ type: "text", text: "Reply with exactly: ok. Do not use tools or read files." }]);
      }
      expect(f.frames.filter(frame => frame.type === "AGENT_CANCEL")).toHaveLength(1);
    },
  );

  it("refuses an invalid model override before spending a workspace start", async () => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, models: { codex: " " } })).rejects.toThrow("model_configuration");
    expect(f.calls).toHaveLength(0);
  });

  it.each([undefined, { codex: "fixture-codex", claude: "fixture-claude", cursor: "fixture-cursor" }])(
    "logs resolved models and effort before the first turn (%j)", async models => {
      const f = await fixture(), beforeTurns: string[] = [];
      await runCloudV2Gate0({ ...f.options, models, log: line => {
        f.options.log(line);
        if (!f.frames.some(frame => frame.type === "AGENT_PROMPT")) beforeTurns.push(line);
      } });
      const expected = models ?? { codex: "gpt-6-luna", claude: "claude-haiku-5-5", cursor: "default" };
      for (const agent of ["codex", "claude", "cursor"] as const) {
        expect(beforeTurns).toContain(`${agent} model=${expected[agent]} effort=low${agent === "cursor" ? " (no native effort control)" : ""}`);
      }
    },
  );

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
    expect(f.frames.filter(f => f.type === "AGENT_PROMPT").map(f => f.agentId)).toEqual(["codex", "claude", "cursor", "claude"]);
    const cancel = f.frames.filter(frame => frame.type === "AGENT_CANCEL");
    expect(cancel).toHaveLength(1);
    expect(cancel[0]).toMatchObject({ agentId: "claude", chatId: expect.stringMatching(/^gate0-stop-/) });
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

  it.each([
    { agents: ["claude"], stop: "claude" },
    { agents: ["cursor", "claude", "codex"], stop: "claude" },
    { agents: ["cursor", "codex"], stop: "codex" },
    { agents: ["cursor"], stop: "cursor" },
  ] as const)("uses $stop for the sole Stop turn among $agents", async ({ agents, stop }) => {
    const f = await fixture();
    await runCloudV2Gate0({ ...f.options, agents });
    expect(f.frames.filter(frame => frame.type === "AGENT_PROMPT").map(frame => frame.agentId)).toEqual([...agents, stop]);
    expect(f.frames.filter(frame => frame.type === "AGENT_CANCEL")).toEqual([expect.objectContaining({ agentId: stop })]);
    expect(f.calls.filter(c => c.method === "POST" && c.path === "/v1/cloud-v2/workspaces")).toHaveLength(1);
    expect(f.calls.filter(c => c.path.endsWith("/start"))).toHaveLength(1);
  });

  // Models answer the fixed prompt with "OK." or "ok." about as often as "ok".
  it("accepts the marker in any case with trailing punctuation, and nothing else", async () => {
    for (const answer of ["OK.", "ok.", " Ok! ", "ok"]) await expect(runCloudV2Gate0((await fixture(undefined, 21, { answer })).options)).resolves.toBeTruthy();
    for (const answer of ["not ok", "okay", "o.k.", "ok, done"]) {
      const f = await fixture(undefined, 21, { answer });
      await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_codex_answer");
      expect(f.state()).toBe("deleted");
    }
  });

  it("deletes the workspace on a failed provider turn and never surfaces the provider's error body", async () => {
    const f = await fixture("cursor");
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_cursor_turn");
    expect(f.state()).toBe("deleted");
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
    expect(f.calls.some(c => c.path.endsWith("/start"))).toBe(false);
    expect(f.logs.join("\n")).not.toContain("provider-secret");
  });

  it("names a failure's closed cause: the workspace's error code, an HTTP status, a schema path", async () => {
    const reshape = (change: (workspace: Record<string, unknown>) => Record<string, unknown> | number): typeof fetch => async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? "GET") !== "GET" || !/^\/v1\/cloud-v2\/workspaces\/[0-9a-f-]{36}$/.test(new URL(String(input)).pathname)) return response;
      const body = await response.json() as { workspace: Record<string, unknown> }, changed = change(body.workspace);
      return typeof changed === "number" ? new Response("{}", { status: changed }) : Response.json({ workspace: changed });
    };
    for (const [change, cause] of [
      [(w: Record<string, unknown>) => w.state === "running" ? { ...w, state: "failed", errorCode: "worker_boot_timeout" } : w, "state_failed:worker_boot_timeout"],
      [(w: Record<string, unknown>) => w.state === "running" ? 503 : w, "http_503"],
      [(w: Record<string, unknown>) => w.state === "running" ? { ...w, branch: null } : w, "schema:workspace.branch"],
    ] as const) {
      const f = await fixture();
      const failure = await runCloudV2Gate0({ ...f.options, fetch: reshape(change) }).catch(error => error);
      expect([failure.stage, failure.cause]).toEqual(["running", cause]);
      expect(failure.message).toBe(`Cloud v2 gate0 failed: running (${cause})`);
    }
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

  it("reports each phase's duration and the VM's observed running time, in order", async () => {
    const f = await fixture(), metrics: { name: string; ms: number }[] = [];
    const result = await runCloudV2Gate0({ ...f.options, agents: ["codex", "claude"], onMetric: metric => metrics.push(metric) });
    expect(metrics.map(metric => metric.name)).toEqual([
      "create_request", "create_to_running", "connect", "terminal", "files_git", "turn_codex", "turn_claude", "stop_turn",
      "history_mirror", "stop_request", "stop_to_stopped", "offline_history", "wake_request", "wake_to_running", "wake_connect",
      "wake_checks", "delete_to_deleted",
    ]);
    for (const metric of metrics) expect(metric.ms).toEqual(expect.any(Number));
    expect(result.metrics).toEqual(metrics);
    expect(result.vmRunningMs).toBeGreaterThanOrEqual(0);
    expect(result.turns).toBe(3);
  });

  it("reports the metrics it completed when a phase fails", async () => {
    const f = await fixture("cursor"), metrics: string[] = [];
    await expect(runCloudV2Gate0({ ...f.options, onMetric: metric => metrics.push(metric.name) })).rejects.toThrow("agent_cursor_turn");
    expect(metrics).toEqual(["create_request", "create_to_running", "connect", "terminal", "files_git", "turn_codex", "turn_claude", "delete_to_deleted"]);
  });

  it("logs unavailable worker timings without failing when they are optional", async () => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, readTimings: async () => [], timingsOptional: true })).resolves.toMatchObject({ deleted: true });
    expect(f.logs).toContain("worker timings incomplete; not required for this target");
  });

  it("sends and stops turns over the HTTPS outbox when the workspace advertises it, and reads its provider cost", async () => {
    const f = await fixture(undefined, 21, { outbox: true });
    const result = await runCloudV2Gate0(f.options);
    expect(result).toMatchObject({ deleted: true, turns: 4, agentCost: { totalUsd: 0.0042, estimated: false } });
    expect(f.frames.some(frame => frame.type === "AGENT_PROMPT" || frame.type === "AGENT_CANCEL")).toBe(false);
    expect(f.prompts.map(row => [row.agentId, row.state])).toEqual([["codex", "completed"], ["claude", "completed"], ["cursor", "completed"], ["claude", "cancelled"]]);
    const sent = f.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompts"));
    for (const call of sent) expect(call.body).toMatchObject({ effort: "low", model: expect.any(String), startedAt: expect.any(Number) });
    expect(f.calls.filter(call => call.path.endsWith("/prompts/stop"))).toEqual([expect.objectContaining({ body: { chatId: f.prompts[3]!.chatId, throughEpoch: "1" } })]);
    expect(f.logs).toContain("turns use the HTTPS prompt outbox");
  });

  it("fails a failed outbox turn and still deletes the workspace", async () => {
    const f = await fixture("claude", 21, { outbox: true });
    await expect(runCloudV2Gate0(f.options)).rejects.toThrow("agent_claude_turn");
    expect(f.state()).toBe("deleted");
  });

  it.each([["settled", "agent_stop_live"], ["ignored", "agent_stop_complete"]] as const)(
    "rejects an outbox Stop whose turn %s and still deletes the workspace", async (outboxStop, stage) => {
      const f = await fixture(undefined, 21, { outbox: true, outboxStop });
      await expect(runCloudV2Gate0({ ...f.options, timeoutMs: 200 })).rejects.toThrow(stage);
      expect(f.state()).toBe("deleted");
    });

  it("keeps the resource only when explicitly requested", async () => {
    const f = await fixture();
    await expect(runCloudV2Gate0({ ...f.options, keep: true })).resolves.toMatchObject({ deleted: false });
    expect(f.state()).toBe("running");
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });
});
