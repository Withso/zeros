import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesignAgentCapabilityManager } from "../design-agent-capability";
import { DesignAgentMcpServer } from "../design-agent-mcp";
import {
  createDesignFrame,
  initializeDesignDocument,
  readDesignWebDocumentState,
} from "../document";

describe("Design-agent MCP boundary", () => {
  let root: string;
  let manager: DesignAgentCapabilityManager;
  let server: DesignAgentMcpServer;
  let client: Client | null;
  let token: string;
  let frame: string;
  let revision: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-agent-mcp-"));
    await initializeDesignDocument(root);
    frame = (await createDesignFrame(root, { title: "MCP draft" })).file;
    revision = (await readDesignWebDocumentState(root, frame)).revision;
    manager = new DesignAgentCapabilityManager();
    token = (
      await manager.create({
        workspaceId: "workspace-1",
        workspacePath: root,
        agentRunId: "design-run-1",
        documentId: `frame:${frame}`,
        expectedRevision: revision,
      })
    ).token;
    server = new DesignAgentMcpServer({ manager, token });
    await server.start();
    client = null;
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function connect(bearer = token): Promise<Client> {
    const next = new Client({ name: "design-agent-test", version: "1.0.0" });
    await next.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${bearer}` },
        },
      }),
    );
    client = next;
    return next;
  }

  it("delivers cancellation while four tool calls are in flight", async () => {
    await server.stop();
    const started: AbortSignal[] = [];
    const finish: Array<() => void> = [];
    server = new DesignAgentMcpServer({
      token,
      handler: {
        assertActive() {},
        listTools: () => [{ name: "hold", inputSchema: { type: "object" } }],
        callTool: async (_name, _input, signal) => {
          started.push(signal);
          await new Promise<void>((resolve) => {
            finish.push(resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [] };
        },
      },
    });
    await server.start();
    const connected = await connect();
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      connected
        .callTool({ name: "hold" }, undefined, { signal: controller.signal })
        .catch(() => null),
    );
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      controllers[0]!.abort();
      await vi.waitFor(() =>
        expect(started.some((signal) => signal.aborted)).toBe(true),
      );
    } finally {
      controllers.forEach((controller) => controller.abort());
      finish.forEach((resolve) => resolve());
      await Promise.all(requests);
    }
  });

  it("exposes only semantic draft tools to the exact run capability", async () => {
    const connected = await connect();
    const tools = await connected.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "design_document_open",
      "design_foundation_read",
      "design_history_redo",
      "design_history_undo",
      "design_projection_read",
      "design_provenance_read",
      "design_source_read",
      "design_transaction_apply",
    ]);

    const opened = await connected.callTool({
      name: "design_document_open",
      arguments: {},
    });
    const content = opened.content as Array<{
      type: string;
      text?: string;
    }>;
    const text = content.find((part) => part.type === "text");
    expect(text).toMatchObject({ type: "text" });
    expect(JSON.parse(text!.text!)).toMatchObject({
      documentId: `frame:${frame}`,
      revision,
    });
  });

  it("rejects missing, malformed, wrong, and revoked bearer authority", async () => {
    await expect(connect("0".repeat(64))).rejects.toThrow();
    expect(manager.revoke(token)).toBe(true);
    await expect(connect(token)).rejects.toThrow();
  });

  it("bounds simultaneous request bodies before buffering them", async () => {
    const held: http.ClientRequest[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        const request = http.request(server.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        request.on("error", () => {});
        request.write("{");
        held.push(request);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(429);
    } finally {
      held.forEach((request) => request.destroy());
    }
  });

  it("binds loopback host/origin and does not disclose the bearer in its registration", async () => {
    expect(server.registration).toEqual({
      name: "design-draft",
      transport: "http",
      url: server.url,
      headersFromEnv: {
        Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY",
      },
    });
    expect(JSON.stringify(server.registration)).not.toContain(token);

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects unknown session identifiers instead of creating a replacement session", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": "unknown-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "untrusted", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(404);
  });

  it("bounds request bodies before the MCP SDK parses them", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(4 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects arguments outside the published semantic schemas", async () => {
    const connected = await connect();
    await expect(
      connected.callTool({
        name: "design_document_open",
        arguments: { unexpected: true },
      }),
    ).rejects.toThrow();
    await expect(
      connected.callTool({
        name: "design_transaction_apply",
        arguments: { transaction: {}, dryRun: "yes" },
      }),
    ).rejects.toThrow();
  });
});
