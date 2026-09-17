import { describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({ disposeCursorHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import * as registry from "../agents/mcp-registry";

describe("engine MCP catalog lifetime", () => {
  it("keeps existing gateway clients connected when the last backend is removed, then reuses that endpoint", async () => {
    const resolve = vi.spyOn(registry, "resolveMcpServers").mockReturnValue({ servers: [], sources: [], gatewayBackends: [], warnings: [] });
    const gateway = { url: "http://127.0.0.1:9000/mcp", catalogRevision: "fixture:1", reload: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      mcpGateway: gateway, gatewayError: null, gatewayReloadChain: Promise.resolve(),
      agents: { setGatewayServer: vi.fn() }, startGateway: vi.fn(),
    });
    try {
      engine.reloadGateway();
      await engine.gatewayReloadChain;
      expect(gateway.reload).toHaveBeenCalledWith([]);
      expect(gateway.stop).not.toHaveBeenCalled();
      expect(engine.mcpGateway).toBe(gateway);
      expect(engine.agents.setGatewayServer).toHaveBeenLastCalledWith(null);
      const backend = { name: "restored", url: "https://mcp.example.test", auth: "oauth" as const, source: "user" as const };
      resolve.mockReturnValue({ servers: [], sources: [], gatewayBackends: [backend], warnings: [] });
      engine.reloadGateway();
      await engine.gatewayReloadChain;
      expect(gateway.reload).toHaveBeenLastCalledWith([backend]);
      expect(engine.agents.setGatewayServer).toHaveBeenLastCalledWith(gateway.url, expect.any(Function));
      const revision = engine.agents.setGatewayServer.mock.calls.at(-1)![1];
      expect(revision()).toBe("fixture:1");
      gateway.catalogRevision = "fixture:2";
      expect(revision()).toBe("fixture:2");
      expect(engine.startGateway).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });
});
