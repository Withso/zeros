import { expect, it } from "vitest";
import { CloudWorker } from "../../../worker";
import { SessionStore } from "../../../sessions/session-store";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../../workspace/__tests__/repository-fixture";
import { ClaudeDriver } from "../driver";
import { harness, result } from "./fake-query";
import { join } from "node:path";

it("routes Claude frames through the relay, mirrors background rows and resumes stored identity", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), h = harness();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} }) } });
  const request = (type: string, fields: Record<string, unknown> = {}) => relay.request(CLIENT_A, browserFrame(type, fields));
  try {
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: config.agents.codex } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await request("AGENT_NEW_SESSION", { agentId: "claude", cwd: scope.root, chatId: "chat" });
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing created session");
    expect(created.session.providerBinding).toBeUndefined();
    const sessionId = created.session.sessionId;
    await request("AGENT_PROMPT", { agentId: "claude", sessionId, chatId: "chat", prompt: [{ type: "text", text: "Run tests" }] });
    await expect.poll(() => h.queries.length).toBe(1); const query = h.queries[0], user = await query.read();
    const nativeId = query.args.options.sessionId!;
    query.push({ type: "system", subtype: "init", session_id: nativeId });
    query.push({ type: "system", subtype: "task_started", task_id: "tests", description: "Run tests", is_backgrounded: true });
    query.push(result(user.uuid, { session_id: nativeId, result: "Tests are running." }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
    relay.disconnect(); await relay.reconnect(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: config.agents.codex } });
    query.push({ type: "system", subtype: "task_notification", task_id: "tests", status: "completed", summary: "Tests passed" });
    await expect.poll(() => relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
    await worker.flush();
    const store = await SessionStore.open(join(state, "sessions"), scope.key);
    expect(store.metadata("chat")?.nativeSessionId).toBe(nativeId);
    expect(store.window("chat").messages.some(row => row.payload.includes("Tests passed"))).toBe(true);
    expect(relay.frames.some(frame => frame.t === "history" && frame.messages?.rows.some(row => row.payload.includes("Tests passed")))).toBe(true);
    expect(query.closed).toBe(false); expect(h.queries).toHaveLength(1);
  } finally { await worker.dispose(); }
});

it("does not persist an unused Claude UUID across login replacement before the first prompt", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), h = harness();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} }) } });
  try {
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: config.agents.codex } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "claude", cwd: scope.root, chatId: "new-chat" }));
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing created session");
    await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: { ...config.agents.codex!, token: "replacement-fixture" } } });
    await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", sessionId: created.session.sessionId, prompt: [{ type: "text", text: "first prompt" }] }));
    await expect.poll(() => h.queries.length).toBe(1);
    const query = h.queries[0], sent = await query.read();
    expect(query.args.options).not.toHaveProperty("resume");
    query.push({ type: "system", subtype: "init", session_id: query.args.options.sessionId });
    query.push(result(sent.uuid, { session_id: query.args.options.sessionId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
  } finally { await worker.dispose(); }
});
