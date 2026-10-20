import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkAdapter, type CursorSdkSendOptions } from "../adapter";
import type { AgentAdapterContext } from "../../../types";
import type { PreparedBoundary } from "../../../containment/types";
import { createCloudNativeHome, isCloudNativeHome } from "../../../containment/cloud-native-home";
import { cloudNativeProviderEnvironment } from "../../../containment/cloud-native-boundary";
import { CloudExecutionBoundary, isCloudPreparedBoundary } from "../../../containment/cloud-execution-boundary";
import * as workerConfiguration from "../../../containment/cloud-worker-config";
import { portableCloudWorkloads } from "../../../containment/__tests__/helpers/portable-cloud-custody";
import { cloudProviderExecution, cloudBootTurnReservation, cloudExecutionLifetime, type CloudBootNativeAuthority, type CloudProviderExecution } from "../../../cloud-provider-execution";
import { testCloudBootFixture } from "../../../__tests__/helpers/test-cloud-boot";

const native = vi.hoisted(() => ({ prepareBoot: vi.fn(), runtime: vi.fn(), create: vi.fn(), resume: vi.fn(), send: vi.fn(), models: vi.fn() }));
vi.mock("../../../containment/cloud-native-boundary", async original => ({
  ...await original<typeof import("../../../containment/cloud-native-boundary")>(),
  CloudNativeBoundary: { prepare: vi.fn(), prepareBoot: native.prepareBoot },
}));
vi.mock("../../../containment/cloud-worker-config", async original => ({
  ...await original<typeof import("../../../containment/cloud-worker-config")>(),
  loadCloudWorkerConfiguration: vi.fn(),
}));
vi.mock("../../../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../../../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
vi.mock("../../../cloud-mcp", async original => ({ ...await original<typeof import("../../../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
vi.mock("../host/host-client", () => ({ createCursorHostRuntime: native.runtime,
  getCursorHostModule: vi.fn(), CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED", CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP", CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor" }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const agent = () => ({ agentId: "native", send: native.send, close() {} });
beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", ""); vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  native.create.mockReset().mockResolvedValue(agent()); native.resume.mockReset().mockResolvedValue(agent()); native.send.mockReset();
  native.models.mockReset().mockResolvedValue([{ id: "test-model" }]);
  native.runtime.mockReset().mockImplementation(() => ({ module: { Agent: { create: native.create, resume: native.resume, list: vi.fn(async () => ({ items: [] })) },
    Cursor: { models: { list: native.models } }, platform: { prewarm: vi.fn(async () => ({})) } }, dispose: async () => {} }));
});
async function setup(operation: "new" | "load" = "new", selection: {
  model?: string;
  beforeSession?: (execution: CloudProviderExecution) => void;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-boot-"))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  // Genuine Host scopes and physical HOME; deployment/cgroup admission is an
  // explicit portable fixture, not a native kernel qualification.
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
  const f = await testCloudBootFixture(root, "cursor", selection.model); cleanups.push(f.close);
  native.prepareBoot.mockImplementation(async (authority: CloudBootNativeAuthority, domain: PreparedBoundary) => {
    authority.lifetime.assertLive();
    const nativeHome = await createCloudNativeHome({ dataRoot: root, conversationId: f.input.conversationId,
      provider: "cursor", executionId: f.selection.executionId });
    const material = authority.takeMaterial();
    const coordinator = { ...domain, nativeHome, providerHomePath: nativeHome.paths.home, hasBackgroundServers: async () => false,
      environment: () => cloudNativeProviderEnvironment(material, authority.model, undefined, authority.environment?.values, nativeHome) };
    authority.lifetime.attach(coordinator); return coordinator;
  });
  const domain = await f.factory.launchBootSelection(f.selection, () => boundary.prepare({ executionId: f.selection.executionId, actor: "agent-code", cwd: root, workspaceRoot: root }));
  const result = await f.factory.prepareBoot({ selection: f.selection, workload: domain, signal: new AbortController().signal });
  const execution = cloudProviderExecution(result.boundary)!;
  const reservation = f.factory.reserveBootTurn(execution, f.selection);
  const ctx: AgentAdapterContext = { projectRoot: root, sessionDirRoot: path.join(root, "sessions"), mcpServers: [],
    emit: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } };
  const adapter = new CursorSdkAdapter(ctx); cleanups.push(() => adapter.dispose());
  const options = { executionId: f.selection.executionId, cwd: root, env: result.env, executionBoundary: result.boundary };
  selection.beforeSession?.(execution);
  if (operation === "new") await adapter.newSession(options); else await adapter.loadSession({ ...options, sessionId: "native-existing" });
  const writes = vi.fn();
  native.send.mockImplementation(async (_message, opts: CursorSdkSendOptions) => {
    opts.beforeNativeWrite?.(); writes(); opts.onNativePromptStage?.("native_write");
    return { id: "native-run", stream: async function* () {}, wait: async () => ({ status: "finished" }), cancel: async () => {} };
  });
  return { ...f, root, domain, adapter, execution, reservation, writes, sessionId: f.selection.executionId };
}
const blocks = [{ type: "text" as const, text: "Synthetic" }];
describe("Cursor original boot reservation across native preparation", () => {
  it.each<Record<string, string>>([
    { CURSOR_MODEL: "alternate-model" },
    { CURSOR_MODEL: "test-model", ZEROS_REQUIRE_EXACT_MODEL: "0" },
  ])("rejects a cloud configuration authority change without replacing the original model: %j", async env => {
    native.models.mockResolvedValue([{ id: "test-model" }, { id: "alternate-model" }]);
    const f = await setup();
    await expect(f.adapter.updateConfig({ sessionId: f.sessionId, env })).rejects.toHaveProperty("code", "cloud_validation_access_denied");
    await expect(f.adapter.updateConfig({ sessionId: f.sessionId, env: { ZEROS_FAST_MODE: "0" } })).resolves.toBeUndefined();
    await expect(f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks })).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(native.send).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ model: { id: "test-model" } }));
    expect(f.writes).toHaveBeenCalledOnce();
    await f.factory.settleBootTurn(f.execution, f.reservation);
  });
  it("refuses cloud configuration after its original execution authority retires", async () => {
    const f = await setup();
    await cloudExecutionLifetime(f.execution).close();
    await expect(f.adapter.updateConfig({ sessionId: f.sessionId, env: { CURSOR_MODEL: "test-model" } }))
      .rejects.toHaveProperty("code", "cloud_validation_lifecycle_superseded");
    expect(f.writes).not.toHaveBeenCalled();
  });
  it.each(["new", "load"] as const)("does not %s from a late registry reply after its original cloud authority retires", async operation => {
    let release!: (models: unknown[]) => void;
    let started!: () => void;
    const discovering = new Promise<void>(resolve => { started = resolve; });
    native.models.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
    let execution!: CloudProviderExecution;
    const pending = setup(operation, { model: "grok-4.7", beforeSession: value => { execution = value; } });
    void pending.catch(() => {});
    await discovering;
    await cloudExecutionLifetime(execution).close();
    release([{ id: "grok-4.7", parameters: [] }]);
    await expect(pending).rejects.toHaveProperty("code", "cloud_validation_lifecycle_superseded");
    expect(native.create).not.toHaveBeenCalled();
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.send).not.toHaveBeenCalled();
  });
  it.each([false, true])("joins a rejected model refresh without replay and rechecks disposal (dispose=%s)", async dispose => {
    const f = await setup();
    await f.adapter.initializeSession(f.sessionId);
    let release!: (models: unknown[]) => void;
    native.models.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    native.send.mockRejectedValueOnce(new Error("Cannot use this model: test-model. Available models: composer-2.5. Use Cursor.models.list() to discover valid selections."));
    await expect(f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks })).rejects.toThrow();
    await vi.waitFor(() => expect(native.models).toHaveBeenCalledTimes(2));
    let settled = false;
    const refresh = f.adapter.initializeSession(f.sessionId).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    const returnedBeforeDiscovery = settled;
    if (dispose) await f.adapter.disposeSession(f.sessionId);
    release([]);
    const result = await refresh;
    expect(returnedBeforeDiscovery).toBe(false);
    if (dispose) expect(result._meta?.models).toBeUndefined();
    else expect(result._meta).toMatchObject({ models: [], modelsAccountScoped: true });
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(native.models).toHaveBeenCalledTimes(2);
  });
  it.each(["new", "load"] as const)("keeps %s cloud model metadata on the admitted execution", async operation => {
    const f = await setup(operation);
    expect((await f.adapter.initialize())._meta?.models).toBeUndefined();
    await vi.waitFor(async () => expect((await f.adapter.initializeSession(f.sessionId))._meta).toMatchObject({
      modelsAccountScoped: true, models: [{ value: "test-model" }],
    }));
    expect((await f.adapter.initializeSession("unrelated-execution"))._meta?.models).toBeUndefined();
    expect(f.writes).not.toHaveBeenCalled();
    await f.adapter.disposeSession(f.sessionId);
    expect((await f.adapter.initializeSession(f.sessionId))._meta?.models).toBeUndefined();
  });
  it.each(["new", "load"] as const)("%s marks actual native handoff and keeps passive observation separate", async operation => {
    const f = await setup(operation), observer = vi.fn();
    expect(isCloudPreparedBoundary(f.domain)).toBe(true);
    const nativeHome = f.execution.coordinator.nativeHome;
    expect(isCloudNativeHome(nativeHome)).toBe(true);
    expect((await stat(nativeHome.paths.home)).uid).toBe(process.geteuid?.());
    expect((await stat(nativeHome.paths.home)).mode & 0o777).toBe(0o700);
    expect(nativeHome.paths.home).toContain(path.join(f.root, "native-agent-homes") + path.sep);
    await f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks, onNativePromptStage: observer });
    expect(native.send.mock.calls[0]![1].beforeNativeWrite).toBeTypeOf("function");
    expect(f.factory.bootScopeActivity([{ provider: "cursor", credentialId: f.selection.credentialRun.credentialId }]).foreground).toBe(1);
    expect(f.writes).toHaveBeenCalledOnce(); expect(observer).toHaveBeenCalledExactlyOnceWith("native_write");
    await f.factory.settleBootTurn(f.execution, f.reservation);
  });
  it("refuses a captured A after configuration awaits and B becomes ready even when the start fence clears", async () => {
    const f = await setup(); let resolve!: (value: ReturnType<typeof agent>) => void;
    const waiting = new Promise<ReturnType<typeof agent>>(done => { resolve = done; });
    native.resume.mockImplementationOnce(() => waiting); await f.adapter.setMode({ sessionId: f.sessionId, modeId: "plan" });
    const pending = f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks }); void pending.catch(() => {});
    await vi.waitFor(() => expect(native.resume).toHaveBeenCalledOnce());
    f.credentials.markDesired(2);
    f.request.sync.mockResolvedValueOnce({ ...f.response, cacheRevision: 2, desiredCacheRevision: 2,
      providers: f.response.providers.map(entry => entry.provider === "cursor" && entry.status === "ready"
        ? { ...entry, credentialId: randomUUID(), credentialRevision: 2, adoptionId: randomUUID(), materialVersion: 2,
          material: { kind: "cursor-api-key", apiKey: "synthetic-replacement-key" } } : entry) });
    await f.credentials.synchronize(); f.canStart.mockReturnValue(true); resolve(agent());
    await expect(pending).rejects.toHaveProperty("code", "cloud_validation_lifecycle_superseded");
    expect(f.writes).not.toHaveBeenCalled();
  });
  it("never replaces the original token with a later current warm token after an await", async () => {
    const f = await setup(); let resolve!: (value: ReturnType<typeof agent>) => void;
    const waiting = new Promise<ReturnType<typeof agent>>(done => { resolve = done; });
    native.resume.mockImplementationOnce(() => waiting); await f.adapter.setMode({ sessionId: f.sessionId, modeId: "plan" });
    const pending = f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks }); void pending.catch(() => {});
    await vi.waitFor(() => expect(native.resume).toHaveBeenCalledOnce());
    // Another accepted original flight consumes and settles A before a later
    // selection is reserved. The waiting A must carry its own old token.
    f.factory.assertNativeHandoff(f.execution, f.reservation); f.factory.markNativeHandoff(f.execution, f.reservation);
    await f.factory.settleBootTurn(f.execution, f.reservation);
    const next = f.factory.selectBoot(f.input), replacement = f.factory.reserveBootTurn(f.execution, next);
    expect(cloudBootTurnReservation(f.execution)).toBe(replacement); resolve(agent());
    await expect(pending).rejects.toHaveProperty("code", "cloud_validation_access_denied");
    expect(f.writes).not.toHaveBeenCalled();
  });
  it("does not mark a stopped configuration wait as native use", async () => {
    const f = await setup(); let resolve!: (value: ReturnType<typeof agent>) => void;
    native.resume.mockImplementationOnce(() => new Promise<ReturnType<typeof agent>>(done => { resolve = done; }));
    await f.adapter.setMode({ sessionId: f.sessionId, modeId: "plan" });
    const pending = f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks });
    await vi.waitFor(() => expect(native.resume).toHaveBeenCalledOnce());
    await f.adapter.cancel({ sessionId: f.sessionId }); resolve(agent());
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" }); expect(f.writes).not.toHaveBeenCalled();
    expect(f.factory.bootScopeActivity([{ provider: "cursor", credentialId: f.selection.credentialRun.credentialId }]).foreground).toBe(0);
  });
});
