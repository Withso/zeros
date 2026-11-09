// One frame's turn in a recorder window. A frame takes tens of milliseconds;
// a page that crashed or stopped producing frames would otherwise hold its
// batch until the batch deadline and fail every frame in it.

/** Long enough for any frame that is still progressing (typical frames take
 * 30–120 ms), short enough that a stopped page fails only its own frame. */
export const DESIGN_RECORDER_FRAME_TIMEOUT_MS = 10_000;

export interface DesignRecorderFrameGuard {
  /** Aborts when the frame stops: its deadline, the batch's abort, or its page going away. */
  readonly signal: AbortSignal;
  /** Settles with `operation`, or rejects as soon as the frame stops. */
  run<T>(operation: Promise<T>): Promise<T>;
  dispose(): void;
}

/** `gone` resolves with a reason when the frame's page crashes or is destroyed. */
export function designRecorderFrameGuard(input: { gone: Promise<string>; signal: AbortSignal; timeoutMs?: number }): DesignRecorderFrameGuard {
  const timeoutMs = input.timeoutMs ?? DESIGN_RECORDER_FRAME_TIMEOUT_MS;
  const controller = new AbortController();
  const stop = (reason: unknown) => { if (!controller.signal.aborted) controller.abort(reason); };
  const timer = setTimeout(() => stop(new Error(`This frame did not finish rendering within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
  const onAbort = () => stop(input.signal.reason ?? new Error("Design recording was cancelled."));
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });
  void input.gone.then((reason) => stop(new Error(reason)));
  const stopped = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // Observed by every run(); never an unhandled rejection on its own.
  stopped.catch(() => {});
  return {
    signal: controller.signal,
    run: (operation) => Promise.race([operation, stopped]),
    dispose() {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    },
  };
}
