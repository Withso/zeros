import { AsyncLocalStorage } from "node:async_hooks";

const authority = new AsyncLocalStorage<(() => void) | undefined>();

/** Scope an engine-minted authority to a semantic operation. Never accept this
 * callback from IPC. Journal writers check it synchronously before admission. */
export function withDesignWriteAuthority<T>(
  assertAuthorized: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const parent = authority.getStore();
  return authority.run(() => {
    parent?.();
    assertAuthorized();
  }, run);
}

export function assertDesignWriteAuthorized(): void {
  authority.getStore()?.();
}

/** A durable journal was already admitted. Revocation cannot strand its
 * recovery halfway through a multi-file transaction. */
export function finishAdmittedDesignWrite<T>(
  run: () => Promise<T>,
): Promise<T> {
  return authority.run(undefined, run);
}
