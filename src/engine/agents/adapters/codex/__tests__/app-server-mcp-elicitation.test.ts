import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bootCodexAppServerRuntime,
  type CodexAppServerHandle,
} from "../app-server";

const fixture = fileURLToPath(
  new URL("./fixtures/codex-app-server-mcp.js", import.meta.url),
);
const params = {
  threadId: "thread-1",
  turnId: "turn-1",
  serverName: "zeros-design",
  mode: "form" as const,
  message: "Allow list_frames?",
  requestedSchema: { type: "object" as const, properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    tool_title: "list_frames",
  },
};

describe("Codex app-server MCP elicitation request", () => {
  it("round-trips the server request through the runtime responder", async () => {
    const runtimeRef: { current?: CodexAppServerHandle } = {};
    const runtime = await bootCodexAppServerRuntime({
      cwd: process.cwd(),
      cliBinary: fixture,
      clientInfo: { name: "Zeros-test", version: "0.0.1" },
      onMcpElicitationRequest: (request) => {
        expect(request.params).toMatchObject({
          serverName: "zeros-design",
          mode: "form",
        });
        expect(runtimeRef.current).toBeDefined();
        runtimeRef.current!.respondToMcpElicitation(request.elicitationId, {
          action: "accept",
          content: null,
          _meta: null,
        });
      },
    });
    runtimeRef.current = runtime;
    try {
      await expect(
        runtime.request("test/emitElicitation", params),
      ).resolves.toEqual({ action: "accept", content: null, _meta: null });
    } finally {
      await runtime.dispose();
    }
  });

  it("cancels immediately when no adapter handler is installed", async () => {
    const runtime = await bootCodexAppServerRuntime({
      cwd: process.cwd(),
      cliBinary: fixture,
      clientInfo: { name: "Zeros-test", version: "0.0.1" },
    });
    try {
      await expect(
        runtime.request("test/emitElicitation", params),
      ).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    } finally {
      await runtime.dispose();
    }
  });

  it("cancels safely when the adapter callback throws", async () => {
    const runtime = await bootCodexAppServerRuntime({
      cwd: process.cwd(),
      cliBinary: fixture,
      clientInfo: { name: "Zeros-test", version: "0.0.1" },
      onMcpElicitationRequest: () => {
        throw new Error("renderer bridge unavailable");
      },
    });
    try {
      await expect(
        runtime.request("test/emitElicitation", params),
      ).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    } finally {
      await runtime.dispose();
    }
  });
});
