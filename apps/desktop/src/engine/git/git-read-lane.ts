import { AsyncLocalStorage } from "node:async_hooks";

const backgroundReads = new AsyncLocalStorage<boolean>();

/** Summary fan-out is bounded without delaying interactive Git observations. */
export function withBackgroundGitReads<T>(read: () => Promise<T>): Promise<T> {
  return backgroundReads.run(true, read);
}

export function isBackgroundGitRead(): boolean {
  return backgroundReads.getStore() === true;
}
