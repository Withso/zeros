import * as nodeModule from "node:module";

// @types/node 20 predates `flushCompileCache` (Node 22.10); the runtime is Node 24.
const node = nodeModule as unknown as { flushCompileCache?: () => void };

/** The service unit sets NODE_COMPILE_CACHE, but Node writes that cache only at
 * a normal exit, and a stopped VM may never give the worker one. Persisting
 * what is compiled so far lets the next boot on this disk skip most parsing.
 * A no-op when the cache is off; Node ignores write failures. */
export function persistCompileCache(): void {
  node.flushCompileCache?.();
}
