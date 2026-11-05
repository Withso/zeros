import type { DriverOpen } from "../driver";
import { redactDriverValue } from "../driver";

export const CLOUD_INPUT_TIMEOUT_MS = 15 * 60_000;

export function cleanInteraction<T>(value: T, input: DriverOpen): T {
  return redactDriverValue(value, input);
}

/** A provider abort must release its callback even if the UI is disconnected. */
export function nativeInputResponse<T>(callback: (() => Promise<T>) | undefined, signal: AbortSignal, cancelled: T): Promise<T> {
  if (!callback || signal.aborted) return Promise.resolve(cancelled);
  return new Promise(resolve => {
    let done = false;
    const finish = (value: T) => {
      if (done) return;
      done = true; signal.removeEventListener("abort", abort); resolve(value);
    };
    const abort = () => finish(cancelled);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(callback).then(finish, () => finish(cancelled));
  });
}
