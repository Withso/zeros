import { AsyncLocalStorage } from "node:async_hooks";

/** A snapshot owns its lane so a foreground join can promote already queued
 * work as well as future lazy comparisons, without launching duplicates. */
export class GitReadLane {
  private readonly waiting = new Set<() => void>();
  constructor(public background: boolean) {}

  promote(): void {
    this.background = false;
    for (const start of [...this.waiting]) start();
  }

  onPromotion(start: () => void): () => void {
    this.waiting.add(start);
    return () => { this.waiting.delete(start); };
  }
}

const backgroundReads = new AsyncLocalStorage<GitReadLane>();

export function withGitReadLane<T>(lane: GitReadLane, read: () => Promise<T>): Promise<T> {
  return backgroundReads.run(lane, read);
}

export function currentGitReadLane(): GitReadLane | undefined {
  return backgroundReads.getStore();
}

/** Summary fan-out is bounded without delaying interactive Git observations. */
export function withBackgroundGitReads<T>(read: () => Promise<T>): Promise<T> {
  return withGitReadLane(new GitReadLane(true), read);
}

export function isBackgroundGitRead(): boolean {
  return currentGitReadLane()?.background === true;
}
