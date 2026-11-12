/** Work every quit waits for, whatever started it: Cmd-Q, a script's quit,
 * the window menu or an update's quitAndInstall (main's before-quit and the
 * updater both await it). Each step bounds itself; a failing step never
 * blocks the quit. Electron-free, so a step's owner can register it without
 * importing the app. */
const steps = new Set<() => Promise<unknown>>();

export function holdQuitFor(step: () => Promise<unknown>): () => void {
  steps.add(step);
  return () => { steps.delete(step); };
}

export async function runQuitSteps(): Promise<void> {
  await Promise.allSettled([...steps].map(step => Promise.resolve().then(step)));
}

export function resetQuitBarrierForTests(): void { steps.clear(); }
