import { beforeEach, describe, expect, it, vi } from "vitest";
const broker = vi.hoisted(() => ({ openSdkRuntime: vi.fn(), refreshSdkRuntime: vi.fn(), fallbackSdkRuntime: vi.fn(),
  signSdkRuntimeProof: vi.fn(), renewSdkRuntimeCapabilities: vi.fn() }));
vi.mock("../cloud-workspace-access-runtime", () => ({ getCloudWorkspaceAccessBroker: () => broker }));
import { cloudWorkspaceSdkRuntimeOpen, cloudWorkspaceSdkRuntimeRefresh, cloudWorkspaceSdkRuntimeLegacy,
  cloudWorkspaceSdkRuntimeProof, cloudWorkspaceSdkRuntimeCapabilities } from "../ipc/commands/cloud-sdk-runtime";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const identity = { ...target, runtimeId: "33333333-3333-4333-8333-333333333333", generation: 2, authorityEpoch: 3,
  engineInstanceId: "44444444-4444-4444-8444-444444444444", connectionSequence: 1 };
const fields = { aud: "zeros:engine", wsp: target.workspaceId, jti: "a".repeat(22), nonce: "b".repeat(22), timestampMs: 1_800_000_000_000, route: "direct" };
const event = {} as Parameters<typeof cloudWorkspaceSdkRuntimeOpen>[1];
beforeEach(() => vi.resetAllMocks());
describe("closed native SDK IPC", () => {
  it("passes only a target or a complete native identity to the broker", async () => {
    await cloudWorkspaceSdkRuntimeOpen(target, event); expect(broker.openSdkRuntime).toHaveBeenCalledWith(target);
    await cloudWorkspaceSdkRuntimeRefresh(identity, event); expect(broker.refreshSdkRuntime).toHaveBeenCalledWith(identity);
    await cloudWorkspaceSdkRuntimeLegacy(identity, event); expect(broker.fallbackSdkRuntime).toHaveBeenCalledWith(identity);
    await cloudWorkspaceSdkRuntimeCapabilities(identity, event); expect(broker.renewSdkRuntimeCapabilities).toHaveBeenCalledWith(identity);
    await cloudWorkspaceSdkRuntimeProof({ runtime: identity, fields }, event);
    expect(broker.signSdkRuntimeProof).toHaveBeenCalledWith({ runtime: identity, fields });
  });
  it.each([
    { runtime: identity, fields: { ...fields, nonce: "arbitrary bytes" } },
    { runtime: identity, fields: { ...fields, aud: "zeros:api" } },
    { runtime: identity, fields: { ...fields, route: "shell" } },
    { runtime: identity, fields: { ...fields, aud: "zeros:realtime", route: "direct" } },
    { runtime: identity, fields, capability: "untrusted-token" },
    { runtime: { ...identity, cloudToken: "untrusted-token" }, fields },
    { runtime: { ...identity, connectionSequence: 0 }, fields },
  ])("rejects unsupported signing input before invoking the authority", async input => {
    expect(await cloudWorkspaceSdkRuntimeProof(input, event)).toEqual({ type: "cloud_runtime_access_error", code: "invalid_input", status: 422 });
    expect(broker.signSdkRuntimeProof).not.toHaveBeenCalled();
  });
  it("rejects a renderer URL or request action instead of exposing a generic cloud proxy", async () => {
    expect(await cloudWorkspaceSdkRuntimeOpen({ ...target, url: "https://foreign.example.test" }, event)).toMatchObject({ code: "invalid_input" });
    expect(await cloudWorkspaceSdkRuntimeCapabilities({ ...identity, action: "other" }, event)).toMatchObject({ code: "invalid_input" });
    expect(broker.openSdkRuntime).not.toHaveBeenCalled(); expect(broker.renewSdkRuntimeCapabilities).not.toHaveBeenCalled();
  });
  it("returns only closed error codes, never upstream prose or tokens", async () => {
    broker.openSdkRuntime.mockRejectedValue({ code: "forbidden", status: 403, message: "private upstream response", token: "private token" });
    expect(await cloudWorkspaceSdkRuntimeOpen(target, event)).toEqual({ type: "cloud_runtime_access_error", code: "forbidden", status: 403 });
  });
});
