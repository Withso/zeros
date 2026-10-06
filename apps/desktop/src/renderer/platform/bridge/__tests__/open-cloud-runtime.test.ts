import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: true, epoch: 1, doc: { status: "ready", deletedAt: null, generation: { number: 1 }, capabilities: { canWrite: true } }, wake: vi.fn(), refresh: vi.fn(), admission: vi.fn(), close: vi.fn(async () => true), connect: vi.fn(async () => {}), dispose: vi.fn(), list: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("../../../features/settings/internal-features", () => ({ isInternalFeatureActive: () => mocks.enabled }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => mocks.epoch, cloudWorkspaceDocument: () => mocks.doc, cloudWorkspaceStopVersion: () => 0,
  refreshCloudWorkspace: mocks.refresh, acceptCloudEngineWorkspace: vi.fn(),
  manageCloudWorkspace: mocks.wake,
  canReadCloudWorkspace: (doc: { status: string }) => !["deleted", "deleting"].includes(doc.status),
  subscribeCloudWorkspaces: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); },
}));
vi.mock("../../cloud-workspace-access", () => ({ openCloudWorkspaceRuntime: mocks.admission, closeCloudWorkspaceRuntime: mocks.close, refreshCloudWorkspaceRuntime: vi.fn() }));
vi.mock("../workspace-bridge", () => ({ bridgeWorkspaceList: mocks.list }));
vi.mock("../ws-client", () => ({ RuntimeClient: class { connect = mocks.connect; dispose = mocks.dispose; on = () => () => {}; onStatusChange = () => () => {}; } }));
vi.mock("../cloud-agent-connection", () => ({ CloudAgentConnection: class { dispose() {} } }));
vi.mock("../cloud-event-reader", () => ({ CloudEventReader: class { dispose() {} on() { return () => {}; } } }));
vi.mock("../cloud-github-native", () => ({ installCloudGithubNative: vi.fn(() => () => {}) }));
import { openCloudRuntime } from "../open-cloud-runtime";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const descriptor = { ...target, runtimeId: "fixture-runtime", generation: 1 };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.epoch = 1; mocks.enabled = true;
  mocks.doc = { status: "ready", deletedAt: null, generation: { number: 1 }, capabilities: { canWrite: true } };
  mocks.refresh.mockImplementation(async () => mocks.doc);
  mocks.wake.mockImplementation(async () => { mocks.doc = { ...mocks.doc, status: "ready" }; return mocks.doc; });
  mocks.admission.mockResolvedValue(descriptor);
  mocks.connect.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([{ id: "local-main", path: "/workspace/repo" }]);
});
afterEach(() => { mocks.listeners.clear(); });
describe("cloud runtime admission fencing", () => {
  it("marks interaction wakes on the existing lifecycle path for both new and connected admissions", async () => {
    const passive = await openCloudRuntime(target, { reason: "interaction" });
    expect(mocks.wake).not.toHaveBeenCalled(); passive.release();
    const peer = await openCloudRuntime(target, { wake: true, reason: "interaction" });
    expect(mocks.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", false, "interaction");
    mocks.wake.mockClear();
    await peer.prepareForRun!(new AbortController().signal, "interaction");
    expect(mocks.wake).toHaveBeenCalledExactlyOnceWith(target, "wake", false, "interaction");
    peer.release();
  });
  it("serializes an explicit ready open with idle capture before acquiring admission", async () => {
    const capture = deferred<typeof mocks.doc>(); mocks.wake.mockReturnValue(capture.promise);
    const opening = openCloudRuntime(target, { wake: true });
    await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
    expect(mocks.admission).not.toHaveBeenCalled();
    capture.resolve(mocks.doc);
    const peer = await opening;
    expect(mocks.admission).toHaveBeenCalledOnce(); peer.release();
  });
  it("revalidates a connected runtime after cancelling ready-state capture", async () => {
    const peer = await openCloudRuntime(target);
    mocks.list.mockClear();
    const capture = deferred<typeof mocks.doc>(); mocks.wake.mockReturnValue(capture.promise);
    const preparing = peer.prepareForRun!(new AbortController().signal);
    await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
    expect(mocks.list).not.toHaveBeenCalled();
    capture.resolve(mocks.doc);
    expect(await preparing).toBe(true);
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.admission).toHaveBeenCalledOnce(); peer.release();
  });
  it("requires replacement admission when committed capture retires a connected runtime", async () => {
    const peer = await openCloudRuntime(target);
    mocks.list.mockClear();
    const capture = deferred<typeof mocks.doc>(); mocks.wake.mockReturnValue(capture.promise);
    const preparing = peer.prepareForRun!(new AbortController().signal);
    await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
    mocks.doc = { ...mocks.doc, status: "waking" };
    for (const listener of mocks.listeners) listener();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    mocks.doc = { ...mocks.doc, status: "ready" }; capture.resolve(mocks.doc);
    expect(await preparing).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("wakes a stopped workspace only for an explicit use before minting fresh admission", async () => {
    mocks.doc = { ...mocks.doc, status: "stopped" };
    await expect(openCloudRuntime(target)).rejects.toThrow(/stopped/);
    expect(mocks.wake).not.toHaveBeenCalled();
    const peer = await openCloudRuntime(target, { wake: true });
    expect(mocks.wake).toHaveBeenCalledOnce();
    expect(mocks.admission).toHaveBeenCalledOnce();
    expect(mocks.wake.mock.invocationCallOrder[0]).toBeLessThan(mocks.admission.mock.invocationCallOrder[0]);
    peer.release();
  });
  it.each(["gate", "viewer"])("does not wake or admit when explicit use lacks %s authority", async reason => {
    mocks.doc = { ...mocks.doc, status: "stopped", capabilities: { canWrite: reason !== "viewer" } };
    mocks.enabled = reason !== "gate";
    await expect(openCloudRuntime(target, { wake: true })).rejects.toThrow();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.admission).not.toHaveBeenCalled();
  });
  it.each(["abort", "account", "generation"])("does not admit after %s changes during an explicit wake", async reason => {
    mocks.doc = { ...mocks.doc, status: "stopped" };
    const wake = deferred<typeof mocks.doc>(); mocks.wake.mockReturnValue(wake.promise);
    const controller = new AbortController();
    const opening = openCloudRuntime(target, { wake: true, signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow(/cancel|account|generation|changed/i);
    await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
    if (reason === "abort") controller.abort();
    if (reason === "account") mocks.epoch++;
    mocks.doc = { ...mocks.doc, status: "ready", generation: { number: reason === "generation" ? 0 : 1 } };
    wake.resolve(mocks.doc);
    await rejected;
    expect(mocks.admission).not.toHaveBeenCalled();
  });
  it("admits the replacement generation after wake and retires a reused older connection calmly", async () => {
    const peer = await openCloudRuntime(target);
    const capture = deferred<typeof mocks.doc>(); mocks.wake.mockReturnValue(capture.promise);
    const preparing = peer.prepareForRun!(new AbortController().signal);
    await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
    mocks.doc = { ...mocks.doc, generation: { number: 2 } };
    for (const listener of mocks.listeners) listener();
    capture.resolve(mocks.doc);
    expect(await preparing).toBe(false);
    mocks.admission.mockResolvedValue({ ...descriptor, generation: 2 });
    const replacement = await openCloudRuntime(target);
    expect(mocks.admission).toHaveBeenCalledTimes(2); replacement.release();
  });
  it("never requests admission from a ready read when a newer stopped document won", async () => {
    const opening = openCloudRuntime(target);
    mocks.doc = { ...mocks.doc, status: "stopped" };
    await expect(opening).rejects.toThrow(/availability|changed/i);
    expect(mocks.admission).not.toHaveBeenCalled();
  });
  it("disposes a connecting peer on cancellation before its connection promise settles", async () => {
    const connecting = deferred<void>(); mocks.connect.mockReturnValue(connecting.promise);
    const controller = new AbortController();
    const opening = openCloudRuntime(target, { signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow(/cancel|changed/i);
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    controller.abort();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    connecting.resolve(); await rejected;
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("rejects a newly admitted generation against a stale ready document and closes it", async () => {
    mocks.admission.mockResolvedValue({ ...descriptor, generation: 2 });
    await expect(openCloudRuntime(target)).rejects.toThrow(/generation|changed/i);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("does not request admission after sign-out during catalog refresh", async () => {
    const read = deferred<typeof mocks.doc>(); mocks.refresh.mockReturnValue(read.promise);
    const opening = openCloudRuntime(target);
    const rejected = expect(opening).rejects.toThrow(/account|cancel|changed/i);
    mocks.epoch++;
    read.resolve(mocks.doc);
    await rejected;
    expect(mocks.admission).not.toHaveBeenCalled();
  });
  it("closes a late admission after cancellation without connecting it", async () => {
    const admission = deferred<typeof descriptor>(); mocks.admission.mockReturnValue(admission.promise);
    const controller = new AbortController();
    const opening = openCloudRuntime(target, { signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow(/cancel|changed/i);
    await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalledOnce());
    controller.abort(); admission.resolve(descriptor);
    await rejected;
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("keeps physical root confirmation mandatory and obtains a fresh admission per open", async () => {
    const first = await openCloudRuntime(target); first.release();
    mocks.list.mockResolvedValue([{ id: "local-main", path: "relative" }]);
    await expect(openCloudRuntime(target)).rejects.toThrow(/workspace root/);
    expect(mocks.admission).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
