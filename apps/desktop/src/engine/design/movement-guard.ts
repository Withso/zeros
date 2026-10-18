import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DesignMovementGuard } from "@zeros/protocol/design-relocation";

const movement = new AsyncLocalStorage<{
  root: string;
  frame: string;
  guard: DesignMovementGuard;
}>();

export function withMeasuredDesignMovement<T>(
  root: string,
  frame: string,
  guard: DesignMovementGuard,
  run: () => Promise<T>,
): Promise<T> {
  return movement.run({ root: path.resolve(root), frame, guard }, run);
}

export function currentDesignMovementGuard(
  root: string,
  frame: string,
): DesignMovementGuard | undefined {
  const current = movement.getStore();
  return current?.root === path.resolve(root) && current.frame === frame
    ? current.guard
    : undefined;
}
