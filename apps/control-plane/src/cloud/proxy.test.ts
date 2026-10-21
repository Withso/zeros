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
  const refreshCodex = vi.fn(async () => { if (refreshed) logins.codex = refreshed; });
  const app = createCloudV2ProxyRoutes({
    store: { verifyProxyToken: vi.fn(async value => value === token ? workspace : null) },
    logins: vi.fn(async (_owner, _org, provider) => logins[provider] ?? null),
    refreshCodex,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 1_000_000_000,
  });
  return { app, fetch, refreshCodex };
}

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
