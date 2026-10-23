import { describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
// This fixture must never use a real public socket, including on a red run
// before the injected request seam exists.
vi.mock("node:https", () => ({ request: vi.fn(() => { throw new Error("Unexpected network I/O in MCP fixture"); }) }));
import { mcpPublicAddress, mcpPublicUrl, safeMcpFetch } from "./safe-fetch.js";

describe("control-plane MCP network boundary", () => {
  it("rejects private, mapped, translated and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "0.0.0.0", "100.64.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "fd00::1", "2001:db8::1"])
      expect(mcpPublicAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(mcpPublicAddress(address)).toBe(true);
    for (const url of ["http://example.test/mcp", "https://user:pass@example.test/mcp", "https://127.0.0.1/mcp", "file:///etc/hosts"])
      expect(() => mcpPublicUrl(url)).toThrow();
  });

  it("refuses DNS answers containing any internal address before opening a socket", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(safeMcpFetch("https://example.test/mcp", {}, { lookup })).rejects.toThrow("public HTTPS");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("cancels a held DNS lookup without opening a late socket", async () => {
    let release!: (value: Array<{ address: string; family: number }>) => void;
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(resolve => { release = resolve; }));
    const controller = new AbortController();
    let settled = false;
    const pending = safeMcpFetch("https://example.test/mcp", { signal: controller.signal }, { lookup }).then(() => false, () => { settled = true; return true; });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    controller.abort();
    try { await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 }); }
    finally { release([{ address: "8.8.8.8", family: 4 }]); await pending; }
  });

  it("pins validated DNS in the real request options and closes the source socket when its consumer cancels", async () => {
    let sourceClosed = false;
    const server = createServer((req, res) => { req.once("close", () => { sourceClosed = true; }); res.writeHead(200); res.write("fixture"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const request = vi.fn(((url: string | URL, options: import("node:https").RequestOptions, callback: (res: import("node:http").IncomingMessage) => void) => {
      expect(new URL(String(url)).hostname).toBe("example.test");
      const lookup = options.lookup as (host: string, options: object, callback: (error: unknown, address: string, family: number) => void) => void;
      lookup("example.test", {}, (_error: unknown, address: string, family: number) => {
        expect([address, family]).toEqual(["8.8.8.8", 4]);
      });
      return httpRequest({ ...options, hostname: "127.0.0.1", host: "127.0.0.1", port: (server.address() as { port: number }).port, path: "/" }, callback);
    }) as typeof httpsRequest);
    try {
      const response = await safeMcpFetch("https://example.test/mcp", {}, { request, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      await response.body?.cancel();
      await vi.waitFor(() => expect(sourceClosed).toBe(true), { timeout: 500 });
      expect(request).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
