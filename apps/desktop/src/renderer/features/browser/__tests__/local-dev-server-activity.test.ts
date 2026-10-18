import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: vi.fn(), useNativeRuntime: () => ({ ready: true }) }));
vi.mock("../local-workspace-folders", () => ({ registeredLocalWorkspaceFolders: () => [] }));
import { LocalDevServerStore, useLocalDevServers } from "../local-dev-servers";

let focused: boolean;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); focused = true; hooks.effects.length = 0;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function Fixture(scope = "/personal/project", active = true) {
  const invoke = vi.fn(async () => ({ root: scope, servers: [] }));
  const store = new LocalDevServerStore({ invoke, workspaceFolders: () => [], storage: () => null });
  const result = useLocalDevServers({ scope, active }, store);
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return { store, invoke, result };
}

describe("Local dev-server observation", () => {
  it.each(["hidden", "blurred", "retained"])("does no native scans or timers while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    const { invoke } = Fixture(undefined, mode !== "retained");
    await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, elapsedMs: 60_000, scans: invoke.mock.calls.length, timers: vi.getTimerCount() }));
    expect(invoke).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["/personal/project", "/organization/project"])("%s stops on blur and refreshes on return", async scope => {
    const { store, invoke } = Fixture(scope); await vi.advanceTimersByTimeAsync(0);
    const confirmed = store.getState(scope);
    expect(invoke).toHaveBeenCalledOnce();
    focused = false; window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(store.getState(scope)).toBe(confirmed);
    focused = true; window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
    for (const cleanup of cleanups.splice(0)) cleanup();
    window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["cloud://organization/workspace", ""])("preserves the unavailable %s path", async scope => {
    const { invoke, result } = Fixture(scope); await vi.advanceTimersByTimeAsync(60_000);
    expect(result.available).toBe(false); expect(invoke).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
