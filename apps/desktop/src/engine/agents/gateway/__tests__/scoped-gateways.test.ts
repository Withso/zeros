import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthVault } from "../oauth-provider";
import type { GatewayBackend } from "../../mcp-registry";

const mocks = vi.hoisted(() => ({ start: vi.fn(), reload: vi.fn(), stop: vi.fn() }));
vi.mock("../server", () => ({
  McpGateway: class {
    start = mocks.start;
    reload = mocks.reload;
    stop = mocks.stop;
  },
}));
import { ScopedMcpGateways } from "../scoped-gateways";

const backend: GatewayBackend = { name: "one", url: "https://example.test/mcp", auth: "oauth", source: "user" };
describe("project MCP gateway lifetime", () => {
  beforeEach(() => {
    mocks.start.mockReset().mockResolvedValue(undefined);
    mocks.reload.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });
  it("shares the admitted initialization without extra startup work", async () => {
    const gateways = new ScopedMcpGateways(() => new OAuthVault(), () => undefined);
    const [one, two] = await Promise.all([gateways.get("project", [backend]), gateways.get("project", [backend])]);
    expect(one).toBe(two);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.reload).not.toHaveBeenCalled();
    await gateways.stop();
  });
  it("does not run a queued reload after its project was removed", async () => {
    let release!: () => void;
    mocks.start.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const gateways = new ScopedMcpGateways(() => new OAuthVault(), () => undefined);
    const first = gateways.get("project", [backend]);
    const queued = gateways.get("project", [{ ...backend, url: "https://changed.test/mcp" }]);
    const results = Promise.allSettled([first, queued]);
    const removed = gateways.remove("project");
    release();
    await removed;
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(gateways.roots()).toEqual([]);
  });
  it("a retired startup failure cannot evict the replacement project", async () => {
    let reject!: (error: Error) => void;
    mocks.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const gateways = new ScopedMcpGateways(() => new OAuthVault(), () => undefined);
    const first = gateways.get("project", [backend]).catch(() => {});
    const removed = gateways.remove("project");
    const replacement = await gateways.get("project", [backend]);
    reject(new Error("Retired startup"));
    await Promise.all([first, removed]);
    expect(gateways.roots()).toEqual(["project"]);
    expect(await gateways.get("project", [backend])).toBe(replacement);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    await gateways.stop();
  });
});
