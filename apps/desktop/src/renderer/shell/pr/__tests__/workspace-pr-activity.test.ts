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
