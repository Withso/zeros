import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const api = vi.hoisted(() => ({ enabled: true, read: vi.fn(), wake: vi.fn(), list: vi.fn() }));
vi.mock("../../features/settings/internal-features", () => ({ isInternalFeatureActive: () => api.enabled }));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(),
  getCloudWorkspaceDocument: api.read,
  changeCloudWorkspaceLifecycle: api.wake,
  listCloudWorkspaceDocuments: api.list,
}));
import { wakeCloudWorkspace } from "../cloud-workspace-wake";
import {
  acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, cloudWorkspaceDocument,
  refreshCloudWorkspaceCatalog,
} from "../cloud-workspace-catalog";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
function doc(version: number, status = "stopped"): CloudWorkspaceDocument {
  return {
    id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
    createdBy: target.organizationId, name: "Wake fixture", placement: "cloud", status, version,
    createdAt: "2026-09-26T00:00:00Z", updatedAt: `2026-09-26T00:00:0${version}Z`, deletedAt: null, error: null,
    // Prompters can run but do not manage, edit, or create compute independently.
    capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 7, architecture: "x86_64", observedState: "stopped", lastObservedAt: null,
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); api.enabled = true;
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc(1));
  api.wake.mockResolvedValue(doc(2, "waking"));
  api.read.mockResolvedValue(doc(3, "ready"));
});
afterEach(() => { clearCloudWorkspaceCatalog(); vi.useRealTimers(); });

describe("explicit cloud wake readiness", () => {
  it("preserves an interaction wake reason when send preparation joins the same lifecycle intent", async () => {
    const automatic = wakeCloudWorkspace(target, doc(1), undefined, "interaction");
    const sending = wakeCloudWorkspace(target, doc(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([automatic, sending]);
    expect(api.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", expect.any(String), "interaction");
  });
  it("shares the lifecycle intent for open and send, retains history ownership, and admits the same generation", async () => {
    const first = wakeCloudWorkspace(target, doc(1));
    const second = wakeCloudWorkspace(target, doc(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const [opened, sending] = await Promise.all([first, second]);
    expect(api.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", expect.any(String));
    expect(api.read).toHaveBeenCalledOnce();
    expect(opened).toBe(sending);
    expect(opened.generation.number).toBe(7);
    expect(opened.capabilities.canManage).toBe(false);
  });

  it("joins an already waking workspace without creating another lifecycle operation", async () => {
    acceptCloudWorkspaceDocument(doc(2, "waking"));
    const pending = wakeCloudWorkspace(target, doc(2, "waking"));
    await vi.advanceTimersByTimeAsync(1_000); await pending;
    expect(api.wake).not.toHaveBeenCalled();
  });

  it.each(["viewer", "gate", "archived", "failed"])("does not start compute for %s", async reason => {
    const initial = doc(2, ["archived", "failed"].includes(reason) ? reason : "stopped");
    if (reason === "viewer") initial.capabilities.canWrite = false;
    if (reason === "gate") api.enabled = false;
    acceptCloudWorkspaceDocument(initial);
    await expect(wakeCloudWorkspace(target, initial)).rejects.toThrow();
    expect(api.wake).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
  });

  it.each(["cancel", "account", "removed", "generation", "run access"])("fences a pending wake when %s changes", async reason => {
    let finish!: (value: CloudWorkspaceDocument) => void;
    api.wake.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = wakeCloudWorkspace(target, doc(1), controller.signal);
    const rejected = expect(pending).rejects.toThrow(/cancel|account|changed|access/i);
    if (reason === "cancel") controller.abort();
    if (reason === "account") clearCloudWorkspaceCatalog();
    if (reason === "removed") { api.list.mockResolvedValue([]); await refreshCloudWorkspaceCatalog(); }
    if (reason === "generation") acceptCloudWorkspaceDocument({ ...doc(3), generation: { ...doc(3).generation, number: 8 } });
    if (reason === "run access") acceptCloudWorkspaceDocument({ ...doc(3), capabilities: { ...doc(3).capabilities, canWrite: false } });
    await rejected;
    finish(doc(2, "waking")); await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).not.toHaveBeenCalled();
    if (["account", "removed"].includes(reason)) expect(cloudWorkspaceDocument(target)).toBeUndefined();
  });

  it("waits through final capture before waking once, and lets a later Stop win", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopping"));
    api.read.mockResolvedValueOnce(doc(2, "stopped")).mockResolvedValueOnce(doc(4, "stopping"));
    api.wake.mockResolvedValue(doc(3, "waking"));
    const pending = wakeCloudWorkspace(target, doc(1, "stopping"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "CloudWorkspaceWakeEndedError", message: expect.stringContaining("stopping") });
    expect(api.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); await rejected;
    expect(api.wake).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).toHaveBeenCalledTimes(2);
  });

  it("bounds readiness polling and does not retry a failed lifecycle mutation", async () => {
    api.wake.mockRejectedValueOnce(new Error("Sponsor is not eligible"));
    await expect(wakeCloudWorkspace(target, doc(1))).rejects.toThrow(/Sponsor/);
    expect(api.read).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(doc(2, "waking"));
    api.read.mockResolvedValue(doc(2, "waking"));
    const pending = wakeCloudWorkspace(target, doc(2, "waking"));
    const rejected = expect(pending).rejects.toThrow(/still starting/);
    await vi.advanceTimersByTimeAsync(120_000); await rejected;
    const reads = api.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).toHaveBeenCalledTimes(reads);
    expect(api.wake).toHaveBeenCalledOnce();
  });
});
