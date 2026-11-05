import { describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({ disposeCursorHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import * as registry from "../agents/mcp-registry";

describe("engine MCP catalog lifetime", () => {
  it("keeps existing gateway clients connected when the last backend is removed, then reuses that endpoint", async () => {
    const resolve = vi.spyOn(registry, "resolveMcpServers").mockReturnValue({ servers: [], sources: [], gatewayBackends: [], warnings: [] });
    const gateway = { url: "http://127.0.0.1:9000/mcp", authorization: `Bearer ${"a".repeat(43)}`, catalogRevision: "fixture:1", reload: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      mcpGateway: gateway, gatewayError: null, gatewayReloadChain: Promise.resolve(),
      scopedMcpGateways: { roots: () => [] },
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
      expect(engine.agents.setGatewayServer).toHaveBeenLastCalledWith({ url: gateway.url, authorization: gateway.authorization }, expect.any(Function));
      const revision = engine.agents.setGatewayServer.mock.calls.at(-1)![1];
      expect(revision()).toBe("fixture:1");
      gateway.catalogRevision = "fixture:2";
      expect(revision()).toBe("fixture:2");
      expect(engine.startGateway).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });
  it("keeps unchanged backends and a pending sign-in when a settings write leaves MCP unchanged", async () => {
    const backend = { name: "remote", url: "https://mcp.example.test", auth: "oauth" as const, source: "user" as const };
    let resolved = [{ ...backend }];
    const resolve = vi.spyOn(registry, "resolveMcpServers").mockImplementation(() => ({ servers: [], sources: [], gatewayBackends: resolved.map(row => ({ ...row })), warnings: [] }));
    const gateway = { url: "http://127.0.0.1:9000/mcp", authorization: `Bearer ${"a".repeat(43)}`, catalogRevision: "fixture:1",
      backends: [{ ...backend }] as unknown[], reload: vi.fn(async (next: unknown[]) => { gateway.backends = next; }), stop: vi.fn() };
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      mcpGateway: gateway, gatewayError: null as string | null, gatewayReloadChain: Promise.resolve(),
      scopedMcpGateways: { roots: () => [] }, agents: { setGatewayServer: vi.fn() }, startGateway: vi.fn(),
    });
    const reload = async (force?: boolean) => { engine.reloadGateway(force); await engine.gatewayReloadChain; };
    try {
      // Save & connect: the save reconnects, sign-in starts, then the settings
      // watcher sees that same write. Reconnecting again would cancel sign-in.
      await reload();
      expect(gateway.reload).toHaveBeenCalledTimes(1);
      await reload(false);
      expect(gateway.reload).toHaveBeenCalledTimes(1);
      resolved = [{ ...backend, disabledTools: ["delete"] } as typeof backend];
      await reload(false);
      expect(gateway.reload).toHaveBeenCalledTimes(2);
      engine.gatewayError = "listen EADDRINUSE";
      await reload(false);
      expect(gateway.reload).toHaveBeenCalledTimes(3);
    } finally { resolve.mockRestore(); }
  });
});
