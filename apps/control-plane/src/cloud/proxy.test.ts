import { describe, expect, it, vi } from "vitest";
import type { CloudAgentCredentialMaterial } from "../cloud-workspaces/agent-credential-envelope.js";
import { createCloudV2ProxyRoutes } from "./proxy.js";
import type { CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";

const token = newCloudV2Token("proxy").token;
const workspace = { id: "w", organizationId: "org", creatorUserId: "creator", state: "running" } as CloudV2Workspace;
const secret = (value: string) => value.padEnd(24, "x");

function setup(logins: Partial<Record<"codex" | "claude" | "cursor", CloudAgentCredentialMaterial>>) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "a=b" } }));
  const app = createCloudV2ProxyRoutes({
    store: { verifyProxyToken: vi.fn(async value => value === token ? workspace : null) },
    logins: vi.fn(async (_owner, _org, provider) => logins[provider] ?? null),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 1_000_000_000,
  });
  return { app, fetch };
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

  it("uses a Claude setup token with the OAuth beta and an API key without it", async () => {
    const oauth = setup({ claude: { kind: "claude-setup-token", accessToken: secret("sk-ant-oat01") } });
    await oauth.app.request("/v2/cloud/proxy/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}`, "anthropic-beta": "a,b" }, body: "{}" });
    const [url, init] = oauth.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init.headers).get("anthropic-beta")).toBe("a,b,oauth-2025-04-20");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret("sk-ant-oat01")}`);
    const key = setup({ claude: { kind: "claude-api-key", apiKey: secret("sk-ant-api") } });
    await key.app.request("/v2/cloud/proxy/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" });
    const headers = new Headers(key.fetch.mock.calls[0]![1].headers);
    expect(headers.get("x-api-key")).toBe(secret("sk-ant-api"));
    expect(headers.get("authorization")).toBeNull();
  });

  it("refuses bad tokens, missing or expired logins and path tricks without calling upstream", async () => {
    const { app, fetch } = setup({ codex: { kind: "codex-chatgpt", accessToken: secret("t"), accountId: "a", expiresAt: 1_000_000 } });
    expect((await app.request("/v2/cloud/proxy/openai/responses", { headers: { authorization: "Bearer zw2p_bad" } })).status).toBe(401);
    expect((await app.request("/v2/cloud/proxy/openai/responses", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.request("/v2/cloud/proxy/anthropic/v1/messages", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.request("/v2/cloud/proxy/other/x", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
