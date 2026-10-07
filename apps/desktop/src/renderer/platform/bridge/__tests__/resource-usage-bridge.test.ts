import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient, type CloudPeer } from "../workspace-runtime-client";
import { cloudWorkspaceKey } from "../cloud-workspace-key";
import { cloudIncoming } from "../cloud-runtime-wire";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const engineInstanceId = "33333333-3333-4333-8333-333333333333";
const scope = { ...target, root: "/admitted", engineWorkspaceId: "local-main" };
const identity = { ...target, generation: 7, engineInstanceId, authorityEpoch: 2, admissionId: "runtime-a" };
let client: WorkspaceRuntimeClient;
afterEach(() => { client?.dispose(); vi.restoreAllMocks(); });
function setup() {
  let current = "account:7";
  const engine = { status: "connected", executionIdentity: { kind: "cloud", ...identity },
    supportsEngineCapability: vi.fn(() => true), requestConnected: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resourceUsage", result: { ...target } })),
    request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: { chats: [] } })),
    on: () => () => {}, onStatusChange: () => () => {} };
  const open = vi.fn(async () => ({ client: engine, scope, runtimeId: "runtime-a", generation: 7,
    release: () => {} }) as unknown as CloudPeer);
  client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => current });
  return { open, engine, change: () => { current = "account:8"; } };
}
describe("resource usage passive bridge", () => {
  it("never opens an absent cloud peer or forwards the operation to Local", async () => {
    const f = setup();
    await expect(client.requestCloudResourceUsage(target, identity)).rejects.toThrow(/disconnected/);
    expect(f.open).not.toHaveBeenCalled();
    await expect(client.request({ type: "WORKSPACE_REQUEST", op: "workspace.resourceUsage", params: { workspaceId: "/local" } })).rejects.toThrow(/cloud/);
    expect(f.open).not.toHaveBeenCalled();
  });
  it("dispatches only through the current admitted connected transport and maps the UUID envelope safely", async () => {
    const f = setup(); await client.openWorkspace(target);
    expect(client.cloudResourceUsageConnection(cloudWorkspaceKey(target))).toEqual(identity);
    expect(await client.requestCloudResourceUsage(target, identity)).toMatchObject({ result: target });
    expect(f.engine.requestConnected).toHaveBeenCalledWith(expect.objectContaining({ params: {
      workspaceId: "local-main", generation: 7, engineInstanceId,
    } }), 5000);
    expect(f.open).toHaveBeenCalledOnce();
    expect(cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "workspace.resourceUsage", result: target }).result).toEqual(target);
    expect(() => cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "workspace.resourceUsage", result: { ...target, workspaceId: engineInstanceId } })).toThrow();
  });
  it("old runtimes are unavailable without dispatch; disconnection never reconnects", async () => {
    const f = setup(); await client.openWorkspace(target);
    f.engine.supportsEngineCapability.mockReturnValue(false);
    expect(await client.requestCloudResourceUsage(target, identity)).toBeNull();
    expect(f.engine.requestConnected).not.toHaveBeenCalled();
    f.engine.status = "disconnected";
    await expect(client.requestCloudResourceUsage(target, identity)).rejects.toThrow(/disconnected/);
    expect(f.open).toHaveBeenCalledOnce();
  });
  it("rejects late samples after admission/account/generation or connection changes", async () => {
    const f = setup(); await client.openWorkspace(target);
    let resolve!: (value: object) => void;
    const result = new Promise<object>(yes => { resolve = yes; });
    f.engine.requestConnected.mockReturnValue(result as never);
    const pending = client.requestCloudResourceUsage(target, identity);
    f.change(); resolve({ type: "WORKSPACE_RESPONSE", result: target });
    await expect(pending).rejects.toThrow(/changed/);
    expect(f.open).toHaveBeenCalledOnce();
  });
});
