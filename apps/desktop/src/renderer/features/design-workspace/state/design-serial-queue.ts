/** Keyed first-in, first-out lane for speculative runtime writes. Successive
 * gestures on one node share a lane, so a cancelled gesture's restore cannot
 * land after the next gesture's preview. A failed task never blocks the lane. */
export function createDesignSerialQueue() {
  const tails = new Map<string, Promise<void>>();
  return {
    run(key: string, task: () => Promise<unknown>): Promise<void> {
      const next = (tails.get(key) ?? Promise.resolve())
        .then(task)
        .then(
          () => {},
          () => {},
        );
      tails.set(key, next);
      void next.then(() => {
        if (tails.get(key) === next) tails.delete(key);
      });
      return next;
    },
    /** Settles once every task queued for `key` so far has finished. */
    idle(key: string): Promise<void> {
      return tails.get(key) ?? Promise.resolve();
    },
    get size(): number {
      return tails.size;
    },
  };
}
