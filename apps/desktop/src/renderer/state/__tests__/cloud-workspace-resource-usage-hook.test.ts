import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>, bridge: null as unknown,
  read: vi.fn(), status: "connected", doc: {
    id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
    teamId: "11111111-1111-4111-8111-111111111111", createdBy: "44444444-4444-4444-8444-444444444444",
    name: "Cloud workspace", placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
    createdAt: "2026-10-07T10:00:00Z", updatedAt: "2026-10-07T10:00:00Z",
    repository: { forge: "github.com", owner: "example", name: "repo", revision: "main" },
    capabilities: { canWrite: true, canEdit: true, canManage: true, canStart: false, startUnavailableReason: null },
    generation: { number: 7, architecture: "linux/amd64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
    recovery: { state: null, checkpointId: null, checkpointAt: null, sourceGeneration: 7, needsAcknowledgement: true },
  } as CloudWorkspaceDocument,
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => void | (() => void)) => { h.effects.push(effect); },
  useState: (initial: () => unknown) => [initial(), vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1,
  getTeamStoreState: () => ({ me: { user: { id: "44444444-4444-4444-8444-444444444444" } } }) }));
vi.mock("../../platform/cloud-workspaces", () => ({ getCloudWorkspaceResourceUsage: h.read }));
vi.mock("../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => h.bridge }));
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridge: () => h.bridge, useBridgeStatus: () => h.status }));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 1, cloudWorkspaceDocument: () => h.doc,
  canReadCloudWorkspace: (doc: unknown) => !!doc, subscribeCloudWorkspaces: () => () => {},
}));
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { cloudWorkspaceResourceUsage, useCloudWorkspaceResourceUsage } from "../use-cloud-workspace-resource-usage";
const identity = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7, engineInstanceId: "33333333-3333-4333-8333-333333333333", authorityEpoch: 2, admissionId: "runtime-a" };
const folder = `cloud://${identity.organizationId}/${identity.workspaceId}`;
let bridge: WorkspaceRuntimeClient;
let cleanups: Array<() => void> = [];
function MountHarness(options = { active: true, open: true, featureActive: true }, path: string | null = folder) {
  h.effects = []; useCloudWorkspaceResourceUsage(path, options);
  cleanups = h.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
}
function unmount() { for (const cleanup of cleanups) cleanup(); cleanups = []; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  h.doc.status = "ready"; h.doc.recovery = { state: null, checkpointId: null, checkpointAt: null, sourceGeneration: 7, needsAcknowledgement: true };
  h.doc.capabilities.startUnavailableReason = null; h.status = "connected"; h.read.mockReset();
  h.read.mockImplementation(async () => ({ version: 1, organizationId: identity.organizationId, workspaceId: identity.workspaceId,
    generation: 7, engineInstanceId: identity.engineInstanceId, sampledAt: new Date().toISOString(),
    cpu: { cores: 2, usedPercent: 40 }, memory: { totalBytes: 100, availableBytes: 60, usedBytes: 40, usedPercent: 40 },
    disk: { totalBytes: 100, availableBytes: 70, usedBytes: 30, usedPercent: 30 } }));
  bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] }); h.bridge = bridge;
  vi.spyOn(bridge, "cloudResourceUsageConnection").mockReturnValue(identity);
  cloudWorkspaceResourceUsage.snapshots.clear();
});
afterEach(() => { unmount(); bridge.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("resource usage hook activity and timer ownership", () => {
  it("polls only the open active surface and removes its timer and visibility listener on close", async () => {
    MountHarness(); await vi.advanceTimersByTimeAsync(0); expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_000); expect(h.read).toHaveBeenCalledTimes(2);
    unmount(); await vi.advanceTimersByTimeAsync(12_000); expect(h.read).toHaveBeenCalledTimes(2);
    expect(document.removeEventListener).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("makes Local and organization Local placement, hidden/inactive/closed/disabled/disconnected/stopped/recovery surfaces inert", async () => {
    for (const path of ["/local/checkout", "/organization/checkout", null]) { MountHarness(undefined, path); unmount(); }
    for (const field of ["active", "open", "featureActive"] as const) {
      MountHarness({ active: true, open: true, featureActive: true, [field]: false }); unmount();
    }
    h.status = "disconnected"; MountHarness(); unmount(); h.status = "connected";
    for (const status of ["setting_up", "waking", "stopping", "stopped", "failed", "archived"]) { h.doc.status = status; MountHarness(); unmount(); }
    h.doc.status = "ready"; h.doc.recovery = { state: "recoverable", checkpointId: null, checkpointAt: null, sourceGeneration: 7, needsAcknowledgement: true };
    MountHarness(); unmount(); h.doc.recovery = null;
    h.doc.capabilities.startUnavailableReason = "cloud_workspace_v2_required"; MountHarness(); unmount(); h.doc.capabilities.startUnavailableReason = null;
    Object.defineProperty(document, "visibilityState", { value: "hidden" }); MountHarness(); unmount();
    await vi.advanceTimersByTimeAsync(12_000); expect(h.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops polling when an older runtime reports unavailable", async () => {
    h.read.mockResolvedValue(null); MountHarness(); await vi.advanceTimersByTimeAsync(0); unmount(); MountHarness();
    await vi.advanceTimersByTimeAsync(12_000); expect(h.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("samples healthy ready and busy server documents whose hypothetical restore needs acknowledgement", async () => {
    for (const status of ["ready", "busy"]) {
      h.doc.status = status;
      MountHarness(); await vi.advanceTimersByTimeAsync(0);
      expect(h.read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_000); expect(h.read).toHaveBeenCalledTimes(2);
      unmount(); cloudWorkspaceResourceUsage.snapshots.clear(); h.read.mockClear();
    }
  });
  it("keeps active recovery inert even when no acknowledgement is required and rejects a late sample", async () => {
    h.doc.recovery = { state: "recoverable", checkpointId: null, checkpointAt: null, sourceGeneration: 7, needsAcknowledgement: false };
    MountHarness(); await vi.advanceTimersByTimeAsync(12_000);
    expect(h.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); unmount();
    h.doc.recovery.state = null;
    let resolve!: (sample: unknown) => void;
    const sample = await h.read(); h.read.mockClear();
    h.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    MountHarness(); await vi.advanceTimersByTimeAsync(0); expect(h.read).toHaveBeenCalledOnce();
    h.doc.recovery.state = "recoverable"; resolve(sample);
    await vi.advanceTimersByTimeAsync(0);
    for (const key of cloudWorkspaceResourceUsage.snapshots.keys()) expect(cloudWorkspaceResourceUsage.snapshots.peekSnapshot(key).data).toBeUndefined();
  });
});
