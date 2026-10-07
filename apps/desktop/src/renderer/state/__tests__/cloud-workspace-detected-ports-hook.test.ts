import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>, read: vi.fn(),
  doc: { status: "ready", generation: { number: 7 } } as { status: string; generation: { number: number } } | undefined,
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => void | (() => void)) => { h.effects.push(effect); },
  useState: (initial: () => unknown) => [initial(), vi.fn()], useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1,
  getTeamStoreState: () => ({ me: { user: { id: "44444444-4444-4444-8444-444444444444" } } }) }));
vi.mock("../../platform/cloud-workspaces", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/cloud-workspaces")>(), getCloudWorkspaceDetectedPorts: h.read,
}));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 1, cloudWorkspaceDocument: () => h.doc,
  canReadCloudWorkspace: (doc: unknown) => !!doc, subscribeCloudWorkspaces: () => () => {},
}));
import { cloudWorkspaceDetectedPorts, useCloudWorkspaceDetectedPorts } from "../use-cloud-workspace-detected-ports";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
let cleanups: Array<() => void> = [];
function MountHarness(options = { active: true, open: true, featureActive: true }, path: string | null = folder) {
  h.effects = []; useCloudWorkspaceDetectedPorts(path, options);
  cleanups = h.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
}
function unmount() { for (const cleanup of cleanups) cleanup(); cleanups = []; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  h.doc = { status: "ready", generation: { number: 7 } }; h.read.mockReset();
  h.read.mockImplementation(async () => ({ version: 1, ...target, generation: 7, status: h.doc?.status ?? "ready", observedAt: null, ports: null }));
  cloudWorkspaceDetectedPorts.snapshots.clear();
});
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("persisted detected-port hook", () => {
  it("reads without an engine and polls only the open visible surface", async () => {
    MountHarness(); await vi.advanceTimersByTimeAsync(0); expect(h.read).toHaveBeenCalledOnce();
    expect(h.read.mock.calls[0][0]).toMatchObject({ ...target, generation: 7 });
    await vi.advanceTimersByTimeAsync(4_000); expect(h.read).toHaveBeenCalledTimes(2);
    unmount(); await vi.advanceTimersByTimeAsync(12_000); expect(h.read).toHaveBeenCalledTimes(2);
    expect(document.removeEventListener).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("performs a persisted read while stopped without recurring polling", async () => {
    h.doc!.status = "stopped"; MountHarness(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12_000); expect(h.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps Local/organization Local, inactive/closed/disabled/hidden and removed owners inert", async () => {
    for (const path of ["/local/checkout", "/organization/checkout", null]) { MountHarness(undefined, path); unmount(); }
    for (const field of ["active", "open", "featureActive"] as const) { MountHarness({ active: true, open: true, featureActive: true, [field]: false }); unmount(); }
    h.doc = undefined; MountHarness(); unmount(); h.doc = { status: "ready", generation: { number: 7 } };
    Object.defineProperty(document, "visibilityState", { value: "hidden" }); MountHarness(); unmount();
    await vi.advanceTimersByTimeAsync(12_000); expect(h.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
