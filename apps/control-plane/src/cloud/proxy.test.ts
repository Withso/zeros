import { describe, expect, it, vi } from "vitest";
import type { CloudAgentCredentialMaterial } from "../agent-credentials/agent-credential-envelope.js";
import { createCloudV2ProxyRoutes } from "./proxy.js";
import type { CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";

const token = newCloudV2Token("proxy").token;
const workspace = { id: "w", organizationId: "org", creatorUserId: "creator", state: "running" } as CloudV2Workspace;
const secret = (value: string) => value.padEnd(24, "x");

function setup(logins: Partial<Record<"codex" | "claude" | "cursor", CloudAgentCredentialMaterial>>, refreshed?: CloudAgentCredentialMaterial) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "a=b" } }));
  let now = 1_000_000_000;
  const verifyProxyToken = vi.fn(async (value: string) => value === token ? workspace : null);
  const login = vi.fn(async (_owner: string, _org: string, provider: "codex" | "claude" | "cursor") => logins[provider] ?? null);
  const refreshCodex = vi.fn(async () => { if (refreshed) logins.codex = refreshed; });
  const app = createCloudV2ProxyRoutes({
    store: { verifyProxyToken },
    logins: login,
    refreshCodex,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
  });
  return { app, fetch, refreshCodex, verifyProxyToken, login, advance: (ms: number) => { now += ms; } };
}

const modelsPath = "/v2/cloud/proxy/openai/model-availability";
const modelList = (...ids: string[]) => Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
const modelRequest = (app: ReturnType<typeof setup>["app"]) => app.request(modelsPath, { headers: { authorization: `Bearer ${token}` } });

describe("cloud Codex account model discovery", () => {
  it("bounds retained credential catalogs and evicts the least recently read key", async () => {
    const selected = { codex: { kind: "codex-api-key" as const, apiKey: secret("key-0") } };
    const env = setup(selected);
    env.fetch.mockImplementation(async () => modelList("gpt-6-luna"));
    for (let key = 0; key < 129; key++) {
      selected.codex.apiKey = secret(`key-${key}`);
      await modelRequest(env.app);
    }
    expect(env.fetch).toHaveBeenCalledTimes(129);
    await modelRequest(env.app); // newest key is retained
    expect(env.fetch).toHaveBeenCalledTimes(129);
    selected.codex.apiKey = secret("key-0");
    await modelRequest(env.app);
    expect(env.fetch).toHaveBeenCalledTimes(130);
  });

  it("abandons provider discovery at its deadline and never reflects the thrown diagnostic", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(1));
    try {
      const env = setup({ codex: { kind: "codex-api-key", apiKey: secret("key-a") } });
      env.fetch.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("private-provider-request-detail")), { once: true });
      }));
      expect(await (await modelRequest(env.app)).json()).toEqual({ models: null });
      expect(timer).toHaveBeenCalledExactlyOnceWith(2_000);
    } finally { timer.mockRestore(); }
  });

  it("coalesces the provider list and caches per credential while checking live authority on every read", async () => {
    const selected = { codex: { kind: "codex-api-key" as const, apiKey: secret("key-a") } };
    const env = setup(selected);
    env.fetch.mockImplementation(async () => modelList("gpt-6-luna"));
    const responses = await Promise.all(Array.from({ length: 8 }, () => modelRequest(env.app)));
    for (const response of responses) expect(await response.json()).toEqual({ models: ["gpt-6-luna"] });
    expect(env.fetch).toHaveBeenCalledOnce();
    const [url, request] = env.fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${selected.codex.apiKey}`);
    expect(env.verifyProxyToken).toHaveBeenCalledTimes(8);
    expect(env.login).toHaveBeenCalledTimes(8);
    env.advance(5 * 60_000 - 1);
    expect(await (await modelRequest(env.app)).json()).toEqual({ models: ["gpt-6-luna"] });
    expect(env.fetch).toHaveBeenCalledOnce();
    env.advance(2);
    await modelRequest(env.app);
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse another key's eligibility and refuses revoked authority even when cached", async () => {
    const selected = { codex: { kind: "codex-api-key" as const, apiKey: secret("key-a") } };
    const env = setup(selected);
    env.fetch.mockImplementation(async () => modelList("gpt-6-luna"));
    await modelRequest(env.app);
    selected.codex = { kind: "codex-api-key", apiKey: secret("key-b") };
    env.fetch.mockImplementation(async () => modelList("gpt-6.1-sol"));
    expect(await (await modelRequest(env.app)).json()).toEqual({ models: ["gpt-6.1-sol"] });
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(env.fetch.mock.calls[1][1].headers).get("authorization")).toBe(`Bearer ${selected.codex.apiKey}`);
    env.verifyProxyToken.mockResolvedValue(null);
    expect((await modelRequest(env.app)).status).toBe(401);
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(env.login).toHaveBeenCalledTimes(2);
  });

  it("leaves ChatGPT discovery alone and does not call OpenAI for a missing login", async () => {
    const env = setup({ codex: { kind: "codex-chatgpt", accessToken: secret("chatgpt-access"), accountId: "acct_1", expiresAt: 2_000_000 } });
    expect(await (await modelRequest(env.app)).json()).toEqual({ models: null });
    expect(env.fetch).not.toHaveBeenCalled();
    env.login.mockResolvedValue(null);
    expect((await modelRequest(env.app)).status).toBe(401);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid json", () => new Response("not-json")],
    ["non-list", () => Response.json({ data: [{ id: "gpt-6-luna" }] })],
    ["partial", () => Response.json({ object: "list", data: [{ id: "gpt-6-luna" }], has_more: true })],
    ["malformed", () => Response.json({ object: "list", data: [{ id: "gpt-6-luna" }, {}] })],
    ["unbounded", () => modelList(...Array.from({ length: 1001 }, (_, i) => `model-${i}`))],
    ["too large", () => new Response("x".repeat(256 * 1024 + 1))],
    ["forbidden", () => Response.json({ error: "private provider detail" }, { status: 403 })],
  ])("treats %s discovery as unknown, with a short retry cache", async (_name, response) => {
    const env = setup({ codex: { kind: "codex-api-key", apiKey: secret("key-a") } });
    env.fetch.mockImplementation(async () => response());
    expect(await (await modelRequest(env.app)).json()).toEqual({ models: null });
    await modelRequest(env.app);
    expect(env.fetch).toHaveBeenCalledOnce();
    env.advance(30_001);
    env.fetch.mockImplementation(async () => modelList());
    expect(await (await modelRequest(env.app)).json()).toEqual({ models: [] });
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("cloud v2 model proxy", () => {
  it("swaps the workspace token for the creator's ChatGPT login and streams the reply", async () => {
    const { app, fetch } = setup({ codex: { kind: "codex-chatgpt", accessToken: secret("chatgpt-access"), accountId: "acct_1", expiresAt: 2_000_000 } });
    const response = await app.request("/v2/cloud/proxy/openai/responses?x=1", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", originator: "codex_cli_rs", cookie: "c=d" },
      body: JSON.stringify({ model: "gpt" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    expect(response.headers.get("set-cookie")).toBeNull();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses?x=1");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${secret("chatgpt-access")}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct_1");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("cookie")).toBeNull();
    expect([...headers.values()].join()).not.toContain(token);
  });

  it("renews an expiring ChatGPT login with the vault's renewal before forwarding", async () => {
    const stale = { kind: "codex-chatgpt" as const, accessToken: secret("stale-access"), accountId: "acct_1", expiresAt: 1_000_010 };
    const fresh = { ...stale, accessToken: secret("fresh-access"), expiresAt: 2_000_000 };
    const { app, fetch, refreshCodex } = setup({ codex: stale }, fresh);
    const response = await app.request("/v2/cloud/proxy/openai/responses", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(response.status).toBe(200);
    expect(refreshCodex).toHaveBeenCalledExactlyOnceWith("creator", "org");
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("authorization")).toBe(`Bearer ${secret("fresh-access")}`);
    const unrenewed = setup({ codex: stale });
    expect((await unrenewed.app.request("/v2/cloud/proxy/openai/responses", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(401);
    expect(unrenewed.fetch).not.toHaveBeenCalled();
  });

  it("proxies only Codex; Claude runs with its own credential on the VM", async () => {
    const { app, fetch } = setup({ claude: { kind: "claude-setup-token", accessToken: secret("sk-ant-oat01") } });
    const response = await app.request("/v2/cloud/proxy/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses bad tokens, missing or expired logins and path tricks without calling upstream", async () => {
    const { app, fetch } = setup({ codex: { kind: "codex-chatgpt", accessToken: secret("t"), accountId: "a", expiresAt: 1_000_000 } });
    expect((await app.request("/v2/cloud/proxy/openai/responses", { headers: { authorization: "Bearer zw2p_bad" } })).status).toBe(401);
    expect((await app.request("/v2/cloud/proxy/openai/responses", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.request("/v2/cloud/proxy/other/x", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
