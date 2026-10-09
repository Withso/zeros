import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let previousRipgrep: string | undefined, previousApiKey: string | undefined;
beforeAll(() => { previousRipgrep = process.env.CURSOR_RIPGREP_PATH; previousApiKey = process.env.CURSOR_API_KEY; process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; });
afterAll(() => {
  if (previousRipgrep === undefined) delete process.env.CURSOR_RIPGREP_PATH; else process.env.CURSOR_RIPGREP_PATH = previousRipgrep;
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousApiKey;
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-cloud-tools-"));
  previousDataDir = process.env.ZEROS_DATA_DIR; process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(agent); resumeSpy.mockReset().mockResolvedValue(agent);
  agent.send.mockReset().mockImplementation(async () => ({ id: "run-1", stream: async function* () {}, wait: async () => ({ status: "finished" }) }));
  prewarmSpy.mockReset().mockResolvedValue({ prewarmed: true });
  createRuntimeSpy.mockReset().mockImplementation(() => ({
    module: { Agent: { create: createSpy, resume: resumeSpy, list: vi.fn(async () => ({ items: [] })) }, Cursor: { models: { list: vi.fn(async () => []) } }, platform: { prewarm: prewarmSpy } },
    dispose: vi.fn(async () => {}),
  }));
  // Every admitted execution carries a lease; this one has no customization.
  vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ productServers: [minted], lease: {} } as unknown as cloudExecution.CloudProviderExecution);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR; else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("Cursor cloud product tools", () => {
  it.each(["new", "resume"])("projects admitted repo instructions through SDK messages on %s, later turns and mode rebuilds", async operation => {
    const cwd = path.join(root, "managed-worktree");
    await mkdir(path.join(cwd, ".cursor/rules"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "ADMITTED_AGENTS_SENTINEL");
    await writeFile(path.join(cwd, ".cursor/rules/always.mdc"), "---\nalwaysApply: true\n---\nADMITTED_RULE_SENTINEL");
    await writeFile(path.join(cwd, ".cursor/mcp.json"), '{"mcpServers":{"unadmitted":{}}}');
    await writeFile(path.join(root, "AGENTS.md"), "CALLER_ROOT_SENTINEL");
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ cwd, productServers: [minted], customization: {}, lease: { customization: {} } } as unknown as cloudExecution.CloudProviderExecution);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      const options = { ...sessionOptions(), executionId: "cloud-projection-fixture", env: { CURSOR_API_KEY: "key", CURSOR_MODEL: "grok-4.6", ZEROS_PERMISSION_MODE: "plan" } };
      const started = operation === "new" ? (await adapter.newSession(options)).session : await adapter.loadSession({ ...options, sessionId: "saved-native-id" });
      const sessionId = options.executionId;
      expect(started.executionId).toBe(sessionId);
      const prompt = [{ type: "text" as const, text: "inspect" }, { type: "image" as const, data: "c3ludGhldGlj", mimeType: "image/png" }];
      await adapter.prompt({ sessionId, prompt });
      expect(agent.send.mock.calls[0]![0].text).toContain("ADMITTED_AGENTS_SENTINEL");
      expect(agent.send.mock.calls[0]![0].text).toContain("ADMITTED_RULE_SENTINEL");
      expect(agent.send.mock.calls[0]![0].text).not.toContain("CALLER_ROOT_SENTINEL");
      expect(agent.send.mock.calls[0]![0].text).not.toContain("unadmitted");
      expect(agent.send.mock.calls[0]![0].images).toEqual([{ data: "c3ludGhldGlj", mimeType: "image/png" }]);
      expect(agent.send.mock.calls[0]![1]).toMatchObject({ mode: "plan", model: { id: "grok-4.6" } });
      await writeFile(path.join(cwd, "AGENTS.md"), "MUTATED_AFTER_ADMISSION");
      await adapter.setMode({ sessionId, modeId: "auto" });
      await adapter.prompt({ sessionId, prompt });
      expect(agent.send.mock.calls[1]![0].text).toContain("ADMITTED_AGENTS_SENTINEL");
      expect(agent.send.mock.calls[1]![0].text).not.toContain("MUTATED_AFTER_ADMISSION");
      await adapter.setMode({ sessionId, modeId: "plan" });
      await adapter.prompt({ sessionId, prompt });
      expect(agent.send.mock.calls[2]![0].text).toContain("ADMITTED_RULE_SENTINEL");
      expect(agent.send.mock.calls[2]![1].mode).toBe("plan");
      const nativeOptions = [...createSpy.mock.calls.map(call => call[0]), ...resumeSpy.mock.calls.map(call => call[1]), ...prewarmSpy.mock.calls.map(call => call[0])];
      for (const native of nativeOptions) {
        expect(native.local.settingSources).toEqual(["user"]);
        expect(native.systemPrompt).toBeUndefined();
        expect(native.apiKey).toBe("key");
        expect(Object.keys(configured(native) ?? {})).toEqual(["design-draft"]);
      }
    } finally { await adapter.dispose(); }
  });
  it("starts a cloud session with only the admitted, already-minted product tools", async () => {
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      const servers = configured(createSpy.mock.calls[0]![0])!;
      expect(Object.keys(servers)).toEqual(["design-draft"]);
      expect(servers["design-draft"]!.headers?.Authorization).toBe("Bearer engine-minted-capability");
      for (const [options] of prewarmSpy.mock.calls) expect(Object.keys(configured(options) ?? {})).toEqual(["design-draft"]);
      // A cloud execution never loads this machine's Cursor settings layers.
      expect((createSpy.mock.calls[0]![0] as { local: { settingSources: string[] } }).local.settingSources).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  it("loads only the user layer for a customized cloud lease", async () => {
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ productServers: [minted], customization: {}, lease: { customization: {} } } as unknown as cloudExecution.CloudProviderExecution);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      expect((createSpy.mock.calls[0]![0] as { local: { settingSources: string[] } }).local.settingSources).toEqual(["user"]);
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
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ productServers: [], lease: {} } as unknown as cloudExecution.CloudProviderExecution);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      expect(configured(createSpy.mock.calls[0]![0]) ?? {}).toEqual({});
    } finally { await adapter.dispose(); }
  });
});
