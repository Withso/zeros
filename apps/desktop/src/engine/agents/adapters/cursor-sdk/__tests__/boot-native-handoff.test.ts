import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkAdapter, type CursorSdkSendOptions } from "../adapter";
import type { AgentAdapterContext } from "../../../types";
import type { PreparedBoundary } from "../../../containment/types";
import { cloudProviderExecution, cloudBootTurnReservation, type CloudBootNativeAuthority } from "../../../cloud-provider-execution";
import { testExecutionBoundary } from "../../../__tests__/helpers/test-execution-boundary";
import { testCloudBootFixture } from "../../../__tests__/helpers/test-cloud-boot";

const native = vi.hoisted(() => ({ prepareBoot: vi.fn(), runtime: vi.fn(), create: vi.fn(), resume: vi.fn(), send: vi.fn() }));
vi.mock("../../../containment/cloud-native-boundary", () => ({ CloudNativeBoundary: { prepare: vi.fn(), prepareBoot: native.prepareBoot } }));
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
  native.runtime.mockReset().mockImplementation(() => ({ module: { Agent: { create: native.create, resume: native.resume, list: vi.fn(async () => ({ items: [] })) },
    Cursor: { models: { list: vi.fn(async () => []) } }, platform: { prewarm: vi.fn(async () => ({})) } }, dispose: async () => {} }));
});
async function setup(operation: "new" | "load" = "new") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-boot-"))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await testCloudBootFixture(root); cleanups.push(f.close);
  native.prepareBoot.mockImplementation(async (authority: CloudBootNativeAuthority, domain: PreparedBoundary) => {
    const coordinator = { ...domain, providerHomePath: "/srv/zeros/home/agent", hasBackgroundServers: async () => false,
      environment: () => ({ HOME: "/srv/zeros/home/agent", CURSOR_API_KEY: "synthetic-cursor-private-key", CURSOR_MODEL: "test-model", ZEROS_EXACT_MODEL: "1" }) };
    authority.lifetime.attach(coordinator); return coordinator;
  });
  const domain = await f.factory.launchBootSelection(f.selection, () => testExecutionBoundary().prepare({ executionId: f.selection.executionId, actor: "agent-code", cwd: root, workspaceRoot: root }));
  const result = await f.factory.prepareBoot({ selection: f.selection, workload: domain, signal: new AbortController().signal });
  const execution = cloudProviderExecution(result.boundary)!;
  const reservation = f.factory.reserveBootTurn(execution, f.selection);
  const ctx: AgentAdapterContext = { projectRoot: root, sessionDirRoot: path.join(root, "sessions"), mcpServers: [],
    emit: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } };
  const adapter = new CursorSdkAdapter(ctx); cleanups.push(() => adapter.dispose());
  const options = { executionId: f.selection.executionId, cwd: root, env: result.env, executionBoundary: result.boundary };
  if (operation === "new") await adapter.newSession(options); else await adapter.loadSession({ ...options, sessionId: "native-existing" });
  const writes = vi.fn();
  native.send.mockImplementation(async (_message, opts: CursorSdkSendOptions) => {
    opts.beforeNativeWrite?.(); writes(); opts.onNativePromptStage?.("native_write");
    return { id: "native-run", stream: async function* () {}, wait: async () => ({ status: "finished" }), cancel: async () => {} };
  });
  return { ...f, adapter, execution, reservation, writes, sessionId: f.selection.executionId };
}
const blocks = [{ type: "text" as const, text: "Synthetic" }];
describe("Cursor original boot reservation across native preparation", () => {
  it.each(["new", "load"] as const)("%s marks actual native handoff and keeps passive observation separate", async operation => {
    const f = await setup(operation), observer = vi.fn();
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
