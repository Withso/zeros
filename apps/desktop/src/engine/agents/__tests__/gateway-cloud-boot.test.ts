import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter, NewSessionResponse } from "../types";
import { cloudProviderExecution, cloudBootTurnReservation, assertCloudBootNativeHandoff,
  markCloudBootNativeHandoff, type CloudBootNativeAuthority } from "../cloud-provider-execution";
import type { PreparedBoundary } from "../containment/types";
import { CloudExecutionBoundary, isCloudPreparedBoundary } from "../containment/cloud-execution-boundary";
import { createCloudNativeHome, isCloudNativeHome, type CloudNativeHome } from "../containment/cloud-native-home";
import { cloudNativeProviderEnvironment } from "../containment/cloud-native-boundary";
import * as workerConfiguration from "../containment/cloud-worker-config";
import { portableCloudWorkloads } from "../containment/__tests__/helpers/portable-cloud-custody";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import { testCloudBootFixture } from "./helpers/test-cloud-boot";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";

const native = vi.hoisted(() => ({ prepareBoot: vi.fn() }));
vi.mock("../containment/cloud-native-boundary", async original => ({
  ...await original<typeof import("../containment/cloud-native-boundary")>(),
  CloudNativeBoundary: { prepare: vi.fn(), prepareBoot: native.prepareBoot },
}));
vi.mock("../cloud-mcp", async original => ({ ...await original<typeof import("../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
vi.mock("../containment/cloud-worker-config", async original => ({
  ...await original<typeof import("../containment/cloud-worker-config")>(),
  loadCloudWorkerConfiguration: vi.fn(),
}));
vi.mock("../containment/cloud-native-history", async original => ({
  ...await original<typeof import("../containment/cloud-native-history")>(),
  copyCloudNativeForkHistory: async (_scope: unknown, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("./helpers/test-cloud-runtime")).testCloudRuntime,
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const blocks = [{ type: "text" as const, text: "Synthetic prompt" }];
async function setup(provider: "cursor" | "codex" = "cursor", initialFactory: "boot" | "legacy" | "none" = "boot") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-gateway-boot-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  // Original Host scopes and physical HOME, with explicit portable deployment
  // admission/cgroup IO. This fixture does not qualify native kernel entry.
  const configuration = { version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
    uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
    toolchain: { node: process.execPath, supervisor: path.resolve("apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs") } };
  vi.mocked(workerConfiguration.loadCloudWorkerConfiguration).mockReturnValue(configuration);
  const guard = vi.spyOn(workerConfiguration, "isCloudWorkerConfiguration").mockImplementation(
    (value: unknown): value is workerConfiguration.CloudWorkerConfiguration => value === configuration);
  let workloads: ReturnType<typeof portableCloudWorkloads>;
  let boundary: CloudExecutionBoundary;
  try {
    workloads = portableCloudWorkloads(configuration);
    boundary = new CloudExecutionBoundary({ projectRoot: root, configuration, workloads });
  } finally { guard.mockRestore(); }
  cleanups.push(async () => { await workloads.drain(workloads.fence()); });
  const f = await testCloudBootFixture(root, provider); cleanups.push(f.close);
  const nativeHomes = new WeakMap<PreparedBoundary, CloudNativeHome>();
  const prepare = boundary.prepare.bind(boundary);
  const onPrepare = vi.spyOn(boundary, "prepare").mockImplementation(async (request, control) => {
    const domain = await prepare(request, control);
    const nativeHome = await createCloudNativeHome({ dataRoot: root, conversationId: f.input.conversationId,
      provider, executionId: request.executionId });
    nativeHomes.set(domain, nativeHome);
    return domain;
  });
  native.prepareBoot.mockImplementation(async (authority: CloudBootNativeAuthority, domain: PreparedBoundary) => {
    authority.lifetime.assertLive();
    const nativeHome = nativeHomes.get(domain);
    if (!nativeHome) throw new Error("Expected original physical fixture HOME");
    const material = authority.takeMaterial();
    const coordinator = { ...domain, nativeHome, providerHomePath: nativeHome.paths.home,
      environment: () => cloudNativeProviderEnvironment(material, authority.model, undefined, authority.environment?.values, nativeHome),
      hasBackgroundServers: async () => false, takeHistoryHandoff: () => undefined };
    authority.lifetime.attach(coordinator); return coordinator;
  });
  const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
  const gateway = new AgentGateway({ projectRoot: root, executionBoundary: boundary,
    cloudAgentExecutionFactory: initialFactory === "boot" ? f.factory : initialFactory === "legacy" ? f.legacy : undefined, events });
  cleanups.push(() => gateway.dispose());
  const start = vi.fn(async (opts: { executionId?: string; executionBoundary?: PreparedBoundary }): Promise<{ session: NewSessionResponse; initialize: { protocolVersion: number } }> => {
    expect(cloudBootTurnReservation(cloudProviderExecution(opts.executionBoundary)!)).not.toBeNull();
    return { session: { executionId: opts.executionId!, sessionId: opts.executionId! }, initialize: { protocolVersion: 1 } };
  });
  const writes = vi.fn(), prompt = vi.fn<AgentAdapter["prompt"]>(async opts => {
    const context = cloudProviderExecution((gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.get(opts.sessionId))!;
    const token = cloudBootTurnReservation(context)!;
    assertCloudBootNativeHandoff(context, token); markCloudBootNativeHandoff(context, token); writes();
    opts.onNativePromptStage?.("native_write");
    return { response: { stopReason: "end_turn" }, stopReason: "end_turn" };
  });
  const unused = async () => { throw new Error("Unexpected Local discovery"); };
  const adapter: AgentAdapter = { agentId: provider, initialize: unused, listSessions: unused, newSession: start,
    loadSession: async opts => (await start(opts)).session,
    prompt, cancel: async () => {}, disposeSession: async () => {}, dispose: async () => {} };
  (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(provider, adapter);
  const options = { cwd: root, conversationId: f.input.conversationId, cloudExecution: f.selection, cloudExecutionId: f.selection.executionId };
  return { ...f, gateway, root, boundary, options, adapter, start, writes, prompt, onPrepare, events };
}

describe("gateway genuine boot mode", () => {
  it("pins only the original cloud history redactor and retains it after positive native retirement", async () => {
    const f = await setup();
    expect(f.gateway.pinCloudHistoryRedactor("cursor", f.selection.executionId)).toBeNull();
    const session = await f.gateway.newSession("cursor", f.options);
    expect(f.gateway.pinCloudHistoryRedactor("codex", session.executionId)).toBeNull();
    const redact = f.gateway.pinCloudHistoryRedactor("cursor", session.executionId);
    expect(redact).not.toBeNull();
    const document = { chatId: "conversation", payload: '{"text":"synthetic-actor-setting"}', nested: { value: "synthetic-actor-settin" } };
    expect(redact!(document)).toEqual({ chatId: "conversation", payload: '{"text":"[redacted]"}', nested: { value: "[redacted]" } });
    expect(document.payload).toContain("synthetic-actor-setting");
    await f.gateway.endSession("cursor", session.executionId, { failClosed: true });
    expect(f.gateway.pinCloudHistoryRedactor("cursor", session.executionId)).toBeNull();
    expect(redact!(document)).toEqual({ chatId: "conversation", payload: '{"text":"[redacted]"}', nested: { value: "[redacted]" } });
    expect(f.writes).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("does not expose a cloud history redactor through a Local gateway even for a foreign native boundary", async () => {
    const f = await setup(), session = await f.gateway.newSession("cursor", f.options);
    const local = new AgentGateway({ projectRoot: f.root, events: f.events, executionBoundary: testExecutionBoundary() });
    cleanups.push(() => local.dispose());
    const boundaries = (local as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries;
    const original = (f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.get(session.executionId)!;
    boundaries.set(session.executionId, original);
    try { expect(local.pinCloudHistoryRedactor("cursor", session.executionId)).toBeNull(); }
    finally { boundaries.clear(); }
  });
  it.each(["legacy", "none"] as const)("installs a genuine boot factory explicitly after %s construction", async initialFactory => {
    const f = await setup("cursor", initialFactory);
    f.gateway.installCloudBootAgentExecutionFactory(f.factory);
    const session = await f.gateway.newSession("cursor", f.options);
    expect(session.executionId).toBe(f.selection.executionId); expect(f.legacy.prepare).not.toHaveBeenCalled();
    (f.gateway as unknown as { events: import("../types").AgentGatewayEvents }).events.onSessionUpdate("cursor", {
      sessionId: session.executionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic-actor-setting" } },
    });
    expect(JSON.stringify(f.events.onSessionUpdate.mock.calls)).not.toContain("synthetic-actor-setting");
    expect(f.events.onSessionUpdate).toHaveBeenCalledOnce();
  });
  it("refuses a copied factory and retains the real legacy constructor factory", async () => {
    const f = await setup("cursor", "legacy");
    expect(() => f.gateway.installCloudBootAgentExecutionFactory({ ...f.factory })).toThrowError(CloudCommandFailureError);
    expect((f.gateway as unknown as { cloudAgentExecutionFactory: unknown }).cloudAgentExecutionFactory).toBe(f.legacy);
    expect(f.onPrepare).not.toHaveBeenCalled();
  });
  it("refuses boot cutover during a legacy admission before a native route exists", async () => {
    const f = await setup("cursor", "legacy");
    let release!: (adapter: AgentAdapter) => void;
    vi.spyOn(f.gateway as unknown as { adapterFor(agentId: string): Promise<AgentAdapter> }, "adapterFor")
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const starting = f.gateway.newSession("cursor", { cwd: f.root, conversationId: "conversation",
      cloudExecution: { delegationId: f.scope.bootId, model: "test-model", source: { kind: "session", actorSessionId: f.provenance.actorSessionId } } });
    expect(() => f.gateway.installCloudBootAgentExecutionFactory(f.factory)).toThrowError(CloudCommandFailureError);
    expect((f.gateway as unknown as { cloudAgentExecutionFactory: unknown }).cloudAgentExecutionFactory).toBe(f.legacy);
    release(f.adapter); await expect(starting).rejects.toThrow("Unexpected legacy admission");
  });
  it("refuses cutover with an active native boundary and replacement of an installed factory", async () => {
    const f = await setup("cursor", "legacy"), boundaries = (f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries;
    boundaries.set("legacy-native", f.boundary as unknown as PreparedBoundary);
    expect(() => f.gateway.installCloudBootAgentExecutionFactory(f.factory)).toThrowError(CloudCommandFailureError);
    boundaries.delete("legacy-native"); f.gateway.installCloudBootAgentExecutionFactory(f.factory);
    const session = await f.gateway.newSession("cursor", f.options);
    expect(() => f.gateway.installCloudBootAgentExecutionFactory(f.factory)).not.toThrow();
    const other = await testCloudBootFixture(f.root); cleanups.push(other.close);
    expect(() => f.gateway.installCloudBootAgentExecutionFactory(other.factory)).toThrowError(CloudCommandFailureError);
    expect(f.gateway.cloudBootReservation("cursor", session.executionId)).not.toBeNull();
  });
  it.each(["new", "load"] as const)("%s preserves ORIGINAL selection and reserves before native startup", async operation => {
    const f = await setup();
    const session = operation === "new" ? await f.gateway.newSession("cursor", f.options) :
      await f.gateway.loadSession("cursor", { version: 1, kind: "native", providerId: "cursor", resumeId: "native-existing" }, f.options);
    if (!session.executionId) throw new Error("Missing admitted execution identity");
    expect(session.executionId).toBe(f.selection.executionId);
    const domain = await f.onPrepare.mock.results[0].value;
    expect(isCloudPreparedBoundary(domain)).toBe(true);
    const nativeHome = cloudProviderExecution((f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> })
      .executionBoundaries.get(session.executionId))!.coordinator.nativeHome;
    expect(isCloudNativeHome(nativeHome)).toBe(true);
    expect((await stat(nativeHome.paths.home)).uid).toBe(process.geteuid?.());
    expect((await stat(nativeHome.paths.home)).mode & 0o777).toBe(0o700);
    expect(nativeHome.paths.home).toContain(path.join(f.root, "native-agent-homes") + path.sep);
    expect(f.start).toHaveBeenCalledOnce(); expect(f.legacy.prepare).not.toHaveBeenCalled();
    const observed = vi.fn(); await expect(f.gateway.prompt("cursor", session.executionId, blocks, "first", observed)).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(f.writes).toHaveBeenCalledOnce(); expect(observed).toHaveBeenCalledExactlyOnceWith("native_write");
    expect(f.request.bootstrap).toHaveBeenCalledOnce(); expect(f.request.sync).not.toHaveBeenCalled(); expect(f.contextRequest).toHaveBeenCalledOnce();
  });
  it("refuses a copied opaque selection before allocation or adapter startup", async () => {
    const f = await setup();
    await expect(f.gateway.newSession("cursor", { ...f.options, cloudExecution: { ...f.selection } })).rejects.toBeInstanceOf(Error);
    expect(f.onPrepare).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.legacy.prepare).not.toHaveBeenCalled();
  });
  it.each(["conversation", "execution", "provider"] as const)("refuses foreign %s before allocation", async field => {
    const f = await setup(), options = { ...f.options,
      ...(field === "conversation" ? { conversationId: "another-conversation" } : {}),
      ...(field === "execution" ? { cloudExecutionId: "another-execution" } : {}) };
    await expect(f.gateway.newSession(field === "provider" ? "claude" : "cursor", options)).rejects.toBeInstanceOf(Error);
    expect(f.onPrepare).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it("refuses a foreign resolved cwd before allocating a native domain", async () => {
    const f = await setup(), other = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-other-boot-")));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    await expect(f.gateway.newSession("cursor", { ...f.options, cwd: other })).rejects.toBeInstanceOf(Error);
    expect(f.onPrepare).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it("warms only the same native session with a fresh ORIGINAL turn reservation and no foreground requests", async () => {
    const f = await setup(), session = await f.gateway.newSession("cursor", f.options);
    const first = cloudBootTurnReservation(cloudProviderExecution((f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.get(session.executionId))!)!;
    await f.gateway.prompt("cursor", session.executionId, blocks, "first");
    await expect(f.gateway.completeCloudForeground("cursor", session.executionId, undefined, first)).resolves.toBe(true);
    const context = cloudProviderExecution((f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.get(session.executionId))!;
    expect(cloudBootTurnReservation(context)).toBeNull();
    await expect(f.gateway.prompt("cursor", session.executionId, blocks, "unreserved")).rejects.toBeInstanceOf(Error);
    expect(f.writes).toHaveBeenCalledOnce();
    const next = f.factory.selectBoot(f.input);
    expect(next).not.toBe(f.selection); expect(next.executionId).toBe(session.executionId);
    f.gateway.reserveCloudBootTurn("cursor", session.executionId, next);
    const second = cloudBootTurnReservation(context)!;
    await f.gateway.prompt("cursor", session.executionId, blocks, "second");
    await expect(f.gateway.completeCloudForeground("cursor", session.executionId, undefined, second)).resolves.toBe(true);
    expect(f.onPrepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce(); expect(f.writes).toHaveBeenCalledTimes(2);
    expect(f.request.bootstrap).toHaveBeenCalledOnce(); expect(f.request.sync).not.toHaveBeenCalled(); expect(f.contextRequest).toHaveBeenCalledOnce();
  });
  it("does not let a delayed old completion settle a newer original reservation", async () => {
    const f = await setup(), session = await f.gateway.newSession("cursor", f.options);
    const execution = cloudProviderExecution((f.gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.get(session.executionId))!;
    const first = cloudBootTurnReservation(execution)!;
    await f.gateway.prompt("cursor", session.executionId, blocks, "first");
    await f.factory.settleBootTurn(execution, first);
    const next = f.factory.selectBoot(f.input), second = f.factory.reserveBootTurn(execution, next);
    f.factory.assertNativeHandoff(execution, second); f.factory.markNativeHandoff(execution, second);
    await expect(f.gateway.completeCloudForeground("cursor", session.executionId, undefined, first)).rejects.toHaveProperty("code", "cloud_validation_access_denied");
    expect(cloudBootTurnReservation(execution)).toBe(second);
  });
  it("refuses current start fences immediately before the actual native handoff", async () => {
    const f = await setup(), session = await f.gateway.newSession("cursor", f.options);
    f.canStart.mockReturnValue(false);
    await expect(f.gateway.prompt("cursor", session.executionId, blocks)).rejects.toBeInstanceOf(Error);
    expect(f.writes).not.toHaveBeenCalled();
  });
  it("uses the ORIGINAL boot factory and first-write reservation for a one-shot native Codex fork", async () => {
    const f = await setup("codex");
    const fork = vi.fn(async (opts: { executionBoundary?: PreparedBoundary }) => {
      const execution = cloudProviderExecution(opts.executionBoundary)!;
      const reservation = cloudBootTurnReservation(execution)!;
      assertCloudBootNativeHandoff(execution, reservation); markCloudBootNativeHandoff(execution, reservation); f.writes();
      return { providerBinding: { version: 1 as const, kind: "native" as const, providerId: "codex", resumeId: "native-forked" } };
    });
    f.adapter.forkProviderBinding = fork;
    const result = await f.gateway.forkProviderBinding("codex", { version: 1, kind: "native", providerId: "codex", resumeId: "native-source" }, {
      ...f.options, sourceConversationId: "another-source-conversation" });
    expect(result.resumeId).toBe("native-forked"); expect(f.writes).toHaveBeenCalledOnce();
    expect(f.legacy.prepare).not.toHaveBeenCalled(); expect(f.onPrepare).toHaveBeenCalledOnce();
    expect(f.authority.lifetime.signal.aborted).toBe(true);
  });
  it.each(["Personal Local", "organization-local"])("keeps %s closed to any cloud selection", async () => {
    const f = await setup(), local = new AgentGateway({ projectRoot: f.root, executionBoundary: testExecutionBoundary(),
      events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
    cleanups.push(() => local.dispose());
    expect(() => local.installCloudBootAgentExecutionFactory(f.factory)).toThrowError(CloudCommandFailureError);
    await expect(local.newSession("cursor", f.options)).rejects.toThrow("Cloud agent admission requires a cloud worker");
    expect(f.onPrepare).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
});
