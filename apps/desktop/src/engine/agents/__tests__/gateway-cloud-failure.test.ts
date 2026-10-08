import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ cloud: null as unknown }));
vi.mock("../cloud-provider-execution", async original => ({
  ...await original<typeof import("../cloud-provider-execution")>(),
  cloudProviderExecution: (boundary?: import("../containment/types").PreparedBoundary) => boundary ? state.cloud : null,
}));
import { AgentGateway } from "../gateway";
import { AgentFailureError, type AgentAdapter } from "../types";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

async function cloudTerminationFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-termination-")));
  let leaseFailure: Error | null = null;
  let stopFailure: Error | null = null;
  let stopGate: Promise<void> | undefined;
  const workload = testExecutionBoundary({ onStop: () => { if (stopFailure) throw stopFailure; } });
  const prepare = workload.prepare.bind(workload);
  workload.prepare = async (...args) => {
    const boundary = await prepare(...args);
    const stop = boundary.stopAndProve.bind(boundary);
    boundary.stopAndProve = async () => { if (stopGate) await stopGate; await stop(); };
    return boundary;
  };
  const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
  const start = vi.fn(async (options: { executionId: string }) => ({
    session: { executionId: options.executionId, sessionId: options.executionId }, initialize: {},
  }));
  const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" },
    cloudAgentExecutionFactory: { prepare: async input => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) }) },
    events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
  (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("codex", {
    agentId: "codex", newSession: start, prompt, cancel: async () => {},
    disposeSession: async () => {}, dispose: async () => {},
  } as unknown as AgentAdapter);
  state.cloud = { lease: { admission: { provider: "codex" }, credentialKind: "codex-api-key", signal: new AbortController().signal,
    validate: async () => { if (leaseFailure) throw leaseFailure; },
    assertLive: () => { if (leaseFailure) throw leaseFailure; }, close: async () => {} },
    redactor: new CloudCustomizationRedactor(["synthetic-private"]) };
  const begin = (executionId: string = randomUUID()) => gateway.newSession("codex", { cwd: root, conversationId: "conversation",
    cloudExecutionId: executionId, cloudExecution: { delegationId: randomUUID(), model: "test-model",
      source: { kind: "session", actorSessionId: randomUUID() } } });
  return { gateway, begin, prompt,
    setLeaseFailure: (error: Error | null) => { leaseFailure = error; },
    setStopFailure: (error: Error | null) => { stopFailure = error; },
    setStopGate: (gate?: Promise<void>) => { stopGate = gate; },
    nativeExit: (executionId: string) => (gateway as unknown as { events: import("../types").AgentGatewayEvents })
      .events.onAgentExit("codex", 1, null, executionId),
    cleanup: async () => { stopFailure = null; stopGate = undefined; await gateway.dispose(); state.cloud = null;
      await rm(root, { recursive: true, force: true }); },
  };
}

describe("cloud provider failure causes", () => {
  it("retains the first typed lease reason before teardown and does not serialize its raw prose", async () => {
    const f = await cloudTerminationFixture();
    try {
      const session = await f.begin();
      f.setLeaseFailure(Object.assign(new Error("Private grant failure synthetic-private"), { code: "cloud_agent_credential_revoked" }));
      await f.gateway.endSession("codex", session.executionId, { failClosed: true });
      f.setLeaseFailure(new CloudCommandFailureError({ stage: "validation", category: "lease_expired" }));
      await f.gateway.endSession("codex", session.executionId, { failClosed: true });
      const error = await f.gateway.prompt("codex", session.executionId, [{ type: "text", text: "Test" }])
        .then(() => undefined, error => error as AgentFailureError & { code: string });
      expect(error).toMatchObject({ name: "AgentFailureError", code: "cloud_agent_credential_revoked",
        failure: { kind: "cloud-credentials-unavailable", stage: "prompt" } });
      expect(JSON.stringify(error)).not.toContain("synthetic-private");
      expect(JSON.stringify(error)).not.toContain("Private grant failure");
      expect(f.prompt).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("retains an observed native exit before retirement without claiming auth", async () => {
    const f = await cloudTerminationFixture();
    try {
      const session = await f.begin();
      f.nativeExit(session.executionId);
      await f.gateway.endSession("codex", session.executionId, { failClosed: true });
      await expect(f.gateway.prompt("codex", session.executionId, [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ name: "AgentFailureError", code: "cloud_provider_prompt_subprocess_exited",
          failure: { kind: "subprocess-exited", stage: "prompt" } });
      expect(f.prompt).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("preserves explicit cancellation before a later native exit", async () => {
    const f = await cloudTerminationFixture();
    try {
      const session = await f.begin();
      await f.gateway.cancel("codex", session.executionId);
      f.nativeExit(session.executionId);
      await f.gateway.endSession("codex", session.executionId, { failClosed: true });
      await expect(f.gateway.prompt("codex", session.executionId, [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ name: "AgentFailureError", code: "cloud_provider_prompt_lifecycle_superseded",
          failure: { kind: "lifecycle-superseded", stage: "prompt" } });
    } finally { await f.cleanup(); }
  });

  it("keeps failed-retirement proof authoritative while its cloud boundary remains retained", async () => {
    const f = await cloudTerminationFixture();
    try {
      const session = await f.begin();
      f.setStopFailure(new CloudCommandFailureError({ stage: "containment", category: "attestation_failed" }));
      await expect(f.gateway.endSession("codex", session.executionId, { failClosed: true }))
        .rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
      await expect(f.gateway.prompt("codex", session.executionId, [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
      expect(f.prompt).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("does not let old delayed retirement delete or poison a replacement admission with the same execution id", async () => {
    const f = await cloudTerminationFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const first = await f.begin();
      f.setStopGate(gate);
      const retiring = f.gateway.endSession("codex", first.executionId, { failClosed: true });
      await vi.waitFor(() => expect(f.gateway.workspaceSessionIds("unmanaged", "/never")).toEqual([]));
      const replacement = await f.begin(first.executionId);
      release();
      await retiring;
      await expect(f.gateway.prompt("codex", replacement.executionId, [{ type: "text", text: "Test" }]))
        .resolves.toMatchObject({ stopReason: "end_turn" });
      expect(f.prompt).toHaveBeenCalledOnce();
    } finally { release(); await f.cleanup(); }
  });

  it("bounds retired cause retention and clears it for a fresh admission", async () => {
    const f = await cloudTerminationFixture();
    const ids: string[] = [];
    try {
      for (let i = 0; i < 129; i++) {
        const session = await f.begin();
        ids.push(session.executionId);
        f.nativeExit(session.executionId);
        await f.gateway.endSession("codex", session.executionId, { failClosed: true });
      }
      await expect(f.gateway.prompt("codex", ids[0]!, [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ code: "cloud_provider_prompt_session_expired" });
      await expect(f.gateway.prompt("codex", ids.at(-1)!, [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ code: "cloud_provider_prompt_subprocess_exited" });
      const replacement = await f.begin(ids.at(-1)!);
      await expect(f.gateway.prompt("codex", replacement.executionId, [{ type: "text", text: "Test" }]))
        .resolves.toMatchObject({ stopReason: "end_turn" });
    } finally { await f.cleanup(); }
  }, 20_000);

  it.each([
    ["newSession", "queued"], ["newSession", "retired"],
    ["loadSession", "queued"], ["loadSession", "retired"],
  ] as const)("preserves the known typed %s startup cause for a %s cloud prompt", async (operation, timing) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-startup-cause-")));
    const executionId = randomUUID();
    let rejectStartup!: (error: Error) => void;
    const startup = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    const native = vi.fn(() => startup);
    const prompt = vi.fn();
    const workload = testExecutionBoundary();
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" },
      cloudAgentExecutionFactory: { prepare: async input => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) }) },
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("codex", {
      agentId: "codex", newSession: native, loadSession: native, prompt,
      disposeSession: async () => {}, dispose: async () => {},
    } as unknown as AgentAdapter);
    state.cloud = { lease: { admission: { provider: "codex" }, credentialKind: "codex-api-key", signal: new AbortController().signal,
      validate: async () => {} }, redactor: new CloudCustomizationRedactor(["synthetic-private"]) };
    const options = { cwd: root, conversationId: "conversation", cloudExecutionId: executionId,
      cloudExecution: { delegationId: randomUUID(), model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
    const starting = (operation === "newSession" ? gateway.newSession("codex", options)
      : gateway.loadSession("codex", { version: 1, kind: "native", providerId: "codex", resumeId: "saved" }, options))
      .then(() => undefined, error => error as unknown);
    const send = () => gateway.prompt("codex", executionId, [{ type: "text", text: "Test" }])
      .then(() => undefined, error => error as unknown);
    try {
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      const waiting = timing === "queued" ? send() : null;
      rejectStartup(new AgentFailureError({ kind: "auth-required", stage: operation, agentId: "codex",
        message: "Native startup refused synthetic-private" }));
      const startupError = await starting;
      expect(startupError).toMatchObject({ code: "cloud_provider_start_auth_required",
        failure: { kind: "auth-required", stage: operation, message: "Native startup refused [redacted]" } });
      expect((gateway as unknown as { executionBoundaries: Map<string, unknown> }).executionBoundaries.has(executionId)).toBe(false);
      const promptError = await (waiting ?? send());
      expect(promptError).toMatchObject({ code: "cloud_provider_start_auth_required",
        failure: { kind: "auth-required", stage: operation, message: "Native startup refused [redacted]" } });
      expect(prompt).not.toHaveBeenCalled();
      await expect(gateway.prompt("cursor", executionId, [{ type: "text", text: "Wrong provider" }]))
        .rejects.toMatchObject({ failure: { kind: "session-expired", stage: "prompt", agentId: "cursor" } });
    } finally {
      rejectStartup(new Error("Fixture closed"));
      await starting;
      state.cloud = null;
      await gateway.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an unadmitted cloud prompt with typed expiry, without claiming provider auth", async () => {
    const workload = testExecutionBoundary();
    const gateway = new AgentGateway({ projectRoot: os.tmpdir(), executionBoundary: { ...workload, backend: "cloud-worker" },
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    try {
      await expect(gateway.prompt("codex", randomUUID(), [{ type: "text", text: "Test" }]))
        .rejects.toMatchObject({ name: "AgentFailureError", code: "cloud_provider_prompt_session_expired",
          failure: { kind: "session-expired", stage: "prompt", agentId: "codex" } });
    } finally { await gateway.dispose(); }
  });

  it.each(["newSession", "loadSession"] as const)("preserves a typed outer workload prepare refusal through %s before credential admission", async stage => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-workload-cause-")));
    const failure = new CloudCommandFailureError({ stage: "containment", category: "canary_failed" });
    const workload = testExecutionBoundary({ prepareError: failure });
    const prepare = vi.fn();
    const native = vi.fn();
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" },
      cloudAgentExecutionFactory: { prepare },
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("claude", {
      agentId: "claude", newSession: native, loadSession: native, disposeSession: async () => {}, dispose: async () => {},
    } as unknown as AgentAdapter);
    const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(),
      model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
    try {
      const result = stage === "newSession" ? gateway.newSession("claude", options)
        : gateway.loadSession("claude", { version: 1, kind: "native", providerId: "claude", resumeId: "saved" }, options);
      await expect(result).rejects.toMatchObject({ code: "cloud_containment_canary_failed", diagnosis: { stage: "containment", category: "canary_failed" } });
      expect(prepare).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    } finally { await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["Personal", "organization-local"])("keeps the %s outer boundary refusal on its existing Local path", async _owner => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-local-workload-cause-")));
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: testExecutionBoundary({
      prepareError: new CloudCommandFailureError({ stage: "containment", category: "canary_failed" }),
    }), events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("claude", {
      agentId: "claude", newSession: vi.fn(), disposeSession: async () => {}, dispose: async () => {},
    } as unknown as AgentAdapter);
    try { await expect(gateway.newSession("claude", { cwd: root })).rejects.toMatchObject({ failure: { kind: "design-protection-failed" } }); }
    finally { await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["newSession", "loadSession", "prompt"] as const)("preserves typed inner causes through %s", async stage => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-typed-")));
    const workload = testExecutionBoundary();
    let failure: Error = new CloudCommandFailureError({ stage: "containment", category: "attestation_failed" });
    const rejected = vi.fn(async () => { throw failure; });
    const started = vi.fn(async (options: { executionId: string }) => ({ session: { executionId: options.executionId, sessionId: options.executionId }, initialize: {} }));
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" },
      cloudAgentExecutionFactory: { prepare: async input => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) }) },
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("cursor", { agentId: "cursor",
      newSession: stage === "newSession" ? rejected : started, loadSession: rejected, prompt: rejected,
      disposeSession: async () => {}, dispose: async () => {} } as unknown as AgentAdapter);
    state.cloud = { lease: { admission: { provider: "cursor" }, credentialKind: "cursor-api-key", signal: new AbortController().signal,
      validate: async () => {} }, redactor: new CloudCustomizationRedactor(["synthetic-private"]) };
    const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(),
      model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
    const run = () => stage === "newSession" ? gateway.newSession("cursor", options)
      : stage === "loadSession" ? gateway.loadSession("cursor", { version: 1, kind: "native", providerId: "cursor", resumeId: "saved" }, options)
      : gateway.newSession("cursor", options).then(session => gateway.prompt("cursor", session.executionId, [{ type: "text", text: "Test" }]));
    try {
      await expect(run()).rejects.toMatchObject({ code: "cloud_containment_attestation_failed", failure: { stage: "initialize" } });
      for (const code of ["cloud_agent_credential_required", "cloud_agent_credential_expired", "cloud_agent_credential_revoked"]) {
        failure = Object.assign(new Error("Delegated credential unavailable synthetic-private"), { code });
        await expect(run()).rejects.toMatchObject({ code, message: "Delegated credential unavailable [redacted]" });
      }
    } finally { state.cloud = null; await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["newSession", "loadSession", "prompt"] as const)("keeps the closed %s stage and structured provider guidance", async stage => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-cause-")));
    const workload = testExecutionBoundary();
    const failure = new AgentFailureError({ kind: "verification-required", stage, agentId: "claude",
      message: "Complete verification at https://example.test/verify. synthetic-private" });
    const rejected = vi.fn(async () => { throw failure; });
    const started = vi.fn(async (options: { executionId: string }) => ({ session: { executionId: options.executionId, sessionId: options.executionId }, initialize: {} }));
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" },
      cloudAgentExecutionFactory: { prepare: async input => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) }) },
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("claude", { agentId: "claude",
      newSession: stage === "newSession" ? rejected : started, loadSession: rejected, prompt: rejected,
      disposeSession: async () => {}, dispose: async () => {} } as unknown as AgentAdapter);
    state.cloud = { lease: { admission: { provider: "claude" }, credentialKind: "claude-api-key", signal: new AbortController().signal,
      validate: async () => {} }, redactor: new CloudCustomizationRedactor(["synthetic-private"]) };
    const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(),
      model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
    try {
      const result = stage === "newSession" ? gateway.newSession("claude", options)
        : stage === "loadSession" ? gateway.loadSession("claude", { version: 1, kind: "native", providerId: "claude", resumeId: "saved" }, options)
        : gateway.newSession("claude", options).then(session => gateway.prompt("claude", session.executionId, [{ type: "text", text: "Test" }]));
      await expect(result).rejects.toMatchObject({ code: `cloud_${stage === "prompt" ? "provider_prompt" : "provider_start"}_verification_required`,
        failure: { kind: "verification-required", message: "Complete verification at https://example.test/verify. [redacted]" } });
      expect(rejected).toHaveBeenCalledOnce();
    } finally { state.cloud = null; await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it("leaves a Local provider error unchanged", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-local-cause-")));
    const failure = new AgentFailureError({ kind: "verification-required", stage: "newSession", message: "Native Local cause" });
    const gateway = new AgentGateway({ projectRoot: root, executionBoundary: testExecutionBoundary(),
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("claude", { agentId: "claude",
      newSession: async () => { throw failure; }, disposeSession: async () => {}, dispose: async () => {} } as unknown as AgentAdapter);
    try { await expect(gateway.newSession("claude", { cwd: root })).rejects.toBe(failure); }
    finally { await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
