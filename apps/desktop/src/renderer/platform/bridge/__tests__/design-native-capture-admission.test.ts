import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignCaptureCleanupUnconfirmedError } from "@zeros/protocol/design-capture";
import { withNativeDesignCaptureAdmission } from "../design-native-capture-admission";

const native = vi.hoisted(() => ({ isNativeRuntime: vi.fn(), nativeInvoke: vi.fn() }));
vi.mock("../../runtime", () => native);
beforeEach(() => {
  native.isNativeRuntime.mockReturnValue(true);
  native.nativeInvoke.mockReset().mockImplementation(async (command) =>
    command === "design_capture_acquire" ? { acquired: true } : { released: true });
});
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("retains main's reservation after cancellation until the in-frame capture settles", async () => {
  const started = deferred<void>();
  const cleanup = deferred<void>();
  const controller = new AbortController();
  const pending = withNativeDesignCaptureAdmission(controller.signal, true, async () => {
    started.resolve();
    await cleanup.promise;
    controller.signal.throwIfAborted();
  });
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await started.promise;
  const job = native.nativeInvoke.mock.calls[0]![1].jobId;
  controller.abort(new Error("cancelled"));
  expect(native.nativeInvoke).toHaveBeenCalledTimes(1);
  cleanup.resolve();
  await rejected;
  expect(native.nativeInvoke).toHaveBeenLastCalledWith("design_capture_release", { jobId: job });
});

it("releases a late admission after cancellation without starting the frame capture", async () => {
  const admission = deferred<{ acquired: boolean }>();
  native.nativeInvoke.mockImplementationOnce(() => admission.promise);
  const controller = new AbortController();
  const work = vi.fn();
  const pending = withNativeDesignCaptureAdmission(controller.signal, true, work);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  admission.resolve({ acquired: true });
  await rejected;
  expect(work).not.toHaveBeenCalled();
  expect(native.nativeInvoke.mock.calls.map(([command]) => command)).toEqual(["design_capture_acquire", "design_capture_release"]);
});

it("never frees main's slot when runtime cleanup or IPC confirmation is lost", async () => {
  await expect(withNativeDesignCaptureAdmission(new AbortController().signal, true, async () => {
    throw new DesignCaptureCleanupUnconfirmedError();
  })).rejects.toBeInstanceOf(DesignCaptureCleanupUnconfirmedError);
  expect(native.nativeInvoke).toHaveBeenCalledTimes(1);
  native.nativeInvoke.mockReset().mockRejectedValue(new Error("IPC disconnected"));
  const work = vi.fn();
  await expect(withNativeDesignCaptureAdmission(new AbortController().signal, true, work)).rejects.toBeInstanceOf(DesignCaptureCleanupUnconfirmedError);
  expect(work).not.toHaveBeenCalled();
});

it("waits for native capacity for an explicit export and leaves optional work deferred", async () => {
  vi.useFakeTimers();
  native.nativeInvoke.mockResolvedValueOnce({ acquired: false });
  const work = vi.fn(async () => "pixels");
  const pending = withNativeDesignCaptureAdmission(new AbortController().signal, true, work);
  expect(work).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBe("pixels");
  native.nativeInvoke.mockClear().mockResolvedValueOnce({ acquired: false });
  await expect(withNativeDesignCaptureAdmission(new AbortController().signal, false, work)).rejects.toThrow("capacity");
  expect(native.nativeInvoke).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps browser-only fallback and treats a failed release as unconfirmed cleanup", async () => {
  native.isNativeRuntime.mockReturnValue(false);
  await expect(withNativeDesignCaptureAdmission(new AbortController().signal, true, async () => "browser")).resolves.toBe("browser");
  expect(native.nativeInvoke).not.toHaveBeenCalled();
  native.isNativeRuntime.mockReturnValue(true);
  native.nativeInvoke.mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce({ released: false });
  await expect(withNativeDesignCaptureAdmission(new AbortController().signal, true, async () => "pixels")).rejects.toBeInstanceOf(DesignCaptureCleanupUnconfirmedError);
});
