import { describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";

const owner = { accountUserId: "account-a", deviceId: "device-a" };
const target = { organizationId: "org-a", workspaceId: "workspace-a" };
function fixture() {
  const row = { ...owner, ...target, replicaId: "replica-a" };
  const runtime = {
    identity: vi.fn(() => owner), list: vi.fn(() => [row]),
    create: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn(), divergences: vi.fn(),
  };
  const state = { cloudReplicaRuntime: runtime };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  return { runtime, engine: state as typeof state & {
    handleCloudReplicaOperation(op: string, params: Record<string, unknown>): unknown;
  } };
}

describe("local replica RPC scope", () => {
  it("preserves the legacy list array and exposes secret-free device metadata separately", () => {
    const { engine, runtime } = fixture();
    expect(engine.handleCloudReplicaOperation("cloudReplica.list", {})).toEqual(runtime.list());
    expect(engine.handleCloudReplicaOperation("cloudReplica.identity", { accountUserId: owner.accountUserId })).toEqual(owner);
  });
  it.each(["list", "create", "pause", "resume", "remove", "divergences"])("rejects a stale account/device before %s", op => {
    const { engine, runtime } = fixture();
    for (const changed of [{ accountUserId: "account-b" }, { deviceId: "device-b" }]) {
      expect(() => engine.handleCloudReplicaOperation(`cloudReplica.${op}`, {
        ...owner, ...target, ...changed, replicaId: "replica-a", rootPath: "/Users/test/copy", idempotencyKey: "test-operation",
      })).toThrow(/identity/);
    }
    expect(runtime[op as "create"]).not.toHaveBeenCalled();
  });
  it.each(["pause", "resume", "remove", "divergences"])("rejects another workspace's replica before %s", op => {
    const { engine, runtime } = fixture();
    expect(() => engine.handleCloudReplicaOperation(`cloudReplica.${op}`, {
      ...owner, ...target, workspaceId: "workspace-b", replicaId: "replica-a", idempotencyKey: "test-operation",
    })).toThrow(/identity/);
    expect(runtime[op as "pause"]).not.toHaveBeenCalled();
  });
});
