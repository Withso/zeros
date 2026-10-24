import http from "node:http";
import type { AddressInfo } from "node:net";

/** One redirect address per engine/channel. Project gateways share this
 * listener so a saved OAuth client never changes redirect URI with the repo. */
export class McpOAuthCallback {
  private server?: http.Server;
  private starting?: Promise<void>;
  private closed = false;
  private readonly handlers = new Set<(query: URLSearchParams) => boolean>();
  constructor(private port: number) {}
  get url(): string { return `http://127.0.0.1:${this.port}/callback`; }
  register(handler: (query: URLSearchParams) => boolean): () => void {
    if (this.closed) throw new Error("MCP callback is closed.");
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("MCP callback is closed."));
    if (this.starting) return this.starting;
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", "default-src 'none'");
      const host = `127.0.0.1:${this.port}`;
      if (req.method !== "GET" || req.headers.host !== host || (req.url?.length ?? 0) > 8192) {
        res.writeHead(400).end("Invalid callback."); return;
      }
      const url = new URL(req.url ?? "/", this.url);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      if (url.searchParams.getAll("state").length !== 1 || !url.searchParams.get("state") ||
          url.searchParams.getAll("code").length > 1 || url.searchParams.getAll("error").length > 1) {
        res.writeHead(400).end("Invalid callback."); return;
      }
      for (const handler of this.handlers) {
        if (!handler(url.searchParams)) continue;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          "<!doctype html><meta charset=utf-8><title>Zeros</title><h2>Return to Zeros</h2><p>Zeros will show the connection result. You can close this tab.</p>",
        );
        return;
      }
      res.writeHead(400).end("No matching sign-in. Return to Zeros and start again.");
    });
    this.server = server;
    this.starting = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    }).catch(error => { this.server = undefined; this.starting = undefined; throw error; });
    return this.starting;
  }
  async stop(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    await this.starting?.catch(() => {});
    const server = this.server; this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
