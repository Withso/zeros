import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRegistration } from "../../types";
import { McpHttpLauncher } from "../http-launcher";
import { LaunchedMcpServers } from "../launched-servers";

const server: McpServerRegistration = { name: "fixture", transport: "stdio", command: "node", args: [], listenUrl: "http://127.0.0.1:3222/mcp" };
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
};
beforeEach(() => {
  vi.spyOn(McpHttpLauncher.prototype, "ensureRunning").mockResolvedValue();
  vi.spyOn(McpHttpLauncher.prototype, "dispose").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("launched MCP owner lifetime", () => {
  it.each(["workspace", "organization"])("keeps another owner's startup and queued admission alive after %s removal", async kind => {
    const pool = new LaunchedMcpServers(vi.fn()), held = deferred();
    await pool.resolve([server], "/a", {}, "a", "/a", true);
    vi.mocked(McpHttpLauncher.prototype.ensureRunning).mockImplementationOnce(() => held.promise);
    const first = pool.resolve([server], "/b", {}, "b", "/b", false);
    const queued = pool.resolve([server], "/b", {}, "b", "/b", false);
    const result = Promise.allSettled([first, queued]);
    await vi.waitFor(() => expect(McpHttpLauncher.prototype.ensureRunning).toHaveBeenCalledTimes(2));
    await pool.removeWhere(entry => kind === "workspace" ? entry.owner === "a" : entry.organization);
    held.resolve();
    expect((await result).map(value => value.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(McpHttpLauncher.prototype.dispose).toHaveBeenCalledOnce();
    await pool.stop();
  });

  it("fences both the running and queued admission for a removed owner", async () => {
    const pool = new LaunchedMcpServers(vi.fn()), held = deferred();
    vi.mocked(McpHttpLauncher.prototype.ensureRunning).mockImplementationOnce(() => held.promise);
    const first = pool.resolve([server], "/a", {}, "a", "/a", false);
    const queued = pool.resolve([server], "/a", {}, "a", "/a", false);
    const result = Promise.allSettled([first, queued]);
    await vi.waitFor(() => expect(McpHttpLauncher.prototype.ensureRunning).toHaveBeenCalledOnce());
    await pool.removeWhere(entry => entry.owner === "a");
    held.resolve();
    expect((await result).map(value => value.status)).toEqual(["rejected", "rejected"]);
    expect(McpHttpLauncher.prototype.ensureRunning).toHaveBeenCalledOnce();
    await expect(pool.resolve([server], "/a", {}, "a", "/a", false)).resolves.toMatchObject([{ transport: "http" }]);
    await pool.stop();
    await expect(pool.resolve([server], "/b", {}, "b", "/b", false)).rejects.toThrow("runtime changed");
  });

  it("fences a queued workspace even before it has a process entry", async () => {
    const pool = new LaunchedMcpServers(vi.fn()), held = deferred();
    vi.mocked(McpHttpLauncher.prototype.ensureRunning).mockImplementationOnce(() => held.promise);
    const first = pool.resolve([server], "/a", {}, "shared-owner", "/repo", false);
    const queued = pool.resolve([server], "/b", {}, "shared-owner", "/repo", false);
    const result = Promise.allSettled([first, queued]);
    await vi.waitFor(() => expect(McpHttpLauncher.prototype.ensureRunning).toHaveBeenCalledOnce());
    await pool.removeWhere(entry => entry.cwd === "/b");
    held.resolve();
    expect((await result).map(value => value.status)).toEqual(["fulfilled", "rejected"]);
    expect(McpHttpLauncher.prototype.ensureRunning).toHaveBeenCalledOnce();
    await pool.stop();
  });
});
