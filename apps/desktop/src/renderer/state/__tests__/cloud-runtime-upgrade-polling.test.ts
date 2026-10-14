import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  changed: new Set<() => void>(),
  account: 1, catalog: 1, access: true,
  workspaces: new Map<string, CloudWorkspaceDocument>(),
  read: vi.fn(), detail: vi.fn(), mutation: vi.fn(),
}));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({ useCloudWorkspaceAccountAccess: () => h.access }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => h.account }));
vi.mock("../../platform/cloud-workspaces", () => ({
  getCloudRuntimeUpgradeAvailability: h.read,
  changeCloudWorkspaceLifecycle: h.mutation,
}));
vi.mock("../cloud-workspace-catalog", async () => {
  const { KeyedAsyncCache } = await import("../../shared/lib/keyed-async-cache");
  const details = new KeyedAsyncCache<CloudWorkspaceDocument>();
  return {
    cloudWorkspaceDetails: details,
    cloudCatalogGeneration: () => h.catalog,
    cloudWorkspaceDocument: (target: { organizationId: string; workspaceId: string }) => h.workspaces.get(target.workspaceId),
    refreshCloudWorkspace: async (target: { organizationId: string; workspaceId: string }) => {
      const result = await h.detail(target);
      details.setData(`cloud://${target.organizationId}/${target.workspaceId}`, result);
      return result;
    },
    subscribeCloudWorkspaces: (listener: () => void) => {
      h.changed.add(listener);
      return () => { h.changed.delete(listener); };
    },
  };
});

import { useCloudRuntimeUpgradeLink } from "../../features/agent/cloud-runtime-upgrade-link";
import { CloudWorkspaceRuntimeControls } from "../../shell/conversation/cloud-workspace-runtime-controls";
import { cloudWorkspaceDetails } from "../cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "../cloud-runtime-upgrade";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const target = (id = workspaceId) => ({ organizationId, workspaceId: id });
const folder = (id = workspaceId) => `cloud://${organizationId}/${id}`;
const key = (id = workspaceId) => cloudRuntimeUpgradeAvailabilityKey(target(id), h.workspaces.get(id)!.generation.number);
function workspace(id = workspaceId): CloudWorkspaceDocument {
  return {
    id, organizationId, placement: "cloud", status: "ready", deletedAt: null,
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    generation: { number: 1 },
  } as CloudWorkspaceDocument;
}
function result(id = workspaceId): CloudRuntimeUpgradeAvailability {
  return { ...target(id), generation: h.workspaces.get(id)!.generation.number,
    currentRuntimeId: `r1-${"a".repeat(64)}`, latestRuntimeId: `r1-${"b".repeat(64)}`,
    updateAvailable: true, unavailableReason: null, transition: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Surface = "link" | "controls";
function Link({ id, active }: { id: string; active: boolean }) { return useCloudRuntimeUpgradeLink(folder(id), active); }
let page: EventTarget & { visibilityState: string }, browser: EventTarget;
const cleanups = new Set<() => void>();
let fired = 0;
const flush = () => vi.advanceTimersByTimeAsync(0);
async function mount(surface: Surface, id = workspaceId, active = true) {
  h.effects.length = 0;
  renderToStaticMarkup(surface === "link" ? createElement(Link, { id, active })
    : createElement(CloudWorkspaceRuntimeControls, { workspace: h.workspaces.get(id)!, active }));
  // Execute real production effects/cache loaders; only I/O and React's host
  // effect installation are replaced. The scheduler itself is not mocked.
  const effects = h.effects.splice(0).map(effect => effect()).filter((off): off is () => void => typeof off === "function");
  const stop = () => { for (const off of effects) off(); cleanups.delete(stop); };
  cleanups.add(stop);
  await flush();
  return stop;
}
function visibility(value: "hidden" | "visible") {
  page.visibilityState = value;
  page.dispatchEvent(new Event("visibilitychange"));
}
function changed() { for (const listener of h.changed) listener(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  h.account++; h.catalog++; h.access = true; h.effects.length = 0;
  cloudRuntimeUpgradeAvailability.clear(); cloudWorkspaceDetails.clear();
  h.workspaces.clear();
  for (const id of [workspaceId, otherId]) {
    const doc = workspace(id); h.workspaces.set(id, doc); cloudWorkspaceDetails.setData(folder(id), doc);
  }
  h.read.mockReset().mockImplementation(async ({ workspaceId: id }) => result(id));
  h.detail.mockReset().mockImplementation(async ({ workspaceId: id }) => h.workspaces.get(id));
  h.mutation.mockClear(); fired = 0;
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  browser = new EventTarget();
  vi.stubGlobal("document", page); vi.stubGlobal("window", browser);
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => timeout(() => { fired++; run(); }, delay)) as typeof setTimeout);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((run: () => void, delay: number) => interval(() => { fired++; run(); }, delay)) as typeof setInterval);
});
afterEach(() => {
  for (const stop of [...cleanups]) stop();
  cloudRuntimeUpgradeAvailability.clear(); cloudWorkspaceDetails.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("runtime upgrade observation budget", () => {
  it.each<Surface>(["link", "controls"])("keeps a hidden %s cold and owns no timer", async surface => {
    page.visibilityState = "hidden";
    const listeners = h.changed.size;
    await mount(surface);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).not.toHaveBeenCalled(); expect(h.detail).not.toHaveBeenCalled();
    expect(fired).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(h.changed.size).toBe(listeners);
  });
  it.each<Surface>(["link", "controls"])("keeps an inactive %s inert", async surface => {
    await mount(surface, workspaceId, false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("shares one 30s fallback between visible composer and controls", async () => {
    await mount("link"); await mount("controls");
    expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(3); expect(fired).toBe(2);
    expect(vi.getTimerCount()).toBe(1); expect(h.detail).not.toHaveBeenCalled(); expect(h.mutation).not.toHaveBeenCalled();
  });
  it.each<Surface>(["link", "controls"])("cancels hidden %s work and coalesces foreground/focus catch-up", async surface => {
    await mount(surface);
    const retained = cloudRuntimeUpgradeAvailability.peekSnapshot(key()).data;
    visibility("hidden"); browser.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledOnce(); expect(fired).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(key()).data).toBe(retained);
    const pending = deferred<CloudRuntimeUpgradeAvailability>(); h.read.mockReturnValueOnce(pending.promise);
    visibility("visible"); browser.dispatchEvent(new Event("focus")); await flush();
    expect(h.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(result()); await flush(); expect(vi.getTimerCount()).toBe(1);
  });
  it("owns no timer during a slow shared read and never rearms in a hidden window", async () => {
    const pending = deferred<CloudRuntimeUpgradeAvailability>(); h.read.mockReturnValueOnce(pending.promise);
    await mount("link"); await mount("controls");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledOnce(); expect(fired).toBe(0); expect(vi.getTimerCount()).toBe(0);
    visibility("hidden"); pending.resolve(result()); await flush(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["draining", "provisioning", "setting_up", "rolling_back"] as const)("retains the 2s %s progress fallback", async state => {
    const value = { ...result(), transition: { id: otherId, generation: 2, runtimeId: result().latestRuntimeId!, state, error: null } };
    cloudRuntimeUpgradeAvailability.setData(key(), value); h.read.mockResolvedValue(value);
    await mount("controls"); await vi.advanceTimersByTimeAsync(1_999);
    expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledOnce(); expect(h.detail).toHaveBeenCalledOnce();
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("honors an intent-warmed exact snapshot without an extra opening request", async () => {
    cloudRuntimeUpgradeAvailability.setData(key(), result());
    await mount("link"); await mount("controls");
    expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999); expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledOnce();
  });
  it("keeps the prior deadline across catalog events and wall-clock changes", async () => {
    await mount("controls");
    await vi.advanceTimersByTimeAsync(20_000);
    changed(); browser.dispatchEvent(new Event("focus")); await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); changed();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(9_999); expect(h.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(3);
  });
  it("retains a confirmed snapshot after a failure and retries on the bounded fallback", async () => {
    await mount("controls");
    const retained = cloudRuntimeUpgradeAvailability.peekSnapshot(key()).data;
    h.read.mockRejectedValueOnce(new Error("synthetic unavailable"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(key()).data).toBe(retained);
    await vi.advanceTimersByTimeAsync(30_000); expect(h.read).toHaveBeenCalledTimes(3);
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(key()).error).toBeNull();
  });
  it.each(["waking", "provisioning", "setting_up"])("retains the 5s %s startup fallback after a catalog event", async status => {
    await mount("controls");
    await vi.advanceTimersByTimeAsync(500);
    h.workspaces.get(workspaceId)!.status = status as CloudWorkspaceDocument["status"]; changed();
    await vi.advanceTimersByTimeAsync(4_499); expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(2); expect(h.detail).toHaveBeenCalledOnce();
    h.workspaces.get(workspaceId)!.status = "ready"; changed();
    await vi.advanceTimersByTimeAsync(29_999); expect(h.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(3);
  });
  it("uses the 2s transition cadence during startup only while details are observed", async () => {
    const value = { ...result(), transition: { id: otherId, generation: 2, runtimeId: result().latestRuntimeId!, state: "draining" as const, error: null } };
    h.workspaces.get(workspaceId)!.status = "waking";
    h.read.mockResolvedValue(value);
    await mount("link");
    const stopDetails = await mount("controls");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.detail).toHaveBeenCalledOnce();
    stopDetails();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.detail).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledTimes(3); expect(h.detail).toHaveBeenCalledOnce();
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("shares an external cache refresh and anchors its next fallback to that read", async () => {
    await mount("link"); await mount("controls");
    await vi.advanceTimersByTimeAsync(20_000);
    const pending = deferred<CloudRuntimeUpgradeAvailability>(); h.read.mockReturnValueOnce(pending.promise);
    const readKey = key();
    const refresh = cloudRuntimeUpgradeAvailability.load(readKey, () => loadCloudRuntimeUpgradeAvailability(readKey), { force: true });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    browser.dispatchEvent(new Event("focus")); changed(); await flush();
    expect(h.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); expect(fired).toBe(0);
    pending.resolve(result()); await refresh; await flush();
    await vi.advanceTimersByTimeAsync(19_999); expect(h.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.detail).not.toHaveBeenCalled(); expect(h.mutation).not.toHaveBeenCalled();
  });
  it("stays idle while a startup detail read is pending and does not rearm after hiding", async () => {
    h.workspaces.get(workspaceId)!.status = "setting_up";
    await mount("controls");
    const pending = deferred<CloudWorkspaceDocument>(); h.detail.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.detail).toHaveBeenCalledOnce();
    const before = fired;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.detail).toHaveBeenCalledOnce();
    expect(fired).toBe(before); expect(vi.getTimerCount()).toBe(0);
    visibility("hidden"); pending.resolve(h.workspaces.get(workspaceId)!); await flush();
    expect(vi.getTimerCount()).toBe(0); expect(h.mutation).not.toHaveBeenCalled();
  });
  it.each(["removed", "generation", "capability"])("retires the old observation when its workspace is %s", async boundary => {
    await mount("controls");
    if (boundary === "removed") h.workspaces.delete(workspaceId);
    else if (boundary === "generation") h.workspaces.get(workspaceId)!.generation.number++;
    else h.workspaces.get(workspaceId)!.capabilities.canManage = false;
    changed(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledOnce(); expect(fired).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps late A1 and B results outside A2 and outside its timer lifetime", async () => {
    const a1 = deferred<CloudRuntimeUpgradeAvailability>(), b = deferred<CloudRuntimeUpgradeAvailability>(), a2 = deferred<CloudRuntimeUpgradeAvailability>();
    h.read.mockReturnValueOnce(a1.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise);
    const oldKey = key(), stopA1 = await mount("controls"); stopA1();
    h.account++; h.catalog++; changed();
    const stopB = await mount("controls", otherId); stopB();
    h.account++; h.catalog++; changed();
    await mount("controls"); const currentKey = key();
    a1.resolve(result()); b.resolve(result(otherId)); await flush();
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(oldKey).data).toBeUndefined();
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(currentKey).data).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    a2.resolve(result()); await flush(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(h.read).toHaveBeenCalledTimes(4);
    expect(h.read.mock.lastCall?.[0]).toEqual(target());
  });
  it("does not restart an unmounted observer when its read settles", async () => {
    const pending = deferred<CloudRuntimeUpgradeAvailability>(); h.read.mockReturnValueOnce(pending.promise);
    const stop = await mount("controls"); stop(); pending.resolve(result()); await flush();
    browser.dispatchEvent(new Event("focus")); visibility("visible");
    await vi.advanceTimersByTimeAsync(60_000); expect(h.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
