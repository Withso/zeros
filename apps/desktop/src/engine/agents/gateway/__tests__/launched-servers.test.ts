import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRegistration } from "../../types";
import { McpServerStartError } from "../../mcp-registration";
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
    await expect(pool.resolve([server], "/a", {}, "a", "/a", false)).resolves.toMatchObject({ servers: [{ transport: "http" }], unavailable: [] });
    await pool.stop();
    await expect(pool.resolve([server], "/b", {}, "b", "/b", false)).rejects.toThrow("runtime changed");
  });

  it("leaves out a server that does not start, says why, and keeps the others", async () => {
    const pool = new LaunchedMcpServers(vi.fn());
    const other = { ...server, name: "other", listenUrl: "http://127.0.0.1:3223/mcp" };
    const unknown = { ...server, name: "unknown", listenUrl: "http://127.0.0.1:3224/mcp" };
    const direct: McpServerRegistration = { name: "direct", transport: "stdio", command: "node" };
    vi.mocked(McpHttpLauncher.prototype.ensureRunning)
      .mockRejectedValueOnce(new McpServerStartError("The server exited before it started listening."))
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("spawn /private/path ENOENT"));
    await expect(pool.resolve([server, other, unknown, direct], "/a", {}, "a", "/a", false)).resolves.toEqual({
      servers: [{ name: "other", transport: "http", url: "http://127.0.0.1:3223/mcp" }, direct],
      unavailable: [
        { name: "fixture", detail: "The server exited before it started listening." },
        { name: "unknown", detail: "Could not start this server. Check its settings, then start a new chat." },
      ],
    });
    // A cancelled admission still fails as a whole instead of dropping servers.
    const controller = new AbortController();
    vi.mocked(McpHttpLauncher.prototype.ensureRunning).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(pool.resolve([server], "/a", {}, "a", "/a", false, controller.signal)).rejects.toThrow();
    await pool.stop();
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

  it("gives a launched server only the scrubbed base environment and its own variables", async () => {
    const started: Array<Record<string, string> | undefined> = [];
    vi.mocked(McpHttpLauncher.prototype.ensureRunning).mockImplementationOnce(async function (this: McpHttpLauncher) {
      started.push((this as unknown as { options: { env?: Record<string, string> } }).options.env);
    });
    const pool = new LaunchedMcpServers(vi.fn());
    const own = "ZEROS_MCP_0123456789ABCDEF0123456789ABCDEF_TOKEN";
    await pool.resolve([{ ...server, envFromEnv: { TOKEN: own } }], "/a", {
      HOME: "/home/user",
      LANG: "C.UTF-8",
      PATH: `/tmp/zeros-git-auth-fixture${path.delimiter}/usr/bin`,
      [own]: "own-secret",
      ZEROS_MCP_FEDCBA9876543210FEDCBA9876543210_TOKEN: "other-server-secret",
      ZEROS_LOCAL_TOKEN: "engine-secret",
      ZEROS_MCP_GATEWAY_CAPABILITY: "capability",
      ZEROS_GIT_AUTH_SOCKET: "/tmp/broker.sock",
      CURSOR_API_KEY: "provider-secret",
    }, "a", "/a", false);
    expect(started).toEqual([{ HOME: "/home/user", LANG: "C.UTF-8", PATH: "/usr/bin", TOKEN: "own-secret" }]);
    await pool.stop();
  });
});
