import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapter, AgentAdapterContext, SessionNotification } from "../../../types";
import { AgentGateway } from "../../../gateway";
import { testExecutionBoundary } from "../../../__tests__/helpers/test-execution-boundary";
import { isTransientConnectionNotice } from "../../../../../renderer/features/agent/transcript-notices";

const sdk = vi.hoisted(() => ({ create: vi.fn(), resume: vi.fn(), models: vi.fn(), dispose: vi.fn() }));
vi.mock("@cursor/sdk", () => ({
  Agent: { create: sdk.create, resume: sdk.resume, list: vi.fn() },
  Cursor: { models: { list: sdk.models } },
  JsonlLocalAgentStore: class { runs = { get: async () => null }; },
  getDefaultSdkStateRoot: (cwd: string) => `/synthetic-cursor-store${cwd}`,
}));
vi.mock("../host/host-client", () => ({
  createCursorHostRuntime: () => ({ module: {
    Agent: { create: sdk.create, resume: sdk.resume, list: vi.fn() },
    Cursor: { models: { list: sdk.models } },
  }, dispose: sdk.dispose }),
  getCursorHostModule: vi.fn(),
  CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED",
  CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP",
  CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor",
}));

const GROK = [{
  id: "grok-4.6",
  parameters: [
    { id: "context", values: [{ value: "256k" }] },
    { id: "reasoning_effort", values: [{ value: "high" }, { value: "xhigh" }] },
  ],
  variants: [{ displayName: "Grok", isDefault: true, params: [
    { id: "context", value: "256k" }, { id: "reasoning_effort", value: "high" },
  ] }],
}];
const OPTIONS = {
  cwd: "/tmp/cursor-local-resume",
  executionId: "local-resume",
  sessionId: "saved-provider-conversation",
  env: { CURSOR_API_KEY: "synthetic-account-key", CURSOR_MODEL: "grok-4.6", ZEROS_THINKING_EFFORT: "xhigh" },
};
const EXPECTED = { id: "grok-4.6", params: [
  { id: "context", value: "256k" }, { id: "reasoning_effort", value: "xhigh" },
] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(authenticationContext = () => "local-account") {
  const updates: SessionNotification[] = [];
  const context: AgentAdapterContext = {
    projectRoot: OPTIONS.cwd,
    sessionDirRoot: "/tmp/cursor-local-resume-sessions",
    mcpServers: [],
    authenticationContext,
    emit: {
      onSessionUpdate: (_agent, update) => { updates.push(update); },
      onAgentStderr() {}, onAgentExit() {}, onPermissionRequest() {}, onQuestionRequest() {},
    },
  };
  return { adapter: new CursorSdkAdapter(context), updates };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CURSOR_API_KEY", "");
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  sdk.create.mockReset().mockResolvedValue({ agentId: "new-agent", close() {} });
  sdk.resume.mockReset().mockResolvedValue({ agentId: OPTIONS.sessionId, close() {} });
  sdk.models.mockReset();
  sdk.dispose.mockReset().mockResolvedValue(undefined);
  // The SDK boundary is the only provider connection in these Local runs.
  // Any newly introduced CP/cloud HTTP dependency fails the test.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Local resume must not contact the control plane"); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Cursor registry discovery during Local resume", () => {
  it("keeps the original conversation pending while a successful catalog takes more than five seconds", async () => {
    const catalog = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementation(() => { started.resolve(); return catalog.promise; });
    const { adapter } = setup();
    let settled = false;
    const pending = adapter.loadSession(OPTIONS).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(settled).toBe(false);
      expect(sdk.resume).not.toHaveBeenCalled();
      catalog.resolve(GROK);
      const result = await pending;
      if ("error" in result) throw result.error;
      expect(result).toHaveProperty("value");
      expect(sdk.resume).toHaveBeenCalledExactlyOnceWith(OPTIONS.sessionId,
        expect.objectContaining({ model: EXPECTED, cwd: OPTIONS.cwd, apiKey: OPTIONS.env.CURSOR_API_KEY }));
      expect(sdk.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      catalog.resolve(GROK);
      await pending;
      await adapter.dispose();
    }
  });

  it("retries one failed catalog read, reports connection progress, and resumes without changing the model", async () => {
    const retry = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementationOnce(() => {
      started.resolve();
      return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    }).mockImplementationOnce(() => retry.promise);
    const { adapter, updates } = setup();
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sdk.models).toHaveBeenCalledTimes(2);
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(updates).toEqual([expect.objectContaining({
        sessionId: OPTIONS.executionId,
        update: expect.objectContaining({ sessionUpdate: "error_notice", code: "api_retry", recoverable: true,
          message: expect.stringMatching(/couldn't reach Cursor.*retrying/i) }),
      })]);
      const messages = applyUpdate([], updates[0]!);
      expect(messages).toHaveLength(1);
      expect(isTransientConnectionNotice(messages[0]!)).toBe(true);
      retry.resolve(GROK);
      const result = await pending;
      if ("error" in result) throw result.error;
      expect(result).toHaveProperty("value");
      expect(sdk.resume).toHaveBeenCalledExactlyOnceWith(OPTIONS.sessionId, expect.objectContaining({ model: EXPECTED }));
      expect(sdk.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      retry.resolve(GROK);
      await pending;
      await adapter.dispose();
    }
  });

  it("exhausts transient failures as a reconnectable error instead of an account-settings refusal", async () => {
    const started = deferred<void>();
    sdk.models.mockImplementation(() => {
      started.resolve();
      return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    });
    const { adapter } = setup();
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject({ error: { failure: {
        kind: "transport-closed", stage: "loadSession", message: expect.stringMatching(/couldn't reach Cursor/i),
      } } });
      expect(sdk.models).toHaveBeenCalledTimes(2);
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await pending; await adapter.dispose(); }
  });

  it("bounds a hung read and refuses its late result without recreating the conversation", async () => {
    const catalog = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementation(() => { started.resolve(); return catalog.promise; });
    const { adapter } = setup();
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject({ error: { failure: { kind: "transport-closed", stage: "loadSession" } } });
      catalog.resolve(GROK);
      await vi.advanceTimersByTimeAsync(0);
      expect((await adapter.initialize())._meta?.models).toBeUndefined();
      expect(sdk.models).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
    } finally { catalog.resolve(GROK); await pending; await adapter.dispose(); }
  });

  it("keeps a confirmed missing registry schema terminal without retry or guessed settings", async () => {
    sdk.models.mockResolvedValue([{ id: "grok-4.6" }]);
    const { adapter, updates } = setup();
    try {
      await expect(adapter.loadSession(OPTIONS)).rejects.toMatchObject({ failure: {
        kind: "protocol-error", stage: "loadSession", message: "Cursor model settings could not be verified for this account.",
      } });
      expect(sdk.models).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  it.each([
    [{ status: 401, message: "Unauthorized" }, "auth-required"],
    [{ status: 429, message: "Too many requests" }, "rate-limited"],
  ])("preserves a definitive discovery refusal %j without automatic retry", async (error, kind) => {
    sdk.models.mockRejectedValue(error);
    const { adapter, updates } = setup();
    try {
      await expect(adapter.loadSession(OPTIONS)).rejects.toMatchObject({ failure: { kind, stage: "loadSession" } });
      expect(sdk.models).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  it("does not retry a successful but malformed catalog as a network failure", async () => {
    sdk.models.mockResolvedValue([{ id: 17 }]);
    const { adapter, updates } = setup();
    try {
      await expect(adapter.loadSession(OPTIONS)).rejects.toMatchObject({ failure: { kind: "protocol-error", stage: "loadSession" } });
      expect(sdk.models).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  it("keeps the original discovery deadline when the failed first read leaves little retry time", async () => {
    const first = deferred<typeof GROK>(), second = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementationOnce(() => { started.resolve(); return first.promise; })
      .mockImplementationOnce(() => second.promise);
    const { adapter } = setup();
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(19_000);
      first.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ error: { failure: { kind: "transport-closed", stage: "loadSession" } } });
      expect(sdk.models).toHaveBeenCalledTimes(2);
      second.resolve(GROK);
      await vi.advanceTimersByTimeAsync(0);
      expect(sdk.resume).not.toHaveBeenCalled();
      expect((await adapter.initialize())._meta?.models).toBeUndefined();
    } finally { first.resolve(GROK); second.resolve(GROK); await pending; await adapter.dispose(); }
  });

  it("does not retry a timed-out read's late failure or overwrite a later successful catalog", async () => {
    const first = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementationOnce(() => { started.resolve(); return first.promise; }).mockResolvedValue(GROK);
    const { adapter, updates } = setup();
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toHaveProperty("error");
      await vi.advanceTimersByTimeAsync(30_000);
      await adapter.loadSession(OPTIONS);
      first.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sdk.models).toHaveBeenCalledTimes(2);
      expect(sdk.resume).toHaveBeenCalledOnce();
      expect(updates).toEqual([]);
      expect((await adapter.initialize())._meta?.models).toEqual([expect.objectContaining({ value: "grok-4.6", selectable: true })]);
    } finally { first.resolve(GROK); await pending; await adapter.dispose(); }
  });

  it("rejects the original account after a slow read crosses an owner switch", async () => {
    const catalog = deferred<typeof GROK>(), started = deferred<void>();
    sdk.models.mockImplementation(() => { started.resolve(); return catalog.promise; });
    let account = "local-personal";
    const { adapter } = setup(() => account);
    const pending = adapter.loadSession(OPTIONS).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      account = "organization-local";
      catalog.resolve(GROK);
      expect(await pending).toMatchObject({ error: { failure: { kind: "lifecycle-superseded", stage: "loadSession" } } });
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { catalog.resolve(GROK); await pending; await adapter.dispose(); }
  });

  it("resumes through the Local gateway without a control-plane connection", async () => {
    vi.useRealTimers();
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-local-cursor-registry-")));
    vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "engine"));
    const { adapter } = setup();
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: testExecutionBoundary(),
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} },
    });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("cursor", adapter);
    sdk.models.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValue(GROK);
    try {
      const resumed = await gateway.loadSession("cursor", {
        version: 1, kind: "native", providerId: "cursor", resumeId: OPTIONS.sessionId,
      }, { cwd: root, env: OPTIONS.env, conversationId: "local-saved-chat" });
      expect(resumed.providerBinding?.resumeId).toBe(OPTIONS.sessionId);
      expect(sdk.resume).toHaveBeenCalledExactlyOnceWith(OPTIONS.sessionId, expect.objectContaining({ model: EXPECTED }));
      expect(sdk.models).toHaveBeenCalledTimes(2);
      expect(sdk.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
