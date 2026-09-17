import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapterContext, McpServerRegistration } from "../../../types";

const { create, resume, prewarm, models } = vi.hoisted(() => ({
  create: vi.fn(), resume: vi.fn(), prewarm: vi.fn(), models: vi.fn(),
}));
vi.mock("@cursor/sdk", () => ({
  Agent: { create, resume, list: vi.fn() }, Cursor: { models: { list: models } },
  platform: { prewarm },
}));
vi.mock("../local-store", () => ({
  wrapSdkWithLocalStore: (raw: object) => ({ ...raw, localStore: { open: async () => null } }),
}));
import { CursorSdkAdapter } from "../adapter";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const gateway = { name: "zeros-gateway", transport: "http", url: "http://127.0.0.1:9010/mcp" } satisfies McpServerRegistration;
const prompt = [{ type: "text" as const, text: "Use the available tools" }];
const adapters: CursorSdkAdapter[] = [];
const handles: ReturnType<typeof handle>[] = [];
const sent: Array<{ agentId: string; options: Record<string, unknown> }> = [];
let gate: ReturnType<typeof deferred<void>> | undefined;
function handle(agentId: string, options: Record<string, unknown>) {
  return {
    agentId, close: vi.fn(),
    send: vi.fn(async () => {
      sent.push({ agentId, options });
      const streamGate = gate;
      return {
        id: `run-${sent.length}`,
        stream: async function* () { if (streamGate) await streamGate.promise; yield { type: "status", status: "FINISHED" }; },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(async () => streamGate?.resolve()),
      };
    }),
  };
}
beforeEach(() => {
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  vi.stubEnv("ZEROS_CURSOR_IN_PROCESS", "1");
  vi.stubEnv("CURSOR_API_KEY", "");
  handles.length = 0; sent.length = 0; gate = undefined;
  create.mockReset().mockImplementation(async (options) => {
    const agent = handle(`agent-${handles.length}`, options); handles.push(agent); return agent;
  });
  resume.mockReset().mockImplementation(async (id, options) => {
    const agent = handle(id, options); handles.push(agent); return agent;
  });
  prewarm.mockReset().mockResolvedValue({ prewarmed: true });
  models.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  gate?.resolve();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  vi.unstubAllEnvs();
});

async function fixture(servers: McpServerRegistration[] = [gateway]) {
  let revision = "gateway-a:1";
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/catalog", sessionDirRoot: "/tmp/catalog/sessions", mcpServers: [],
    mcpCatalogRevision: (server: McpServerRegistration) => server.name === gateway.name && server.transport === "http" && server.url === gateway.url ? revision : undefined,
    emit: { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() },
  };
  const adapter = new CursorSdkAdapter(ctx); adapters.push(adapter);
  const opts = { cwd: "/tmp/catalog", env: { CURSOR_API_KEY: "synthetic" }, mcpServers: servers };
  const { session } = await adapter.newSession(opts);
  const send = () => adapter.prompt({ sessionId: session.executionId, prompt });
  return { adapter, sessionId: session.executionId, opts, send, change: (next = "gateway-a:2") => { revision = next; } };
}
const catalogOf = (options: Record<string, unknown>) => (options.mcpServers as Record<string, { headers?: Record<string, string> }>)[gateway.name].headers?.["X-Zeros-Mcp-Catalog"];

describe("Cursor managed MCP catalog refresh", () => {
  it("refreshes once before the next send and retains the native conversation", async () => {
    const f = await fixture();
    await f.send(); f.change(); await f.send(); await f.send();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.agentId)).toEqual(["agent-0", "agent-0", "agent-0"]);
    expect(sent.map((s) => catalogOf(s.options))).toEqual(["gateway-a:1", "gateway-a:2", "gateway-a:2"]);
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(gateway).not.toHaveProperty("headers");
  });

  it("uses the same revision for prewarm/create and refreshes a stale first-send cache", async () => {
    const warming = deferred(); prewarm.mockReturnValue(warming.promise);
    const f = await fixture();
    expect(catalogOf(prewarm.mock.calls[0][0])).toBe("gateway-a:1");
    expect(catalogOf(create.mock.calls[0][0])).toBe("gateway-a:1");
    f.change(); await f.send();
    warming.resolve();
    expect(catalogOf(sent[0].options)).toBe("gateway-a:2");
  });

  it("does not interrupt active or sibling runs when the catalog changes", async () => {
    const f = await fixture(); gate = deferred();
    const pending = f.send();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    f.change();
    const { session } = await f.adapter.newSession(f.opts);
    expect(resume).not.toHaveBeenCalled();
    expect(handles[0].close).not.toHaveBeenCalled();
    expect(catalogOf(create.mock.calls[1][0])).toBe("gateway-a:2");
    gate.resolve(); await pending; gate = undefined;
    await f.adapter.prompt({ sessionId: session.executionId, prompt });
    await f.send();
    expect(sent.map((s) => catalogOf(s.options))).toEqual(["gateway-a:1", "gateway-a:2", "gateway-a:2"]);
  });

  it("uses the current revision on history resume without adding it to saved registrations", async () => {
    const f = await fixture(); f.change();
    const result = await f.adapter.loadSession({ ...f.opts, sessionId: "saved-agent" });
    await f.adapter.prompt({ sessionId: result.executionId!, prompt });
    expect(sent[0].agentId).toBe("saved-agent");
    expect(catalogOf(sent[0].options)).toBe("gateway-a:2");
    expect(f.opts.mcpServers).toEqual([gateway]);
  });

  it("coalesces mode and catalog changes, preserving the model and other MCP options", async () => {
    const sse = { name: "other", transport: "sse" as const, url: "https://tools.example/events", headers: { "X-Fixture": "kept" } };
    const f = await fixture([gateway, sse]); f.change();
    await f.adapter.setMode({ sessionId: f.sessionId, modeId: "agent" });
    await f.send();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(catalogOf(prewarm.mock.calls.at(-1)![0])).toBe("gateway-a:2");
    expect(sent[0].options).toMatchObject({ mcpServers: { other: { type: "sse", url: sse.url, headers: sse.headers } } });
  });

  it.each([{ servers: [] }, { servers: [{ ...gateway, name: "unmanaged" }] }, { servers: [{ ...gateway, url: "http://127.0.0.1:9020/mcp" }] }])("leaves unrelated MCP configurations alone: $servers", async ({ servers }) => {
    const f = await fixture(servers); await f.send(); f.change(); await f.send();
    expect(resume).not.toHaveBeenCalled();
  });

  it("catches a newer catalog published during resume before sending", async () => {
    const f = await fixture(); f.change();
    resume.mockImplementationOnce(async (id, options) => { f.change("gateway-a:3"); return handle(id, options); });
    await f.send();
    expect(catalogOf(sent[0].options)).toBe("gateway-a:3");
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("fails recoverably without sending stale tools when refresh fails, then retries", async () => {
    const f = await fixture(); f.change();
    resume.mockRejectedValueOnce(new Error("MCP refresh connection reset"));
    await expect(f.send()).rejects.toThrow(/MCP refresh/);
    expect(sent).toHaveLength(0);
    await f.send(); expect(catalogOf(sent[0].options)).toBe("gateway-a:2");
  });

  it("bounds repeated catalog changes instead of submitting a stale prompt", async () => {
    const f = await fixture(); f.change(); let revision = 2;
    resume.mockImplementation(async (id, options) => {
      f.change(`gateway-a:${++revision}`); return handle(id, options);
    });
    await expect(f.send()).rejects.toThrow(/kept changing/);
    expect(resume).toHaveBeenCalledTimes(3); expect(sent).toHaveLength(0);
  });

  it("keeps authentication failure evidence when catalog preparation is rejected", async () => {
    const f = await fixture(); f.change();
    resume.mockRejectedValueOnce(Object.assign(new Error("Credential was revoked"), { status: 401, code: "unauthenticated" }));
    await expect(f.send()).rejects.toMatchObject({ failure: { kind: "auth-required" } });
    expect(sent).toHaveLength(0); expect(handles[0].close).not.toHaveBeenCalled();
  });

  it("keeps a stopped prompt cancelled when its preparation later rejects", async () => {
    const f = await fixture(); f.change(); const refreshing = deferred<ReturnType<typeof handle>>();
    resume.mockReturnValueOnce(refreshing.promise);
    const pending = f.send(); await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    await f.adapter.cancel({ sessionId: f.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    refreshing.reject(new Error("late refresh failure"));
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toHaveLength(0);
    await f.send(); expect(sent).toHaveLength(1);
  });

  it("settles Stop immediately during refresh and serializes a subsequent queued send", async () => {
    const f = await fixture(); f.change(); const refreshing = deferred<ReturnType<typeof handle>>();
    resume.mockReturnValueOnce(refreshing.promise);
    const pending = f.send(); await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    await f.adapter.cancel({ sessionId: f.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    const next = f.send();
    expect(sent).toHaveLength(0); expect(resume).toHaveBeenCalledOnce();
    refreshing.resolve(handle("agent-0", resume.mock.calls[0][1]));
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(sent).toHaveLength(1);
  });

  it("does not revive a disposed session when refresh completes late", async () => {
    const f = await fixture(); f.change(); const refreshing = deferred<ReturnType<typeof handle>>();
    resume.mockReturnValueOnce(refreshing.promise);
    const pending = f.send(); await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    await f.adapter.disposeSession(f.sessionId);
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    const late = handle("agent-0", resume.mock.calls[0][1]); refreshing.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(sent).toHaveLength(0);
  });
});
