import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapterContext, McpServerRegistration } from "../../../types";
import type { PreparedBoundary } from "../../../containment/types";
import { createCloudNativeHome, type CloudNativeHome } from "../../../containment/cloud-native-home";
import { CursorSdkAdapter } from "../adapter";
import * as cloudExecution from "../../../cloud-provider-execution";
import { cloudCursorStateRoot, durableCursorStateRoot } from "../state-overlay";

const { createRuntimeSpy, createSpy, resumeSpy, prewarmSpy } = vi.hoisted(() => ({
  createRuntimeSpy: vi.fn(), createSpy: vi.fn(), resumeSpy: vi.fn(), prewarmSpy: vi.fn(),
}));
vi.mock("../host/host-client", () => {
  const module = { Agent: { create: createSpy, resume: resumeSpy, list: vi.fn(async () => ({ items: [] })) },
    Cursor: { models: { list: vi.fn(async () => []) } }, platform: { prewarm: prewarmSpy } };
  return { createCursorHostRuntime: createRuntimeSpy, getCursorHostModule: vi.fn(() => module),
    CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED", CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP", CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor" };
});

let root: string, nativeHome: CloudNativeHome, previousDataDir: string | undefined;
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
const cloudBoundary = () => ({ status: { actor: "agent-code", backend: "cloud-worker" }, nativeHome,
  providerHomePath: nativeHome.paths.home } as unknown as PreparedBoundary);
const execution = (extra: Record<string, unknown> = {}) => ({ coordinator: cloudBoundary(),
  productServers: [minted], lease: {}, ...extra } as unknown as cloudExecution.CloudProviderExecution);
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
  nativeHome = await createCloudNativeHome({ dataRoot: root, conversationId: "cloud-tools",
    provider: "cursor", executionId: "cloud-tools" });
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
  vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue(execution());
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR; else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("Cursor cloud product tools", () => {
  it.each(["new", "resume"])("%s uses the original physical history store instead of a caller root or workspace hash", async operation => {
    const nativeHome = await createCloudNativeHome({ dataRoot: root,
      conversationId: "original-store", provider: "cursor", executionId: "original-store" });
    const stateRoot = path.join(nativeHome.paths.cursorHome, "zeros-store");
    const options = { ...sessionOptions(), env: { CURSOR_API_KEY: "key", CURSOR_MODEL: "grok-4.6",
      ZEROS_CURSOR_STATE_ROOT: "/caller-store" } };
    const coordinator = { ...options.executionBoundary, nativeHome, providerHomePath: nativeHome.paths.home,
      environment: () => ({ ...nativeHome.environment(), ZEROS_CURSOR_STATE_ROOT: stateRoot }) };
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue({ coordinator,
      productServers: [], lease: {} } as unknown as cloudExecution.CloudProviderExecution);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      if (operation === "new") await adapter.newSession(options);
      else await adapter.loadSession({ ...options, sessionId: "existing-agent" });
      expect(createRuntimeSpy.mock.calls[0]![0].env.ZEROS_CURSOR_STATE_ROOT).toBe(stateRoot);
      expect(createRuntimeSpy.mock.calls[0]![0].env.ZEROS_CURSOR_STATE_ROOT)
        .not.toBe(cloudCursorStateRoot(root, nativeHome.paths.home));
    } finally { await adapter.dispose(); }
  });

  it("does not treat a readable old backend as cloud placement authority", async () => {
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue(null);
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession({ ...sessionOptions(), mcpServers: [] });
      const selected = createRuntimeSpy.mock.calls[0]![0];
      expect(selected.env.ZEROS_CURSOR_STATE_ROOT).toBe(await durableCursorStateRoot(root));
      expect(selected.env.ZEROS_CURSOR_STATE_ROOT).not.toBe(cloudCursorStateRoot(root, sessionOptions().executionBoundary.providerHomePath));
    } finally { await adapter.dispose(); }
  });

  it("uses the admitted physical cloud HOME without changing the Local state layout", async () => {
    const adapter = new CursorSdkAdapter(ctx());
    try {
      const options = sessionOptions();
      await adapter.newSession(options);
      expect(createRuntimeSpy.mock.calls[0]![0].env.ZEROS_CURSOR_STATE_ROOT).toBe(path.join(nativeHome.paths.cursorHome, "zeros-store"));
      expect(createRuntimeSpy.mock.calls[0]![0].env.ZEROS_CURSOR_STATE_ROOT).not.toContain("/srv/zeros/home/agent");
    } finally { await adapter.dispose(); }
  });

  it.each(["new", "resume"])("projects admitted repo instructions through SDK messages on %s, later turns and mode rebuilds", async operation => {
    const cwd = path.join(root, "managed-worktree");
    await mkdir(path.join(cwd, ".cursor/rules"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "ADMITTED_AGENTS_SENTINEL");
    await writeFile(path.join(cwd, ".cursor/rules/always.mdc"), "---\nalwaysApply: true\n---\nADMITTED_RULE_SENTINEL");
    await writeFile(path.join(cwd, ".cursor/mcp.json"), '{"mcpServers":{"unadmitted":{}}}');
    await writeFile(path.join(root, "AGENTS.md"), "CALLER_ROOT_SENTINEL");
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue(execution({ cwd, customization: {}, lease: { customization: {} } }));
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
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue(execution({ customization: {}, lease: { customization: {} } }));
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
    vi.spyOn(cloudExecution, "cloudProviderExecution").mockReturnValue(execution({ productServers: [] }));
    const adapter = new CursorSdkAdapter(ctx());
    try {
      await adapter.newSession(sessionOptions());
      expect(configured(createSpy.mock.calls[0]![0]) ?? {}).toEqual({});
    } finally { await adapter.dispose(); }
  });
});
