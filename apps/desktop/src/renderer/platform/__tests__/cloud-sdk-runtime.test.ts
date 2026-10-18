import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ epoch: 1, invoke: vi.fn(), close: vi.fn(async () => true) }));
vi.mock("../runtime", () => ({ nativeInvoke: state.invoke }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.epoch }));
vi.mock("../cloud-workspace-access", () => ({ closeCloudWorkspaceRuntime: state.close }));
import { cloudSdkRuntimeIdentity, openCloudSdkWorkspaceRuntime, refreshCloudSdkWorkspaceRuntime,
  fallbackCloudSdkWorkspaceRuntime, signCloudSdkRuntimeProof, renewCloudSdkRuntimeCapabilities } from "../cloud-sdk-runtime";
import type { CloudSdkRuntimeTarget } from "../../../../shared/cloud-sdk-contract";
import { CloudSdkTargetSchema } from "../../../../shared/cloud-sdk-contract";
import { parseCloudWorkspaceKey } from "../bridge/cloud-workspace-key";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) }, now = 1_800_000_000_000;
const bootScope = { ...target, generation: 7, engineInstanceId: id(3), bootId: id(4), writerEpoch: id(5), fundingOwnerUserId: id(6), fundingOwnerEpoch: 1 };
const capabilities = { engine: { token: "synthetic-engine-capability", expiresAt: new Date(now + 300_000).toISOString() },
  realtime: { token: "synthetic-relay-capability", expiresAt: new Date(now + 300_000).toISOString() } };
const runtime: CloudSdkRuntimeTarget = { kind: "cloud", channel: "sdk-websocket", ...target, runtimeId: id(7), generation: 7,
  authorityEpoch: 3, engineInstanceId: id(3), connectionSequence: 1, expiresAt: now + 300_000, bootScope, clientSessionId: id(8), deviceSessionId: id(9),
  connect: { workspaceId: id(2), generation: 7, engineInstanceId: id(3), runtimeBinding: { authorityEpoch: 3, bootScope }, capabilities,
    routes: [{ kind: "direct", url: "wss://fixture-node-47891.on.boat.dev/ws", priority: 0 }], renewAt: new Date(now + 180_000).toISOString(), relayHedgeMs: 400 } };
const fields = { aud: "zeros:engine", wsp: target.workspaceId, jti: "a".repeat(22), nonce: "b".repeat(22), timestampMs: now, route: "direct" as const };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { state.epoch = 1; vi.clearAllMocks(); });

describe("renderer native SDK boundary", () => {
  it("reduces a parsed cloud navigation key to the closed native target before admission", async () => {
    state.invoke.mockImplementationOnce(async (_command, input) => { CloudSdkTargetSchema.parse(input); return runtime; });
    const parsed = parseCloudWorkspaceKey(`cloud://${target.organizationId}/${target.workspaceId}/src/index.ts`)!;
    expect(await openCloudSdkWorkspaceRuntime(parsed)).toEqual(runtime);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_open", target);
  });

  it("opens explicit cloud targets and keeps capabilities out of every return identity", async () => {
    state.invoke.mockResolvedValue(runtime);
    expect(await openCloudSdkWorkspaceRuntime(target)).toEqual(runtime);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_open", target);
    await refreshCloudSdkWorkspaceRuntime(runtime);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_refresh", cloudSdkRuntimeIdentity(runtime));
    state.invoke.mockResolvedValue(capabilities); await renewCloudSdkRuntimeCapabilities(runtime);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_capabilities", cloudSdkRuntimeIdentity(runtime));
    state.invoke.mockResolvedValue("s".repeat(86)); await signCloudSdkRuntimeProof(runtime, fields);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_proof", { runtime: cloudSdkRuntimeIdentity(runtime), fields });
    expect(JSON.stringify(state.invoke.mock.calls)).not.toContain("synthetic-engine-capability");
  });
  it("closes a native admission delivered after the source account changed", async () => {
    const gate = deferred<unknown>(); state.invoke.mockReturnValueOnce(gate.promise);
    const opening = openCloudSdkWorkspaceRuntime(target), refused = expect(opening).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    state.epoch++; gate.resolve(runtime); await refused;
    expect(state.close).toHaveBeenCalledExactlyOnceWith(runtime.runtimeId);
  });
  it.each(["proof", "renewal"])("rejects a late %s result from another account incarnation", async kind => {
    const gate = deferred<unknown>(); state.invoke.mockReturnValueOnce(gate.promise);
    const pending = kind === "proof" ? signCloudSdkRuntimeProof(runtime, fields) : renewCloudSdkRuntimeCapabilities(runtime);
    const refused = expect(pending).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    state.epoch++; gate.resolve(kind === "proof" ? "s".repeat(86) : capabilities); await refused;
  });
  it("preserves the exact legacy descriptor returned by native fallback", async () => {
    const legacy = { kind: "cloud", channel: "control-plane-websocket", ...target, runtimeId: id(10), generation: 7,
      authorityEpoch: 3, engineInstanceId: id(3), connectionSequence: 1, expiresAt: now + 120_000,
      bootScope, url: "wss://api.example.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"g".repeat(43)}` };
    state.invoke.mockResolvedValueOnce(legacy);
    expect(await fallbackCloudSdkWorkspaceRuntime(runtime)).toEqual(legacy);
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_runtime_legacy", cloudSdkRuntimeIdentity(runtime));
  });
});
