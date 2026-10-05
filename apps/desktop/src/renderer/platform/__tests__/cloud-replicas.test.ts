import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch: 0,
  bridge: {} as object | null, rpc: vi.fn(), picker: vi.fn() }));
vi.mock("../bridge/active-bridge", () => ({ getActiveBridge: () => state.bridge }));
vi.mock("../bridge/workspace-bridge", () => ({ workspaceOp: state.rpc }));
vi.mock("../git", () => ({ dialogPickFolder: state.picker }));
vi.mock("../../features/team/team-store", () => ({
  getTeamStoreState: () => ({ me: state.account ? { user: { id: state.account } } : null }),
  getOrganizationStoreGeneration: () => state.epoch,
}));
import { readCloudReplicaIdentity, listCloudReplicas, createCloudReplica, changeCloudReplica, pickCloudReplicaFolder } from "../cloud-replicas";

const scope = { accountUserId: state.account, accountEpoch: 0,
  deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const replica = { ...scope, replicaId: "33333333-3333-4333-8333-333333333333", rootPath: "/Users/test/copy",
  desiredState: "active", observedState: "in_sync", eventCursor: 7, manifestRevision: 3,
  ignorePolicy: { version: 1, excludePrefixes: [] }, lastErrorCode: null };
beforeEach(() => { state.account = scope.accountUserId; state.epoch = 0; state.bridge = { executionIdentity: { kind: "local" } }; vi.clearAllMocks(); });

describe("Mac replica platform boundary", () => {
  it("refuses a remote-only bridge instead of offering a Mac folder to its engine", async () => {
    state.bridge = { executionIdentity: { kind: "cloud" } };
    await expect(listCloudReplicas(scope)).rejects.toThrow(/local engine/);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("reads public device identity locally before a replica exists", async () => {
    state.rpc.mockResolvedValue({ accountUserId: scope.accountUserId, deviceId: scope.deviceId, privateKey: "must-not-cross" });
    expect(await readCloudReplicaIdentity(scope)).toEqual({ accountUserId: scope.accountUserId, deviceId: scope.deviceId });
    expect(state.rpc).toHaveBeenCalledWith(state.bridge, "cloudReplica.identity", { accountUserId: scope.accountUserId }, expect.any(Number));
  });
  it("lists only the selected workspace while retaining independent replicas on this device", async () => {
    state.rpc.mockResolvedValue([replica, { ...replica, workspaceId: scope.organizationId }, { ...replica, desiredState: "removed", observedState: "removed" }]);
    expect(await listCloudReplicas(scope)).toHaveLength(1);
    expect(state.rpc).toHaveBeenCalledWith(state.bridge, "cloudReplica.list", expect.objectContaining({
      accountUserId: scope.accountUserId, deviceId: scope.deviceId, organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    }), expect.any(Number));
  });
  it.each(["accountUserId", "deviceId"])("rejects a response from another %s", async field => {
    state.rpc.mockResolvedValue([{ ...replica, [field]: scope.organizationId }]);
    await expect(listCloudReplicas(scope)).rejects.toThrow(/identity/);
  });
  it("rejects a delayed read after account replacement or a local bridge restart", async () => {
    state.rpc.mockImplementationOnce(async () => { state.epoch++; return [replica]; });
    await expect(listCloudReplicas(scope)).rejects.toThrow(/account/);
    state.epoch = 0;
    state.rpc.mockImplementationOnce(async () => { state.bridge = {}; return [replica]; });
    await expect(listCloudReplicas(scope)).rejects.toThrow(/connection/);
  });
  it("does not dispatch an obsolete account's create or folder selection", async () => {
    state.account = scope.organizationId;
    await expect(createCloudReplica(scope, "/Users/test/copy", "test-create-operation")).rejects.toThrow(/account/);
    await expect(pickCloudReplicaFolder(scope)).rejects.toThrow(/account/);
    expect(state.rpc).not.toHaveBeenCalled(); expect(state.picker).not.toHaveBeenCalled();
  });
  it("rejects a folder selected after sign-out and treats cancellation as no destination", async () => {
    state.picker.mockImplementationOnce(async () => { state.epoch++; return "/Users/test/copy"; });
    await expect(pickCloudReplicaFolder(scope)).rejects.toThrow(/account/);
    state.epoch = 0; state.picker.mockResolvedValue(null);
    expect(await pickCloudReplicaFolder(scope)).toBeNull();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("creates with the cloud UUID as a Local RPC parameter and a stable operation key", async () => {
    state.rpc.mockResolvedValue(replica);
    await createCloudReplica(scope, "/Users/test/copy", "test-create-operation");
    expect(state.rpc).toHaveBeenCalledWith(state.bridge, "cloudReplica.create", {
      accountUserId: scope.accountUserId, deviceId: scope.deviceId,
      organizationId: scope.organizationId, workspaceId: scope.workspaceId,
      rootPath: "/Users/test/copy", pathLabel: "copy", idempotencyKey: "test-create-operation",
    }, expect.any(Number));
  });
  it("sends cloud replacement only on explicit resume and never includes local content", async () => {
    state.rpc.mockResolvedValue(replica);
    await changeCloudReplica(scope, replica.replicaId, "resume", "test-resume-operation");
    expect(state.rpc.mock.calls[0][2]).toMatchObject({ replaceDiverged: false });
    await changeCloudReplica(scope, replica.replicaId, "resume", "test-replace-operation", true);
    expect(state.rpc.mock.calls[1][2]).toEqual({
      accountUserId: scope.accountUserId, deviceId: scope.deviceId, organizationId: scope.organizationId, workspaceId: scope.workspaceId,
      replicaId: replica.replicaId, idempotencyKey: "test-replace-operation", replaceDiverged: true,
    });
  });
});
