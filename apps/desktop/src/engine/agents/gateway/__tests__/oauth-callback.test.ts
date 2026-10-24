import http from "node:http";
import { describe, expect, it } from "vitest";
import { McpOAuthCallback } from "../oauth-callback";
import { McpGateway } from "../server";

describe("shared MCP OAuth callback", () => {
  it("keeps a single redirect address across project gateways and routes exact states", async () => {
    const callback = new McpOAuthCallback(0);
    const one = new McpGateway({ port: 0, callbackPort: 0, callback });
    const two = new McpGateway({ port: 0, callbackPort: 0, callback });
    try {
      await Promise.all([one.start([]), two.start([])]);
      const url = callback.url;
      const seen: string[] = [];
      const remove = callback.register(query => { if (query.get("state") !== "two") return false; seen.push(query.get("code")!); return true; });
      expect((await fetch(`${url}?state=wrong&code=a`)).status).toBe(400);
      const response = await fetch(`${url}?state=two&code=b`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(seen).toEqual(["b"]);
      await one.stop();
      expect(callback.url).toBe(url);
      expect((await fetch(`${url}?state=two&code=c`)).status).toBe(200);
      remove();
      expect((await fetch(`${url}?state=two&code=d`)).status).toBe(400);
    } finally { await one.stop(); await two.stop(); await callback.stop(); }
  });
  it("rejects duplicate state, foreign Host and non-GET callbacks", async () => {
    const callback = new McpOAuthCallback(0);
    try {
      await callback.start();
      callback.register(() => true);
      expect((await fetch(`${callback.url}?state=a&state=b`)).status).toBe(400);
      expect((await fetch(`${callback.url}?state=a`, { method: "POST" })).status).toBe(400);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        http.get(`${callback.url}?state=a`, { headers: { host: "foreign.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
      });
      expect(status).toBe(400);
    } finally { await callback.stop(); }
  });
});
