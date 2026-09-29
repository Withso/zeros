import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ execution: null as unknown }));
vi.mock("../cloud-provider-execution", async importOriginal => ({
  ...await importOriginal<typeof import("../cloud-provider-execution")>(), cloudProviderExecution: () => state.execution,
}));
import { AgentGateway } from "../gateway";
import type { AgentGatewayOptions } from "../types";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";

describe("cloud gateway secret delivery", () => {
  it("keeps subagent messages and authoritative replacements separate", () => {
    const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
    const gateway = new AgentGateway({ projectRoot: "/tmp", events, cloudAgentExecutionFactory: { prepare: vi.fn() } });
    const internal = gateway as unknown as { events: AgentGatewayOptions["events"]; executionBoundaries: Map<string, unknown> };
    state.execution = { lease: { signal: new AbortController().signal, admission: { provider: "claude" } }, redactor: new CloudCustomizationRedactor(["synthetic-private"]) };
    internal.executionBoundaries.set("test", {});
    try {
      internal.events.onSessionUpdate("claude", { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", messageId: "first", parentToolId: "subagent", content: { type: "text", text: "syn" } } });
      internal.events.onSessionUpdate("claude", { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", messageId: "second", content: { type: "text", text: "Separate message." } } });
      expect(events.onSessionUpdate.mock.calls[1]![1].update.content.text).toBe("Separate message.");
      internal.events.onSessionUpdate("claude", { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", messageId: "first", parentToolId: "subagent", textMode: "replace", content: { type: "text", text: "Authoritative message." } } });
      expect(events.onSessionUpdate.mock.calls[2]![1].update.content.text).toBe("Authoritative message.");
    } finally { internal.executionBoundaries.clear(); state.execution = null; }
  });
  it("redacts transcript chunks and provider stderr before publishing them and leaves Local events intact", () => {
    const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
    const gateway = new AgentGateway({ projectRoot: "/tmp", events, cloudAgentExecutionFactory: { prepare: vi.fn() } });
    const internal = gateway as unknown as { events: AgentGatewayOptions["events"]; executionBoundaries: Map<string, unknown> };
    state.execution = { lease: { signal: new AbortController().signal, admission: { provider: "claude" } }, redactor: new CloudCustomizationRedactor(["synthetic-mcp-private"]) };
    internal.executionBoundaries.set("test", {});
    try {
      for (const text of ["Tool result: synthetic-mcp-", "private!"]) internal.events.onSessionUpdate("claude", {
        sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      internal.events.onAgentStderr("claude", "failure synthetic-mcp-private\n");
      const chunks = events.onSessionUpdate.mock.calls.map(([, message]) => message.update.content.text).join("");
      expect(chunks).toBe("Tool result: [redacted]!");
      expect(events.onAgentStderr).toHaveBeenCalledWith("claude", "failure [redacted]\n");
      const local = new AgentGateway({ projectRoot: "/tmp", events });
      expect((local as unknown as { events: unknown }).events).toBe(events);
    } finally { internal.executionBoundaries.clear(); state.execution = null; }
  });
});

it.each(["newSession", "loadSession"] as const)("filters %s failures, diagnostics and causes before boundary disposal", async stage => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { testExecutionBoundary } = await import("./helpers/test-execution-boundary");
  const { AgentFailureError } = await import("../types");
  const literal = "synthetic-private-startup-value", diagnostic = literal.slice(0, -1), root = await realpath(await mkdtemp("/tmp/zeros-cloud-errors-"));
  const workload = testExecutionBoundary();
  const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
  const factory = { prepare: vi.fn(async (input: { workload: unknown }) => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) })) };
  const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" }, events, cloudAgentExecutionFactory: factory } as AgentGatewayOptions);
  const failure = new AgentFailureError({ kind: "protocol-error", stage, agentId: "claude", message: `Boot failed\nstderr tail:\n${diagnostic}`, exit: { code: 1, signal: null, stderrTail: diagnostic } });
  failure.cause = new Error(`Cause: ${literal}\nPartial diagnostic: ${diagnostic}`);
  const adapter = { agentId: "claude", newSession: vi.fn(async () => { throw failure; }), loadSession: vi.fn(async () => { throw failure; }), disposeSession: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  (gateway as unknown as { adapters: Map<string, unknown> }).adapters.set("claude", adapter);
  state.execution = { lease: { signal: new AbortController().signal, admission: { provider: "claude" }, close: vi.fn(async () => {}) }, redactor: new CloudCustomizationRedactor([literal]) };
  const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(), model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
  try {
    const result = await (stage === "newSession" ? gateway.newSession("claude", options) : gateway.loadSession("claude", { version: 1, kind: "native", providerId: "claude", resumeId: "native" }, options)).catch(error => error);
    expect(result).toBeInstanceOf(AgentFailureError);
    expect(result.failure).toMatchObject({ kind: "protocol-error", stage, agentId: "claude", exit: { code: 1, signal: null, stderrTail: "[redacted]" } });
    expect(result.message).not.toContain(diagnostic); expect(result.stack).not.toContain(diagnostic); expect(result.cause.message).not.toContain(diagnostic);
    expect(adapter.disposeSession).toHaveBeenCalled();
  } finally { state.execution = null; await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
});

it.each([true, false])("uses a fresh provider binding and one scrubbed owner handoff (binding available at startup: %s)", async hasInitialBinding => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { testExecutionBoundary } = await import("./helpers/test-execution-boundary");
  const root = await realpath(await mkdtemp("/tmp/zeros-cloud-owner-")), workload = testExecutionBoundary();
  const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
  const factory = { prepare: vi.fn(async (input: { workload: unknown }) => ({ boundary: input.workload, env: {}, authorityId: "a".repeat(64) })) };
  const gateway = new AgentGateway({ projectRoot: root, executionBoundary: { ...workload, backend: "cloud-worker" }, events, cloudAgentExecutionFactory: factory } as AgentGatewayOptions);
  const binding = { version: 1 as const, kind: "native" as const, providerId: "claude", resumeId: "fresh-binding" };
  const adapter = { agentId: "claude", newSession: vi.fn(async (input: {executionId:string}) => ({ session: {executionId:input.executionId,sessionId:input.executionId,...(hasInitialBinding ? {providerBinding:binding} : {})}, initialize:{} })),
    loadSession: vi.fn(), prompt: vi.fn(async () => ({stopReason:"end_turn"})), disposeSession: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  (gateway as unknown as { adapters: Map<string, unknown> }).adapters.set("claude", adapter);
  state.execution = { lease: { signal: new AbortController().signal, admission: { provider: "claude" }, close: vi.fn(async () => {}), validate: vi.fn(async () => {}) }, redactor: new CloudCustomizationRedactor([]),
    coordinator: {requiresFreshHistory:true,takeHistoryHandoff:vi.fn().mockReturnValueOnce('Earlier safe answer [redacted].')} };
  const options = { cwd: root, conversationId: "conversation", cloudExecution: { delegationId: randomUUID(), model: "test-model", source: { kind: "session" as const, actorSessionId: randomUUID() } } };
  try {
    const response = await gateway.loadSession("claude", {...binding,resumeId:"previous-owner-binding"}, options);
    expect(adapter.loadSession).not.toHaveBeenCalled(); expect(adapter.newSession).toHaveBeenCalledOnce();
    expect(response).toMatchObject({resumedFresh:true});
    expect(response.providerBinding).toEqual(hasInitialBinding ? binding : undefined);
    await gateway.prompt('claude',response.executionId!,[{type:'text',text:'Continue.'}]);
    await gateway.prompt('claude',response.executionId!,[{type:'text',text:'Next.'}]);
    expect(JSON.stringify(adapter.prompt.mock.calls[0])).toContain('Earlier safe answer [redacted].');
    expect(JSON.stringify(adapter.prompt.mock.calls[1])).not.toContain('Earlier safe answer');
  } finally { state.execution = null; await gateway.dispose(); await rm(root, { recursive: true, force: true }); }
});
