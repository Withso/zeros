/** Optional questions use the existing durable prompt queue. Only the entry
 * inserted by this answer may be steered; earlier user drafts keep their order. */
export async function deliverOptionalAnswer(options: {
  queued: () => readonly { bubbleId: string }[];
  send: () => void;
  steer: (bubbleId: string) => Promise<boolean> | undefined;
  drain: () => void;
}): Promise<void> {
  const before = new Set(options.queued().map((entry) => entry.bubbleId));
  options.send();
  const added = options.queued().find((entry) => !before.has(entry.bubbleId));
  if (added && !(await options.steer(added.bubbleId))) {
    // The turn may have settled while steering was in flight. Its finally
    // cannot drain an entry that was still claimed then; retry now that the
    // existing steer path has restored it. Drain still respects holds/status.
    options.drain();
  }
}
