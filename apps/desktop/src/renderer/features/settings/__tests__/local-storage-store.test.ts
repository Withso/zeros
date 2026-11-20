import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_STORAGE_CATEGORY_IDS,
  LOCAL_STORAGE_PROGRESS_EVENT,
  type LocalStorageReport,
} from "../../../../../shared/local-storage";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  electron: true,
  handlers: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("../../../platform/runtime", () => ({
  isElectron: () => native.electron,
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));
import {
  _resetLocalStorageForTests,
  cancelLocalStorageMeasurement,
  clearLocalStorageCache,
  ensureLocalStorageMeasured,
  getLocalStorageView,
  isLocalStorageSupported,
  retainLocalStorageView,
  subscribeLocalStorageView,
  warmLocalStorage,
} from "../local-storage-store";

function report(revision: number, bytes: number | null, patch: Partial<LocalStorageReport> = {}): LocalStorageReport {
  return {
    revision,
    measuring: false,
    measuredAt: Date.now(),
    categories: LOCAL_STORAGE_CATEGORY_IDS.map((id) => ({
      id,
      status: bytes === null ? "unmeasured" : "measured",
      bytes,
      measuring: false,
      progressBytes: null,
      location: null,
      revealable: true,
    })),
    ...patch,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const calls = (command: string) => native.invoke.mock.calls.filter(([name]) => name === command).length;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  _resetLocalStorageForTests();
  native.invoke.mockReset();
  native.listen.mockReset().mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
    native.handlers.set(event, handler);
    return () => native.handlers.delete(event);
  });
  native.handlers.clear();
  native.electron = true;
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Local Storage store", () => {
  it("is supported only in the Mac app", () => {
    expect(isLocalStorageSupported()).toBe(true);
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(isLocalStorageSupported()).toBe(false);
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    native.electron = false;
    expect(isLocalStorageSupported()).toBe(false);
    ensureLocalStorageMeasured();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does nothing until warmed or opened", () => {
    expect(getLocalStorageView().report).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
  });

  it("shares one request between intent warming and opening the page", async () => {
    const reply = deferred<LocalStorageReport>();
    native.invoke.mockReturnValueOnce(reply.promise);
    warmLocalStorage();
    const release = retainLocalStorageView();
    ensureLocalStorageMeasured();
    expect(calls("local_storage_measure")).toBe(1);
    reply.resolve(report(3, 100));
    await flush();
    expect(getLocalStorageView().report?.revision).toBe(3);
    // A fresh snapshot is reused by the next open.
    release();
    await flush();
    retainLocalStorageView()();
    expect(calls("local_storage_measure")).toBe(1);
  });

  it("streams progress and ignores anything older than what it shows", async () => {
    const reply = deferred<LocalStorageReport>();
    native.invoke.mockReturnValueOnce(reply.promise);
    ensureLocalStorageMeasured();
    await flush();
    const progress = native.handlers.get(LOCAL_STORAGE_PROGRESS_EVENT)!;
    progress(report(5, null, { measuring: true }));
    expect(getLocalStorageView().report?.revision).toBe(5);
    progress(report(4, 999));
    progress({ revision: 9, nonsense: true });
    expect(getLocalStorageView().report?.revision).toBe(5);
    reply.resolve(report(7, 10));
    await flush();
    expect(getLocalStorageView().report?.revision).toBe(7);
    expect(native.handlers.has(LOCAL_STORAGE_PROGRESS_EVENT)).toBe(false);
  });

  it("keeps the last confirmed sizes during a refresh and after a failed one", async () => {
    native.invoke.mockResolvedValueOnce(report(1, 50));
    ensureLocalStorageMeasured();
    await flush();
    const confirmed = getLocalStorageView().report;
    const reply = deferred<LocalStorageReport>();
    native.invoke.mockReturnValueOnce(reply.promise);
    ensureLocalStorageMeasured({ force: true });
    expect(getLocalStorageView().report).toBe(confirmed);
    reply.reject(new Error("Local Storage is available on macOS only."));
    await flush();
    expect(getLocalStorageView().report).toBe(confirmed);
    expect(getLocalStorageView().error).toMatch("macOS");
  });

  it("keeps one stable snapshot reference between changes", async () => {
    native.invoke.mockResolvedValueOnce(report(1, 50));
    ensureLocalStorageMeasured();
    await flush();
    const a = getLocalStorageView();
    ensureLocalStorageMeasured();
    expect(getLocalStorageView()).toBe(a);
    const listener = vi.fn();
    const off = subscribeLocalStorageView(listener);
    native.handlers.get(LOCAL_STORAGE_PROGRESS_EVENT)?.(report(1, 50));
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("measures again once the snapshot is old, or on Refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    native.invoke.mockResolvedValue(report(1, 50));
    ensureLocalStorageMeasured();
    await flush();
    ensureLocalStorageMeasured();
    expect(calls("local_storage_measure")).toBe(1);
    ensureLocalStorageMeasured({ force: true });
    await flush();
    expect(calls("local_storage_measure")).toBe(2);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    ensureLocalStorageMeasured();
    expect(calls("local_storage_measure")).toBe(3);
    vi.useRealTimers();
  });

  it("an owner switch A → B → A neither refetches nor drops the snapshot nor cancels", async () => {
    const reply = deferred<LocalStorageReport>();
    native.invoke.mockReturnValueOnce(reply.promise);
    // Settings remounts per owner: the old page releases in the same commit
    // the new one retains.
    let release = retainLocalStorageView();
    for (let i = 0; i < 2; i++) {
      release();
      release = retainLocalStorageView();
    }
    await flush();
    expect(calls("local_storage_measure")).toBe(1);
    expect(calls("local_storage_cancel")).toBe(0);
    reply.resolve(report(2, 10));
    await flush();
    const snapshot = getLocalStorageView().report;
    release();
    release = retainLocalStorageView();
    release();
    release = retainLocalStorageView();
    await flush();
    expect(getLocalStorageView().report).toBe(snapshot);
    expect(calls("local_storage_measure")).toBe(1);
    release();
  });

  it("cancels the walk when the page is left", async () => {
    native.invoke.mockImplementation((command: string) =>
      command === "local_storage_measure" ? new Promise(() => {}) : Promise.resolve(null),
    );
    const release = retainLocalStorageView();
    release();
    release();
    await flush();
    expect(calls("local_storage_cancel")).toBe(1);
  });

  it("a viewer that returns while a cancelled run settles gets exactly one fresh measurement", async () => {
    const first = deferred<LocalStorageReport>();
    native.invoke.mockImplementation((command: string) =>
      command === "local_storage_measure" ? (calls("local_storage_measure") === 1 ? first.promise : new Promise(() => {})) : Promise.resolve(null),
    );
    const release = retainLocalStorageView();
    release();
    await flush();
    expect(calls("local_storage_cancel")).toBe(1);
    const again = retainLocalStorageView();
    expect(calls("local_storage_measure")).toBe(1);
    // Main settles the cancelled run with nothing newly confirmed.
    first.resolve(report(4, null, { measuredAt: null }));
    await flush();
    expect(calls("local_storage_measure")).toBe(2);
    await flush();
    expect(calls("local_storage_measure")).toBe(2);
    again();
  });

  it("does not restart when the cancel lost the race and the run completed", async () => {
    const first = deferred<LocalStorageReport>();
    native.invoke.mockImplementation((command: string) =>
      command === "local_storage_measure" ? first.promise : Promise.resolve(null),
    );
    const release = retainLocalStorageView();
    release();
    await flush();
    const again = retainLocalStorageView();
    first.resolve(report(4, 10));
    await flush();
    await flush();
    expect(calls("local_storage_measure")).toBe(1);
    again();
  });

  it("does not restart a cancelled run once no viewer remains", async () => {
    const first = deferred<LocalStorageReport>();
    native.invoke.mockImplementation((command: string) =>
      command === "local_storage_measure" ? first.promise : Promise.resolve(null),
    );
    const release = retainLocalStorageView();
    release();
    await flush();
    first.resolve(report(4, null, { measuredAt: null }));
    await flush();
    await flush();
    expect(calls("local_storage_measure")).toBe(1);
  });

  it("does not cancel when nothing is running", async () => {
    native.invoke.mockResolvedValueOnce(report(1, 1));
    const release = retainLocalStorageView();
    await flush();
    release();
    await flush();
    cancelLocalStorageMeasurement();
    expect(calls("local_storage_cancel")).toBe(0);
  });

  it("clears with the closed category id only and shows what was freed", async () => {
    native.invoke.mockResolvedValueOnce(report(1, 61_000_000));
    ensureLocalStorageMeasured();
    await flush();
    const reply = deferred<unknown>();
    native.invoke.mockReturnValueOnce(reply.promise);
    const clearing = clearLocalStorageCache();
    expect(getLocalStorageView().clearing).toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith("local_storage_clear_cache", { category: "cache" });
    void clearLocalStorageCache();
    expect(calls("local_storage_clear_cache")).toBe(1);
    reply.resolve({ freedBytes: 42_000_000, report: report(4, 19_000_000) });
    await clearing;
    expect(getLocalStorageView()).toMatchObject({ clearing: false, freedBytes: 42_000_000 });
    expect(getLocalStorageView().report?.revision).toBe(4);
  });

  it("keeps listening after a clear while main resumes the interrupted walk", async () => {
    native.invoke.mockResolvedValueOnce({ freedBytes: null, report: report(3, 1, { measuring: true }) });
    await clearLocalStorageCache();
    expect(getLocalStorageView().freedBytes).toBeNull();
    expect(native.handlers.has(LOCAL_STORAGE_PROGRESS_EVENT)).toBe(true);
    native.handlers.get(LOCAL_STORAGE_PROGRESS_EVENT)!(report(6, 2));
    expect(getLocalStorageView().report?.revision).toBe(6);
    expect(native.handlers.has(LOCAL_STORAGE_PROGRESS_EVENT)).toBe(false);
  });
});
