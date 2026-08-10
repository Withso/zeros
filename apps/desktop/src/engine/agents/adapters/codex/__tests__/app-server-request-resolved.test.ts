import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexMcpElicitationRequest } from "../app-server";
import { bootCodexAppServerRuntime } from "../app-server";

const roots: string[] = [];

async function fakeCodexCli(root: string): Promise<string> {
  const script = path.join(root, "fake-codex.js");
  await writeFile(
    script,
    `
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
input.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({
      id: frame.id,
      result: {
        userAgent: "codex_cli 0.146.0",
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "macos"
      }
    });
    return;
  }
  if (frame.method === "initialized") {
    setTimeout(() => {
      send({
        id: "mcp-native-1",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "calendar",
          mode: "url",
          message: "Authorize calendar access",
          url: "https://example.com/authorize",
          elicitationId: "elicitation-1",
          _meta: null
        }
      });
      setTimeout(() => {
        send({
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: "mcp-native-1" }
        });
      }, 25);
    }, 10);
    return;
  }
  if (frame.id === "mcp-native-1" && !frame.method) {
    process.stderr.write("late MCP elicitation response\\n");
  }
});
`,
    "utf8",
  );
  return script;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test timed out")), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex serverRequest/resolved", () => {
  it("abandons an externally cleared MCP request without a late JSON-RPC response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-codex-resolved-"));
    roots.push(root);
    const cliBinary = await fakeCodexCli(root);
    const stderr: string[] = [];
    let resolveRequest!: (request: CodexMcpElicitationRequest) => void;
    const requestReceived = new Promise<CodexMcpElicitationRequest>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    let resolveSettled!: (questionId: string) => void;
    const requestSettled = new Promise<string>((resolve) => {
      resolveSettled = resolve;
    });

    const runtime = await bootCodexAppServerRuntime({
      cwd: root,
      cliBinary,
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onMcpElicitationRequest: resolveRequest,
      onMcpElicitationSettled: resolveSettled,
      onStderr: (line) => stderr.push(line),
    });

    try {
      const request = await withTimeout(requestReceived);
      expect(request.requestId).toBe("mcp-native-1");
      expect(request.params.mode).toBe("url");
      expect(await withTimeout(requestSettled)).toBe(request.questionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stderr).not.toContain("late MCP elicitation response");
    } finally {
      await runtime.dispose();
    }
  });
});
