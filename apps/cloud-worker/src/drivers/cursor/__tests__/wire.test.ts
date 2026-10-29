import { join } from "node:path";
import { expect, it } from "vitest";
import { CloudWorker } from "../../../worker";
import { SessionStore } from "../../../sessions/session-store";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../../workspace/__tests__/repository-fixture";
import { CursorDriver } from "../driver";
import { fixtureHost, prompt, text } from "./fixture-host";

it("retains a mid-chat cloud selection for the next native run without replacing the active run", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), host = await fixtureHost();
  let spawns = 0;
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { cursor: () => { spawns++; return new CursorDriver({ hostPath: host.path, environment: { PATH: process.env.PATH, HOME: state } }); } } });
  const request = (type: string, fields: Record<string, unknown>) => relay.request(CLIENT_A, browserFrame(type, { agentId: "cursor", ...fields }));
  try {
    worker.start(); await relay.receive({ ...config, workspace: scope.workspace, agents: { cursor: { apiKey: "fixture-cursor" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await request("AGENT_NEW_SESSION", { cwd: scope.root, chatId: "settings" });
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing session");
    const sessionId = created.session.sessionId;
    await request("AGENT_PROMPT", { sessionId, prompt: prompt({ hang: true, inspect: true }) });
    await expect.poll(() => relay.bridge("AGENT_SESSION_UPDATE").some(row => JSON.stringify(row.frame).includes("Ready"))).toBe(true);
    await request("AGENT_UPDATE_CONFIG", { sessionId, env: { CURSOR_MODEL: "grok-4.7", ZEROS_THINKING_EFFORT: "low", ZEROS_FAST_MODE: "1" } });
    await request("AGENT_STEER", { sessionId, prompt: text("finish run") });
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
    await request("AGENT_PROMPT", { sessionId, prompt: prompt({ inspect: true }) });
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(2);
    await worker.flush();
    const stored = await SessionStore.open(join(state, "sessions"), scope.key);
    expect(stored.metadata("settings")?.chat).toMatchObject({ model: "grok-4.7", effort: "low", fast: true });
    const messages = stored.window("settings").messages.map(row => JSON.parse(row.payload));
    const inspection = messages.filter(row => row.kind === "text" && row.role === "agent").at(-1);
    expect(JSON.parse(inspection.text)).toMatchObject({ sends: 2, initialModel: { id: "composer-2.5" }, model: { id: "grok-4.7", params: [
      { id: "context", value: "large" }, { id: "effort", value: "low" }, { id: "fast", value: "true" },
    ] } });
    expect(spawns).toBe(1); expect(relay.bridge("AGENT_ERROR")).toEqual([]);
  } finally { await worker.dispose(); await host.dispose(); }
});

it("routes Cursor across reconnect, preserves native history and replaces idle credentials", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(), host = await fixtureHost();
  let spawns = 0;
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { cursor: () => { spawns++; return new CursorDriver({ hostPath: host.path, environment: { PATH: process.env.PATH, HOME: state } }); } } });
  const current = { ...config, workspace: scope.workspace, agents: { cursor: { apiKey: "fixture-cursor" } } };
  const request = (type: string, fields: Record<string, unknown> = {}) => relay.request(CLIENT_A, browserFrame(type, { agentId: "cursor", ...fields }));
  try {
    worker.start(); await relay.receive(current); await relay.receive({ t: "open", clientId: CLIENT_A });
    await request("AGENT_INIT_AGENT");
    expect(relay.bridge("AGENT_AGENT_INITIALIZED")[0].frame).toMatchObject({ initialize: { agentCapabilities: { steering: true } } });
    await request("AGENT_NEW_SESSION", { cwd: scope.root, chatId: "chat" });
    const created = relay.bridge("AGENT_SESSION_CREATED")[0].frame;
    if (created.type !== "AGENT_SESSION_CREATED") throw new Error("Missing session");
    const sessionId = created.session.sessionId;
    const running = browserFrame("AGENT_PROMPT", { agentId: "cursor", sessionId, chatId: "chat", prompt: prompt({ hang: true }) });
    await relay.request(CLIENT_A, running);
    await expect.poll(() => relay.bridge("AGENT_SESSION_UPDATE").some(row => JSON.stringify(row.frame).includes("Ready"))).toBe(true);
    relay.disconnect(); await relay.reconnect();
    await relay.receive({ ...current, agents: { cursor: { apiKey: "replacement-fixture" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A }); expect(spawns).toBe(1);
    // Reconnect retrieves the original inbox receipt using the same request id.
    await relay.request(CLIENT_A, running);
    await request("AGENT_CANCEL", { sessionId });
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
    await request("AGENT_PROMPT", { sessionId, chatId: "chat", prompt: prompt({ inspect: true }) });
    await expect.poll(() => relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(2); expect(spawns).toBe(2);
    await worker.flush();
    const store = await SessionStore.open(join(state, "sessions"), scope.key);
    expect(store.metadata("chat")?.nativeSessionId).toBe("native-agent");
    const messages = store.window("chat").messages.map(row => JSON.parse(row.payload));
    const inspection = messages.filter(row => row.kind === "text" && row.role === "agent").at(-1);
    expect(JSON.parse(inspection.text)).toMatchObject({ resumed: true, sends: 1, ownLogin: true, forbidden: false });
    expect(relay.frames.some(frame => frame.t === "history" && frame.messages?.rows.some(row => row.payload.includes("Ready")))).toBe(true);
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  } finally { await worker.dispose(); await host.dispose(); }
});
