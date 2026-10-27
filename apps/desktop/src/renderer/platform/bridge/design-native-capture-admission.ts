import { DESIGN_CAPTURE_TIMEOUT_MS, DesignCaptureCleanupUnconfirmedError } from "@zeros/protocol/design-capture";
import { isNativeRuntime, nativeInvoke } from "../runtime";

function waitForCapacity(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The app shell reserves main's native export slot before an iframe clones
 * its DOM. A cancelled consumer still joins runtime cleanup before releasing.
 * Browser-only development keeps the renderer scheduler's bounded fallback. */
export async function withNativeDesignCaptureAdmission<T>(
  signal: AbortSignal, explicit: boolean, work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (!isNativeRuntime()) return work();
  const jobId = crypto.randomUUID();
  const deadline = Date.now() + DESIGN_CAPTURE_TIMEOUT_MS;
  for (let delay = 100; ; delay = Math.min(500, delay * 2)) {
    signal.throwIfAborted();
    let acquired: boolean;
    try {
      const reply = await nativeInvoke<{ acquired: boolean }>("design_capture_acquire", { jobId, explicit });
      if (typeof reply?.acquired !== "boolean") throw new Error("Invalid capture admission reply.");
      acquired = reply.acquired;
    } catch {
      // A lost reply can hide a live reservation. Do not start another job.
      throw new DesignCaptureCleanupUnconfirmedError();
    }
    if (acquired) break;
    signal.throwIfAborted();
    if (!explicit || Date.now() + delay >= deadline)
      throw new Error("Design capture capacity reached. Try again when the active render finishes.");
    await waitForCapacity(delay, signal);
  }
  let outcome: { value: T } | { error: unknown };
  try {
    signal.throwIfAborted();
    outcome = { value: await work() };
  } catch (error) {
    if (error instanceof DesignCaptureCleanupUnconfirmedError) throw error;
    outcome = { error };
  }
  try {
    const reply = await nativeInvoke<{ released: boolean }>("design_capture_release", { jobId });
    if (reply?.released !== true) throw new Error("Capture release was not confirmed.");
  } catch {
    throw new DesignCaptureCleanupUnconfirmedError();
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
