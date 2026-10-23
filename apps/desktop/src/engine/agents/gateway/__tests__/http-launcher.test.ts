import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpLauncher as Launcher, resolveMcpCwd, type McpHttpLaunchOptions } from "../http-launcher";
import { HostExecutionBoundary } from "../../containment/host-boundary";
import type { PreparedBoundary } from "../../containment/types";
class McpHttpLauncher extends Launcher {
  constructor(options: Omit<McpHttpLaunchOptions, "boundaryFactory">) {
    const boundary = new HostExecutionBoundary({ projectRoot: process.cwd() });
    super({ ...options, boundaryFactory: request => boundary.prepare({ executionId: request.executionId,
      actor: "repo-code-task", cwd: request.cwd, workspaceRoot: request.workspaceRoot }) });
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zeros-mcp-launch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { root, server, port, url: `http://127.0.0.1:${port}/mcp` };
}
const close = (server: ReturnType<typeof createServer>) => new Promise<void>(resolve => server.close(() => resolve()));

describe("launched loopback MCP lifecycle", () => {
  it("retries retained cleanup proof after a refusal and shares concurrent disposal", async () => {
    let release!: () => void;
    const stopAndProve = vi.fn().mockRejectedValueOnce(new Error("Fixture cleanup refusal"))
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const launcher = new Launcher({ command: "node", listenUrl: "http://127.0.0.1:3222/mcp", workspaceRoot: "/fixture", boundaryFactory: vi.fn() });
    // Retain the same boundary handle a real successful launch would own.
    (launcher as unknown as { boundary: PreparedBoundary }).boundary = { stopAndProve } as unknown as PreparedBoundary;
    await expect(launcher.dispose()).rejects.toThrow("Fixture cleanup refusal");
    const retry = launcher.dispose();
    const concurrent = launcher.dispose();
    expect(retry).toBe(concurrent);
    const result = retry.then(() => true, () => false);
    try {
      await vi.waitFor(() => expect(stopAndProve).toHaveBeenCalledTimes(2));
    } finally { release?.(); await result; }
    expect(await result).toBe(true);
    await launcher.dispose();
    expect(stopAndProve).toHaveBeenCalledTimes(2);
    await expect(launcher.ensureRunning()).rejects.toThrow("closed");
  });

  it("starts once on demand, passes literal args/env/cwd, and stops on dispose", async () => {
    const { root, server, port, url } = await fixture();
    await close(server);
    const marker = join(root, "launch.json");
    const launcher = new McpHttpLauncher({ command: process.execPath, args: ["-e",
      `require('node:fs').appendFileSync(process.env.MCP_MARKER, JSON.stringify([process.cwd(),process.argv[1],process.env.MCP_VALUE])); require('node:net').createServer(s=>s.end()).listen(${port},'127.0.0.1');`,
      "$(must-stay-literal)"], env: { MCP_MARKER: marker, MCP_VALUE: "fixture-value" }, listenUrl: url, workspaceRoot: root });
    cleanups.push(() => launcher.dispose());
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([launcher.ensureRunning(), launcher.ensureRunning()]);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([root, "$(must-stay-literal)", "fixture-value"]);
    await launcher.dispose();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
    await close(server);
    await expect(launcher.ensureRunning()).rejects.toThrow("closed");
  });

  it("refuses an occupied endpoint before executing a command", async () => {
    const { root, server, url } = await fixture();
    cleanups.push(() => close(server));
    const marker = join(root, "unexpected");
    const launcher = new McpHttpLauncher({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(process.argv[1], 'launched')`, marker], listenUrl: url, workspaceRoot: root });
    cleanups.push(() => launcher.dispose());
    await expect(launcher.ensureRunning()).rejects.toThrow("already in use");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds startup and cancels an abandoned launch without idle retries", async () => {
    const { root, server, url } = await fixture();
    await close(server);
    const launcher = new McpHttpLauncher({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], listenUrl: url,
      workspaceRoot: root, startupTimeoutMs: 400 });
    cleanups.push(() => launcher.dispose());
    await expect(launcher.ensureRunning()).rejects.toThrow("start");
    const controller = new AbortController();
    const pending = launcher.ensureRunning(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await launcher.dispose();
  });

  it("rejects remote endpoints and expands cwd relative to the runtime", () => {
    for (const listenUrl of ["https://127.0.0.1:123/mcp", "http://example.test/mcp", "http://user@127.0.0.1/mcp", "http://127.0.0.1/mcp#x"])
      expect(() => new McpHttpLauncher({ command: "node", listenUrl, workspaceRoot: "/repo" })).toThrow();
    expect(resolveMcpCwd("../tools", "/workspace/repo", "/home/runtime")).toBe("/workspace/tools");
    expect(resolveMcpCwd("~/tools", "/workspace/repo", "/home/runtime")).toBe("/home/runtime/tools");
    expect(resolveMcpCwd(undefined, "/workspace/repo", "/home/runtime")).toBe("/workspace/repo");
  });
});
