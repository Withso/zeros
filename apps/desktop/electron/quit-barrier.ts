/** Work every quit waits for, whatever started it: Cmd-Q, a script's quit,
 * the window menu or an update's quitAndInstall (main's before-quit and the
 * updater both await it). Each step bounds itself; a failing step never
 * blocks the quit. Electron-free, so a step's owner can register it without
 * importing the app. */
const steps = new Map<() => Promise<unknown>, (() => void) | undefined>();

/** step runs at every quit; resume runs if that quit is aborted and the app keeps running. */
export function holdQuitFor(step: () => Promise<unknown>, resume?: () => void): () => void {
  steps.set(step, resume);
  return () => { steps.delete(step); };
}

/** A started quit ended with the app still running (an update that could not
 * install): every step's owner returns to normal operation. */
export function resumeAfterAbortedQuit(): void {
  for (const resume of steps.values()) { try { resume?.(); } catch { /* one owner never blocks another */ } }
}

export async function runQuitSteps(): Promise<void> {
  await Promise.allSettled([...steps.keys()].map(step => Promise.resolve().then(step)));
}

export function resetQuitBarrierForTests(): void { steps.clear(); }
