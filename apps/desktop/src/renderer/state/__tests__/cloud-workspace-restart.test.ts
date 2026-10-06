import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

const api = vi.hoisted(() => ({ enabled: true, read: vi.fn(), lifecycle: vi.fn(), connect: vi.fn(), failure: vi.fn(), clear: vi.fn() }));
vi.mock("../../features/settings/internal-features", () => ({ isInternalFeatureActive: () => api.enabled }));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(),
  getCloudWorkspaceDocument: api.read,
  changeCloudWorkspaceLifecycle: api.lifecycle,
}));
vi.mock("../workbench-availability", () => ({
  reconnectWorkbenchWorkspace: api.connect, recordWorkbenchConnectionFailure: api.failure, clearWorkbenchConnectionFailure: api.clear,
}));
import { cloudWorkspaceRestartVisible, restartCloudWorkspace } from "../cloud-workspace-restart";
import { cloudWorkspaceRestartPhase, subscribeCloudWorkspaceRestarts } from "../cloud-workspace-restart-status";
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, cloudWorkspaceDocument, cloudWorkspaceStopVersion, manageCloudWorkspace } from "../cloud-workspace-catalog";
import { wakeCloudWorkspace } from "../cloud-workspace-wake";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target);
function doc(version: number, status = "ready"): CloudWorkspaceDocument {
  return {
    ...target, id: target.workspaceId, teamId: target.organizationId, createdBy: target.organizationId,
    name: "Restart fixture", placement: "cloud", status, version, deletedAt: null, error: null,
    createdAt: "2026-09-26T00:00:00Z", updatedAt: new Date(Date.UTC(2026, 8, 26) + version * 1_000).toISOString(),
    capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 7, architecture: "x86_64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); api.enabled = true;
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc(1));
  api.lifecycle.mockImplementation(async (_target, operation) => doc(operation === "stop" ? 2 : 4, operation === "stop" ? "stopping" : "waking"));
  api.read.mockResolvedValueOnce(doc(3, "stopped")).mockResolvedValue(doc(5, "ready"));
  api.connect.mockResolvedValue(undefined);
});
afterEach(() => { clearCloudWorkspaceCatalog(); vi.useRealTimers(); });

describe("manual cloud workspace Restart", () => {
  it("connects the current generation when its accepted wake automatically upgrades the runtime", async () => {
    api.read.mockReset().mockResolvedValueOnce(doc(3, "stopped"))
      .mockResolvedValueOnce({ ...doc(5, "provisioning"), generation: { ...doc(5).generation, number: 8 } })
      .mockResolvedValueOnce({ ...doc(6, "ready"), generation: { ...doc(6).generation, number: 8 } });
    api.connect.mockImplementation(async () => { expect(cloudWorkspaceDocument(target)?.generation.number).toBe(8); });
    const task = restartCloudWorkspace(target);
    const ready = expect(task).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000); await ready;
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop", "wake"]);
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(folder);
    expect(api.failure).not.toHaveBeenCalled();
  });
  it("waits for the final Stop checkpoint, wakes with a fresh operation, then connects the same workspace", async () => {
    const phases: (string | null)[] = [cloudWorkspaceRestartPhase(folder)];
    const off = subscribeCloudWorkspaceRestarts(() => phases.push(cloudWorkspaceRestartPhase(folder)));
    const task = restartCloudWorkspace(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop"]);
    const stopRevision = cloudWorkspaceStopVersion(target);
    expect(stopRevision).toBeGreaterThan(0);
    expect(api.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); await task;
    expect(phases).toEqual([null, "stopping", "stopped", "waking", "connecting", null]);
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop", "wake"]);
    expect(api.lifecycle.mock.calls[0][2]).not.toBe(api.lifecycle.mock.calls[1][2]);
    expect(cloudWorkspaceStopVersion(target)).toBe(stopRevision);
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(folder);
    expect(cloudWorkspaceDocument(target)?.generation.number).toBe(7);
    expect(api.failure).not.toHaveBeenCalled();
    off();
  });

  it.each(["stop", "wake", "connect"])("reports a %s failure once for joined callers, clears busy and never continues past the failure", async operation => {
    if (operation === "connect") api.connect.mockRejectedValue(new Error("Connection failed"));
    else api.lifecycle.mockImplementation(async (_target, op) => {
      if (op === operation) throw new Error(`${op} failed`);
      return doc(2, "stopped");
    });
    const task = restartCloudWorkspace(folder);
    expect(restartCloudWorkspace(folder)).toBe(task);
    const rejected = expect(task).rejects.toThrow(/failed/);
    await vi.advanceTimersByTimeAsync(3_000); await rejected;
    expect(api.failure).toHaveBeenCalledExactlyOnceWith(folder, expect.any(Error), "restart");
    expect(cloudWorkspaceRestartPhase(folder)).toBeNull();
    if (operation === "stop") expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop"]);
    if (operation !== "connect") expect(api.connect).not.toHaveBeenCalled();
  });

  it("joins simultaneous Restart requests and an already in-flight Stop", async () => {
    let finish!: (value: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const stop = manageCloudWorkspace(target, "stop");
    const first = restartCloudWorkspace(folder);
    const joined = restartCloudWorkspace(folder);
    expect(joined).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.lifecycle).toHaveBeenCalledOnce();
    finish(doc(2, "stopping")); await stop;
    await vi.advanceTimersByTimeAsync(2_000); await first;
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop", "wake"]);
    expect(api.connect).toHaveBeenCalledOnce();
  });

  it("joins an already in-flight wake without sending a Stop or another wake", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    api.read.mockReset().mockResolvedValue(doc(5, "ready"));
    const wake = wakeCloudWorkspace(target, doc(1, "stopped"));
    const restart = restartCloudWorkspace(folder);
    await vi.advanceTimersByTimeAsync(1_000); await Promise.all([wake, restart]);
    expect(api.lifecycle).toHaveBeenCalledExactlyOnceWith(target, "wake", expect.any(String));
    expect(api.connect).toHaveBeenCalledOnce();
  });

  it.each(["stopping", "stopped", "waking"])("joins server %s state without repeating its lifecycle mutation", async status => {
    acceptCloudWorkspaceDocument(doc(1, status));
    if (status !== "stopping") api.read.mockReset().mockResolvedValue(doc(5, "ready"));
    const task = restartCloudWorkspace(folder);
    await vi.advanceTimersByTimeAsync(2_000); await task;
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(status === "waking" ? [] : ["wake"]);
    expect(api.connect).toHaveBeenCalledOnce();
  });

  it.each(["no canWrite", "archived", "archiving", "deleting", "deleted", "Local Personal", "Local organization", "flag off"])("does not mutate or connect for %s", async reason => {
    const current = doc(2, ["archived", "archiving", "deleting", "deleted"].includes(reason) ? reason : "ready");
    if (reason === "no canWrite") current.capabilities.canWrite = false;
    if (reason === "flag off") api.enabled = false;
    acceptCloudWorkspaceDocument(current);
    const path = reason.startsWith("Local") ? "/fixture/local" : folder;
    await expect(restartCloudWorkspace(path)).rejects.toThrow();
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.failure).not.toHaveBeenCalled();
    if (reason !== "no canWrite" && reason !== "flag off") expect(cloudWorkspaceRestartVisible(path, current)).toBe(false);
  });

  it.each(["account", "generation", "archived", "canWrite"])("never wakes after %s changes while Stop is pending", async reason => {
    let finish!: (value: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const task = restartCloudWorkspace(folder);
    const rejected = expect(task).rejects.toThrow(/changed/);
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "account") clearCloudWorkspaceCatalog();
    else acceptCloudWorkspaceDocument({ ...doc(3, reason === "archived" ? "archived" : "stopped"),
      ...(reason === "generation" ? { generation: { ...doc(3).generation, number: 8 } } : {}),
      ...(reason === "canWrite" ? { capabilities: { ...doc(3).capabilities, canWrite: false } } : {}) });
    finish(doc(2, "stopped")); await rejected;
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop"]);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("keeps simultaneous owners independent and does not persist a stopped restart intent", async () => {
    const other = { ...target, organizationId: "33333333-3333-4333-8333-333333333333", workspaceId: "44444444-4444-4444-8444-444444444444" };
    acceptCloudWorkspaceDocument({ ...doc(1), id: other.workspaceId, organizationId: other.organizationId });
    let finish!: (value: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const task = restartCloudWorkspace(folder);
    const rejected = expect(task).rejects.toThrow(/account/);
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudWorkspaceRestartPhase(cloudWorkspaceKey(other))).toBeNull();
    expect(cloudWorkspaceRestartPhase("/local")).toBeNull();
    clearCloudWorkspaceCatalog();
    expect(cloudWorkspaceRestartPhase(folder)).toBeNull();
    finish(doc(2, "stopped")); await rejected;
    acceptCloudWorkspaceDocument(doc(3, "stopped"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.lifecycle.mock.calls.map(call => call[1])).toEqual(["stop"]);
  });
});
