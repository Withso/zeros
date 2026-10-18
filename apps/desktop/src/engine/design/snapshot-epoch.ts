import path from "node:path";

// ──────────────────────────────────────────────────────────
// Design snapshot read fences
// ──────────────────────────────────────────────────────────
//
// Aggregate Design snapshot reads are shared while in flight. A read that
// began before a native save (an agent's Write, a shell edit, a rebuilt style
// output) must not answer a request made after that save was observed: the
// renderer would publish the older aggregate as fresh and show nothing until
// the next event. Observers fence a checkout as soon as they see a change, and
// a request joins only a flight that started in the current fence epoch.
// Epochs come from one monotonic counter, so evicting an idle checkout can
// never make an old flight look current again.

const MAX_FENCED_ROOTS = 512;
let counter = 0;
let coarseEpoch = 0;
let evictedFloor = 0;
const epochs = new Map<string, number>();

/** Record that this checkout's Design inputs may have changed. Without a root,
 * every checkout is fenced (a coarse watcher event). */
export function fenceDesignSnapshotReads(root?: string | null): void {
  counter += 1;
  if (!root) {
    coarseEpoch = counter;
    return;
  }
  const key = path.resolve(root);
  epochs.delete(key);
  epochs.set(key, counter);
  while (epochs.size > MAX_FENCED_ROOTS) {
    const oldest = epochs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    evictedFloor = Math.max(evictedFloor, epochs.get(oldest) ?? 0);
    epochs.delete(oldest);
  }
}

/** The fence epoch a snapshot flight for this checkout starts in. */
export function designSnapshotReadEpoch(root: string): string {
  return String(
    Math.max(coarseEpoch, epochs.get(path.resolve(root)) ?? evictedFloor),
  );
}
