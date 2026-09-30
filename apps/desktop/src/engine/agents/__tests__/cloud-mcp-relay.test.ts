import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { cloudCodexMcpServer } from "../cloud-mcp";

describe("Codex legacy SSE MCP relay", () => {
  it.each(["message", ""])("round-trips JSON-RPC with SSE event type %j", async event => {
    let stream: ServerResponse | undefined;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: endpoint\ndata: /messages\n\n");
      } else {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => {
          const input = JSON.parse(Buffer.concat(chunks).toString());
          response.writeHead(202).end();
          stream!.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { ok: true } })}\n\n`);
        });
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test server address");
    const config = cloudCodexMcpServer({ name: "fixture", transport: "sse", url: `http://127.0.0.1:${address.port}/events` });
    if (config.transport !== "stdio") throw new Error("Missing relay");
    const child = spawn(process.execPath, config.args, { env: { ...process.env, ...config.env }, stdio: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) resolve(output.trim()); });
        child.on("error", reject);
        child.on("exit", code => reject(new Error(`Relay exited: ${code}`)));
        timer = setTimeout(() => reject(new Error("Relay did not deliver the JSON-RPC response")), 2000);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }) + "\n");
      expect(JSON.parse(await result)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    } finally {
      clearTimeout(timer); child.kill(); stream?.end(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
