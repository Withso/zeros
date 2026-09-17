import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import * as registry from "../registry";
import type { AgentAdapter, AgentAdapterContext, McpServerRegistration } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

it("shares live revisions only with the owning gateway endpoint, including an empty catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-catalog-"));
  vi.stubEnv("ZEROS_DATA_DIR", root);
  let context!: AgentAdapterContext;
  const entry = registry.findAgent("cursor")!;
  const factory = vi.spyOn(entry, "createAdapter").mockImplementation((ctx) => {
    context = ctx;
    return { agentId: "cursor", dispose: async () => {} } as AgentAdapter;
  });
  const gateway = new AgentGateway({
    projectRoot: root, executionBoundary: testExecutionBoundary(),
    events: { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() },
  });
  const server = { name: "zeros-gateway", transport: "http", url: "http://127.0.0.1:9010/mcp" } satisfies McpServerRegistration;
  try {
    await (gateway as unknown as { adapterFor(id: string): Promise<AgentAdapter> }).adapterFor("cursor");
    expect(context.mcpCatalogRevision!(server)).toBeUndefined();
    let revision = "generation:1";
    gateway.setGatewayServer(server.url, () => revision);
    expect(context.mcpCatalogRevision!(server)).toBe(revision);
    expect(context.mcpCatalogRevision!({ ...server, name: "user-server" })).toBeUndefined();
    expect(context.mcpCatalogRevision!({ ...server, url: `${server.url}/other` })).toBeUndefined();
    revision = "generation:2";
    gateway.setGatewayServer(null);
    expect(context.mcpCatalogRevision!(server)).toBe(revision);
    gateway.setGatewayServer(server.url, () => "replacement:1");
    expect(context.mcpCatalogRevision!(server)).toBe("replacement:1");
  } finally {
    await gateway.dispose(); factory.mockRestore(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
