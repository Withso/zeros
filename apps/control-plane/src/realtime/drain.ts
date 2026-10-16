/** Upper bound for a graceful drain, matching the largest `sys.drain`
 * deadline the uplink contract allows. */
export const MAX_DRAIN_MS = 120_000;

/** Spreads the retirement of open connections over a drain window, so a
 * deploy does not turn every session into one simultaneous reconnect wave
 * against the replacement instance. Each connection keeps working until its
 * own moment. Resolves once `pending()` reaches zero or the window plus the
 * grace ends, whichever is first. */
export function staggeredDrain<T>(options: {
  items: Iterable<T>;
  windowMs: number;
  retire: (item: T) => void;
  pending: () => number;
  /** Extra time after the last retirement for close handshakes. */
  graceMs?: number;
  random?: () => number;
}): Promise<void> {
  const windowMs = Math.max(0, Math.min(MAX_DRAIN_MS, Math.floor(options.windowMs)));
  const random = options.random ?? Math.random;
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const item of [...options.items]) {
    const delay = windowMs === 0 ? 0 : Math.floor(Math.min(0.999_999, Math.max(0, random())) * windowMs);
    if (delay === 0) { options.retire(item); continue; }
    const timer = setTimeout(() => options.retire(item), delay);
    timer.unref?.();
    timers.push(timer);
  }
  const deadline = windowMs + (options.graceMs ?? 1_500);
  return new Promise(resolve => {
    const startedAt = Date.now();
    const check = () => {
      if (options.pending() === 0 || Date.now() - startedAt >= deadline) {
        for (const timer of timers) clearTimeout(timer);
        resolve();
        return;
      }
      const next = setTimeout(check, 50);
      next.unref?.();
    };
    check();
  });
}
