import { expect, it } from "vitest";
import { CloudWorker } from "../../../worker";
import { SessionStore } from "../../../sessions/session-store";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../../workspace/__tests__/repository-fixture";
import { ClaudeDriver } from "../driver";
import { harness, result } from "./fake-query";
import { join } from "node:path";

const oauth = { oauthToken: "offline-oauth-placeholder" };
const api = { apiKey: "offline-api-key-placeholder" };

it("carries a mid-chat cloud config into the live query and the next prompt's staged restart", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), h = harness();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} }) } });
  const request = (type: string, fields: Record<string, unknown>) => relay.request(CLIENT_A, browserFrame(type, { agentId: "claude", ...fields }));
  try {
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: oauth } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await request("AGENT_NEW_SESSION", { cwd: scope.root, chatId: "settings", env: { ZEROS_THINKING_EFFORT: "low" } });
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing session");
    const sessionId = created.session.sessionId;
    const prompt = () => request("AGENT_PROMPT", { sessionId, prompt: [{ type: "text", text: "fixture" }] });
    await prompt(); await expect.poll(() => h.queries.length).toBe(1);
    const query = h.queries[0], first = await query.read(), nativeId = query.args.options.sessionId!;
    await request("AGENT_UPDATE_CONFIG", { sessionId, env: { ZEROS_THINKING_EFFORT: "ultracode", ZEROS_FAST_MODE: "1" } });
    expect(query.flagSettings).toEqual([{ effortLevel: "xhigh", fastMode: true, ultracode: true }]);
    await request("AGENT_UPDATE_CONFIG", { sessionId, env: { ZEROS_THINKING_EFFORT: "max" } });
    expect(query.closed).toBe(false); expect(query.interrupts).toBe(0);
    query.push(result(first.uuid, { session_id: nativeId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
    await prompt(); await expect.poll(() => h.queries.length).toBe(2);
    const next = h.queries[1], second = await next.read();
    expect(next.args.options).toMatchObject({ resume: nativeId, effort: "max", settings: { fastMode: false, ultracode: false } });
    next.push(result(second.uuid, { session_id: nativeId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(2);
    await worker.flush();
    const stored = await SessionStore.open(join(state, "sessions"), scope.key);
    expect(stored.metadata("settings")?.chat).toMatchObject({ effort: "max", fast: false });
    expect(relay.bridge("AGENT_ERROR")).toEqual([]);
  } finally { await worker.dispose(); }
});

it("routes Claude frames through the relay, mirrors background rows and resumes stored identity", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), h = harness();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} }) } });
  const request = (type: string, fields: Record<string, unknown> = {}) => relay.request(CLIENT_A, browserFrame(type, fields));
  try {
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: oauth } });
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
    relay.disconnect(); await relay.reconnect(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: api } });
    expect(query.args.options.env?.CLAUDE_CODE_OAUTH_TOKEN === oauth.oauthToken).toBe(true);
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
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: oauth } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "claude", cwd: scope.root, chatId: "new-chat" }));
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing created session");
    await relay.receive({ ...config, workspace: scope.workspace, agents: { claude: api } });
    await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", sessionId: created.session.sessionId, prompt: [{ type: "text", text: "first prompt" }] }));
    await expect.poll(() => h.queries.length).toBe(1);
    const query = h.queries[0], sent = await query.read();
    expect(query.args.options).not.toHaveProperty("resume");
    expect(query.args.options.env?.ANTHROPIC_API_KEY === api.apiKey).toBe(true);
    expect(query.args.options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    query.push({ type: "system", subtype: "init", session_id: query.args.options.sessionId });
    query.push(result(sent.uuid, { session_id: query.args.options.sessionId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
  } finally { await worker.dispose(); }
});

it.each([
  { mode: "OAuth replacement", initial: oauth, replacement: { oauthToken: "offline-replacement-oauth" } },
  { mode: "API key replacement", initial: api, replacement: { apiKey: "offline-replacement-api-key" } },
  { mode: "OAuth to API key", initial: oauth, replacement: api },
  { mode: "API key to OAuth", initial: api, replacement: oauth },
])("keeps a turn's credential, then resumes with the full config's $mode", async ({ initial, replacement }) => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), h = harness();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} }) } });
  const configure = (login: typeof initial) => relay.receive({ ...config, workspace: scope.workspace, agents: { claude: login } });
  try {
    worker.start(); await configure(initial); await relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "claude", cwd: scope.root, chatId: "rotation" }));
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing created session");
    const prompt = () => relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", sessionId: created.session.sessionId, prompt: [{ type: "text", text: "fixture" }] }));
    await prompt(); await expect.poll(() => h.queries.length).toBe(1);
    const first = h.queries[0], sent = await first.read(), nativeId = first.args.options.sessionId!;
    const expectedEnv = (login: typeof initial) => "oauthToken" in login
      ? { CLAUDE_CODE_OAUTH_TOKEN: login.oauthToken } : { ANTHROPIC_API_KEY: login.apiKey };
    expect(JSON.stringify(first.args.options.env) === JSON.stringify(expectedEnv(initial))).toBe(true);
    await configure(replacement);
    expect(first.closed).toBe(false); expect(h.queries).toHaveLength(1);
    expect(JSON.stringify(first.args.options.env) === JSON.stringify(expectedEnv(initial))).toBe(true);
    first.push(result(sent.uuid, { session_id: nativeId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
    await prompt(); await expect.poll(() => h.queries.length).toBe(2);
    const second = h.queries[1], next = await second.read();
    expect(first.closed).toBe(true); expect(second.args.options.resume).toBe(nativeId);
    expect(JSON.stringify(second.args.options.env) === JSON.stringify(expectedEnv(replacement))).toBe(true);
    second.push(result(next.uuid, { session_id: nativeId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(2);
    await configure(replacement); await prompt();
    const unchanged = await second.read(); expect(h.queries).toHaveLength(2);
    second.push(result(unchanged.uuid, { session_id: nativeId }));
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(3);
    expect(relay.bridge("AGENT_ERROR")).toHaveLength(0);
  } finally { await worker.dispose(); }
});
