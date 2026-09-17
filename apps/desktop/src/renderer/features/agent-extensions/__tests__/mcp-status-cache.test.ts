import { describe, expect, it } from "vitest";
import {
  mcpGatewayStatusCache,
  mcpGatewayStatusKey,
} from "../../../state/read-caches";

describe("MCP status ownership", () => {
  it("does not show the prior engine's authentication after retargeting a stable bridge", () => {
    const bridge = {};
    const local = mcpGatewayStatusKey(bridge, "local:sidecar");
    mcpGatewayStatusCache.setData(local, { running: true, error: null, servers: [] });
    const cloud = mcpGatewayStatusKey(bridge, "cloud:org:workspace:2:1:engine");
    expect(mcpGatewayStatusCache.getSnapshot(cloud).data).toBeUndefined();
  });
  it("keeps each engine's status isolated and rejects responses superseded by sign-in", async () => {
    const first = mcpGatewayStatusKey({});
    const second = mcpGatewayStatusKey({});
    const connected = {
      running: true,
      error: null,
      servers: [
        {
          name: "docs",
          url: "https://example.test/mcp",
          state: "connected" as const,
          toolCount: 1,
        },
      ],
    };
    mcpGatewayStatusCache.setData(first, connected);
    expect(mcpGatewayStatusCache.getSnapshot(second).data).toBeUndefined();
    let resolve!: (value: typeof connected) => void;
    const pending = mcpGatewayStatusCache.load(
      first,
      () =>
        new Promise<typeof connected>((done) => {
          resolve = done;
        }),
      { force: true },
    );
    expect(mcpGatewayStatusCache.getSnapshot(first).data).toBe(connected);
    await Promise.resolve();
    const newer = { ...connected, servers: [] };
    mcpGatewayStatusCache.setData(first, newer);
    resolve(connected);
    await pending;
    expect(mcpGatewayStatusCache.getSnapshot(first).data).toBe(newer);
  });
});
