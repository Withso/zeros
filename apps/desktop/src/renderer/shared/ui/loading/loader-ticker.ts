/** Minimum time a loader-line subject stays before the next one replaces it.
 * Longer than the hand-off dissolve (shared/ui/motion/soft-motion.ts), so
 * motions never restart or stack when calls change faster than they play. */
export const LOADER_TICK_DWELL_MS = 550;

/** How long to wait before the loader line shows `incoming`: 0 to show it now.
 * Subjects that come and go inside one dwell are skipped, because the caller
 * shows whatever is newest when the wait ends. `immediate` subjects (the run
 * closed, so the timer returns) never wait. */
export function loaderTickDelay(
  shown: { key: string; at: number },
  incoming: string,
  now: number,
  immediate: boolean,
): number {
  if (incoming === shown.key || immediate) return 0;
  return Math.max(0, shown.at + LOADER_TICK_DWELL_MS - now);
}
