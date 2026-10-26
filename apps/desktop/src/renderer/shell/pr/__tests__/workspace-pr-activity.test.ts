import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refreshKey: 1, probe: vi.fn(), changed: vi.fn(),
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
}));
vi.mock("../../../platform/git", () => ({ ghPrSync: fixture.probe }));
vi.mock("../../../state/use-projects", () => ({ notifyWorkspacesChanged: fixture.changed }));
vi.mock("../../use-git-refresh-key", () => ({ useGitRefreshKey: () => fixture.refreshKey }));

let useWorkspacePrSync: typeof import("../use-workspace-pr-sync").useWorkspacePrSync;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
const cleanups: Array<() => void> = [];
function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
function Fixture(path = "/personal/project", id = "local-a", prNumber: number | null = null) {
  useWorkspacePrSync({ id, path, prNumber, repoSlug: `repo-${id}` } as Workspace);
  for (const effect of fixture.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.clearAllMocks();
  fixture.effects.length = 0; fixture.refreshKey = 1; fixture.probe.mockResolvedValue(null);
  ({ useWorkspacePrSync } = await import("../use-workspace-pr-sync"));
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
});
afterEach(() => { unmount(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local workspace PR discovery activity", () => {
  it.each([
    ["/personal/project", "hidden"], ["/personal/project", "blurred"],
    ["/organization/project", "hidden"], ["/organization/project", "blurred"],
  ])("does no discovery or timer work for %s while %s", async (path, mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    Fixture(path); await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, path, reads: fixture.probe.mock.calls.length, timers: vi.getTimerCount() }));
    expect(fixture.probe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the timer on blur, refreshes on return, and coalesces focus with visibility", async () => {
    Fixture(); await vi.advanceTimersByTimeAsync(0); expect(fixture.probe).toHaveBeenCalledOnce();
    focused = false; window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.probe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    focused = true; window.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
    unmount(); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });

  it("keeps in-flight A separate from B and catches a hidden refresh generation on reveal", async () => {
    let finish!: (value: { number: number }) => void;
    fixture.probe.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture();
    focused = false; window.dispatchEvent(new Event("blur")); unmount();
    fixture.refreshKey++; Fixture("/organization/project", "local-b");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.probe.mock.calls).toEqual([["local-a"]]);
    focused = true; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe.mock.calls).toEqual([["local-a"], ["local-b"]]);
    finish({ number: 12 }); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.changed.mock.calls).toEqual([["repo-local-a"]]);
  });

  it("owns no timer after a PR is known", async () => {
    Fixture("/personal/project", "local-a", 42); await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.probe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces refreshes during a pending probe into one fresh successor", async () => {
    let finish!: (value: null) => void;
    fixture.probe.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture();
    for (let index = 0; index < 3; index++) {
      unmount(); fixture.refreshKey++; Fixture();
    }
    expect(fixture.probe).toHaveBeenCalledOnce();
    finish(null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });

  it("does not confirm an invalidated absence before its successor finishes", async () => {
    const { workspacePrDiscoverySnapshot } = await import("../workspace-pr-discovery-state");
    const finishes: Array<(value: null) => void> = [];
    fixture.probe.mockImplementation(() => new Promise(done => { finishes.push(done); }));
    Fixture(); unmount(); fixture.refreshKey++; Fixture();
    finishes[0](null); await vi.advanceTimersByTimeAsync(0);
    expect(workspacePrDiscoverySnapshot("local-a")).toEqual({ pending: true, checked: false, error: null });
    finishes[1](null); await vi.advanceTimersByTimeAsync(0);
    expect(workspacePrDiscoverySnapshot("local-a")).toEqual({ pending: false, checked: true, error: null });
  });

  it("defers the pending successor while hidden and catches up on a quick reveal", async () => {
    let finish!: (value: null) => void;
    fixture.probe.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture(); unmount(); fixture.refreshKey++; Fixture();
    focused = false; window.dispatchEvent(new Event("blur"));
    finish(null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledOnce();
    focused = true; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });

  it("keeps failures distinct from an empty successful observation and recovers on refresh", async () => {
    const { workspacePrDiscoverySnapshot } = await import("../workspace-pr-discovery-state");
    const error = new Error("GitHub is temporarily unavailable");
    fixture.probe.mockRejectedValueOnce(error);
    Fixture(); await vi.advanceTimersByTimeAsync(0);
    expect(workspacePrDiscoverySnapshot("local-a")).toMatchObject({ pending: false, checked: false, error });
    expect(workspacePrDiscoverySnapshot("local-b").error).toBeNull();
    unmount(); fixture.refreshKey++; Fixture(); await vi.advanceTimersByTimeAsync(0);
    expect(workspacePrDiscoverySnapshot("local-a")).toEqual({ pending: false, checked: true, error: null });
  });

  it("rechecks after returning from GitHub during a pending lookup without a Git refresh", async () => {
    let finish!: (value: null) => void;
    fixture.probe.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture();
    focused = false; window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(3_000);
    focused = true; window.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.probe).toHaveBeenCalledOnce();
    finish(null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });

  it("awaits one fresh manual retry when the previous lookup is still pending", async () => {
    const { retryWorkspacePrDiscovery } = await import("../use-workspace-pr-sync");
    const finishes: Array<(value: null) => void> = [];
    fixture.probe.mockImplementation(() => new Promise(done => { finishes.push(done); }));
    Fixture();
    let retried = false;
    const retry = retryWorkspacePrDiscovery("local-a").then(() => { retried = true; });
    finishes[0](null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    expect(retried).toBe(false);
    finishes[1](null); await retry;
    expect(retried).toBe(true);
  });

  it("retires loading snapshots when pending observations are evicted", async () => {
    const { workspacePrDiscoverySnapshot } = await import("../workspace-pr-discovery-state");
    const finishes: Array<(value: null) => void> = [];
    fixture.probe.mockImplementation(() => new Promise(done => { finishes.push(done); }));
    for (let index = 0; index < 140; index++) {
      Fixture(`/workspace-${index}`, `workspace-${index}`); unmount();
    }
    for (const finish of finishes) finish(null);
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 140; index++) expect(workspacePrDiscoverySnapshot(`workspace-${index}`).pending).toBe(false);
    expect(workspacePrDiscoverySnapshot("workspace-0")).toBe(workspacePrDiscoverySnapshot("never-visited"));
  });

  it("shares manual retries across multiple mounted consumers of one workspace", async () => {
    const { retryWorkspacePrDiscovery } = await import("../use-workspace-pr-sync");
    const finishes: Array<(value: null) => void> = [];
    fixture.probe.mockImplementation(() => new Promise(done => { finishes.push(done); }));
    Fixture(); Fixture();
    const retry = retryWorkspacePrDiscovery("local-a");
    finishes[0](null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    finishes[1](null); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    await retry;
  });

  it("does not republish discovery or notify a deleted workspace", async () => {
    const { forgetPrCachesForWorkspace } = await import("../pr-cache-forget");
    const { workspacePrDiscoverySnapshot } = await import("../workspace-pr-discovery-state");
    let finish!: (value: { number: number }) => void;
    fixture.probe.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture(); unmount(); forgetPrCachesForWorkspace("local-a");
    finish({ number: 12 }); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(workspacePrDiscoverySnapshot("local-a")).toBe(workspacePrDiscoverySnapshot("never-visited"));
  });

  it("restores exact-key discovery across Local, organization and cloud navigation", async () => {
    const { workspacePrDiscoverySnapshot } = await import("../workspace-pr-discovery-state");
    const error = new Error("GitHub unavailable for A");
    fixture.probe.mockRejectedValueOnce(error);
    Fixture(); await vi.advanceTimersByTimeAsync(0); unmount();
    const retained = workspacePrDiscoverySnapshot("local-a");
    Fixture("/organization/project", "local-b"); await vi.advanceTimersByTimeAsync(0); unmount();
    const cloud = "cloud://organization/workspace";
    Fixture(cloud, cloud); await vi.advanceTimersByTimeAsync(0); unmount();
    Fixture(); await vi.advanceTimersByTimeAsync(0);
    expect(workspacePrDiscoverySnapshot("local-a")).toBe(retained);
    expect(retained.error).toBe(error);
    expect(workspacePrDiscoverySnapshot("local-b")).toEqual({ pending: false, checked: true, error: null });
    expect(workspacePrDiscoverySnapshot(cloud)).toEqual({ pending: false, checked: true, error: null });
    expect(fixture.probe.mock.calls).toEqual([["local-a"], ["local-b"], [cloud]]);
  });

  it.each(["hidden", "blurred"])("does no cloud discovery or timer work while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    Fixture("cloud://organization/workspace", "cloud://organization/workspace");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("backs cloud errors off across repeated Git refresh generations", async () => {
    const cloud = "cloud://organization/workspace";
    fixture.probe.mockRejectedValue(new Error("GitHub read unavailable"));
    for (let index = 0; index < 30; index++) {
      fixture.refreshKey++; Fixture(cloud, cloud);
      await vi.advanceTimersByTimeAsync(1_000); unmount();
    }
    expect(fixture.probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); Fixture(cloud, cloud);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
  });
});
