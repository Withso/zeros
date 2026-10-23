import { describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import { PassThrough, Writable } from "node:stream";
// This fixture must never use a real public socket, including on a red run
// before the injected request seam exists.
vi.mock("node:https", () => ({ request: vi.fn(() => { throw new Error("Unexpected network I/O in MCP fixture"); }) }));
import { mcpPublicAddress, mcpPublicUrl, safeMcpFetch } from "./safe-fetch.js";

function bufferedResponse(bytes: number, end = false) {
  const source = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
  const closed = new Promise<void>(resolve => source.once("close", resolve));
  let outgoing: Writable | undefined;
  const request = vi.fn(((_url, _options, callback: (response: IncomingMessage) => void) => {
    const req = new Writable({ autoDestroy: false, final(done) {
      callback(source as unknown as IncomingMessage);
      // Buffer bytes before the fetch continuation can cancel, so the Node
      // readable's queued resume still has data when cancellation wins.
      source.write(Buffer.alloc(bytes, "x"));
      if (end) source.end();
      done();
    } });
    outgoing = req;
    return Object.assign(req, { setTimeout: () => req });
  }) as typeof httpsRequest);
  return { source, closed, request, get outgoing() { return outgoing; },
    close() { source.destroy(); outgoing?.destroy(); },
    fetch: () => safeMcpFetch("https://example.test/mcp", {}, { request, lookup: async () => [{ address: "8.8.8.8", family: 4 }] }) };
}

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

  it.each(["body", "reader"])("cancels a buffered %s before queued Node flow without a late enqueue", async consumer => {
    const fixture = bufferedResponse(64);
    try {
      const response = await fixture.fetch();
      const reader = consumer === "reader" ? response.body!.getReader() : undefined;
      try { await (reader ? reader.cancel() : response.body!.cancel()); }
      finally { reader?.releaseLock(); }
      await fixture.closed;
      expect(fixture.source.destroyed).toBe(true);
      expect(fixture.outgoing?.destroyed).toBe(true);
    } finally { fixture.close(); }
  });

  it.each([2_000_000, 2_000_001])("preserves the response byte bound for %i buffered bytes and closes both streams", async bytes => {
    const fixture = bufferedResponse(bytes, true);
    try {
      const response = await fixture.fetch();
      if (bytes > 2_000_000) await expect(response.arrayBuffer()).rejects.toThrow("MCP response too large");
      else expect((await response.arrayBuffer()).byteLength).toBe(bytes);
      await fixture.closed;
      expect(fixture.outgoing?.destroyed).toBe(true);
    } finally { fixture.close(); }
  });

  it("rejects an oversized outgoing body before DNS or socket creation", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const request = vi.fn<typeof httpsRequest>();
    await expect(safeMcpFetch("https://example.test/mcp", { method: "POST", body: "x".repeat(1_000_001) }, { lookup, request }))
      .rejects.toThrow("MCP request too large");
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["cancel", "abort"])("pins validated DNS in the real request options and closes the source socket on %s", async action => {
    let sourceClosed = false;
    const controller = new AbortController();
    const server = createServer((req, res) => { req.socket.once("close", () => { sourceClosed = true; }); res.writeHead(200); res.write("fixture"); });
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
      const response = await safeMcpFetch("https://example.test/mcp", { signal: controller.signal }, { request, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      if (action === "abort") {
        const body = response.text();
        controller.abort();
        await expect(body).rejects.toThrow();
      } else await response.body?.cancel();
      await vi.waitFor(() => expect(sourceClosed).toBe(true), { timeout: 500 });
      expect(request).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
