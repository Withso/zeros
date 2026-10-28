import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessMetricsSnapshot } from "../../platform/process-metrics";

// Execute the real component and commit its effects. Native reads and the clock
// are controlled; no DOM or process sampler is needed to count background work.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  callbacks: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<{ index: number; run: () => void | (() => void); deps?: readonly unknown[] }>,
  stateIndex: 0, refIndex: 0, callbackIndex: 0, effectIndex: 0,
  writes: vi.fn(), ready: true, internal: true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  memo: (component: unknown) => component,
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      hooks.writes(hooks.states[index]);
    }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (value: unknown, deps: readonly unknown[]) => {
    const index = hooks.callbackIndex++, previous = hooks.callbacks[index];
    if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) hooks.callbacks[index] = { value, deps };
    return hooks.callbacks[index].value;
  },
  useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.effectIndex++, previous = hooks.effects[index];
    if (!previous || !deps || deps.some((dep, i) => dep !== previous.deps?.[i])) hooks.pending.push({ index, run, deps });
  },
}));
const native = vi.hoisted(() => ({
  snapshot: vi.fn(), census: vi.fn(),
  terminals: new Set<() => void>(), bridgeChanges: new Set<() => void>(),
  connected: new Set<(...args: unknown[]) => void>(),
}));
vi.mock("../../platform/runtime", () => ({ useNativeRuntime: () => ({ ready: hooks.ready }) }));
vi.mock("../../features/settings/internal-features", () => ({
  useInternalFeatureActive: (feature: string) => feature === "resourceSummary" && hooks.internal,
}));
vi.mock("../../platform/process-metrics", () => ({ processMetricsSnapshot: native.snapshot, processDiagnosticsReport: vi.fn() }));
vi.mock("../../platform/pty", () => ({
  ptyProcessPids: native.census,
  onPtyTerminalsChanged: (fn: () => void) => { native.terminals.add(fn); return () => native.terminals.delete(fn); },
}));
vi.mock("../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({}),
  onActiveBridgeChange: (fn: () => void) => { native.bridgeChanges.add(fn); return () => native.bridgeChanges.delete(fn); },
  onActiveBridgeConnected: (fn: (...args: unknown[]) => void) => { native.connected.add(fn); return () => native.connected.delete(fn); },
}));
vi.mock("../../shared/lib/clipboard", () => ({ copyToClipboardWithFallback: vi.fn() }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ResourceMonitor } from "../resource-monitor";

let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let win: EventTarget;
let focused: boolean;
const totals = { cpuPercent: 0, memoryBytes: 100, peakCpuPercent: 0, peakCpuAt: null,
  peakMemoryBytes: 100, peakMemoryAt: null, processCount: 1 };
const snapshot = (sampledAt: number): ProcessMetricsSnapshot => ({
  sampledAt, samplingIntervalMs: 1_000, scanDurationMs: 1, cpuReady: true, logicalCpuCount: 8,
  systemMemoryBytes: 1000, terminalRootsKnown: true, memorySource: "resident", footprintAgeMs: null,
  system: null, otherApps: [], totals: { all: totals, excludingTerminals: totals }, processes: [],
});
function render(open: boolean) {
  hooks.states[0] = open;
  hooks.stateIndex = hooks.refIndex = hooks.callbackIndex = hooks.effectIndex = 0;
  const result = ResourceMonitor({});
  const pending = hooks.pending.splice(0);
  for (const { index } of pending) hooks.effects[index]?.cleanup?.();
  for (const { index, run, deps } of pending) hooks.effects[index] = { deps, cleanup: run() || undefined };
  return result;
}
function foreground(visible: boolean, focus = true) {
  page.visibilityState = visible ? "visible" : "hidden"; focused = focus;
  page.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event(focus ? "focus" : "blur"));
}
function dispose() {
  for (const effect of hooks.effects.splice(0)) effect.cleanup?.();
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers(); focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  win = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  vi.stubGlobal("document", page); vi.stubGlobal("window", win);
  hooks.states.length = hooks.refs.length = hooks.callbacks.length = hooks.pending.length = 0;
  hooks.ready = hooks.internal = true; hooks.writes.mockClear();
  native.snapshot.mockReset().mockResolvedValue(snapshot(1));
  native.census.mockReset().mockResolvedValue([10]);
});
afterEach(() => {
  dispose();
  expect(native.terminals.size + native.bridgeChanges.size + native.connected.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("resource monitor activity", () => {
  it("does not announce a single failed sample that recovers on the next poll", async () => {
    native.snapshot.mockRejectedValueOnce(new Error("temporary sample failure"));
    render(true); await settle();
    expect(hooks.writes).not.toHaveBeenCalledWith("temporary sample failure");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hooks.states[1]).toEqual(snapshot(1));
    expect(hooks.writes).not.toHaveBeenCalledWith("temporary sample failure");
  });
  it("reports repeated sampling failures and clears them on a confirmed sample", async () => {
    native.snapshot.mockRejectedValueOnce(new Error("sample failed")).mockRejectedValueOnce(new Error("sample failed"));
    render(true); await settle();
    expect(hooks.writes).not.toHaveBeenCalledWith("sample failed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hooks.writes).toHaveBeenCalledWith("sample failed");
    hooks.writes.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hooks.writes).toHaveBeenCalledWith(null);
    expect(hooks.states[1]).toEqual(snapshot(1));
  });
  it("keeps full-app memory live every five seconds without PTY reads while closed", async () => {
    render(false); await settle();
    expect(native.snapshot).toHaveBeenCalledOnce();
    expect(native.snapshot).toHaveBeenLastCalledWith({ terminalPids: [], terminalRootsKnown: false, detail: true });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(native.snapshot).toHaveBeenCalledOnce();
    native.snapshot.mockResolvedValueOnce(snapshot(2));
    await vi.advanceTimersByTimeAsync(1);
    expect(native.snapshot).toHaveBeenCalledTimes(2);
    expect(hooks.states[1]).toEqual(snapshot(2));
    expect(native.census).not.toHaveBeenCalled();
    expect(native.terminals.size + native.bridgeChanges.size + native.connected.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([false, true])("does not render or sample without Internal access (open=%s)", async (open) => {
    hooks.internal = false;
    expect(render(open)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.snapshot).not.toHaveBeenCalled();
    expect(native.census).not.toHaveBeenCalled();
    expect(native.terminals.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a held scan when Internal access is disabled and resumes without overlap", async () => {
    let finish!: (value: ProcessMetricsSnapshot) => void;
    native.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(true); await settle();
    hooks.internal = false;
    expect(render(true)).toBeNull();
    hooks.writes.mockClear();
    finish(snapshot(99)); await settle();
    expect(hooks.writes).not.toHaveBeenCalledWith(snapshot(99));
    expect(vi.getTimerCount()).toBe(0);
    hooks.internal = true; render(false); await settle();
    expect(native.snapshot).toHaveBeenCalledTimes(2);
    expect(hooks.states[1]).toEqual(snapshot(1));
  });

  it("pauses the live summary while hidden and catches up once on reveal", async () => {
    foreground(false); render(false); await vi.advanceTimersByTimeAsync(30_000);
    expect(native.snapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    foreground(true); await settle();
    expect(native.snapshot).toHaveBeenCalledOnce();
    foreground(false); await vi.advanceTimersByTimeAsync(30_000);
    expect(native.snapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("samples immediately on open and sequentially each second", async () => {
    let finish!: (value: ProcessMetricsSnapshot) => void;
    native.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(true); await settle();
    expect(native.snapshot).toHaveBeenCalledOnce();
    expect(native.snapshot).toHaveBeenLastCalledWith({ terminalPids: [10], terminalRootsKnown: true, detail: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(native.snapshot).toHaveBeenCalledOnce();
    finish(snapshot(2)); await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.snapshot).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["hidden", "blurred"])("is inert while %s and refreshes once on reveal", async (state) => {
    foreground(state !== "hidden", state !== "blurred");
    render(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(native.snapshot).not.toHaveBeenCalled(); expect(native.census).not.toHaveBeenCalled();
    expect(native.terminals.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    foreground(true); await settle();
    expect(native.snapshot).toHaveBeenCalledOnce(); expect(native.census).toHaveBeenCalledOnce();
    expect(native.terminals.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
  });

  it("releases listeners and settle timers on blur, retaining the last confirmed sample", async () => {
    render(true); await settle();
    const confirmed = hooks.states[1];
    for (const listener of native.terminals) listener();
    foreground(true, false); await settle();
    native.snapshot.mockClear(); native.census.mockClear(); hooks.writes.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0); expect(native.terminals.size).toBe(0);
    expect(native.snapshot).not.toHaveBeenCalled(); expect(native.census).not.toHaveBeenCalled();
    expect(hooks.writes).not.toHaveBeenCalled(); expect(hooks.states[1]).toBe(confirmed);
  });

  it("fences a held read through close/open without overlapping native scans", async () => {
    let finish!: (value: ProcessMetricsSnapshot) => void;
    native.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(true); await settle(); render(false); render(true); await settle();
    expect(native.snapshot).toHaveBeenCalledOnce();
    hooks.writes.mockClear(); finish(snapshot(99)); await settle();
    expect(hooks.writes).not.toHaveBeenCalledWith(snapshot(99));
    expect(native.snapshot).toHaveBeenCalledTimes(2);
    expect(hooks.states[1]).toEqual(snapshot(1));
  });

  it("does not publish late native replies after hiding or unmounting", async () => {
    let finish!: (value: ProcessMetricsSnapshot) => void;
    native.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(true); await settle(); foreground(false); dispose(); hooks.writes.mockClear();
    finish(snapshot(99)); await settle(); foreground(true); await settle();
    expect(hooks.writes).not.toHaveBeenCalled(); expect(native.snapshot).toHaveBeenCalledOnce();
  });

  it("keeps browser/cloud-only clients outside the native monitor", async () => {
    hooks.ready = false; render(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(native.snapshot).not.toHaveBeenCalled(); expect(native.census).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
