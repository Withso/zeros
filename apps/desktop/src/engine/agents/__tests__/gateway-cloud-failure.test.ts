import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ cloud: null as unknown }));
vi.mock("../cloud-provider-execution", async original => ({
  ...await original<typeof import("../cloud-provider-execution")>(), cloudProviderExecution: () => state.cloud,
}));
import { AgentGateway } from "../gateway";
import { AgentFailureError, type AgentAdapter } from "../types";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

describe("cloud provider failure causes", () => {
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
