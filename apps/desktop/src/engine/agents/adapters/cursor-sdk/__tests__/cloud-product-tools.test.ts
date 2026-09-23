import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapterContext, McpServerRegistration } from "../../../types";
import type { PreparedBoundary } from "../../../containment/types";
import { CursorSdkAdapter } from "../adapter";
import * as cloudExecution from "../../../cloud-provider-execution";

const { createRuntimeSpy, createSpy, resumeSpy, prewarmSpy } = vi.hoisted(() => ({
  createRuntimeSpy: vi.fn(), createSpy: vi.fn(), resumeSpy: vi.fn(), prewarmSpy: vi.fn(),
}));
vi.mock("../host/host-client", () => {
  const module = { Agent: { create: createSpy, resume: resumeSpy, list: vi.fn(async () => ({ items: [] })) },
    Cursor: { models: { list: vi.fn(async () => []) } }, platform: { prewarm: prewarmSpy } };
  return { createCursorHostRuntime: createRuntimeSpy, getCursorHostModule: vi.fn(() => module),
    CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED", CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP", CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor" };
});

let root: string, previousDataDir: string | undefined;
const agent = { agentId: "agent-1", send: vi.fn(), close: vi.fn() };
// The session receives the gateway's full registration list plus a coordinator
// environment. Neither the user's MCP server nor the unminted Design credential
// reference may reach a cloud execution; only the admitted product snapshot does.
const userServer = { name: "user-tools", transport: "http", url: "http://127.0.0.1:9999/mcp" } satisfies McpServerRegistration;
const unminted = { name: "design-draft", transport: "http", url: "http://127.0.0.1:9010/mcp",
  headersFromEnv: { Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY" } } satisfies McpServerRegistration;
const minted = { name: "design-draft", transport: "http", url: "http://127.0.0.1:9010/mcp",
  headers: { Authorization: "Bearer engine-minted-capability" } } satisfies McpServerRegistration;
const ctx = (): AgentAdapterContext => ({ projectRoot: root, mcpServers: [userServer], sessionDirRoot: path.join(root, "sessions"),
  emit: { onSessionUpdate: () => {}, onPermissionRequest: () => {}, onQuestionRequest: () => {}, onAgentStderr: () => {}, onAgentExit: () => {} } });
const cloudBoundary = () => ({ status: { actor: "agent-code", backend: "cloud-worker" }, providerHomePath: path.join(root, "worker-home") } as unknown as PreparedBoundary);
const sessionOptions = () => ({ cwd: root, env: { CURSOR_API_KEY: "key", CURSOR_MODEL: "grok-4.6" }, mcpServers: [userServer, unminted], executionBoundary: cloudBoundary() });
const configured = (options: Record<string, unknown>) => options.mcpServers as Record<string, { url: string; headers?: Record<string, string> }> | undefined;

beforeAll(() => { process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-cloud-tools-"));
  previousDataDir = process.env.ZEROS_DATA_DIR; process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(agent); resumeSpy.mockReset().mockResolvedValue(agent);
  prewarmSpy.mockReset().mockResolvedValue({ prewarmed: true });
  createRuntimeSpy.mockReset().mockImplementation(() => ({
    module: { Agent: { create: createSpy, resume: resumeSpy, list: vi.fn(async () => ({ items: [] })) }, Cursor: { models: { list: vi.fn(async () => []) } }, platform: { prewarm: prewarmSpy } },
    dispose: vi.fn(async () => {}),
  }));
  vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ productServers: [minted] } as unknown as cloudExecution.CloudProviderExecution);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR; else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("Cursor cloud product tools", () => {
  it("starts a cloud session with only the admitted, already-minted product tools", async () => {
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      const servers = configured(createSpy.mock.calls[0]![0])!;
      expect(Object.keys(servers)).toEqual(["design-draft"]);
      expect(servers["design-draft"]!.headers?.Authorization).toBe("Bearer engine-minted-capability");
      for (const [options] of prewarmSpy.mock.calls) expect(Object.keys(configured(options) ?? {})).toEqual(["design-draft"]);
    } finally { await adapter.dispose(); }
  });

  it("resumes a cloud session with the same admitted product tools", async () => {
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.loadSession({ ...sessionOptions(), sessionId: "prior-agent-id" });
      const servers = configured(resumeSpy.mock.calls[0]![1])!;
      expect(Object.keys(servers)).toEqual(["design-draft"]);
      expect(servers["design-draft"]!.headers?.Authorization).toBe("Bearer engine-minted-capability");
    } finally { await adapter.dispose(); }
  });

  it("never falls back to the user's MCP registry when a cloud execution has no product tools", async () => {
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ productServers: [] } as unknown as cloudExecution.CloudProviderExecution);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      expect(configured(createSpy.mock.calls[0]![0]) ?? {}).toEqual({});
    } finally { await adapter.dispose(); }
  });
});
