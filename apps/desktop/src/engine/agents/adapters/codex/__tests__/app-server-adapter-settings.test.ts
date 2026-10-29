import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(params: unknown) => void>>(),
  runTurn: vi.fn(),
  request: vi.fn(),
  interrupt: vi.fn(async () => {}),
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: { userAgent: "codex_cli 0.165.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" },
    cliVersion: "0.165.0", binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({ threadId: "thread-settings", model: "gpt-6.1-sol", raw: {} }),
    runTurn: native.runTurn,
    interruptTurn: native.interrupt,
    request: native.request,
    requestTyped: native.request,
    onNotification: (method: string, handler: (params: unknown) => void) => {
      const listeners = native.listeners.get(method) ?? new Set();
      listeners.add(handler); native.listeners.set(method, listeners);
      return () => listeners.delete(handler);
    },
    dispose: vi.fn(async () => {}),
  })),
}));
vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({ root: "/tmp/s", env: "/tmp/s/env", log: "/tmp/s/log", telemetry: "/tmp/s/tel" })),
  writeSessionMeta: vi.fn(async () => {}), removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

const adapters: CodexAppServerAdapter[] = [];
const notify = (method: string, params: unknown) => native.listeners.get(method)?.forEach(handler => handler(params));
const settings = () => native.request.mock.calls.filter(([method]) => method === "turn/settings/update").map(([, params]) => params);
const env = (effort = "low", fast = false, model = "gpt-6.1-sol") => ({
  OPENAI_MODEL: model, ZEROS_THINKING_EFFORT: effort, ...(fast ? { ZEROS_FAST_MODE: "1" } : {}),
});

beforeEach(() => {
  native.listeners.clear(); native.runTurn.mockReset(); native.interrupt.mockClear();
  native.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "config/read") return { config: {} };
    if (method === "skills/list" || method === "model/list") return { data: [] };
    return {};
  });
});
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.dispose())); });

async function setup() {
  const log = vi.fn();
  const adapter = new CodexAppServerAdapter({
    projectRoot: "/tmp/proj", mcpServers: [], sessionDirRoot: "/tmp/sessions",
    emit: { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: log, onAgentExit: vi.fn() },
  });
  adapters.push(adapter);
  const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: env() });
  const update = (next: Record<string, string>) => adapter.updateConfig({ sessionId: session.sessionId, env: next });
  async function start(id = "turn-1", acknowledge = true) {
    let accept!: (status?: string) => void;
    let resolve!: (value: unknown) => void;
    native.runTurn.mockImplementationOnce((_params, options) => {
      accept = (status = "inProgress") => options.onTurnStarted(id, status);
      if (acknowledge) {
        accept();
        notify("turn/started", { threadId: "thread-settings", turn: { id, status: "inProgress" } });
      }
      return new Promise(done => { resolve = done; });
    });
    const result = adapter.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Work" }] });
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    const terminal = (turnId = id) => notify("turn/completed", { threadId: "thread-settings", turn: { id: turnId, status: "completed" } });
    const finish = async () => { terminal(); resolve({ turnId: id, status: "completed", raw: {} }); return result; };
    return { result, accept, terminal, finish };
  }
  return { adapter, sessionId: session.sessionId, log, update, start };
}

describe("Codex active-turn settings", () => {
  it("updates effort and Fast on the exact active turn and retains them for the next turn", async () => {
    const f = await setup(), turn = await f.start();
    await f.update(env("ultracode", true));
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-1", effort: "ultra", serviceTier: "fast" }]);
    await f.update(env("ultracode", true));
    expect(settings()).toHaveLength(1);
    await f.update(env("ultracode"));
    expect(settings()[1]).toEqual({ threadId: "thread-settings", turnId: "turn-1", serviceTier: null });
    await turn.finish();
    const next = await f.start("turn-2");
    expect(native.runTurn.mock.calls.at(-1)?.[0]).toMatchObject({ effort: "ultra", serviceTierForTurn: "default" });
    await next.finish();
  });

  it("applies the latest change once a pending turn/start identifies the active turn", async () => {
    const f = await setup(), turn = await f.start("turn-pending", false);
    await f.update(env("high", true));
    expect(settings()).toEqual([]);
    turn.accept();
    await vi.waitFor(() => expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-pending", effort: "high", serviceTier: "fast" }]));
    await turn.finish();
  });

  it("does not lose a change immediately after an unchanged snapshot", async () => {
    const f = await setup(), turn = await f.start();
    const unchanged = f.update(env());
    const changed = f.update(env("high", true));
    await Promise.all([unchanged, changed]);
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-1", effort: "high", serviceTier: "fast" }]);
    await turn.finish();
  });

  it("retains a config change when acknowledgement arrives before its promise settles", async () => {
    const f = await setup(), turn = await f.start("turn-pending", false);
    const changing = f.update(env("high", true));
    turn.accept();
    await changing;
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-pending", effort: "high", serviceTier: "fast" }]);
    await turn.finish();
  });

  it("serializes in-flight updates and publishes only the latest queued selection", async () => {
    const f = await setup(), turn = await f.start();
    let release!: () => void;
    native.request.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.update(env("high"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const middle = f.update(env("max", true));
    const latest = f.update(env("ultracode"));
    expect(settings()).toHaveLength(1);
    release(); await Promise.all([first, middle, latest]);
    expect(settings()).toEqual([
      { threadId: "thread-settings", turnId: "turn-1", effort: "high" },
      { threadId: "thread-settings", turnId: "turn-1", effort: "ultra" },
    ]);
    await turn.finish();
  });

  it.each(["notification", "ack"])("does not update a turn already completed by its %s", async terminal => {
    const f = await setup(), turn = await f.start("turn-done", false);
    await f.update(env("high", true));
    if (terminal === "notification") turn.terminal();
    turn.accept(terminal === "ack" ? "completed" : "inProgress");
    await f.update(env("max"));
    expect(settings()).toEqual([]);
    await turn.finish();
  });

  it("clears liveness at native completion before prompt settlement, ignoring stale completions", async () => {
    const f = await setup(), turn = await f.start();
    turn.terminal("retired-turn");
    await f.update(env("high"));
    expect(settings()).toHaveLength(1);
    turn.terminal();
    await f.update(env("max", true));
    expect(settings()).toHaveLength(1);
    await turn.finish();
  });

  it("does not target Stop, disposal, idle sessions or another session id", async () => {
    const f = await setup();
    await f.update(env("high"));
    await f.adapter.updateConfig({ sessionId: "another-execution", env: env("max") });
    expect(settings()).toEqual([]);
    const turn = await f.start();
    await f.adapter.cancel({ sessionId: f.sessionId });
    await f.update(env("max", true));
    expect(settings()).toEqual([]);
    await turn.finish();
    await f.adapter.disposeSession(f.sessionId);
    await f.update(env("low"));
    expect(settings()).toEqual([]);
  });

  it("keeps a newly selected model and its knobs for the next turn", async () => {
    const f = await setup(), turn = await f.start();
    await f.update(env("max", true, "gpt-6.1-terra"));
    expect(settings()).toEqual([]);
    await turn.finish();
    const next = await f.start("turn-2");
    expect(native.runTurn.mock.calls.at(-1)?.[0]).toMatchObject({ model: "gpt-6.1-terra", effort: "max", serviceTierForTurn: "fast" });
    await next.finish();
  });

  it("logs an unsupported effort update without failing the active turn or losing later settings", async () => {
    const f = await setup(), turn = await f.start();
    native.request.mockImplementation(async method => {
      if (method === "turn/settings/update") throw new Error("Model does not support reasoning effort updates; private-fixture-detail");
      return {};
    });
    await expect(f.update(env("high", true))).resolves.toBeUndefined();
    expect(settings()).toHaveLength(1);
    expect(f.log.mock.calls.flat().join(" ")).toMatch(/settings.*(?:failed|rejected|could not)/i);
    expect(f.log.mock.calls.flat().join(" ")).not.toContain("private-fixture-detail");
    expect(native.interrupt).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toMatchObject({ stopReason: "end_turn" });
    const next = await f.start("turn-2");
    expect(native.runTurn.mock.calls.at(-1)?.[0]).toMatchObject({ effort: "high", serviceTierForTurn: "fast" });
    await next.finish();
  });

  it("coalesces changes behind an in-flight update and drops the queued change on completion", async () => {
    const f = await setup(), turn = await f.start();
    let release!: () => void;
    native.request.mockImplementation(async method => {
      if (method === "turn/settings/update") await new Promise<void>(done => { release = done; });
      return {};
    });
    const first = f.update(env("high"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = f.update(env("max", true));
    expect(settings()).toHaveLength(1);
    await turn.finish();
    const next = await f.start("turn-2");
    release(); await Promise.all([first, queued]);
    expect(settings()).toHaveLength(1);
    expect(native.runTurn.mock.calls.at(-1)?.[0]).toMatchObject({ effort: "max", serviceTierForTurn: "fast" });
    await next.finish();
  });
});
