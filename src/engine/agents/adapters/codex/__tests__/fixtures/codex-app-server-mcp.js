#!/usr/bin/env node
"use strict";

/* global process */

// Minimal bidirectional JSON-RPC fixture for the MCP server→client request.
// `test/emitElicitation` asks this fake app-server to send an elicitation and
// resolves only after Zeros answers it, making a missing handler deterministic.
let buffer = "";
let nextElicitation = 1;
const awaiting = new Map();

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function handle(frame) {
  if (frame.method === "initialize" && frame.id != null) {
    send({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        userAgent: "codex_cli 99.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (frame.method === "test/emitElicitation" && frame.id != null) {
    const elicitationRequestId = `fixture-mcp-${nextElicitation++}`;
    awaiting.set(elicitationRequestId, frame.id);
    send({
      jsonrpc: "2.0",
      id: elicitationRequestId,
      method: "mcpServer/elicitation/request",
      params: frame.params,
    });
    return;
  }
  if (frame.id != null && frame.method == null) {
    const originalRequestId = awaiting.get(String(frame.id));
    if (originalRequestId == null) return;
    awaiting.delete(String(frame.id));
    send({ jsonrpc: "2.0", id: originalRequestId, result: frame.result });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
