import { randomUUID } from "node:crypto";

/** A unique same-directory atomic-write path outside the engine's
 * `.zeros-tmp` Design-transaction recovery namespace. */
export function electronAtomicTemporaryPath(target: string): string {
  return `${target}.zeros-electron-tmp-${process.pid}-${randomUUID()}`;
}
