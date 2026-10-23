import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { ControlPlaneError } from "../../features/team/control-plane";

const api = vi.hoisted(() => ({ enabled: true, signedIn: true, entitled: true, read: vi.fn(), wake: vi.fn(), list: vi.fn(), rollout: false }));
vi.mock("../cloud-workspace-stream-rollout", () => ({ cloudCatalogStreamRolloutEnabled: () => api.rollout }));
vi.mock("../../features/settings/internal-features", () => ({ isInternalFeatureActive: () => api.enabled }));
vi.mock("../../features/team/team-store", async original => ({
  ...await original<typeof import("../../features/team/team-store")>(),
  getTeamStoreState: () => ({ me: api.signedIn ? {
    user: { id: "nonstaff-member", staffRole: null },
    organizations: [{ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, workspaceCapabilities: { cloud: api.entitled } }],
    teams: [],
  } : null }),
  useTeams: () => ({ me: api.signedIn ? {
    user: { id: "nonstaff-member", staffRole: null },
    organizations: [{ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, workspaceCapabilities: { cloud: api.entitled } }],
    teams: [],
  } : null }),
}));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(),
  getCloudWorkspaceDocument: api.read,
  changeCloudWorkspaceLifecycle: api.wake,
  listCloudWorkspaceDocuments: api.list,
}));
import { wakeCloudWorkspace } from "../cloud-workspace-wake";
import {
  acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, cloudWorkspaceDocument,
  refreshCloudWorkspaceCatalog, manageCloudWorkspace,
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
  vi.useFakeTimers(); vi.clearAllMocks(); api.enabled = true; api.signedIn = true; api.entitled = true;
  api.rollout = false;
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc(1));
  api.wake.mockResolvedValue(doc(2, "waking"));
  api.read.mockResolvedValue(doc(3, "ready"));
});
afterEach(() => { clearCloudWorkspaceCatalog(); vi.useRealTimers(); });

describe("explicit cloud wake readiness", () => {

  it.each(["ready", "busy"])("prepares an already-%s workspace without creating wake intents", async status => {
    acceptCloudWorkspaceDocument(doc(1, status));
    api.wake.mockResolvedValue(doc(2, status));
    for (let navigation = 0; navigation < 3; navigation++) {
      await expect(wakeCloudWorkspace(target, cloudWorkspaceDocument(target)!, undefined, undefined,
        { id: crypto.randomUUID() })).resolves.toMatchObject({ status });
    }
    expect(api.wake).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a settled ready preparation into a wake after another device stops it", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1, "ready"), undefined, undefined, intent);
    acceptCloudWorkspaceDocument(doc(2, "stopped"));
    await expect(wakeCloudWorkspace(target, doc(2, "stopped"), undefined, undefined, intent))
      .rejects.toMatchObject({ name: "CloudWorkspaceWakeEndedError" });
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("keeps an uncertain request's ID and reason after catalog progress settles the operation slot", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce(doc(3, "ready"));
    const intent = { id: crypto.randomUUID() };
    await expect(wakeCloudWorkspace(target, doc(1), undefined, "interaction", intent)).rejects.toThrow("Response lost");
    acceptCloudWorkspaceDocument(doc(2));
    await wakeCloudWorkspace(target, doc(2), undefined, undefined, intent);
    expect(api.wake.mock.calls).toEqual([
      [target, "wake", intent.id, "interaction"], [target, "wake", intent.id, "interaction"],
    ]);
  });

  it("retains a definitive refusal until a fresh explicit intent requests a stopped start", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockRejectedValueOnce(new ControlPlaneError(409, "quota_exceeded", "No capacity")).mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() }, retry = { id: crypto.randomUUID() };
    await expect(wakeCloudWorkspace(target, doc(1), undefined, undefined, intent)).rejects.toThrow("No capacity");
    await expect(wakeCloudWorkspace(target, doc(1), undefined, undefined, intent)).rejects.toThrow("No capacity");
    expect(api.wake).toHaveBeenCalledOnce();
    await wakeCloudWorkspace(target, doc(1), undefined, undefined, retry);
    expect(api.wake).toHaveBeenLastCalledWith(target, "wake", retry.id);
  });
  it("does not bypass a definitive refusal by joining another actor's setup", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockRejectedValueOnce(new ControlPlaneError(403, "run_access_denied", "Run denied"));
    const intent = { id: crypto.randomUUID() };
    await expect(wakeCloudWorkspace(target, doc(1), undefined, undefined, intent)).rejects.toThrow("Run denied");
    acceptCloudWorkspaceDocument(doc(2, "setting_up"));
    const outcome = wakeCloudWorkspace(target, doc(2, "setting_up"), undefined, undefined, intent)
      .then(() => "opened", error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(0);
    acceptCloudWorkspaceDocument(doc(3, "ready"));
    expect(await outcome).toBe("Run denied");
    expect(api.wake).toHaveBeenCalledOnce();
  });

  it("retires a confirmed intent when a deleted owner becomes readable again", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1, "ready"), undefined, undefined, intent);
    acceptCloudWorkspaceDocument(doc(3, "deleted"));
    acceptCloudWorkspaceDocument(doc(4, "ready"));
    await expect(wakeCloudWorkspace(target, doc(4, "ready"), undefined, undefined, intent)).rejects.toThrow(/owner|changed/i);
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("retires a confirmed intent on catalog omission even if the same key is later re-added", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1, "ready"), undefined, undefined, intent);
    api.list.mockResolvedValue([]); await refreshCloudWorkspaceCatalog();
    acceptCloudWorkspaceDocument(doc(3, "ready"));
    await expect(wakeCloudWorkspace(target, doc(3, "ready"), undefined, undefined, intent)).rejects.toThrow(/owner|changed/i);
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("resumes a cancelled waiter through the same replacement drain without another wake", async () => {
    const replacement = { ...doc(2, "stopping"), generation: { ...doc(2).generation, number: 8 } };
    api.wake.mockResolvedValue(replacement);
    const intent = { id: crypto.randomUUID() }, controller = new AbortController();
    const first = wakeCloudWorkspace(target, doc(1), controller.signal, undefined, intent);
    const cancelled = expect(first).rejects.toThrow(/cancel/i);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await cancelled;
    const resumed = wakeCloudWorkspace(target, replacement, undefined, undefined, intent);
    const ready = expect(resumed).resolves.toMatchObject({ status: "ready", generation: { number: 8 } });
    void ready.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    acceptCloudWorkspaceDocument({ ...doc(3, "ready"), generation: replacement.generation });
    await ready;
    expect(api.wake).toHaveBeenCalledOnce();
  });

  it("does not submit a second wake after this intent joined existing setup progress", async () => {
    acceptCloudWorkspaceDocument(doc(2, "setting_up"));
    const intent = { id: crypto.randomUUID() };
    const pending = wakeCloudWorkspace(target, doc(2, "setting_up"), undefined, undefined, intent);
    await vi.advanceTimersByTimeAsync(0);
    acceptCloudWorkspaceDocument(doc(3, "ready")); await pending;
    await wakeCloudWorkspace(target, doc(3, "ready"), undefined, undefined, intent);
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("does not extend the fifteen-minute lifetime when the same intent is retried", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready")); api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1, "ready"), undefined, undefined, intent);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await expect(wakeCloudWorkspace(target, doc(2, "ready"), undefined, undefined, intent)).rejects.toMatchObject({
      name: "CloudWorkspaceWakeEndedError", reason: "queued_timeout", message: expect.stringContaining("fifteen minutes"),
    });
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("isolates cancellation while two preparations share one pending intent", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let finish!: (value: CloudWorkspaceDocument) => void;
    api.wake.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const intent = { id: crypto.randomUUID() }, controller = new AbortController();
    const first = wakeCloudWorkspace(target, doc(1), controller.signal, undefined, intent);
    const cancelled = expect(first).rejects.toThrow(/cancel/i);
    const second = wakeCloudWorkspace(target, doc(1), undefined, undefined, intent);
    controller.abort(); await cancelled;
    finish(doc(2, "ready")); await second;
    expect(api.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", intent.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 425, 429, 503])("retries a transient %s response with the same ID and reason", async status => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockRejectedValueOnce(new ControlPlaneError(status, "temporarily_unavailable", "Try later"))
      .mockResolvedValueOnce(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await expect(wakeCloudWorkspace(target, doc(1), undefined, "interaction", intent)).rejects.toThrow("Try later");
    await wakeCloudWorkspace(target, doc(1), undefined, undefined, intent);
    expect(api.wake.mock.calls).toEqual([
      [target, "wake", intent.id, "interaction"], [target, "wake", intent.id, "interaction"],
    ]);
  });

  it("submits one wake for seven settled readiness attempts belonging to one send intent", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    for (let attempt = 0; attempt < 7; attempt++) {
      await wakeCloudWorkspace(target, cloudWorkspaceDocument(target)!, undefined, undefined, intent);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(api.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", intent.id);
    expect(api.read).not.toHaveBeenCalled();
  });

  it("does not reuse a settled intent after a later explicit Stop", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1), undefined, undefined, intent);
    api.wake.mockResolvedValue(doc(3, "stopped"));
    await manageCloudWorkspace(target, "stop");
    api.wake.mockResolvedValue(doc(4, "ready"));
    await expect(wakeCloudWorkspace(target, doc(3, "stopped"), undefined, undefined, intent))
      .rejects.toMatchObject({ name: "CloudWorkspaceWakeEndedError" });
    expect(api.wake).toHaveBeenCalledTimes(2);
  });

  it("does not carry a settled intent into a replacement account", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    api.wake.mockResolvedValue(doc(2, "ready"));
    const intent = { id: crypto.randomUUID() };
    await wakeCloudWorkspace(target, doc(1, "ready"), undefined, undefined, intent);
    clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc(3, "ready"));
    api.wake.mockResolvedValue(doc(4, "ready"));
    await expect(wakeCloudWorkspace(target, doc(3, "ready"), undefined, undefined, intent)).rejects.toThrow(/account|owner/i);
    expect(api.wake).not.toHaveBeenCalled();
  });

  it("wakes for a nonstaff member without enabling the retired preference", async () => {
    api.enabled = false;
    const pending = wakeCloudWorkspace(target, doc(1));
    await Promise.all([expect(pending).resolves.toMatchObject({ status: "ready" }), vi.advanceTimersByTimeAsync(2_000)]);
    expect(api.wake).toHaveBeenCalledOnce();
  });
  it("settles catalog readiness immediately without a fallback poll", async () => {
    acceptCloudWorkspaceDocument(doc(2, "waking"));
    let result: CloudWorkspaceDocument | undefined;
    const failed = vi.fn();
    const pending = wakeCloudWorkspace(target, doc(2, "waking")).then(value => { result = value; }, failed);
    await vi.advanceTimersByTimeAsync(25);
    const ready = doc(3, "ready");
    acceptCloudWorkspaceDocument(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(ready);
    expect(result).toBe(cloudWorkspaceDocument(target));
    await pending;
    expect(api.read).not.toHaveBeenCalled();
    expect(api.wake).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles catalog readiness while the fallback refresh is hung", async () => {
    acceptCloudWorkspaceDocument(doc(2, "waking"));
    api.read.mockReturnValue(new Promise(() => {}));
    let result: CloudWorkspaceDocument | undefined;
    const failed = vi.fn();
    const pending = wakeCloudWorkspace(target, doc(2, "waking")).then(value => { result = value; }, failed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.read).toHaveBeenCalledOnce();
    const ready = doc(3, "ready");
    acceptCloudWorkspaceDocument(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(ready);
    expect(result).toBe(cloudWorkspaceDocument(target));
    await pending;
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows catalog stop completion immediately and ignores another workspace's readiness", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopping"));
    let result: CloudWorkspaceDocument | undefined;
    const failed = vi.fn();
    const pending = wakeCloudWorkspace(target, doc(1, "stopping")).then(value => { result = value; }, failed);
    await vi.advanceTimersByTimeAsync(25);
    acceptCloudWorkspaceDocument({ ...doc(2, "ready"), id: "33333333-3333-4333-8333-333333333333" });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    expect(api.wake).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(doc(2, "stopped"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.wake).toHaveBeenCalledOnce();
    acceptCloudWorkspaceDocument(doc(3, "ready"));
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.status).toBe("ready");
    await pending;
    expect(api.read).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("preserves an interaction wake reason when send preparation joins the same lifecycle intent", async () => {
    const automatic = wakeCloudWorkspace(target, doc(1), undefined, "interaction");
    const sending = wakeCloudWorkspace(target, doc(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([automatic, sending]);
    expect(api.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", expect.any(String), "interaction");
  });
  it("shares the lifecycle intent for open and send, retains history ownership, and admits the same generation", async () => {
    const first = wakeCloudWorkspace(target, doc(1));
    const second = wakeCloudWorkspace(target, doc(1));
    await vi.advanceTimersByTimeAsync(2_000);
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
    await vi.advanceTimersByTimeAsync(2_000); await pending;
    expect(api.wake).not.toHaveBeenCalled();
  });

  it.each(["viewer", "signed-out", "no-entitlement", "archived", "failed"])("does not start compute for %s", async reason => {
    const initial = doc(2, ["archived", "failed"].includes(reason) ? reason : "stopped");
    if (reason === "viewer") initial.capabilities.canWrite = false;
    if (reason === "signed-out") api.signedIn = false;
    if (reason === "no-entitlement") api.entitled = false;
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
    if (reason === "generation") acceptCloudWorkspaceDocument({ ...doc(3), generation: { ...doc(3).generation, number: 6 } });
    if (reason === "run access") acceptCloudWorkspaceDocument({ ...doc(3), capabilities: { ...doc(3).capabilities, canWrite: false } });
    await rejected;
    finish(doc(2, "waking")); await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).not.toHaveBeenCalled();
    if (["account", "removed"].includes(reason)) expect(cloudWorkspaceDocument(target)).toBeUndefined();
  });

  it("follows replacement drain, provisioning and setup for the same wake without another mutation", async () => {
    const replacement = (version: number, status: string) => ({ ...doc(version, status), generation: { ...doc(version).generation, number: 8 } });
    api.wake.mockResolvedValue(replacement(2, "stopping"));
    api.read.mockResolvedValueOnce(replacement(3, "provisioning")).mockResolvedValueOnce(replacement(4, "setting_up")).mockResolvedValue(replacement(5, "ready"));
    const opened = wakeCloudWorkspace(target, doc(1), undefined, "interaction");
    const sending = wakeCloudWorkspace(target, doc(1));
    const completed = Promise.all([opened, sending]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await completed).map(value => value.generation.number)).toEqual([8, 8]);
    expect(api.wake).toHaveBeenCalledOnce();
  });

  it("follows a failed replacement back to the source generation for shared navigation and send wakes", async () => {
    const candidate = (version: number, status: string) => ({ ...doc(version, status), generation: { ...doc(version).generation, number: 8 } });
    api.wake.mockResolvedValue(candidate(2, "provisioning"));
    api.read.mockResolvedValueOnce(candidate(3, "setting_up")).mockResolvedValueOnce(doc(4, "waking")).mockResolvedValue(doc(5, "ready"));
    const failed = vi.fn();
    const completed = Promise.all([wakeCloudWorkspace(target, doc(1), undefined, "interaction"), wakeCloudWorkspace(target, doc(1))]).catch(failed);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await completed)?.map((value: CloudWorkspaceDocument) => value.generation.number)).toEqual([7, 7]);
    expect(failed).not.toHaveBeenCalled(); expect(api.wake).toHaveBeenCalledOnce();
  });

  it("waits through final capture before waking once, and lets a later Stop win", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopping"));
    api.read.mockResolvedValueOnce(doc(2, "stopped")).mockResolvedValueOnce(doc(4, "stopping"));
    api.wake.mockResolvedValue(doc(3, "waking"));
    const pending = wakeCloudWorkspace(target, doc(1, "stopping"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "CloudWorkspaceWakeEndedError", message: expect.stringContaining("stopping") });
    expect(api.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000); await rejected;
    expect(api.wake).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).toHaveBeenCalledTimes(2);
  });
  it("ends an older wake as soon as Stop is requested, before its HTTP response", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let finishWake!: (value: CloudWorkspaceDocument) => void, finishStop!: (value: CloudWorkspaceDocument) => void;
    api.wake.mockImplementation((_target, operation) => new Promise(resolve => {
      if (operation === "stop") finishStop = resolve; else finishWake = resolve;
    }));
    const pending = wakeCloudWorkspace(target, doc(1));
    const ended = expect(pending).rejects.toMatchObject({ name: "CloudWorkspaceWakeEndedError", message: expect.stringContaining("stopped") });
    const stopping = manageCloudWorkspace(target, "stop");
    finishWake(doc(2, "ready")); await ended;
    finishStop(doc(3, "stopped")); await stopping;
    expect(api.read).not.toHaveBeenCalled();
  });

  it("bounds readiness polling and does not retry a failed lifecycle mutation", async () => {
    api.wake.mockRejectedValueOnce(new Error("Sponsor is not eligible"));
    await expect(wakeCloudWorkspace(target, doc(1))).rejects.toThrow(/Sponsor/);
    expect(api.read).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(doc(2, "waking"));
    api.read.mockResolvedValue(doc(2, "waking"));
    const pending = wakeCloudWorkspace(target, doc(2, "waking"));
    const rejected = expect(pending).rejects.toThrow(/still starting/);
    await vi.advanceTimersByTimeAsync(15 * 60_000); await rejected;
    const reads = api.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.read).toHaveBeenCalledTimes(reads);
    expect(api.wake).toHaveBeenCalledOnce();
  });
  it.each([150_000, 360_000])("keeps lifecycle progress calm for %i ms before replacement readiness", async duration => {
    const replacement = (version: number, status: string) => ({ ...doc(version, status), generation: { ...doc(version).generation, number: 8 } });
    api.wake.mockResolvedValue(replacement(2, "provisioning")); api.read.mockImplementation(async () => cloudWorkspaceDocument(target)!);
    let result: CloudWorkspaceDocument | undefined; const failed = vi.fn();
    const pending = wakeCloudWorkspace(target, doc(1)).then(value => { result = value; }, failed);
    await vi.advanceTimersByTimeAsync(duration / 2);
    acceptCloudWorkspaceDocument(replacement(3, "setting_up"));
    await vi.advanceTimersByTimeAsync(duration / 2);
    expect(result).toBeUndefined(); expect(failed).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(replacement(4, "ready")); await vi.advanceTimersByTimeAsync(1_000); await pending;
    expect(result?.generation.number).toBe(8); expect(api.wake).toHaveBeenCalledOnce();
  });
  it("ends a hung lifecycle immediately on a document error and caps missing progress at fifteen minutes", async () => {
    api.wake.mockReturnValue(new Promise(() => {}));
    const pending = wakeCloudWorkspace(target, doc(1));
    const ended = expect(pending).rejects.toThrow("Setup failed");
    acceptCloudWorkspaceDocument({ ...doc(2, "setting_up"), error: { code: "setup_failed", message: "Setup failed" } });
    await ended;
    acceptCloudWorkspaceDocument(doc(3, "waking"));
    api.read.mockReturnValue(new Promise(() => {}));
    const hung = wakeCloudWorkspace(target, doc(3, "waking"));
    const capped = expect(hung).rejects.toThrow(/still starting/);
    await vi.advanceTimersByTimeAsync(15 * 60_000); await capped;
  });
});
