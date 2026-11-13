import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudV2ControlFrameSchema, CREATOR_AGENT_MODELS_FEATURE } from "@zeros/protocol/cloud-v2-relay";
import { creatorModelMetadata } from "../credentials/model-availability";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

// Test the existing menu consumer without adding a Local runtime dependency.
const { modelsForAgent, modelCatalogInitialize } = await import(fileURLToPath(new URL("../../../desktop/src/renderer/features/agent/model-catalog.ts", import.meta.url)));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const reply = (...models: string[]) => Response.json({ models });

async function setup(fetch = vi.fn<typeof globalThis.fetch>(async () => reply("gpt-6-luna"))) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-models-"));
  let now = 1_000;
  const relay = new FakeRelay();
  const drivers: FakeDriver[] = [];
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {},
    drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } }, modelDiscovery: { fetch, now: () => now } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive(config);
  await relay.receive({ t: "open", clientId: CLIENT_A });
  async function initialize(agentId = "codex") {
    const request = browserFrame("AGENT_INIT_AGENT", { agentId });
    await relay.request(CLIENT_A, request);
    const response = relay.response(request.id) as Extract<BridgeMessage, { type: "AGENT_AGENT_INITIALIZED" }>;
    expect(response.type).toBe("AGENT_AGENT_INITIALIZED");
    return response.initialize;
  }
  return { relay, fetch, initialize, drivers, advance: (ms: number) => { now += ms; } };
}

describe("cloud Codex model metadata", () => {
  it("uses the selected key's complete cached list to disable unavailable menu models", async () => {
    const env = await setup();
    const initialize = await env.initialize();
    expect(initialize._meta).toMatchObject({ modelsDynamic: true, modelsAccountScoped: true,
      models: [{ value: "gpt-6-luna", label: "gpt-6-luna" }] });
    const menu = modelsForAgent("codex", initialize);
    expect(menu.find((model: { value: string }) => model.value === "gpt-6.1-sol").selectable).toBe(false);
    expect(menu.find((model: { value: string }) => model.value === "gpt-6-luna").selectable).not.toBe(false);
    await env.initialize();
    for (const selectedAgent of ["claude", "cursor"]) {
      const crossAgent = await env.initialize(selectedAgent);
      expect(crossAgent._meta?.models).toBeUndefined();
      const models = modelsForAgent("codex", modelCatalogInitialize("codex", selectedAgent, crossAgent));
      expect(models.find((model: { value: string }) => model.value === "gpt-6.1-sol").selectable).toBe(false);
    }
    expect(env.fetch).toHaveBeenCalledOnce();
    const [url, request] = env.fetch.mock.calls[0];
    expect(url).toBe(`${config.agents.codex!.baseUrl}/model-availability`);
    expect(request?.method).toBe("GET");
    expect(request?.redirect).toBe("error");
    expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${config.agents.codex!.token}`);
    expect(JSON.stringify(initialize)).not.toMatch(/fixture-proxy-token|127\.0\.0\.1/);
    const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "new-chat", cwd: config.workspace.checkoutPath });
    await env.relay.request(CLIENT_A, open);
    expect(env.relay.response(open.id)).toMatchObject({ type: "AGENT_SESSION_CREATED", initialize });
    expect(env.fetch).toHaveBeenCalledOnce();
  });

  it("opens and sends a turn while model discovery is still pending", async () => {
    let release!: (response: Response) => void;
    const env = await setup(vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { release = resolve; })));
    const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "new-chat", cwd: config.workspace.checkoutPath });
    await env.relay.request(CLIENT_A, open);
    const response = env.relay.response(open.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(response.type).toBe("AGENT_SESSION_CREATED");
    const prompt = browserFrame("AGENT_PROMPT", { agentId: "codex", chatId: "new-chat", sessionId: response.session.sessionId,
      userMessageId: "user-message", prompt: [{ type: "text", text: "ok" }] });
    await env.relay.request(CLIENT_A, prompt);
    await expect.poll(() => env.drivers[0].prompts.length).toBe(1);
    env.drivers[0].complete();
    await expect.poll(() => env.relay.response(prompt.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    release(reply("gpt-6-luna"));
    expect((await env.initialize())._meta?.models).toEqual([{ value: "gpt-6-luna", label: "gpt-6-luna" }]);
  });

  it.each([
    ["malformed", () => Response.json({ models: ["gpt-6-luna", 1] })],
    ["invalid id", () => reply("not a model")],
    ["oversized", () => new Response("x".repeat(256 * 1024 + 1))],
    ["too many", () => reply(...Array.from({ length: 1001 }, (_, i) => `model-${i}`))],
    ["revoked", () => Response.json({ error: "revoked" }, { status: 401 })],
  ])("does not disable models from a %s response or reuse a different credential's snapshot", async (_name, response) => {
    const env = await setup();
    const confirmed = await env.initialize();
    env.fetch.mockImplementation(async () => response());
    env.advance(30_001);
    expect(await env.initialize()).toEqual(confirmed);
    await env.relay.receive({ ...config, loginRevision: "1" });
    const unknown = await env.initialize();
    expect(unknown._meta?.modelsAccountScoped).not.toBe(true);
    expect(unknown._meta?.models).toBeUndefined();
    expect(unknown._meta?.cloudModelScope).not.toBe(confirmed._meta?.cloudModelScope);
  });

  it("keeps proxy token renewals cached but fences a late answer from the previous credential revision", async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }))
      .mockImplementation(async () => reply("gpt-6.1-sol"));
    const env = await setup(fetch);
    const prior = env.initialize();
    await expect.poll(() => fetch.mock.calls.length).toBe(1);
    const next = { ...config, loginRevision: "1", agents: { codex: { ...config.agents.codex!, token: "replacement-proxy-token" } } };
    await env.relay.receive(next);
    const current = await env.initialize();
    expect(current._meta?.models).toEqual([{ value: "gpt-6.1-sol", label: "gpt-6.1-sol" }]);
    release(reply("gpt-6-luna"));
    expect(await prior).toEqual(current);
    await env.relay.receive({ ...next, agents: { codex: { ...next.agents.codex, token: "renewed-proxy-token" } } });
    expect(await env.initialize()).toEqual(current);
    expect(fetch).toHaveBeenCalledTimes(2);
    env.advance(30_001);
    await env.initialize();
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe("Bearer renewed-proxy-token");
  });

  it("keeps unknown separate from an authoritative empty list and clears a removed credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ models: null }));
    const env = await setup(fetch);
    const unknown = await env.initialize();
    expect(unknown._meta?.modelsAccountScoped).not.toBe(true);
    expect(modelsForAgent("codex", unknown).every((model: { selectable?: boolean }) => model.selectable !== false)).toBe(true);
    expect(unknown._meta?.modelsDynamic).toBe(true);
    fetch.mockImplementation(async () => reply());
    env.advance(30_001);
    const empty = await env.initialize();
    expect(empty._meta).toMatchObject({ models: [], modelsAccountScoped: true });
    expect(modelsForAgent("codex", empty).every((model: { selectable?: boolean }) => model.selectable === false)).toBe(true);
    await env.relay.receive({ ...config, loginRevision: "1", agents: {} });
    const removed = await env.initialize();
    expect(removed._meta?.modelsAccountScoped).not.toBe(true);
    expect(removed._meta?.cloudModelScope).not.toBe(empty._meta?.cloudModelScope);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("§ activated workspace: the current Creator's selected models (creator-agent-models-v1)", () => {
  const acting = { ...config, agents: {}, actingUser: 1 as const, gitIdentity: null, loginRevision: "7",
    agentLogins: { claude: true as const, cursor: true as const },
    agentModels: { claude: ["claude-opus-5-5[1m]", "claude-haiku-5-5"], cursor: ["grok-4.7"] } };
  const values = (menu: Array<{ value: string; selectable?: boolean }>) => menu.filter(model => model.selectable !== false).map(model => model.value);

  it("lists exactly the Creator's models for every member, scoped by loginRevision; a logged-in agent with none lists none", () => {
    const claude = creatorModelMetadata("claude", acting as never)!;
    expect(claude).toMatchObject({ modelsDynamic: true, modelsAccountScoped: true, cloudModelScope: `cloud/${config.workspace.id}/7/creator` });
    expect(values(modelsForAgent("claude", { protocolVersion: 1, agentCapabilities: {}, _meta: claude }))).toEqual(["claude-opus-5-5[1m]", "claude-haiku-5-5"]);
    expect(values(modelsForAgent("cursor", { protocolVersion: 1, agentCapabilities: {}, _meta: creatorModelMetadata("cursor", acting as never) }))).toEqual(["grok-4.7"]);
    const none = creatorModelMetadata("cursor", { ...acting, agentModels: { claude: [] } } as never)!;
    expect(none.models).toEqual([]);
    expect(values(modelsForAgent("cursor", { protocolVersion: 1, agentCapabilities: {}, _meta: none }))).toEqual([]);
    expect(creatorModelMetadata("codex", acting as never)).toMatchObject({ models: [], modelEnvVar: "OPENAI_MODEL", modelsAccountScoped: true });
  });

  it("keeps today's metadata for an older control plane (no agentModels) and for non-activated workspaces", () => {
    const { agentModels: _models, ...older } = acting;
    expect(creatorModelMetadata("claude", older as never)).toBeUndefined();
    expect(creatorModelMetadata("claude", { ...config, agentModels: acting.agentModels } as never)).toBeUndefined();
  });

  it("parses agentModels like the control plane: unique, ≤ 128, valid ids, known agents only", () => {
    expect(CloudV2ControlFrameSchema.safeParse(acting).success).toBe(true);
    for (const bad of [{ claude: ["a", "a"] }, { claude: ["not a model"] }, { gemini: ["x"] }, { claude: Array.from({ length: 129 }, (_, i) => `m${i}`) }])
      expect(CloudV2ControlFrameSchema.safeParse({ ...acting, agentModels: bad }).success).toBe(false);
    expect(CLOUD_WORKER_FEATURES.split(",")).toContain(CREATOR_AGENT_MODELS_FEATURE);
  });

  it("tells every client to re-read agents when the login revision changes, and only then", async () => {
    const env = await setup();
    const signals = () => env.relay.bridge("DB_CHANGED").filter(entry => (entry.frame as { kinds: string[] }).kinds.includes("agents"));
    await env.relay.receive({ ...config, mcpServers: [] });
    expect(signals()).toHaveLength(0);
    await env.relay.receive({ ...config, loginRevision: "1" });
    expect(signals()).toEqual([{ clientId: "*", frame: expect.objectContaining({ type: "DB_CHANGED", kinds: ["agents"], workspaceIds: [config.workspace.id] }) }]);
  });
});
