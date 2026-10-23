import { describe, expect, it } from "vitest";
import { cloudV2AgentConfig } from "./composition.js";

const secret = (value: string) => value.padEnd(24, "x");
const proxy = async () => ({ token: "zw2p_token", expiresAt: 1 });

describe("cloud v2 agent configuration", () => {
  it("gives Claude and Cursor their own credentials, as Conductor does, and Codex the model proxy", async () => {
    expect(await cloudV2AgentConfig({
      codex: { kind: "codex-chatgpt", accessToken: secret("chatgpt"), accountId: "acct", expiresAt: 2_000_000_000 },
      claude: { kind: "claude-setup-token", accessToken: secret("sk-ant-oat01") },
      cursor: { kind: "cursor-api-key", apiKey: secret("crsr_key") },
    }, "https://api.example.test/v2/cloud/proxy", proxy)).toEqual({
      codex: { baseUrl: "https://api.example.test/v2/cloud/proxy/openai", token: "zw2p_token", expiresAt: 1 },
      claude: { oauthToken: secret("sk-ant-oat01") },
      cursor: { apiKey: secret("crsr_key") },
    });
    expect(await cloudV2AgentConfig({ claude: { kind: "claude-api-key", apiKey: secret("sk-ant-api") } }, "https://x.test", proxy))
      .toEqual({ claude: { apiKey: secret("sk-ant-api") } });
    expect(await cloudV2AgentConfig({}, "https://x.test", proxy)).toEqual({});
  });
});
